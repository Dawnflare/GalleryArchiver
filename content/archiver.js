/* Content script: core hoarding, anti-placeholder, auto-scroll, freeze */

(() => {
  const HOST = location.hostname.replace(/^www\./, '');

  function absUrl(href) {
    try { return new URL(href, location.origin).toString(); } catch { return href || ''; }
  }

  function pickBestFromSrcset(img) {
    const ss = img.getAttribute('srcset');
    if (!ss) return img.currentSrc || img.src || null;
    const candidates = ss.split(',').map(s => s.trim()).map(token => {
      const m = token.match(/^(.*)\s+(\d+)(w|x)$/);
      if (m) return { url: absUrl(m[1].trim()), width: parseInt(m[2], 10), unit: m[3] };
      return { url: absUrl(token.split(/\s+/)[0]), width: 0, unit: 'w' };
    });
    candidates.sort((a, b) => b.width - a.width);
    return (candidates[0] && candidates[0].url) || img.currentSrc || img.src || null;
  }

  function resolveImageUrl(img) {
    if (!img) return '';
    const candidates = [];
    const seen = new Set();
    const push = (url) => {
      if (!url) return;
      const resolved = absUrl(url);
      if (!resolved || seen.has(resolved) || isTinyDataURI(resolved)) return;
      seen.add(resolved);
      candidates.push(resolved);
    };

    push(pickBestFromSrcset(img));
    push(img.currentSrc);
    push(img.getAttribute('src'));

    const dataAttrs = [
      'data-src',
      'data-srcset',
      'data-original-src',
      'data-original',
      'data-url',
      'data-image-url',
      'data-full',
      'data-fullsrc',
      'data-img-src',
      'data-img',
      'data-href',
    ];
    dataAttrs.forEach(name => push(img.getAttribute(name)));

    Array.from(img.attributes || []).forEach(attr => {
      if (/^data-(?:src|url)/i.test(attr.name)) push(attr.value);
    });

    const bg = img.style && img.style.backgroundImage;
    if (bg) {
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m) push(m[1]);
    }

    return candidates[0] || '';
  }

  function isTinyDataURI(url) {
    return /^data:/.test(url || '') && (url || '').length < 1024;
  }

  function getGalleryRootCivitai() {
    const g = document.getElementById('gallery');
    if (g) return g;
    const anchors = Array.from(document.querySelectorAll('a[href*="/images/"], a[href^="/images/"]'));
    if (!anchors.length) return document.body;
    const sample = anchors.slice(0, 20);
    const chains = sample.map(a => {
      const list = [];
      for (let n = a; n && n !== document.documentElement; n = n.parentElement) list.push(n);
      return list;
    });
    for (const cand of chains[0] || []) {
      if (chains.every(chain => chain.includes(cand))) return cand;
    }
    return document.getElementById('gallery') || document.body;
  }

  function selectCardsCivitai(root) {
    const set = new Set();
    root.querySelectorAll('a[href*="/images/"] img, a[href^="/images/"] img').forEach(img => {
      const card = img.closest('a[href*="/images/"], a[href^="/images/"]') || img.parentElement;
      if (card) set.add(card);
    });
    root.querySelectorAll('a[href*="/images/"], a[href^="/images/"]').forEach(a => set.add(a));
    return Array.from(set);
  }

  function extractMediaFromCardCivitai(card) {
    const anchorHref = card.getAttribute && card.getAttribute('href');
    const img = card.querySelector('img');
    if (img) {
      return { type: 'image', imgEl: img, href: anchorHref ? absUrl(anchorHref) : null };
    }
    const video = card.querySelector('video');
    if (video) {
      return { type: 'video', videoEl: video, href: anchorHref ? absUrl(anchorHref) : null };
    }
    return null;
  }

  function getGalleryRootTensor() {
    const imgs = Array.from(document.querySelectorAll('article img, div[data-index] img')).slice(0, 40);
    if (!imgs.length) return document.querySelector('main') || document.body;
    const cards = imgs.map(img => img.closest('article, div[data-index], [data-rmiz], .card, .group, .relative, .cursor-pointer'))
      .filter(Boolean);
    if (!cards.length) return document.querySelector('main') || document.body;
    const chains = cards.map(n => {
      const v = [];
      for (let x = n; x && x !== document.documentElement; x = x.parentElement) v.push(x);
      return v;
    });
    for (const cand of chains[0]) {
      if (chains.every(chain => chain.includes(cand))) return cand;
    }
    return document.querySelector('main') || document.body;
  }

  function selectCardsTensor(root) {
    const set = new Set();
    root.querySelectorAll('article img, div[data-index] img').forEach(img => {
      const card = img.closest('article, div[data-index]') || img.parentElement;
      if (card) set.add(card);
    });
    return Array.from(set);
  }

  function extractMediaFromCardTensor(card) {
    const img = card.querySelector('img');
    if (img) return { type: 'image', imgEl: img, href: null };
    const video = card.querySelector('video');
    if (video) return { type: 'video', videoEl: video, href: null };
    return null;
  }

  const adapterCivitai = {
    getGalleryRoot: getGalleryRootCivitai,
    selectCards: selectCardsCivitai,
    extractMediaFromCard: extractMediaFromCardCivitai,
  };

  const adapterTensorArt = {
    getGalleryRoot: getGalleryRootTensor,
    selectCards: selectCardsTensor,
    extractMediaFromCard: extractMediaFromCardTensor,
  };

  const adapters = {
    'civitai.com': adapterCivitai,
    'tensor.art': adapterTensorArt,
  };

  const ACTIVE_ADAPTER = adapters[HOST] || adapterCivitai;

  const state = {
    running: false,
    seen: 0,
    captured: 0,
    deduped: 0,
    maxItems: 200,
    scrollDelay: 300,
    stabilityTimeout: 400,
    items: new Map(),
    allImageUrls: new Set(),
    observer: null,
    scrollTimer: null,
    lastNewItemAt: 0,
    cache: null,
    scrollEl: null,
    origHtmlStyle: '',
    origBodyStyle: '',
    autoSave: false,
    adapter: ACTIVE_ADAPTER,
  };

  function ensureCache() {
    if (!state.cache) {
      const cache = document.createElement('div');
      cache.id = 'archiver-cache';
      cache.style.display = 'none';
      document.body.appendChild(cache);
      state.cache = cache;
    }
  }

  function postStats() {
    chrome.runtime.sendMessage({
      type: 'ARCHIVER_STATS',
      seen: state.seen,
      captured: state.captured,
      deduped: state.deduped,
      total: state.items.size
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

  async function blobToDataURL(blob) {
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => resolve('');
      fr.readAsDataURL(blob);
    });
  }

  async function imageToCanvasDataURL(url) {
    if (!url) return '';
    return await new Promise((resolve) => {
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.decoding = 'sync';
        img.loading = 'eager';
        const cleanup = () => {
          img.onload = null;
          img.onerror = null;
        };
        img.onload = () => {
          try {
            const w = Math.max(1, img.naturalWidth || img.width || 0);
            const h = Math.max(1, img.naturalHeight || img.height || 0);
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/png'));
          } catch (err) {
            console.warn('[Archiver] canvas inline failed', url, err);
            resolve('');
          } finally {
            cleanup();
          }
        };
        img.onerror = () => {
          cleanup();
          resolve('');
        };
        img.src = url;
      } catch (err) {
        console.warn('[Archiver] image load failed', url, err);
        resolve('');
      }
    });
  }

  async function fetchImageAsDataURL(url) {
    if (!url) return '';
    if (url.startsWith('data:')) return url;
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('bad status');
      const blob = await res.blob();
      const type = blob.type || '';
      if (type && !type.startsWith('image/')) throw new Error('not image');
      return await blobToDataURL(blob);
    } catch (err) {
      console.warn('[Archiver] failed to inline image', url, err);
      return await imageToCanvasDataURL(url);
    }
  }

  async function cloneImageToCache(img, { href = null, wrapIfNoHref = false } = {}) {
    const src = resolveImageUrl(img);
    if (!src || isTinyDataURI(src)) return false;
    const dataUrl = await fetchImageAsDataURL(src);
    if (!dataUrl) return false;
    ensureCache();
    const clone = document.createElement('img');
    clone.src = dataUrl;
    clone.alt = img.alt || '';
    clone.loading = 'eager';
    clone.decoding = 'sync';
    let node = clone;
    if (!href && wrapIfNoHref && src) {
      const a = document.createElement('a');
      a.href = src;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.appendChild(clone);
      node = a;
    }
    state.cache.appendChild(node);
    return true;
  }

  async function cloneVideoToCache(video, { href = null, wrapIfNoHref = false } = {}) {
    const poster = absUrl(video.poster || '');
    let dataUrl = poster ? await fetchImageAsDataURL(poster) : '';
    if (!dataUrl) {
      const src = absUrl(video.currentSrc || (video.querySelector('source') && video.querySelector('source').src) || '');
      dataUrl = await fetchImageAsDataURL(src);
    }
    if (!dataUrl) return false;
    ensureCache();
    const clone = document.createElement('img');
    clone.src = dataUrl;
    clone.alt = video.getAttribute('aria-label') || video.getAttribute('title') || '';
    let node = clone;
    if (!href && wrapIfNoHref && (poster || video.currentSrc)) {
      const a = document.createElement('a');
      a.href = poster || video.currentSrc || '';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.appendChild(clone);
      node = a;
    }
    state.cache.appendChild(node);
    return true;
  }

  function keyForMedia(media) {
    if (!media) return null;
    if (media.href) return absUrl(media.href);
    if (media.imgEl) {
      const src = resolveImageUrl(media.imgEl);
      if (src) return src;
    }
    if (media.videoEl) {
      const src = media.videoEl.poster || media.videoEl.currentSrc || (media.videoEl.querySelector('source') && media.videoEl.querySelector('source').src);
      if (src) return absUrl(src);
    }
    return null;
  }

  function processCard(card) {
    if (!state.running || state.captured >= state.maxItems) return;
    const adapter = state.adapter || adapterCivitai;
    const media = adapter.extractMediaFromCard(card);
    if (!media) return;
    const key = keyForMedia(media);
    if (!key || state.items.has(key)) return;

    state.items.set(key, { type: media.type, status: 'pending' });
    state.seen++;
    state.deduped = state.items.size;
    postStats();

    const wrapIfNoHref = !media.href;
    const href = media.href ? absUrl(media.href) : null;

    const task = media.type === 'video' && media.videoEl
      ? cloneVideoToCache(media.videoEl, { href, wrapIfNoHref })
      : media.imgEl
        ? cloneImageToCache(media.imgEl, { href, wrapIfNoHref })
        : Promise.resolve(false);

    task.then(ok => {
      if (!state.running) return;
      if (!ok) {
        state.items.delete(key);
        state.deduped = state.items.size;
        postStats();
        return;
      }
      state.captured++;
      state.allImageUrls.add(key);
      state.lastNewItemAt = performance.now();
      postStats();
      postState();
      if (state.captured >= state.maxItems) stopRunning(false, false);
    }).catch(err => {
      console.warn('[Archiver] failed to clone media', err);
      state.items.delete(key);
      state.deduped = state.items.size;
      postStats();
    });
  }

  function scanOnce() {
    if (!state.running || state.captured >= state.maxItems) return;
    ensureCache();
    const adapter = state.adapter || adapterCivitai;
    const root = (adapter.getGalleryRoot && adapter.getGalleryRoot()) || document.body;
    const cards = (adapter.selectCards && adapter.selectCards(root)) || [];
    cards.forEach(card => {
      if (state.captured >= state.maxItems) return;
      processCard(card);
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
      if (state.captured > before) {
        state.lastNewItemAt = now;
      } else if (now - state.lastNewItemAt > 6000) {
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
    ensureCache();
    restoreScrollStyles();
    if (state.cache) state.cache.style.display = 'none';
  }

  async function startRunning() {
    if (state.running) return;
    state.adapter = ACTIVE_ADAPTER;
    state.running = true;
    state.seen = 0;
    state.captured = 0;
    state.deduped = 0;
    state.items = new Map();
    state.allImageUrls = new Set();
    const opts = await new Promise(resolve => {
      chrome.storage.local.get({ maxItems: 200, scrollDelay: 300, stabilityTimeout: 400 }, resolve);
    });
    state.maxItems = parseInt(opts.maxItems, 10) || 200;
    state.scrollDelay = parseInt(opts.scrollDelay, 10) || 300;
    state.stabilityTimeout = parseInt(opts.stabilityTimeout, 10) || 400;
    document.querySelectorAll('img').forEach(img => {
      const url = resolveImageUrl(img);
      if (url) state.allImageUrls.add(url);
    });
    postStats();
    postState();
    ensureCache();
    startObserver();
    state.scrollEl = getScrollElement();
    state.scrollEl.scrollTo(0, 0);
    scanOnce();
    state.origHtmlStyle = document.documentElement.getAttribute('style') || '';
    state.origBodyStyle = document.body.getAttribute('style') || '';
    applyScrollStyles();
    autoScrollLoop();
  }

  function stopRunning(freeze=false, restoreStyles=true) {
    state.running = false;
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (state.scrollTimer) {
      clearTimeout(state.scrollTimer);
      state.scrollTimer = null;
    }
    state.scrollEl = null;
    if (freeze) {
      freezePage();
    } else if (restoreStyles) {
      restoreScrollStyles();
      if (state.cache) {
        state.cache.remove();
        state.cache = null;
      }
    }
    postState();
    if (state.autoSave && state.captured >= state.maxItems) {
      chrome.runtime.sendMessage({ type: 'ARCHIVER_SAVE_MHTML' });
    }
    state.autoSave = false;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'ARCHIVER_START') {
      state.autoSave = !!msg.autoSave;
      startRunning();
    }
    if (msg?.type === 'ARCHIVER_STOP') stopRunning(true);
    if (msg?.type === 'ARCHIVER_RESET') {
      stopRunning(false);
      sendResponse();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'ARCHIVER_SAVE_MHTML_VIA_PAGE') {
      (async () => {
        try {
          const { bytes, blobUrl, mime, suggestedName } = msg.payload || {};

          let blob;
          if (blobUrl) {
            const res = await fetch(blobUrl);
            const fetched = await res.blob();
            const ab = await fetched.arrayBuffer();
            blob = new Blob([ab], { type: mime || fetched.type || 'application/x-mimearchive' });
          } else if (bytes instanceof ArrayBuffer) {
            blob = new Blob([new Uint8Array(bytes)], { type: mime || 'application/x-mimearchive' });
          } else if (ArrayBuffer.isView(bytes)) {
            blob = new Blob([new Uint8Array(bytes.buffer)], { type: mime || 'application/x-mimearchive' });
          } else if (typeof bytes === 'string' && bytes.startsWith('data:')) {
            const res = await fetch(bytes);
            blob = await res.blob();
            if (mime && blob.type !== mime) {
              blob = new Blob([await blob.arrayBuffer()], { type: mime });
            }
          } else {
            console.warn('[Archiver] unexpected bytes payload:', { type: typeof bytes, ctor: bytes?.constructor?.name });
            blob = new Blob([], { type: mime || 'application/x-mimearchive' });
          }

          console.log('[Archiver] save blob size:', blob.size, 'type:', blob.type);

          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = suggestedName || 'archive.mhtml';
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            try { a.remove(); } catch {}
            try { URL.revokeObjectURL(url); } catch {}
          }, 300000);
          sendResponse({ ok: true });
        } catch (err) {
          console.error('[Archiver] in-page save failed:', err);
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
      })();
      return true;
    }
  });

    // Dev helper (console): window.__civitaiArchiverStart()
    window.__civitaiArchiverStart = startRunning;
    window.__civitaiArchiverStop = () => stopRunning(true);

    if (typeof module !== 'undefined' && module.exports) {
      module.exports = { absUrl, pickBestFromSrcset, isTinyDataURI };
    }
  })();

// ------------------------------------------------------------
// [Archiver] PREPARE: replace gallery <video> with still <img>
// ------------------------------------------------------------
(function () {
  const A_IMG_PAGE = 'a[href*="/images/"], a[href^="/images/"]';
  const TRANSPARENT_PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

  function finalizeIfGood(imgEl) {
    return new Promise((resolve) => {
      const done = () => resolve(true);
      if (imgEl.complete && imgEl.naturalWidth > 0) return done();
      imgEl.addEventListener('load', done, { once: true });
      imgEl.addEventListener('error', () => resolve(false), { once: true });
    });
  }

  // Fetch an image URL and return a data URL. Returns '' on failure or if the
  // response is clearly not an image (some "poster" URLs return the original
  // video instead, which bloats the save if converted to data: URIs).
  async function imageURLToDataURL(url) {
    // Attempt to fetch the poster so we can inline it. Some image CDN endpoints
    // require cookies, so include credentials. If the response is not an image
    // or the fetch fails, fall back to trying via an <img> element and canvas.
    try {
      const res = await fetch(url, { credentials: 'include' });
      const blob = await res.blob();
      if (!blob.type.startsWith('image/')) throw new Error('not image');
      return await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => resolve('');
        fr.readAsDataURL(blob);
      });
    } catch (_) {
      // Fallback: load through an <img> and draw to canvas. This avoids CORS
      // restrictions when the server allows it and lets us downscale/encode.
      return await new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            let { width, height } = img;
            const MAX_W = 512;
            if (width > MAX_W) {
              height = Math.round(height * (MAX_W / width));
              width = MAX_W;
            }
            const c = document.createElement('canvas');
            c.width = width; c.height = height;
            c.getContext('2d').drawImage(img, 0, 0, width, height);
            resolve(c.toDataURL('image/jpeg', 0.9));
          } catch (_) {
            resolve('');
          }
        };
        img.onerror = () => resolve('');
        img.src = url;
      });
    }
  }

  // Try to capture a first frame if poster is missing and CORS allows
  async function captureFirstFrameToDataURL(src) {
    try {
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous';   // CORS-friendly servers will allow canvas use
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.src = src;

      await new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error('video load timeout')), 1000);
        v.addEventListener('loadeddata', () => { clearTimeout(to); res(); }, { once: true });
        v.addEventListener('error', () => { clearTimeout(to); rej(new Error('video load error')); }, { once: true });
      });

      // nudge to a safe timestamp near 0
      try {
        v.currentTime = 0.05;
        await new Promise((res) => v.addEventListener('seeked', res, { once: true }));
      } catch (_) { /* some codecs don’t need seek */ }

      const w = Math.max(1, v.videoWidth || 450);
      const h = Math.max(1, v.videoHeight || Math.round(w * 9 / 16));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(v, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.9);
    } catch (_) {
      return '';
    }
  }

  async function videoToStillURL(videoEl) {
    // 1) Prefer the poster; convert to data URL so saved pages stay self‑contained
    if (videoEl.poster) {
      const dataUrl = await imageURLToDataURL(videoEl.poster);
      if (dataUrl) return dataUrl;
      // If the poster can't be inlined fall through to frame capture
    }

    // 2) Otherwise try to grab a frame from an actual source
    const direct = videoEl.currentSrc ||
                   (videoEl.querySelector('source') && videoEl.querySelector('source').src) ||
                   '';
    if (!direct) return '';
    return await captureFirstFrameToDataURL(direct);
  }

  function looksLikeGalleryVideo(v) {
    // under an anchor to /images/… (the same way we pick image cards)
    return !!v.closest(A_IMG_PAGE);
  }

  function looksLikeStandaloneVideo(v) {
    return location.pathname.startsWith('/images/') && !v.closest(A_IMG_PAGE);
  }

  async function freezeVideosInPlace() {
    const vids = Array.from(document.querySelectorAll('video'))
      .filter(looksLikeGalleryVideo)
      // skip ones we already processed
      .filter(v => !v.dataset.archiverFrozen);

    let processed = 0, ok = 0, fail = 0, skipped = 0;

    for (const v of vids) {
      processed++;
      try {
        const still = await videoToStillURL(v);
        const img = document.createElement('img');
        img.alt = 'Video snapshot';

        // Keep sizing consistent with the original gallery cards
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        img.style.display = 'block';

        // Strip sources to avoid embedding videos
        v.pause?.();
        v.removeAttribute('src');
        v.removeAttribute('poster');
        v.querySelectorAll('source').forEach(s => s.remove());
        v.load?.();

        // Replace the <video> in place; anchor/href stays intact
        v.replaceWith(img);

        img.src = still || TRANSPARENT_PX;
        const loaded = await finalizeIfGood(img);
        if (still && loaded) ok++; else fail++;
        img.dataset.archiverFrozen = '1';
      } catch (e) {
        fail++;
      }
    }

    return { processed, ok, fail, skipped, total: vids.length };
  }

  async function freezeStandaloneVideos() {
    const vids = Array.from(document.querySelectorAll('video'))
      .filter(looksLikeStandaloneVideo)
      .filter(v => !v.dataset.archiverFrozen);

    let processed = 0, ok = 0, fail = 0, skipped = 0;

    for (const v of vids) {
      processed++;
      try {
        const still = await videoToStillURL(v);

        const cs = getComputedStyle(v);
        const img = document.createElement('img');
        img.alt = 'Video snapshot';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = cs.objectFit;
        img.style.display = 'block';

        const a = document.createElement('a');
        a.href = location.href;
        a.style.width = cs.width;
        a.style.height = cs.height;
        a.style.maxWidth = cs.maxWidth;
        a.style.maxHeight = cs.maxHeight;
        a.style.display = cs.display;
        a.appendChild(img);

        // Strip sources to avoid embedding videos
        v.pause?.();
        v.removeAttribute('src');
        v.removeAttribute('poster');
        v.querySelectorAll('source').forEach(s => s.remove());
        v.load?.();

        v.replaceWith(a);

        img.src = still || TRANSPARENT_PX;
        const loaded = await finalizeIfGood(img);
        if (still && loaded) ok++; else fail++;
        img.dataset.archiverFrozen = '1';
      } catch (e) {
        fail++;
      }
    }

    return { processed, ok, fail, skipped, total: vids.length };
  }

  // Message hook: popup will ask us to prepare the DOM before saving
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'ARCHIVER_HAS_UNFROZEN_VIDEOS') {
      const count = document.querySelectorAll('video:not([data-archiver-frozen])').length;
      sendResponse({ count });
      return;
    }
    if (msg.type === 'ARCHIVER_PREPARE_FOR_SAVE') {
      (async () => {
        try {
          const s1 = await freezeVideosInPlace();
          const s2 = await freezeStandaloneVideos();
          const stats = {
            processed: (s1.processed || 0) + (s2.processed || 0),
            ok:        (s1.ok || 0) + (s2.ok || 0),
            fail:      (s1.fail || 0) + (s2.fail || 0),
            skipped:   (s1.skipped || 0) + (s2.skipped || 0),
            total:     (s1.total || 0) + (s2.total || 0),
          };
          sendResponse({ ok: true, stats });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true; // keep channel open for async response
    }
  });

  // Optional debug helper (run in console if needed):
  //   window.__archiverFreezeVideos = freezeVideosInPlace;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports.freezeStandaloneVideos = freezeStandaloneVideos;
  }
})();

/* ------------------------------------------------------------------
 * [Archiver] Scope gallery layout to #gallery
 *  - Applies 6-col grid only inside #gallery (header/description unchanged)
 *  - Cleans up injected layout style when ARCHIVER_STOP fires
 * ------------------------------------------------------------------ */
(function () {
  const STYLE_ID_GRID  = 'archiver-gallery-grid-style';

  const $  = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

  function getGalleryRoot() {
    // Prefer explicit id the site uses
    const g = document.getElementById('gallery');
    if (g) return g;

    // Fallback: lowest common ancestor of several /images/... anchors
    const anchors = $$('a[href*="/images/"], a[href^="/images/"]');
    if (anchors.length < 6) return null;
    const sample = anchors.slice(0, 20);
    const chains = sample.map(a => {
      const list = [];
      for (let n=a; n && n!==document.documentElement; n=n.parentElement) list.push(n);
      return list;
    });
    let lca = null;
    for (const cand of chains[0]) {
      if (chains.every(chain => chain.includes(cand))) { lca = cand; break; }
    }
    return (lca && lca !== document.body) ? lca : null;
  }

  function ensureGridStyles(galleryRoot) {
    if (!galleryRoot) return;
    if (document.getElementById(STYLE_ID_GRID)) return;

    const s = document.createElement('style');
    s.id = STYLE_ID_GRID;

    // IMPORTANT: All rules are hard-scoped under #gallery so header/description don’t change.
    s.textContent = `
      /* keep the gallery container full width without touching header */
      #gallery .mantine-Container-root,
      #gallery .mantine-container,
      #gallery [class*="Container-root"] {
        max-width: 100% !important;
        width: 100% !important;
      }

      /* force 6 columns only inside the gallery grid */
      #gallery .mantine-SimpleGrid-root,
      #gallery [class*="SimpleGrid-root"],
      #gallery [class*="simpleGrid"] {
        display: grid !important;
        grid-template-columns: repeat(6, minmax(0, 1fr)) !important;
        gap: 12px !important;
      }
    `;
    document.head.appendChild(s);
  }

  function cleanup() {
    const s1 = document.getElementById(STYLE_ID_GRID);
    if (s1) s1.remove();
  }

  /* ------------------------- Message integration ------------------------- */
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'ARCHIVER_PREPARE_FOR_SAVE') {
      (async () => {
        try {
          const root = getGalleryRoot();
          ensureGridStyles(root);
          await new Promise(r => setTimeout(r, 30));
        } catch (_) {
          /* ignore */
        }
      })();
    }
    if (msg.type === 'ARCHIVER_STOP') {
      cleanup();
    }
  });

  // Safety: restore on navigation
  window.addEventListener('beforeunload', cleanup, { once: true });
})();

/* ------------------------------------------------------------------
 * [Archiver] Play badge overlay (data:SVG) with re-apply guard
 *  - Puts a small ▶ overlay inside each video card
 *  - Keeps re-applying for ~1.2s to survive React re-renders
 *  - Requires no external CSS, serializes cleanly to MHTML
 * ------------------------------------------------------------------ */
(() => {
  const LOG = (...a)=>{ try { console.log('[Archiver] overlay', ...a);} catch(_){} };
  const $$  = (sel, root=document) => Array.from(root.querySelectorAll(sel));

  const ATTR_OVERLAY = 'data-archiver-overlay';
  const ATTR_REL_SET = 'data-archiver-pos-rel';

  function getGalleryRoot() {
    return document.getElementById('gallery') || document;
  }

// Bright yellow play glyph (with subtle dark stroke for contrast)
function svgPlayBadgeDataURL(diamPx, color = '#FFD400', stroke = 'rgba(0,0,0,.75)') {
  const d = Math.max(16, Math.floor(diamPx));
  const r = Math.floor(d / 2);
  const triLeftX = Math.floor(r * 0.55);
  const triTopY  = Math.floor(r * 0.35);
  const triBotY  = Math.floor(r * 1.65);
  const triTipX  = Math.floor(r * 1.55);

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}" viewBox="0 0 ${d} ${d}">
      <!-- darker translucent puck to ensure visibility on busy images -->
      <circle cx="${r}" cy="${r}" r="${r}" fill="rgba(0,0,0,0.55)"/>
      <!-- bright triangle with a thin stroke so it stands out on light areas -->
      <polygon points="${triLeftX},${triTopY} ${triLeftX},${triBotY} ${triTipX},${r}"
               fill="${color}" stroke="${stroke}" stroke-width="${Math.max(1, Math.round(d * 0.04))}"/>
    </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

  function ensureRelative(container) {
    const style = (container && container.style) ? container.style : null;
    if (!style) return;
    const cs = getComputedStyle(container).position;
    if (cs !== 'relative' && cs !== 'absolute' && cs !== 'fixed') {
      style.position = 'relative';
      container.setAttribute(ATTR_REL_SET, '1');
    }
  }

  function cardForPoster(posterImg) {
    // Prefer the clickable <a href="/images/...">
    const a = posterImg.closest('a[href*="/images/"]');
    if (a) return a;

    // Fallback: EdgeVideo wrapper, then its parent container
    const edge = posterImg.closest('[class^="EdgeVideo_"]');
    if (edge) return edge;

    // Last resort: the poster's parent
    return posterImg.parentElement || posterImg;
  }

  function overlayBadgeForPoster(posterImg) {
    const card = cardForPoster(posterImg);
    if (!card) return false;

    if (card.querySelector(`img[${ATTR_OVERLAY}="badge"]`)) return false;

    ensureRelative(card);

    const rect = card.getBoundingClientRect();
    const size = Math.min(Math.max(Math.floor(Math.min(rect.width, rect.height) * 0.12), 24), 56);

    const img = new Image();
    img.setAttribute(ATTR_OVERLAY, 'badge');
    img.alt = '';
    img.decoding = 'sync';
    img.loading  = 'eager';
    img.src = svgPlayBadgeDataURL(size);
    img.style.cssText = [
      'position:absolute',
      'top:8px',
      'right:8px',
      `width:${size}px`,
      `height:${size}px`,
      'pointer-events:none',
      'z-index:2147483000',
      'display:block'
    ].join(';');

    card.appendChild(img);
    return true;
  }

  function collectPosters(root) {
    return $$(
      '#gallery a[href*="/images/"] img[alt*="Video"], ' +
      '#gallery [class^="EdgeVideo_"] img[alt*="Video"], ' +
      'a[href*="/images/"] img[alt*="Video"]',
      root
    );
  }

  // Re-apply for ~durationMs with a MutationObserver + interval
  async function guardOverlays(root, durationMs = 1200) {
    let placed = 0, processed = 0;

    const applyOnce = () => {
      const posters = collectPosters(root);
      for (const p of posters) {
        processed++;
        if (overlayBadgeForPoster(p)) placed++;
      }
    };

    applyOnce();

    const observer = new MutationObserver(() => applyOnce());
    observer.observe(root || document, { childList: true, subtree: true });

    const tick = setInterval(applyOnce, 120);

    await new Promise(r => setTimeout(r, durationMs));

    clearInterval(tick);
    observer.disconnect();

    LOG(`placed ${placed}/${processed} (guard ${durationMs}ms)`);
    return { processed, placed };
  }

  function cleanupOverlays() {
    document.querySelectorAll(`img[${ATTR_OVERLAY}="badge"]`).forEach(n => n.remove());
    document.querySelectorAll(`[${ATTR_REL_SET}="1"]`).forEach(n => {
      try { n.style.position = ''; } catch(_) {}
      n.removeAttribute(ATTR_REL_SET);
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'ARCHIVER_PREPARE_FOR_SAVE') {
      (async () => {
        try {
          const stats = await guardOverlays(getGalleryRoot(), 1200);
          // tiny extra settle so BG will almost always catch overlays in paint
          await new Promise(r => setTimeout(r, 30));
          sendResponse(Object.assign({ ok: true }, stats));
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }
    if (msg.type === 'ARCHIVER_STOP') {
      cleanupOverlays();
    }
  });

  window.addEventListener('beforeunload', cleanupOverlays, { once: true });
})();
