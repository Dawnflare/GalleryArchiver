/* Content script (debug build): robust video inline + card clone to detach React before MHTML */

(() => {
  const DEBUG = true; // set to false to silence logs

  const log = (...args) => { if (DEBUG) console.log('[Archiver]', ...args); };
  const warn = (...args) => console.warn('[Archiver]', ...args);

  const state = {
    running: false,
    seen: 0,
    captured: 0,
    deduped: 0,
    maxItems: 100,
    scrollDelay: 300,
    stabilityTimeout: 400,
    items: new Map(),
    seenDetailUrls: new Set(),
    allImageUrls: new Set(),
    observer: null,
    scrollTimer: null,
    lastNewItemAt: 0,
    bucket: null,
    scrollEl: null,
    origHtmlStyle: '',
    origBodyStyle: '',
  };

  const SEL_ANCHOR_IMG = 'a[href*="/images/"] img, a[href^="/images/"] img';
  const SEL_ANCHOR_BG = 'a[href*="/images/"], a[href^="/images/"]';
  const SEL_ANY_VIDEO = 'video'; // see getCardAnchor()

  function absUrl(href) {
    try { return new URL(href, location.origin).toString(); } catch { return href; }
  }

  function getCardAnchor(el) {
    // Walk up the tree a few levels and look for an /images/ detail link
    let n = el;
    for (let d = 0; n && d < 7; d++) {
      const a = n.querySelector && n.querySelector('a[href*="/images/"], a[href^="/images/"]');
      if (a) return a;
      n = n.parentElement;
    }
    // Fallback: sibling search
    const p = el.parentElement;
    if (p) {
      const a = p.querySelector && p.querySelector('a[href*="/images/"], a[href^="/images/"]');
      if (a) return a;
    }
    return null;
  }

  function getCardRoot(el) {
    // Try to find a stable element to clone/replace so React won't re-render our <video>
    const isCardish = (x) => {
      if (!x || !x.className) return false;
      const c = String(x.className);
      return /mantine-|Card|card|group|grid|stack/i.test(c);
    };
    let n = el;
    for (let d = 0; n && d < 7; d++) {
      if (isCardish(n)) return n;
      n = n.parentElement;
    }
    return el.parentElement || el; // fallback
  }

  function ensureBucket() {
    if (!state.bucket) {
      const bucket = document.createElement('div');
      bucket.id = 'civitai-archiver-bucket';
      bucket.style.display = 'none';
      document.body.appendChild(bucket);
      state.bucket = bucket;
    }
  }

  function postStats() {
    chrome.runtime.sendMessage({
      type: 'ARCHIVER_STATS',
      seen: state.seen,
      captured: state.captured,
      deduped: state.deduped,
      total: state.allImageUrls.size
    });
  }
  function postState() {
    chrome.runtime.sendMessage({
      type: 'ARCHIVER_STATE',
      running: state.running,
      captured: state.captured,
      maxItems: state.maxItems
    });
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onloadend = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }
  async function fetchAsDataURLWithType(url) {
    const r = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
    if (!r.ok) throw new Error(`fetch failed ${r.status}`);
    const b = await r.blob();
    const dataUrl = await blobToDataURL(b);
    return { dataUrl, mime: b.type || '' };
  }
  function findPreferredVideoSource(videoEl) {
    const sources = [...videoEl.querySelectorAll('source')];
    const byType = (t) => sources.find(s => (s.type || '').toLowerCase() === t)?.src;
    const byExt  = (re) => sources.map(s => s.src).find(u => re.test(u || ''));
    return (
      byType('video/webm') || byExt(/\.webm($|\?)/i) ||
      byType('video/mp4')  || byExt(/\.mp4($|\?)/i)  ||
      videoEl.currentSrc || videoEl.src || null
    );
  }

  function pickBestFromSrcset(img) {
    const ss = img.getAttribute('srcset');
    if (!ss) return img.currentSrc || img.src || null;
    const candidates = ss.split(',').map(s => s.trim()).map(token => {
      const m = token.match(/^(.*)\s+(\d+)(w|x)$/);
      if (m) return { url: absUrl(m[1].trim()), width: parseInt(m[2], 10), unit: m[3] };
      return { url: absUrl(token.split(/\s+/)[0]), width: 0, unit: 'w' };
    });
    candidates.sort((a,b) => b.width - a.width);
    return (candidates[0] && candidates[0].url) || img.currentSrc || img.src || null;
  }
  function finalizeIfGood(imgEl) {
    return new Promise((resolve) => {
      const done = () => resolve(true);
      if (imgEl.complete && imgEl.naturalWidth > 0) return done();
      imgEl.addEventListener('load', done, { once: true });
      imgEl.addEventListener('error', () => resolve(false), { once: true });
    });
  }
  function stabilityWatcher(targetEl, timeoutMs, onStable) {
    let timer = null;
    const mo = new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        mo.disconnect();
        onStable();
      }, timeoutMs);
    });
    mo.observe(targetEl, { attributes: true, attributeFilter: ['src', 'srcset', 'style', 'class'] });
    timer = setTimeout(() => { mo.disconnect(); onStable(); }, timeoutMs);
  }

  function processAnchorImg(anchor, img) {
    if (!state.running || state.captured >= state.maxItems) return;
    const detailUrl = absUrl(anchor.getAttribute('href') || '');
    if (!detailUrl) return;
    if (state.seenDetailUrls.has(detailUrl)) return;
    state.seenDetailUrls.add(detailUrl);
    state.seen++;

    const initialUrl = pickBestFromSrcset(img) || img.src || '';
    stabilityWatcher(img, state.stabilityTimeout, async () => {
      if (!state.running || state.captured >= state.maxItems) return;
      const bestNow = pickBestFromSrcset(img) || img.src || initialUrl;
      if (!bestNow) return;

      const cloneImg = document.createElement('img');
      cloneImg.src = bestNow;
      ensureBucket();
      state.bucket.appendChild(cloneImg);
      const ok = await finalizeIfGood(cloneImg);
      if (!ok || !state.running) { cloneImg.remove(); return; }

      state.captured++;
      state.deduped = state.seenDetailUrls.size;
      state.lastNewItemAt = performance.now();
      state.allImageUrls.add(absUrl(bestNow));
      postStats(); postState();
      if (state.captured >= state.maxItems) stopRunning(false, false);
    });
    postStats();
  }

  function scanOnce() {
    if (!state.running || state.captured >= state.maxItems) return;
    ensureBucket();

    document.querySelectorAll(SEL_ANCHOR_IMG).forEach(img => {
      if (state.captured >= state.maxItems) return;
      const a = img.closest('a');
      if (a) processAnchorImg(a, img);
    });

    document.querySelectorAll(SEL_ANCHOR_BG).forEach(a => {
      if (state.captured >= state.maxItems) return;
      const style = getComputedStyle(a);
      const bg = style.backgroundImage;
      if (bg && bg !== 'none') {
        const m = bg.match(/url\([\"']?(.*?)[\"']?\)/);
        if (m && m[1]) {
          const url = absUrl(m[1]);
          const detailUrl = absUrl(a.getAttribute('href') || '');
          if (!detailUrl || state.seenDetailUrls.has(detailUrl)) return;
          if (state.captured >= state.maxItems) return;
          state.seenDetailUrls.add(detailUrl);
          state.seen++;

          stabilityWatcher(a, state.stabilityTimeout, async () => {
            if (!state.running || state.captured >= state.maxItems) return;
            const cloneImg = document.createElement('img');
            cloneImg.src = url;
            ensureBucket();
            state.bucket.appendChild(cloneImg);
            const ok = await finalizeIfGood(cloneImg);
            if (!ok || !state.running) { cloneImg.remove(); return; }
            state.captured++;
            state.deduped = state.seenDetailUrls.size;
            state.lastNewItemAt = performance.now();
            state.allImageUrls.add(absUrl(url));
            postStats(); postState();
            if (state.captured >= state.maxItems) stopRunning(false, false);
          });
          postStats();
        }
      }
    });
  }

  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(() => {
      if (!state.running || state.captured >= state.maxItems) return;
      scanOnce();
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  }

  function getScrollElement() {
    for (const sel of ['#__next', '#app', 'main']) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight) return el;
    }
    return document.scrollingElement || document.documentElement || document.body;
  }

  async function autoScrollLoop() {
    const scrollEl = state.scrollEl || (state.scrollEl = getScrollElement());
    state.lastNewItemAt = performance.now();
    while (state.running) {
      const before = state.captured;
      scrollEl.scrollBy(0, scrollEl.clientHeight * 0.9);
      await new Promise(r => setTimeout(r, state.scrollDelay));
      if (!state.running) break;
      scanOnce();
      if (!state.running) break;
      const now = performance.now();
      if (state.captured > before) state.lastNewItemAt = now;
      else if (now - state.lastNewItemAt > 6000) {
        scrollEl.scrollBy(0, 50);
        await new Promise(r => setTimeout(r, state.scrollDelay));
        if (!state.running) break;
        scanOnce();
      }
    }
  }

  function applyScrollStyles() {
    document.documentElement.style.height = 'auto';
    document.documentElement.style.overflowY = 'auto';
    document.body.style.height = 'auto';
    document.body.style.overflowY = 'auto';
  }

  function restoreScrollStyles() {
    document.documentElement.setAttribute('style', state.origHtmlStyle);
    document.body.setAttribute('style', state.origBodyStyle);
  }

  function freezePage() {
    ensureBucket();
    restoreScrollStyles();
    state.bucket.style.display = 'none';
  }

  async function inlineSingleVideoBinary(videoEl, { inlinePoster = true } = {}) {
    try {
      const a = getCardAnchor(videoEl);
      if (!a) {
        log('skip video (no /images/ anchor nearby)');
        return { ok: false, reason: 'no-anchor' };
      }
      const srcUrl = findPreferredVideoSource(videoEl);
      if (!srcUrl) {
        log('skip video (no src found)');
        return { ok: false, reason: 'no-src' };
      }
      const { dataUrl, mime } = await fetchAsDataURLWithType(srcUrl);
      const posterUrl = videoEl.poster || '';

      // Build replacement <video>
      const nv = document.createElement('video');
      nv.setAttribute('playsinline', '');
      nv.setAttribute('preload', 'auto');
      nv.setAttribute('muted', '');
      nv.setAttribute('autoplay', '');
      nv.setAttribute('loop', '');
      nv.muted = true; nv.autoplay = true; nv.loop = true; nv.playsInline = true;

      if (videoEl.getAttribute('style')) nv.setAttribute('style', videoEl.getAttribute('style'));
      if (videoEl.className) nv.className = videoEl.className;

      // Inline poster if possible
      if (posterUrl) {
        try {
          const { dataUrl: posterData } = await fetchAsDataURLWithType(posterUrl);
          nv.setAttribute('poster', posterData);
        } catch {
          nv.setAttribute('poster', posterUrl);
        }
      }

      nv.src = dataUrl;

      // Replace element and clone the card root to detach React reconciliation
      const card = getCardRoot(videoEl);
      videoEl.replaceWith(nv);
      const clone = card.cloneNode(true);
      card.replaceWith(clone);

      // Visual cue (only live page)
      try {
        nv.style.outline = '2px solid #00FFFF';
        setTimeout(() => { nv.style.outline = ''; }, 800);
        nv.load(); const p = nv.play(); if (p && p.catch) p.catch(()=>{});
      } catch { /* noop */ }

      log('inlined video:', { mime, len: dataUrl.length, anchor: a.href.slice(0,60) + '…' });
      return { ok: true };
    } catch (err) {
      warn('inlineSingleVideoBinary failed', err);
      return { ok: false, reason: String(err) };
    }
  }

  async function inlineVideosForSnapshot(maxConcurrent = 3) {
    const candidates = [...document.querySelectorAll(SEL_ANY_VIDEO)];
    const videos = candidates.filter(v => !!getCardAnchor(v));
    log('prepare: videos candidates:', candidates.length, 'kept:', videos.length);

    let i = 0, inlined = 0, failed = 0;
    async function worker() {
      while (i < videos.length) {
        const v = videos[i++];
        const res = await inlineSingleVideoBinary(v, { inlinePoster: true });
        if (res.ok) inlined++; else failed++;
      }
    }
    await Promise.all(Array(Math.min(maxConcurrent, videos.length)).fill(0).map(() => worker()));
    log('prepare: done', { total: videos.length, inlined, failed });
    return { total: videos.length, inlined, failed };
  }

  async function startRunning() {
    if (state.running) return;
    state.running = true;
    state.seen = 0;
    state.captured = 0;
    state.deduped = 0;
    state.seenDetailUrls.clear();
    state.allImageUrls = new Set();
    const opts = await new Promise(resolve => {
      chrome.storage.local.get({ maxItems: 100, scrollDelay: 300, stabilityTimeout: 400 }, resolve);
    });
    state.maxItems = parseInt(opts.maxItems, 10) || 100;
    state.scrollDelay = parseInt(opts.scrollDelay, 10) || 300;
    state.stabilityTimeout = parseInt(opts.stabilityTimeout, 10) || 400;

    document.querySelectorAll('img').forEach(img => {
      const url = pickBestFromSrcset(img) || img.currentSrc || img.src;
      if (url) state.allImageUrls.add(absUrl(url));
    });
    postStats(); postState();
    ensureBucket();
    startObserver();
    state.scrollEl = (document.scrollingElement || document.documentElement || document.body);
    state.scrollEl.scrollTo(0, 0);
    scanOnce();
    state.origHtmlStyle = document.documentElement.getAttribute('style') || '';
    state.origBodyStyle = document.body.getAttribute('style') || '';
    document.documentElement.style.overflowY = 'auto';
    document.body.style.overflowY = 'auto';
    autoScrollLoop();
  }

  function stopRunning(freeze=false, restoreStyles=true) {
    state.running = false;
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    if (state.scrollTimer) { clearTimeout(state.scrollTimer); state.scrollTimer = null; }
    state.scrollEl = null;
    if (freeze) freezePage();
    else if (restoreStyles) {
      restoreScrollStyles();
      if (state.bucket) { state.bucket.remove(); state.bucket = null; }
    }
    postState();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'ARCHIVER_START') startRunning();
    if (msg?.type === 'ARCHIVER_STOP') stopRunning(true);
    if (msg?.type === 'ARCHIVER_RESET') { stopRunning(false); sendResponse(); }
    if (msg?.type === 'ARCHIVER_PREPARE_FOR_SAVE') {
      inlineVideosForSnapshot(4)
        .then(stats => {
          log('prepare stats:', stats);
          // Short settle to ensure DOM mutations are committed before snapshot
          setTimeout(() => sendResponse({ ok: true, stats }), 300);
        })
        .catch(err => {
          warn('prepare-for-save failed', err);
          setTimeout(() => sendResponse({ ok: false, error: String(err) }), 300);
        });
      return true;
    }
  });

  // Dev hooks
  window.__archiverInlineVideos = inlineVideosForSnapshot;
  window.__archiverStart = startRunning;
  window.__archiverStop = () => stopRunning(true);
})();
