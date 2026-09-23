'use strict';
// Detects media the network sniffer can't see: <video>/<audio> with direct
// src, <source> children, and MSE/blob streams. Reports to the background worker.
(function () {
  const seen = new Set();

  function report(items) {
    if (!items.length) return;
    try { chrome.runtime.sendMessage({ type: 'domMedia', items, tabId: null }); } catch (e) {}
  }

  // Inject the page-context hook (fetch/XHR/MSE manifest discovery)
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {}

  // Receive manifest URLs discovered by the page hook
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || !ev.data.__freedm) return;
    const u = ev.data.url;
    if (!u || seen.has(u)) return;
    seen.add(u);
    report([{ url: u, mime: ev.data.mime || '', title: document.title, pageUrl: location.href }]);
  });

  function scan() {
    const items = [];
    const pageUrl = location.href;
    const title = document.title;
    document.querySelectorAll('video, audio').forEach((el) => {
      const urls = [];
      if (el.src) urls.push(el.src);
      el.querySelectorAll('source').forEach((s) => { if (s.src) urls.push(s.src); });
      // currentSrc catches what the browser actually resolved
      if (el.currentSrc) urls.push(el.currentSrc);
      for (const u of urls) {
        if (!u || seen.has(u)) continue;
        seen.add(u);
        items.push({ url: u, mime: el.getAttribute('type') || '', title, pageUrl, isBlob: u.startsWith('blob:') });
      }
    });
    report(items);
  }

  // ---- SPA route detection ----
  // X/YouTube/Reddit change routes with pushState/replaceState. The background
  // worker's webNavigation listeners are unreliable for these, so watch the URL
  // from inside the page and report changes directly. This is what actually
  // clears the previous video's entry when clicking through posts.
  let lastHref = location.href;
  function notifyUrlChange() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    seen.clear(); // media found on the previous route is no longer relevant
    try {
      chrome.runtime.sendMessage({
        type: 'spaNavigate', url: location.href, title: document.title,
      });
    } catch (e) {}
    setTimeout(scan, 800); // let the new route render its player
  }

  // Patch history so we hear about programmatic navigation.
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    if (typeof orig === 'function') {
      history[fn] = function () {
        const r = orig.apply(this, arguments);
        setTimeout(notifyUrlChange, 0);
        return r;
      };
    }
  }
  window.addEventListener('popstate', () => setTimeout(notifyUrlChange, 0));
  window.addEventListener('hashchange', () => setTimeout(notifyUrlChange, 0));
  // Poll as a final safety net: some frameworks bypass the History API.
  setInterval(notifyUrlChange, 700);

  // The document title often lands after the route change; report it once it
  // settles so the filename isn't the stale "(21) 主页 X".
  let lastTitle = document.title;
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(() => {
      if (document.title === lastTitle) return;
      lastTitle = document.title;
      try {
        chrome.runtime.sendMessage({
          type: 'titleUpdate', url: location.href, title: document.title,
        });
      } catch (e) {}
    }).observe(titleEl, { childList: true });
  }

  // ============================================================
  // IDM-style floating "download this video" button.
  // Shows in the top-right corner of any <video> on hover.
  // Only in the top frame — injecting into every iframe would spawn
  // duplicate/misplaced buttons and can't position against the main viewport.
  // ============================================================
  if (window.top === window.self) {
  const OVERLAY_ID = 'freedm-video-overlay';
  let overlayEl = null;
  let overlayTarget = null;   // the <video> the button currently belongs to
  let hideTimer = null;
  let lastCursor = { x: NaN, y: NaN };   // last known cursor pos (for post resolution)
  let overlayCursor = { x: NaN, y: NaN }; // cursor pos when overlay was last shown
  const DEBUG = false;                    // set true to trace URL resolution in console
  function log(...args) { if (DEBUG) try { console.log('[TDM]', ...args); } catch (e) {} }

  function isDownloadableVideo(v) {
    if (!(v instanceof HTMLVideoElement)) return false;
    const r = v.getBoundingClientRect();
    // ignore tiny/hidden players (ads pixels, 0-size autoplay probes)
    if (r.width < 120 || r.height < 80) return false;
    if (v.readyState === 0 && !v.currentSrc && !v.querySelector('source')) return false;
    return true;
  }

  function buildOverlay() {
    if (overlayEl) return overlayEl;
    const el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.innerHTML = `
      <button type="button" class="freedm-dl-btn" title="使用 TDM 下载此视频">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M12 3v10.5M12 13.5l-4-4M12 13.5l4-4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M5 19h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
        </svg>
        <span>下载该视频</span>
      </button>`;
    // inline styles so no external CSS is needed and page styles can't bleed in
    const s = el.style;
    s.position = 'fixed';
    s.zIndex = '2147483647';
    s.display = 'none';
    s.pointerEvents = 'auto';
    const btn = el.querySelector('.freedm-dl-btn');
    Object.assign(btn.style, {
      display: 'flex', alignItems: 'center', gap: '6px',
      padding: '7px 12px', border: 'none', borderRadius: '8px',
      background: 'linear-gradient(135deg,#2f7be0,#1e5fc0)', color: '#fff',
      font: '600 13px/1 "Microsoft YaHei",system-ui,sans-serif', cursor: 'pointer',
      boxShadow: '0 4px 14px rgba(0,0,0,.35)', whiteSpace: 'nowrap',
      transition: 'transform .12s, box-shadow .12s',
    });
    btn.onmouseenter = () => { btn.style.transform = 'translateY(-1px)'; btn.style.boxShadow = '0 6px 18px rgba(0,0,0,.45)'; };
    btn.onmouseleave = () => { btn.style.transform = 'none'; btn.style.boxShadow = '0 4px 14px rgba(0,0,0,.35)'; };
    btn.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      triggerDownload(overlayTarget);
      btn.querySelector('span').textContent = '已发送 ✓';
      setTimeout(() => { if (btn.querySelector('span')) btn.querySelector('span').textContent = '下载该视频'; }, 1800);
    };
    // keep visible while hovering the button itself
    el.onmouseenter = () => { clearTimeout(hideTimer); };
    el.onmouseleave = () => scheduleHide();
    (document.body || document.documentElement).appendChild(el);
    overlayEl = el;
    return el;
  }

  function positionOverlay(video) {
    const el = buildOverlay();
    const r = video.getBoundingClientRect();
    el.style.display = 'block';
    el.style.top = Math.max(6, r.top + 10) + 'px';
    // right-align inside the video, clamped to viewport
    const w = el.offsetWidth || 130;
    el.style.left = Math.min(window.innerWidth - w - 6, r.right - w - 10) + 'px';
  }

  function showOverlayFor(video) {
    if (!isDownloadableVideo(video)) return;
    clearTimeout(hideTimer);
    overlayTarget = video;
    positionOverlay(video);
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (overlayEl) overlayEl.style.display = 'none'; }, 600);
  }

  // In a feed (x.com/home, a profile, search results...) one page holds many
  // videos, so location.href is NOT the video's URL. Find the specific post's
  // permalink for the clicked video so yt-dlp gets a status/watch URL, not "/home".
  function isPermalinkPage() {
    return /\/status\/\d+/.test(location.pathname) ||       // x / twitter
      /\/watch\b/.test(location.pathname) ||                 // youtube /watch
      location.pathname.startsWith('/shorts/') ||            // youtube shorts
      /\/video\//.test(location.pathname) ||                 // tiktok, reddit
      /\/(p|reel|tv)\//.test(location.pathname);             // instagram
  }

  // From a tweet <article>, get the canonical status URL. The most reliable
  // anchor is the timestamp: a <time> element wrapped in an <a href=".../status/N">.
  function statusUrlFromArticle(article) {
    if (!article) return null;
    // 1) timestamp link (points to THIS tweet, never a quoted/reply one)
    const timeA = article.querySelector('a[href*="/status/"] time');
    if (timeA) {
      const a = timeA.closest('a[href*="/status/"]');
      const m = a && a.getAttribute('href').match(/\/[^/]+\/status\/\d+/);
      if (m) return location.origin + m[0];
    }
    // 2) any status link that is NOT inside a quoted tweet (role="link" nested block)
    const links = [...article.querySelectorAll('a[href*="/status/"]')];
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (/\/analytics$|\/likes$|\/retweets$|\/quotes$/.test(href)) continue; // skip metric links
      const m = href.match(/\/[^/]+\/status\/\d+/);
      if (m) return location.origin + m[0];
    }
    return null;
  }

  function resolvePostUrl(video, clientX, clientY) {
    if (isPermalinkPage()) return location.href;

    const host = location.hostname.replace(/^www\./, '');
    const isX = /(^|\.)x\.com$/.test(host) || /twitter\.com$/.test(host);
    const isYT = /youtube\.com$/.test(host) || /youtu\.be$/.test(host);

    if (isX) {
      // Strategy A: the <article> that contains the video element.
      let art = video && video.closest && video.closest('article');
      let url = statusUrlFromArticle(art);
      if (url) { log('resolved via video article:', url); return url; }

      // Strategy B: the <article> under the cursor position (covers cases where
      // the video sits in an overlay/portal outside the article subtree).
      if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
        const stack = document.elementsFromPoint(clientX, clientY);
        for (const el of stack) {
          const a2 = el.closest && el.closest('article');
          url = statusUrlFromArticle(a2);
          if (url) { log('resolved via cursor article:', url); return url; }
        }
      }

      // Strategy C: nearest article by vertical position to the video.
      if (video) {
        const vr = video.getBoundingClientRect();
        let best = null, bestDist = Infinity;
        for (const a of document.querySelectorAll('article')) {
          const r = a.getBoundingClientRect();
          if (r.height === 0) continue;
          const overlap = !(vr.bottom < r.top || vr.top > r.bottom);
          const dist = overlap ? 0 : Math.min(Math.abs(vr.top - r.top), Math.abs(vr.top - r.bottom));
          if (dist < bestDist) { bestDist = dist; best = a; }
        }
        url = statusUrlFromArticle(best);
        if (url) { log('resolved via nearest article:', url); return url; }
      }
      log('X: could not resolve a status URL, falling back to page URL');
    }

    if (isYT && video) {
      const cont = video.closest('ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-video-renderer, ytd-grid-video-renderer');
      const a = cont && cont.querySelector('a#thumbnail[href*="watch"], a[href*="/watch?v="], a[href*="/shorts/"]');
      if (a) {
        const href = a.getAttribute('href');
        return href.startsWith('http') ? href : location.origin + href;
      }
    }

    // TikTok：从最近的 data-video-id 属性或嵌入代码(blockquote.tiktok-embed cite)
    // 提取具体视频链接。TikTok 的 feed/foryou 页 URL 不含视频ID，必须这样取。
    const isTT = /tiktok\.com$/.test(host);
    if (isTT) {
      // 1) 从视频元素向上找带 data-video-id 的容器
      if (video) {
        let p = video;
        for (let d = 0; p && d < 25; d++, p = p.parentElement) {
          if (!p.getAttribute) continue;
          const vid = p.getAttribute('data-video-id') || p.getAttribute('data-e2e-video-id')
            || p.getAttribute('data-scroll-index-id') || p.id && (/(\d{15,})/.exec(p.id)||[])[1];
          if (vid && /^\d{10,}$/.test(vid)) {
            const a = p.querySelector && p.querySelector('a[href*="/@"]');
            const m = a && /\/@([\w.-]+)/.exec(a.getAttribute('href') || '');
            const author = (m && m[1]) || 'user';
            return 'https://www.tiktok.com/@' + author + '/video/' + vid;
          }
        }
      }
      // 2) 页面 canonical / og:url（TikTok 视频页几乎都有，最可靠）
      const canon = document.querySelector('link[rel="canonical"]');
      const ogurl = document.querySelector('meta[property="og:url"]');
      for (const cand of [canon && canon.href, ogurl && ogurl.content]) {
        const cm = cand && /\/@([\w.-]+)\/video\/(\d+)/.exec(cand);
        if (cm) return 'https://www.tiktok.com/@' + cm[1] + '/video/' + cm[2];
      }
      // 3) tiktok-embed 嵌入块（cite 或 data-video-id）
      const bq = document.querySelector('blockquote.tiktok-embed[cite], blockquote.tiktok-embed[data-video-id]');
      if (bq) {
        const cm = /\/@([\w.-]+)\/video\/(\d+)/.exec(bq.getAttribute('cite') || '');
        if (cm) return 'https://www.tiktok.com/@' + cm[1] + '/video/' + cm[2];
        const vid = bq.getAttribute('data-video-id');
        if (vid && /^\d+$/.test(vid)) return 'https://www.tiktok.com/@user/video/' + vid;
      }
      // 4) 页面里任意 /@user/video/id 链接
      for (const link of document.querySelectorAll('a[href*="/video/"]')) {
        const lm = /\/@([\w.-]+)\/video\/(\d+)/.exec(link.getAttribute('href') || '');
        if (lm) return 'https://www.tiktok.com/@' + lm[1] + '/video/' + lm[2];
      }
    }

    // generic fallback for other platforms
    if (video) {
      let p = video.parentElement;
      for (let d = 0; p && d < 20; d++, p = p.parentElement) {
        const a = p.querySelector && p.querySelector('a[href*="/status/"],a[href*="/watch?v="],a[href*="/video/"],a[href*="/shorts/"]');
        if (a) {
          const href = a.getAttribute('href');
          const full = href.startsWith('http') ? href : location.origin + href;
          return full.split('?')[0];
        }
      }
    }
    return location.href; // give up → page URL (correct on permalink pages)
  }

  function triggerDownload(video) {
    // Prefer the post's own URL for known video platforms (yt-dlp handles them);
    // otherwise send the direct media src.
    const host = location.hostname.replace(/^www\./, '');
    const isPlatform = /(youtube\.com|youtu\.be|x\.com|twitter\.com|tiktok\.com|reddit\.com|bilibili\.com|vimeo\.com|twitch\.tv|facebook\.com|instagram\.com)/i.test(host);
    // Use the video's own centre as the hit-test point — by click time the cursor
    // is on the button, not the video, so the recorded cursor may be stale.
    let px = overlayCursor.x, py = overlayCursor.y;
    if (video) {
      const r = video.getBoundingClientRect();
      if (r.width && r.height) { px = r.left + r.width / 2; py = r.top + r.height / 2; }
    }
    let payload;
    if (isPlatform) {
      const postUrl = resolvePostUrl(video, px, py);
      payload = { url: postUrl, kind: 'video-platform', filename: (document.title || 'video') + '.mp4' };
    } else {
      const src = (video && (video.currentSrc || video.src)) ||
        (video && video.querySelector('source') && video.querySelector('source').src) || '';
      if (!src || src.startsWith('blob:')) {
        const postUrl = resolvePostUrl(video, px, py);
        payload = { url: postUrl, kind: 'video-platform', filename: (document.title || 'video') + '.mp4' };
      } else {
        payload = { url: src, kind: null };
      }
    }
    log('triggerDownload ->', payload.url);
    try { chrome.runtime.sendMessage({ type: 'send', items: [payload] }); } catch (e) {}
  }

  // The big fix: X/YouTube layer transparent control/click-catcher elements ON
  // TOP of <video>, so mouseenter never reaches the video and the button never
  // showed. Instead, hit-test on document-level mousemove: find the largest
  // video whose box contains the cursor, regardless of what's stacked above it.
  let allVideos = [];
  function refreshVideoList() {
    allVideos = [...document.querySelectorAll('video')].filter(isDownloadableVideo);
  }
  function videoUnderPoint(x, y) {
    let best = null, bestArea = 0;
    for (const v of allVideos) {
      const r = v.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const area = r.width * r.height;
        if (area > bestArea) { bestArea = area; best = v; }
      }
    }
    return best;
  }

  let lastMove = 0;
  document.addEventListener('mousemove', (e) => {
    lastCursor = { x: e.clientX, y: e.clientY };  // always track (used to resolve the post)
    const now = Date.now();
    if (now - lastMove < 60) return;   // throttle
    lastMove = now;
    const v = videoUnderPoint(e.clientX, e.clientY);
    if (v) {
      overlayCursor = { x: e.clientX, y: e.clientY }; // where the button was shown
      showOverlayFor(v);
    } else if (overlayEl && overlayEl.style.display !== 'none') {
      // don't hide if the cursor is over the button itself
      const o = overlayEl.getBoundingClientRect();
      const onBtn = e.clientX >= o.left && e.clientX <= o.right && e.clientY >= o.top && e.clientY <= o.bottom;
      if (!onBtn) scheduleHide();
    }
  }, true);

  function wireVideos() { refreshVideoList(); }
  // reposition while scrolling/resizing so the button tracks the video
  window.addEventListener('scroll', () => { if (overlayEl && overlayEl.style.display !== 'none' && overlayTarget) positionOverlay(overlayTarget); }, true);
  window.addEventListener('resize', () => { refreshVideoList(); if (overlayEl && overlayEl.style.display !== 'none' && overlayTarget) positionOverlay(overlayTarget); });
  // keep the video list fresh as players load/unload
  setInterval(refreshVideoList, 2000);
  refreshVideoList();
  } // end top-frame-only overlay block

  const obs = new MutationObserver(() => { clearTimeout(obs._t); obs._t = setTimeout(() => { scan(); }, 600); });
  if (document.body) obs.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => { scan(); });
  window.addEventListener('load', () => { scan(); });
  setTimeout(() => { scan(); }, 1500);
  setInterval(() => { scan(); }, 5000);
})();
