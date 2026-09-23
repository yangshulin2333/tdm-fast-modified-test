'use strict';
// Runs in the PAGE context (not the isolated content-script world) so it can
// hook fetch / XHR / MSE / <video>. Modern players load HLS/DASH manifests or
// media via JS and often leave only a blob: URL on the <video>. By watching the
// actual network calls the player makes, we surface the real media URL.
(function () {
  const MEDIA_URL = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|flv|avi|ts|m4s|m4a|mp3|aac|ogg|wav|opus)(\?|$)/i;
  const MEDIA_MIME = /(mpegurl|dash\+xml|video\/|audio\/)/i;
  const seen = new Set();

  const post = (url, mime) => {
    try {
      if (!url || typeof url !== 'string') return;
      if (url.startsWith('blob:') || url.startsWith('data:')) return;
      const isMedia = MEDIA_URL.test(url) || MEDIA_MIME.test(mime || '');
      if (!isMedia) return;
      if (/\.(ts|m4s)(\?|$)/i.test(url)) return;   // 分片太吵，不逐个报
      if (seen.has(url)) return;
      seen.add(url);
      window.postMessage({ __freedm: true, url: String(url), mime: mime || '' }, '*');
    } catch (e) {}
  };

  // 1) hook fetch（含响应 content-type 补判）
  const _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      let u;
      try { u = typeof input === 'string' ? input : (input && input.url); post(u); } catch (e) {}
      return _fetch.apply(this, arguments).then((resp) => {
        try {
          const ct = resp.headers && resp.headers.get && resp.headers.get('content-type');
          if (ct && MEDIA_MIME.test(ct)) post(resp.url || u, ct);
        } catch (e) {}
        return resp;
      });
    };
  }

  // 2) hook XHR（open 拿 URL；load 后拿 content-type）
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__freedmUrl = url;
      post(url);
      this.addEventListener('load', function () {
        try {
          const ct = this.getResponseHeader && this.getResponseHeader('content-type');
          if (ct && MEDIA_MIME.test(ct)) post(this.__freedmUrl, ct);
        } catch (e) {}
      });
    } catch (e) {}
    return _open.apply(this, arguments);
  };

  // 3) 扫描 <video>/<audio> 的真实 src（有些直接设直链）
  function scanMediaEl(el) {
    try {
      const src = el.currentSrc || el.src || '';
      if (src && !src.startsWith('blob:')) post(src);
      el.querySelectorAll && el.querySelectorAll('source').forEach((s) => {
        const ss = s.src || s.getAttribute('src') || '';
        if (ss) post(ss, s.type || '');
      });
    } catch (e) {}
  }
  function scanAll() { try { document.querySelectorAll('video, audio').forEach(scanMediaEl); } catch (e) {} }
  let scans = 0;
  const iv = setInterval(() => { scanAll(); if (++scans > 15) { clearInterval(iv); setInterval(scanAll, 5000); } }, 2000);
  if (document.readyState !== 'loading') scanAll();
  else document.addEventListener('DOMContentLoaded', scanAll);

  // 4) MutationObserver：动态插入的播放器立即扫
  try {
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'VIDEO' || n.tagName === 'AUDIO') scanMediaEl(n);
        else if (n.querySelectorAll) n.querySelectorAll('video, audio').forEach(scanMediaEl);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
})();
