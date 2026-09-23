'use strict';
function fmtSize(b) {
  if (b == null) return '未知大小';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}
function tagColor(kind) {
  return { hls: '#e91e63', dash: '#9c27b0', 'video-platform': '#d32f2f', http: '#2f7be0' }[kind] || '#2f7be0';
}

let resources = [];
let tabId = null;
// selection is keyed by resource URL so it survives re-renders/refreshes
const selection = new Map(); // url -> boolean
const listEl = document.getElementById('list');

function sig(list) { return list.map((r) => r.url).join('|'); }

function draw() {
  listEl.innerHTML = '';
  if (!resources.length) {
    listEl.innerHTML = '<div class="empty">当前页面暂未嗅探到资源。<br>播放视频、点击下载链接，或等待播放器加载后再看。</div>';
    return;
  }
  resources.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'item';
    const checked = selection.get(r.url) ? 'checked' : '';
    const hint = r.kind === 'video-platform'
      ? '<div class="hintline">整页视频：将通过 yt-dlp 解析并选择清晰度</div>' : '';
    div.innerHTML = `
      <input type="checkbox" data-url="${encodeURIComponent(r.url)}" ${checked}>
      <div class="meta">
        <div class="fn" title="${r.filename}">${r.filename}</div>
        <div class="sub" title="${r.url}">${fmtSize(r.size)} · ${r.url}</div>
        ${hint}
      </div>
      <span class="tag" style="background:${tagColor(r.kind)}22;color:${tagColor(r.kind)}">${r.tag || '文件'}</span>`;
    listEl.appendChild(div);
  });
  // wire checkbox change -> update selection map
  listEl.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.onchange = () => selection.set(decodeURIComponent(cb.dataset.url), cb.checked);
  });
}

function selectedItems() {
  return resources.filter((r) => selection.get(r.url));
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;
  let lastSig = null;
  const load = () => chrome.runtime.sendMessage({ type: 'getResources', tabId }, (resp) => {
    const next = (resp && resp.resources) || [];
    const nextSig = sig(next);
    if (nextSig === lastSig) return; // nothing changed -> don't re-render (preserves UI)
    lastSig = nextSig;
    // default new resources to selected; keep existing choices
    for (const r of next) if (!selection.has(r.url)) selection.set(r.url, true);
    // drop selections for resources no longer present
    const present = new Set(next.map((r) => r.url));
    for (const k of [...selection.keys()]) if (!present.has(k)) selection.delete(k);
    resources = next;
    draw();
  });
  load();
  setInterval(load, 1500); // live-refresh, but only re-renders when list changes

  document.getElementById('send').onclick = () => {
    const items = selectedItems();
    if (!items.length) return;
    chrome.runtime.sendMessage({ type: 'send', items }, () => window.close());
  };
  document.getElementById('selAll').onclick = () => {
    // toggle: if all selected -> deselect all; else select all
    const allSel = resources.length > 0 && resources.every((r) => selection.get(r.url));
    for (const r of resources) selection.set(r.url, !allSel);
    draw();
    document.getElementById('selAll').textContent = allSel ? '全选' : '取消全选';
  };
  document.getElementById('clear').onclick = () => {
    chrome.runtime.sendMessage({ type: 'clear', tabId }, () => { resources = []; selection.clear(); lastSig = null; draw(); });
  };

  // ---- takeover settings panel ----
  const CATEGORY_LABELS = {
    video: '视频', audio: '音频', archive: '压缩包', program: '程序/安装包',
    document: '文档', model: '大模型', other: '种子/磁力',
  };
  const CATEGORY_ORDER = ['video','audio','archive','program','document','model','other'];
  const DEFAULTS = {
    takeover: true,
    categories: { video:true, audio:true, archive:true, program:true, document:true, model:true, other:true },
    customExt: [], minSize: 0, blacklist: [],
  };
  const tk = document.getElementById('takeover');
  const gear = document.getElementById('gear');
  const panel = document.getElementById('settings');
  const catsEl = document.getElementById('cats');
  const customEl = document.getElementById('customExt');
  const minSizeEl = document.getElementById('minSize');
  const blacklistEl = document.getElementById('blacklist');
  const savedEl = document.getElementById('saved');

  // build category checkboxes
  for (const cat of CATEGORY_ORDER) {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.dataset.cat = cat;
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(CATEGORY_LABELS[cat]));
    catsEl.appendChild(lab);
  }

  let saveTimer = null;
  function flashSaved() {
    savedEl.textContent = '✓ 已保存';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { savedEl.textContent = ''; }, 1200);
  }
  function collectAndSave() {
    const categories = {};
    catsEl.querySelectorAll('input[data-cat]').forEach((cb) => { categories[cb.dataset.cat] = cb.checked; });
    const customExt = customEl.value.split(/[,，\s]+/).map((s) => s.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
    const minSize = Math.max(0, parseInt(minSizeEl.value, 10) || 0);
    const blacklist = (blacklistEl ? blacklistEl.value : '').split(/[,，\s\n]+/)
      .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean);
    chrome.storage.local.set({ takeover: tk.checked, categories, customExt, minSize, blacklist }, flashSaved);
  }
  function loadSettings() {
    chrome.storage.local.get(['takeover','categories','customExt','minSize','blacklist'], (r) => {
      tk.checked = (typeof r.takeover === 'boolean') ? r.takeover : DEFAULTS.takeover;
      const cats = Object.assign({}, DEFAULTS.categories, r.categories || {});
      catsEl.querySelectorAll('input[data-cat]').forEach((cb) => { cb.checked = !!cats[cb.dataset.cat]; });
      customEl.value = Array.isArray(r.customExt) ? r.customExt.join(', ') : '';
      minSizeEl.value = (typeof r.minSize === 'number') ? r.minSize : 0;
      if (blacklistEl) blacklistEl.value = Array.isArray(r.blacklist) ? r.blacklist.join(', ') : '';
    });
  }
  loadSettings();

  gear.onclick = () => panel.classList.toggle('open');
  tk.onchange = collectAndSave;
  catsEl.addEventListener('change', collectAndSave);
  customEl.addEventListener('change', collectAndSave);
  minSizeEl.addEventListener('change', collectAndSave);
  if (blacklistEl) blacklistEl.addEventListener('change', collectAndSave);
}
init();
