'use strict';
// FreeDM sniffer — comprehensive resource detection (HTTP files, HLS, DASH, media)
const FREEDM_ENDPOINT = 'http://127.0.0.1:37651/capture';

// Video platforms handled by yt-dlp on the desktop side. When the user is on
// one of these pages, we offer to download the video via the page URL.
const VIDEO_PLATFORMS = /(^|\.)(youtube\.com|youtu\.be|twitter\.com|x\.com|reddit\.com|redd\.it|tiktok\.com|vimeo\.com|bilibili\.com|facebook\.com|instagram\.com|twitch\.tv|dailymotion\.com)$/i;

function isVideoPlatformPage(url) {
  try {
    const u = new URL(url);
    if (!VIDEO_PLATFORMS.test(u.hostname)) return false;
    // must look like a watch/video page, not the homepage
    const p = u.pathname;
    if (/youtube\.com$/i.test(u.hostname)) return /\/watch|\/shorts\//.test(p + u.search) || u.searchParams.has('v');
    if (/youtu\.be$/i.test(u.hostname)) return p.length > 1;
    if (/tiktok\.com$/i.test(u.hostname)) return /\/video\/|\/@/.test(p);
    if (/(twitter|x)\.com$/i.test(u.hostname)) return /\/status\//.test(p);
    if (/reddit\.com$/i.test(u.hostname)) return /\/comments\//.test(p);
    if (/bilibili\.com$/i.test(u.hostname)) return /\/video\//.test(p);
    return p.length > 1;
  } catch (e) { return false; }
}

const RES_EXT = /\.(mp4|mkv|avi|mov|flv|webm|ts|m4v|3gp|mp3|flac|wav|aac|m4a|ogg|opus|zip|rar|7z|tar|gz|xz|bz2|iso|exe|msi|dmg|apk|deb|rpm|pdf|docx?|xlsx?|pptx?|epub|mobi|azw3|psd|ai|sketch|torrent)(\?|$)/i;
const MEDIA_MIME = /^(video|audio)\//i;
const STREAM_MIME = /(mpegurl|dash\+xml)/i;
const DOC_MIME = /(application\/(zip|x-rar|x-7z|octet-stream|pdf|vnd\.|x-msdownload|x-apple-diskimage))/i;

// Minimum size (bytes) for a plain media file to be captured when not an attachment
const MIN_MEDIA_SIZE = 200 * 1024;

const tabResources = new Map(); // tabId -> Map(url -> resource)
const tabInfo = new Map();      // tabId -> { title, pageUrl }

function keyFor(url) { return url.split('#')[0]; }

function filenameFromUrl(url, fallbackExt) {
  try {
    const u = new URL(url);
    let name = decodeURIComponent(u.pathname.split('/').pop() || '');
    if (!name || !name.includes('.')) {
      const host = u.hostname.replace(/^www\./, '');
      name = (name || host) + (fallbackExt ? '.' + fallbackExt : '');
    }
    return name || 'download';
  } catch (e) { return 'download'; }
}

function classify(mime, url) {
  const u = url.toLowerCase();
  if (/mpegurl/i.test(mime) || /\.m3u8/.test(u)) return { kind: 'hls', tag: '视频流(HLS)' };
  if (/dash\+xml/i.test(mime) || /\.mpd/.test(u)) return { kind: 'dash', tag: '视频流(DASH)' };
  if (/^video\//i.test(mime) || /\.(mp4|mkv|webm|flv|mov|avi|ts|m4v)/.test(u)) return { kind: 'http', tag: '视频' };
  if (/^audio\//i.test(mime) || /\.(mp3|flac|m4a|aac|wav|ogg|opus)/.test(u)) return { kind: 'http', tag: '音频' };
  if (/\.(zip|rar|7z|tar|gz|xz|bz2|iso)/.test(u)) return { kind: 'http', tag: '压缩包' };
  if (/\.(exe|msi|dmg|apk|deb|rpm)/.test(u)) return { kind: 'http', tag: '程序' };
  if (/\.(pdf|docx?|xlsx?|pptx?|epub|mobi)/.test(u)) return { kind: 'http', tag: '文档' };
  return { kind: 'http', tag: '文件' };
}

function addResource(tabId, res) {
  if (tabId < 0) return;
  if (!tabResources.has(tabId)) tabResources.set(tabId, new Map());
  const map = tabResources.get(tabId);
  const k = keyFor(res.url);
  // Stamp the page this resource belongs to. tabInfo.pageUrl gets updated by
  // onUpdated (which also fires on SPA route changes), so it can't be trusted
  // later to tell which page a resource came from — the stamp can.
  if (!res.ownerPage) {
    const info = tabInfo.get(tabId);
    res.ownerPage = pageKey((info && info.pageUrl) || res.url);
  }
  // For streams, dedupe by manifest; upgrade if we learn size later
  if (map.has(k)) {
    const prev = map.get(k);
    if (res.size && !prev.size) prev.size = res.size;
    return;
  }
  map.set(k, res);
  updateBadge(tabId);
}

// Drop everything that wasn't captured on `url`. This is the single source of
// truth for "is this entry stale?", used by both navigation events and the
// popup's read path.
function pruneToPage(tabId, url) {
  const map = tabResources.get(tabId);
  if (!map) return;
  const cur = pageKey(url);
  for (const [k, r] of map) {
    const owner = r.ownerPage || pageKey(r.url);
    if (owner !== cur) map.delete(k);
  }
  updateBadge(tabId);
}

function updateBadge(tabId) {
  const n = tabResources.get(tabId)?.size || 0;
  chrome.action.setBadgeBackgroundColor({ color: '#2f7be0' });
  // 标签可能已被关闭 → setBadgeText 会抛/拒绝 "No tab with id"。
  // MV3 里它返回 Promise，用 .catch 吞掉拒绝，避免 Uncaught (in promise)。
  try {
    const p = chrome.action.setBadgeText({ tabId, text: n ? String(Math.min(n, 99)) : '' });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) { /* ignore */ }
}

// ---- Header-based sniffing ----
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.type === 'main_frame') return;
    const url = details.url;
    // 黑名单站点：完全不嗅探
    if (isBlacklisted(url, extSettings)) return;

    // On a video-platform tab, DON'T sniff individual fragments/manifests/API
    // responses — yt-dlp handles the whole page. Surfacing every .m3u8/.m4s/
    // videoplayback chunk just produces junk the user can't use.
    const info0 = tabInfo.get(details.tabId);
    if (info0 && info0.isVideoPlatform) return;

    const headers = details.responseHeaders || [];
    let mime = '', size = null, disp = '';
    for (const h of headers) {
      const n = h.name.toLowerCase();
      if (n === 'content-type') mime = h.value || '';
      else if (n === 'content-length') size = parseInt(h.value, 10);
      else if (n === 'content-disposition') disp = h.value || '';
    }
    const isStream = STREAM_MIME.test(mime) || /\.(m3u8|mpd)(\?|$)/i.test(url);
    const isMedia = MEDIA_MIME.test(mime);
    const isAttachment = /attachment/i.test(disp);
    const isResExt = RES_EXT.test(url);
    const isDoc = DOC_MIME.test(mime);

    if (!(isStream || isMedia || isAttachment || isResExt || isDoc)) return;

    // ---- Junk filters: skip streaming fragments that aren't downloadable on their own ----
    // HLS/DASH media segments (.ts, .m4s, fragmented mp4 chunks)
    if (/\.(ts|m4s)(\?|$)/i.test(url) && !isAttachment) return;
    // YouTube/Google videoplayback chunked ranges (never a whole file)
    if (/videoplayback|googlevideo\.com/i.test(url) && !isAttachment) return;
    // DASH/CMAF init & media segments by query hints
    if (/[?&](range|sq|rn|rbuf|itag)=/i.test(url) && !isAttachment) return;
    // API/JSON/telemetry that happens to have octet-stream mime
    if (/\/api\/|\.json(\?|$)|badge_count|settings\.json/i.test(url) && !isAttachment && !isResExt && !isMedia && !isStream) return;
    // m3u8: 只跳过明确是"分段子列表"的极小文件；master/带清晰度信息的保留。
    // 放宽阈值，避免把真正的清单当噪音丢掉（很多网站的 master playlist 只有几百字节）。
    if (/\.m3u8(\?|$)/i.test(url) && size != null && size < 200 && !/master|playlist|index/i.test(url)) return;
    // skip small non-attachment media fragments (e.g. MSE byte-range probes)
    if (isMedia && !isStream && !isAttachment && size != null && size < MIN_MEDIA_SIZE) return;

    const cls = classify(mime, url);
    let filename = filenameFromUrl(url, cls.kind === 'hls' || cls.kind === 'dash' ? 'mp4' : '');
    const m = /filename\*?=(?:UTF-8'')?"?([^;"]+)"?/i.exec(disp);
    if (m) { try { filename = decodeURIComponent(m[1]); } catch (e) { filename = m[1]; } }
    // name streams after the page title when the manifest name is generic
    if ((cls.kind === 'hls' || cls.kind === 'dash')) {
      const info = tabInfo.get(details.tabId);
      if (info && info.title && /^(index|master|playlist|manifest|video|chunklist)/i.test(filename)) {
        filename = sanitize(cleanTitle(info.title, info.pageUrl || url)) + '.mp4';
      }
    }
    addResource(details.tabId, {
      url, filename, mime, size: Number.isFinite(size) ? size : null,
      kind: cls.kind, tag: cls.tag,
      referer: tabInfo.get(details.tabId)?.pageUrl || details.initiator || '',
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

function sanitize(s) { return (s || 'video').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'video'; }

// Page titles arrive noisy: X prefixes an unread count ("(21) ..."), and while a
// route is still loading the title is often the generic site name rather than
// the post. Strip the count, and if what remains is generic, build a name from
// the URL instead so files aren't all called "主页 X.mp4".
// NOTE: \b is an ASCII word boundary and never matches after CJK characters,
// so "主页 X" slipped through. Match the whole remaining title instead.
const GENERIC_TITLE = /^(主页|首页|探索|通知|消息|home|explore|notifications|messages|x|twitter|youtube|reddit|tiktok|bilibili|哔哩哔哩)(\s*[·|\-–—]?\s*(x|twitter|youtube|reddit|tiktok))?\s*$/i;
function cleanTitle(title, url) {
  let t = (title || '').replace(/^\(\d+\+?\)\s*/, '').trim();   // drop "(21) "
  t = t.replace(/\s*[|\-–—]\s*(X|Twitter|YouTube|Reddit|TikTok)\s*$/i, '').trim();
  if (!t || GENERIC_TITLE.test(t)) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      // x.com/<user>/status/<id> -> "<user>-<id>"
      const si = parts.indexOf('status');
      if (si > 0 && parts[si + 1]) return `${parts[0]}-${parts[si + 1]}`;
      const v = u.searchParams.get('v');            // youtube.com/watch?v=<id>
      if (v) return v;
      if (parts.length) return parts[parts.length - 1];
      return u.hostname.replace(/^www\./, '');
    } catch (e) { /* fall through */ }
  }
  return t || 'video';
}

// Compare pages ignoring the hash, so #fragment changes don't wipe the list.
function pageKey(url) {
  try { const u = new URL(url); return u.origin + u.pathname + u.search; }
  catch (e) { return url || ''; }
}

// Refresh a tab's state for the page it is currently on. Called from both the
// tabs and webNavigation listeners so single-page apps are handled too.
function syncTab(tabId, url, title) {
  if (!url) return;
  const prev = tabInfo.get(tabId);
  const isVP = isVideoPlatformPage(url);

  // Record the current page FIRST so anything captured from here on is stamped
  // with the right owner.
  tabInfo.set(tabId, { title: title || (prev && prev.title), pageUrl: url, isVideoPlatform: isVP });

  // Then drop everything that belongs to a different page. This is decided by
  // each resource's own ownerPage stamp, not by comparing against tabInfo —
  // onUpdated also fires on SPA route changes and would have already moved
  // tabInfo to the new URL, making a "did it change?" check silently useless.
  pruneToPage(tabId, url);

  if (isVP) {
    addResource(tabId, {
      url,
      filename: sanitize(cleanTitle(title || (prev && prev.title), url)) + '.mp4',
      mime: 'video/*', size: null, kind: 'video-platform', tag: '在线视频',
      referer: url,
      ownerPage: pageKey(url),
    });
  }
}

// track page title/url for naming + referer
chrome.tabs.onUpdated.addListener((tabId, ch, tab) => {
  if (!tab) return;
  // Only act when the URL or title actually changed; onUpdated also fires for
  // favicon/audible/status updates that must not disturb the captured list.
  if (ch.url || ch.title || ch.status === 'complete') {
    syncTab(tabId, ch.url || tab.url, tab.title);
  }
});

// clear on top-frame navigation (full page loads)
chrome.webNavigation?.onCommitted?.addListener?.((d) => {
  if (d.frameId === 0) { tabResources.delete(d.tabId); updateBadge(d.tabId); }
});
// SPA route changes (X, YouTube, Reddit) — these do NOT fire onCommitted.
chrome.webNavigation?.onHistoryStateUpdated?.addListener?.((d) => {
  if (d.frameId !== 0) return;
  chrome.tabs.get(d.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    syncTab(d.tabId, d.url || tab.url, tab.title);
  });
});
chrome.webNavigation?.onReferenceFragmentUpdated?.addListener?.((d) => {
  if (d.frameId !== 0) return;
  chrome.tabs.get(d.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    syncTab(d.tabId, d.url || tab.url, tab.title);
  });
});
chrome.tabs.onRemoved.addListener((tabId) => { tabResources.delete(tabId); tabInfo.delete(tabId); });

// ---- content-script reported resources (blob/MSE, <video src>, <source>) ----
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab ? sender.tab.id : (msg.tabId ?? -1);

  // Reported by the content script when the page changes route without a real
  // navigation (X/YouTube/Reddit). This is the reliable trigger — webNavigation
  // events do not fire consistently for these apps.
  if (msg.type === 'spaNavigate') {
    if (tabId >= 0 && msg.url) syncTab(tabId, msg.url, msg.title);
    reply && reply({ ok: true });
    return true;
  }
  // The title usually arrives after the route change; refresh the entry's
  // filename once it does.
  if (msg.type === 'titleUpdate') {
    if (tabId >= 0 && msg.url) {
      const info = tabInfo.get(tabId);
      if (info && pageKey(info.pageUrl) === pageKey(msg.url)) {
        info.title = msg.title;
        const map = tabResources.get(tabId);
        if (map) {
          for (const r of map.values()) {
            if (r.kind === 'video-platform' && pageKey(r.url) === pageKey(msg.url)) {
              r.filename = sanitize(cleanTitle(msg.title, msg.url)) + '.mp4';
            }
          }
        }
      }
    }
    reply && reply({ ok: true });
    return true;
  }
  if (msg.type === 'domMedia' && Array.isArray(msg.items)) {
    // On video-platform tabs, ignore DOM/blob noise — yt-dlp handles the page.
    const ti = tabInfo.get(tabId);
    if (ti && ti.isVideoPlatform) { reply && reply({ ok: true }); return true; }
    for (const it of msg.items) {
      if (!it.url || it.url.startsWith('blob:') || it.url.startsWith('data:')) {
        // blob/MSE without a real URL: skip silently (was noisy "需嗅探manifest").
        continue;
      }
      const cls = classify(it.mime || '', it.url);
      addResource(tabId, { url: it.url, filename: filenameFromUrl(it.url, 'mp4'), mime: it.mime || '', size: null, kind: cls.kind, tag: cls.tag, referer: it.pageUrl || '' });
    }
    reply && reply({ ok: true });
    return true;
  }
  if (msg.type === 'getResources') {
    // Defense in depth: never trust that a navigation event fired. MV3 service
    // workers sleep, and SPA route changes are easy to miss — so verify against
    // the tab's ACTUAL current URL every time the popup reads the list.
    chrome.tabs.get(msg.tabId, (tab) => {
      const liveUrl = (!chrome.runtime.lastError && tab && tab.url) || null;
      if (liveUrl) {
        const info = tabInfo.get(msg.tabId);
        if (!info || pageKey(info.pageUrl) !== pageKey(liveUrl)) {
          // we missed the navigation entirely — rebuild state for this page
          syncTab(msg.tabId, liveUrl, tab.title);
        } else {
          pruneToPage(msg.tabId, liveUrl);
        }
      }
      const map = tabResources.get(msg.tabId);
      reply({
        resources: map ? [...map.values()] : [],
        info: tabInfo.get(msg.tabId) || {},
      });
    });
    return true; // keep the message channel open for the async reply
  }
  if (msg.type === 'send') { sendToFreeDM(msg.items); reply({ ok: true }); return true; }
  if (msg.type === 'clear') { tabResources.delete(msg.tabId); updateBadge(msg.tabId); reply({ ok: true }); return true; }
});

// ============================================================
// Download takeover (the IDM behaviour): when the browser is about to start a
// download, cancel it and hand the URL to TDM instead — so a plain click on a
// download link pops the TDM dialog without needing the right-click menu.
// ============================================================

// ---- configurable takeover rules ----
// Each category maps to a set of extensions. The user toggles categories (and
// can add custom extensions) in the popup; nothing here is hardcoded as "always
// on" except the master takeover switch.
const CATEGORY_EXT = {
  video: ['mp4','mkv','webm','avi','mov','flv','wmv','m4v','mpg','mpeg','ts','m2ts','3gp','ogv','m3u8','mpd','rmvb','vob'],
  audio: ['mp3','m4a','aac','flac','wav','ogg','opus','wma','alac','aiff','weba','mid'],
  archive: ['zip','rar','7z','tar','gz','bz2','xz','tgz','iso','cab'],
  program: ['exe','msi','dmg','pkg','apk','deb','rpm','appimage','bat'],
  document: ['pdf','doc','docx','xls','xlsx','ppt','pptx','epub','mobi','txt','csv'],
  model: ['gguf','safetensors','bin','ckpt','pt','pth','onnx','h5','tflite'],
  other: ['torrent','magnet'],
};
// Defaults: only video + audio on, matching the previous behaviour.
const DEFAULT_SETTINGS = {
  takeover: true,
  categories: { video: true, audio: true, archive: true, program: true, document: true, model: true, other: true },
  customExt: [],          // e.g. ['psd','sketch']
  minSize: 0,             // only take over files >= this many MB (0 = no limit)
  blacklist: [],          // 域名黑名单：这些站点不嗅探/不接管，如 ['bank.com','example.org']
};
let extSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

// 判断某 URL 的域名是否在黑名单中（匹配该域名及其所有子域名）
function isBlacklisted(url, settings) {
  const list = settings.blacklist || [];
  if (!list.length) return false;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return false; }
  if (!host) return false;
  for (let d of list) {
    d = String(d).trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '').replace(/^\./, '');
    if (!d) continue;
    // 精确匹配域名，或匹配其子域名（bank.com 命中 www.bank.com、pay.bank.com）
    if (host === d || host.endsWith('.' + d)) return true;
  }
  return false;
}

// Build the active extension set from enabled categories + custom list.
function activeExtSet(settings) {
  const set = new Set();
  for (const [cat, on] of Object.entries(settings.categories || {})) {
    if (on) for (const e of CATEGORY_EXT[cat] || []) set.add(e);
  }
  for (const e of settings.customExt || []) {
    const clean = String(e).trim().replace(/^\./, '').toLowerCase();
    if (clean) set.add(clean);
  }
  return set;
}
function extOf(item) {
  const src = (item.filename || item.finalUrl || item.url || '').split(/[?#]/)[0];
  const m = /\.([a-z0-9]{1,12})$/i.exec(src);
  return m ? m[1].toLowerCase() : '';
}
function shouldIntercept(item, settings) {
  if (!settings.takeover) return false;
  const url = item.url || item.finalUrl || '';
  if (!/^https?:/i.test(url)) return false;           // skip blob:, data:, file:
  if (isBlacklisted(url, settings)) return false;     // 黑名单站点不接管
  if (item.byExtensionId) return false;               // downloads from other extensions
  // size gate (Chrome gives fileSize when known; -1/0 = unknown → allow)
  if (settings.minSize > 0 && item.fileSize > 0 && item.fileSize < settings.minSize * 1024 * 1024) return false;

  const mime = (item.mime || '').toLowerCase();
  const cats = settings.categories || {};
  // MIME shortcut for the two media categories (covers extension-less stream URLs)
  if (cats.video && mime.startsWith('video/')) return true;
  if (cats.audio && mime.startsWith('audio/')) return true;
  // otherwise decide purely by extension against the active set
  const ext = extOf(item);
  if (!ext) return false;
  return activeExtSet(settings).has(ext);
}

// ---- load & keep settings in sync ----
function applyStored(r) {
  if (r && typeof r === 'object') {
    if (typeof r.takeover === 'boolean') extSettings.takeover = r.takeover;
    if (r.categories && typeof r.categories === 'object') extSettings.categories = Object.assign({}, DEFAULT_SETTINGS.categories, r.categories);
    if (Array.isArray(r.customExt)) extSettings.customExt = r.customExt;
    if (typeof r.minSize === 'number') extSettings.minSize = r.minSize;
    if (Array.isArray(r.blacklist)) extSettings.blacklist = r.blacklist;
  }
  // 更新勾选状态；若菜单还不存在（Service Worker 被唤醒但 onInstalled 未重跑），
  // update 会回调 lastError，这时重建菜单，避免 "Cannot find menu item" 报错。
  try {
    chrome.contextMenus.update('freedm-toggle', { checked: extSettings.takeover }, () => {
      if (chrome.runtime.lastError) { try { createMenus(); } catch (e) {} }
    });
  } catch (e) {}
}
chrome.storage.local.get(['takeover','categories','customExt','minSize'], applyStored);
chrome.storage.onChanged.addListener((ch) => {
  const patch = {};
  for (const k of ['takeover','categories','customExt','minSize']) if (ch[k]) patch[k] = ch[k].newValue;
  applyStored(patch);
});

if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    try {
      if (!shouldIntercept(item, extSettings)) return;   // let the browser handle it
      // 稳妥地取文件名：优先浏览器给的，其次从 URL 推断，最后兜底，绝不传空
      let fname = '';
      if (item.filename) fname = item.filename.split(/[\\/]/).pop();
      if (!fname) fname = filenameFromUrl(item.finalUrl || item.url);
      if (!fname) fname = 'download';
      // cancel + erase the browser's own download, then send to TDM
      chrome.downloads.cancel(item.id, () => {
        chrome.downloads.erase({ id: item.id }, () => {});
      });
      // figure out the source tab for a Referer hint
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const ref = (tabs[0] && tabs[0].url) || item.referrer || '';
        sendToFreeDM([{
          url: item.finalUrl || item.url,
          filename: fname,
          mime: item.mime, size: item.fileSize > 0 ? item.fileSize : null,
          referer: ref,
        }]);
      });
    } catch (e) { /* on any error, don't block the browser's download */ }
  });
}

// ---- context menu ----
function createMenus() {
  // 先清空再创建，避免重复 id 报错
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'freedm-dl', title: '使用 TDM Fast 下载此链接', contexts: ['link', 'video', 'audio', 'image'] });
    chrome.contextMenus.create({ id: 'freedm-video', title: '使用 TDM Fast 下载此视频（YouTube/X/TikTok等）', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'freedm-all', title: '嗅探本页全部资源到 TDM Fast', contexts: ['page', 'action'] });
    chrome.contextMenus.create({ id: 'freedm-toggle', title: '接管视频/音频下载', type: 'checkbox', checked: extSettings.takeover, contexts: ['action'] });
  });
}
chrome.runtime.onInstalled.addListener(createMenus);
// Service Worker 每次启动也确保菜单存在（MV3 worker 会休眠/重启，onInstalled 不会重跑）
createMenus();
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'freedm-dl') {
    const url = info.linkUrl || info.srcUrl;
    if (url) sendToFreeDM([{ url, filename: filenameFromUrl(url), referer: tab?.url || '' }]);
  } else if (info.menuItemId === 'freedm-video') {
    if (tab && tab.url) sendToFreeDM([{ url: tab.url, filename: sanitize(tab.title || 'video') + '.mp4', kind: 'video-platform', referer: tab.url }]);
    else notify('无法下载', '未获取到当前页面地址。');
  } else if (info.menuItemId === 'freedm-all') {
    const map = tabResources.get(tab.id);
    if (map && map.size) sendToFreeDM([...map.values()]);
    else notify('未发现资源', '当前页面还没有嗅探到可下载资源。');
  } else if (info.menuItemId === 'freedm-toggle') {
    extSettings.takeover = info.checked;
    chrome.storage.local.set({ takeover: info.checked });
    notify('TDM', info.checked ? '已开启：视频/音频将自动用 TDM Fast 下载' : '已关闭：下载交回浏览器');
  }
});

async function sendToFreeDM(items) {
  // attach a referer header hint so protected media downloads succeed
  const payload = items.map((it) => ({
    url: it.url, filename: it.filename, kind: it.kind, mime: it.mime, size: it.size,
    headers: it.referer ? { Referer: it.referer } : undefined,
  }));
  try {
    const res = await fetch(FREEDM_ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload.length === 1 ? payload[0] : { items: payload }),
    });
    if (!res.ok) throw new Error('bad status');
    notify('已发送到 TDM Fast', payload.length === 1 ? payload[0].filename : payload.length + ' 个资源');
  } catch (e) {
    notify('发送失败', '请确认 TDM Fast 下载器正在运行（端口 37651）。');
  }
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/48.png', title, message });
}
