/* Content script: core hoarding, anti-placeholder, auto-scroll, freeze */

(() => {
  const state = {
    running: false,
    seen: 0,
    captured: 0,
    deduped: 0,
    maxItems: 200,
    scrollDelay: 300,
    stabilityTimeout: 400,
    items: new Map(), // key -> { detailUrl, imageUrl, el, state }
    seenDetailUrls: new Set(), // dedupe by detail link
    allImageUrls: new Set(), // every image destined for archive
    observer: null,
    scrollTimer: null,
    lastNewItemAt: 0,
    bucket: null,
    scrollEl: null,
    origHtmlStyle: '',
    origBodyStyle: '',
    autoSave: false,
  };

  const SEL_ANCHOR_IMG = 'a[href*="/images/"] img, a[href^="/images/"] img';
  const SEL_ANCHOR_BG = 'a[href*="/images/"], a[href^="/images/"]';

  function absUrl(href) {
    try { return new URL(href, location.origin).toString(); } catch { return href; }
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

  function pickBestFromSrcset(img) {
    const ss = img.getAttribute('srcset');
    if (!ss) return img.currentSrc || img.src || null;
    // Parse candidates: "url widthDescriptor, url widthDescriptor, ..."
    const candidates = ss.split(',').map(s => s.trim()).map(token => {
      const m = token.match(/^(.*)\s+(\d+)(w|x)$/);
      if (m) return { url: absUrl(m[1].trim()), width: parseInt(m[2], 10), unit: m[3] };
      // fallback: might be just URL (rare); let width=0
      return { url: absUrl(token.split(/\s+/)[0]), width: 0, unit: 'w' };
    });
    candidates.sort((a,b) => b.width - a.width);
    return (candidates[0] && candidates[0].url) || img.currentSrc || img.src || null;
  }

  function isTinyDataURI(url) {
    // Heuristic: data URI and short length (common for blurred placeholders)
    return /^data:/.test(url) && url.length < 1024; // 1 KB threshold
  }

  // Ensure an image element is fully loaded

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
    // Kick off timer in case there are no changes after attach
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

    // Wait for image attributes to settle before cloning
    stabilityWatcher(img, state.stabilityTimeout, async () => {
      if (!state.running || state.captured >= state.maxItems) return;
      const bestNow = pickBestFromSrcset(img) || img.src || initialUrl;
      if (!bestNow || isTinyDataURI(bestNow)) return;

      const cloneImg = document.createElement('img');
      cloneImg.src = bestNow;
      state.bucket.appendChild(cloneImg);
      const ok = await finalizeIfGood(cloneImg);
      if (!ok || !state.running) {
        cloneImg.remove();
        return;
      }

      state.captured++;
      state.deduped = state.seenDetailUrls.size;
      state.lastNewItemAt = performance.now();
      state.allImageUrls.add(absUrl(bestNow));
      postStats();
      postState();

      if (state.captured >= state.maxItems) stopRunning(false, false);
    });

    postStats();
  }

  function scanOnce() {
    if (!state.running || state.captured >= state.maxItems) return;
    ensureBucket();
    // IMG-based cards
    document.querySelectorAll(SEL_ANCHOR_IMG).forEach(img => {
      if (state.captured >= state.maxItems) return;
      const a = img.closest('a');
      if (a) processAnchorImg(a, img);
    });

    // CSS background-image anchors (fallback)
    document.querySelectorAll(SEL_ANCHOR_BG).forEach(a => {
      if (state.captured >= state.maxItems) return;
      const style = getComputedStyle(a);
      const bg = style.backgroundImage;
      if (bg && bg !== 'none') {
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
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
            state.bucket.appendChild(cloneImg);
            const ok = await finalizeIfGood(cloneImg);
            if (!ok || !state.running) {
              cloneImg.remove();
              return;
            }
            state.captured++;
            state.deduped = state.seenDetailUrls.size;
            state.lastNewItemAt = performance.now();
            state.allImageUrls.add(absUrl(url));
            postStats();
            postState();
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

      // If no progress for a while, attempt a small nudge but keep looping
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
    ensureBucket();
    // In earlier versions we hid the live app and revealed the bucket to create a
    // static grid for the MHTML export. Now that the browser reliably captures
    // the full page, keep the app visible and leave the bucket hidden so the
    // saved archive doesn't include a duplicate grid.
    restoreScrollStyles();
    // Ensure bucket stays hidden
    state.bucket.style.display = 'none';
  }

  async function startRunning() {
    if (state.running) return;
    state.running = true;
    state.seen = 0;
    state.captured = 0;
    state.deduped = 0;
    state.seenDetailUrls.clear();
    state.allImageUrls = new Set();
    // Load options before starting capture
    const opts = await new Promise(resolve => {
    chrome.storage.local.get({ maxItems: 200, scrollDelay: 300, stabilityTimeout: 400 }, resolve);
    });
    state.maxItems = parseInt(opts.maxItems, 10) || 200;
    state.scrollDelay = parseInt(opts.scrollDelay, 10) || 300;
    state.stabilityTimeout = parseInt(opts.stabilityTimeout, 10) || 400;
    // Collect any images already on the page
    document.querySelectorAll('img').forEach(img => {
      const url = pickBestFromSrcset(img) || img.currentSrc || img.src;
      if (url) state.allImageUrls.add(absUrl(url));
    });
    postStats();
    postState();
    ensureBucket();
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
      if (state.bucket) {
        state.bucket.remove();
        state.bucket = null;
      }
    }
    postState();
    if (state.autoSave && state.captured >= state.maxItems) {
      chrome.runtime.sendMessage({ type: 'ARCHIVER_SAVE_MHTML' });
    }
    state.autoSave = false;
  }

  function scrollElementToTop(el) {
    if (!el) return false;
    let didScroll = false;

    try {
      if (typeof el.scrollTo === 'function') {
        el.scrollTo(0, 0);
        didScroll = true;
      }
    } catch (_) {}

    try {
      el.scrollTop = 0;
      el.scrollLeft = 0;
      didScroll = true;
    } catch (_) {}

    return didScroll;
  }

  function scrollLivePageTargetsToTop() {
    const targets = new Set([
      state.scrollEl,
      document.scrollingElement,
      document.documentElement,
      document.body,
      document.getElementById('__next'),
      document.getElementById('app'),
      document.getElementById('main'),
      document.querySelector('main')
    ].filter(Boolean));

    document.querySelectorAll('.scroll-area, .mantine-ScrollArea-viewport, [data-radix-scroll-area-viewport]')
      .forEach(el => targets.add(el));

    const activeScroller = document.activeElement?.closest?.(
      '.scroll-area, .mantine-ScrollArea-viewport, [data-radix-scroll-area-viewport], main, #__next, #app, #main'
    );
    if (activeScroller) targets.add(activeScroller);

    let scrolledTargets = 0;
    targets.forEach(el => {
      if (scrollElementToTop(el)) scrolledTargets++;
    });

    try {
      if (typeof window.scrollTo === 'function') {
        window.scrollTo(0, 0);
      }
    } catch (_) {}

    return scrolledTargets;
  }

  async function returnLivePageViewToTop() {
    let scrolledTargets = scrollLivePageTargetsToTop();

    await new Promise(resolve => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve);
      else setTimeout(resolve, 16);
    });

    scrolledTargets += scrollLivePageTargetsToTop();
    return { scrolledTargets };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'ARCHIVER_START') {
      state.autoSave = !!msg.autoSave;
      startRunning();
    }
    if (msg?.type === 'ARCHIVER_STOP') stopRunning(true);
    if (msg?.type === 'ARCHIVER_RETURN_TO_TOP') {
      returnLivePageViewToTop()
        .then(result => sendResponse({ ok: true, ...result }))
        .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (msg?.type === 'ARCHIVER_RESET') {
      stopRunning(false);
      sendResponse();
    }
  });

// Save MHTML by clicking a hidden <a download> IN THE PAGE (preserves last-used folder)
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

        const url = URL.createObjectURL(blob);              // page-origin blob URL
        const a = document.createElement('a');
        a.href = url;
        a.download = suggestedName || 'archive.mhtml';      // basename only
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
    return true; // keep the message channel open for sendResponse
  }
});

    // Dev helper (console): window.__civitaiArchiverStart()
    window.__civitaiArchiverStart = startRunning;
    window.__civitaiArchiverStop = () => stopRunning(true);
    window.__archiverReturnToTop = returnLivePageViewToTop;

    if (typeof module !== 'undefined' && module.exports) {
      module.exports = { absUrl, pickBestFromSrcset, isTinyDataURI, returnLivePageViewToTop };
    }
  })();

// Solo detail viewers share a layout, but must not use model/gallery prep.
(function () {
  const marker = 'data-archiver-solo';
  const original = 'data-archiver-solo-original-style';
  const styleId = 'archiver-solo-layout';

  function detect() {
    if (!/^\/images\/\d+\/?$/.test(location.pathname)) return null;
    const main = document.querySelector('main');
    if (!main || main.querySelector('[data-tour="model:start"], #gallery')) return null;
    const existing = main.querySelector(`[${marker}="row"]`);
    if (existing) return { row: existing };
    // The desktop width token plus scroll viewport distinguishes the details
    // panel from avatars, recommendation cards, and unrelated sidebars.
    const sidebar = Array.from(main.querySelectorAll('div')).find(el =>
      Array.from(el.classList).some(c => /^@md:w-\[450px\]$/.test(c)) &&
      el.querySelector('.mantine-ScrollArea-viewport'));
    const row = sidebar?.parentElement;
    if (!row) return null;
    const region = Array.from(row.children).find(el => el !== sidebar &&
      el.querySelector('video, img[class*="EdgeImage"]'));
    const media = region?.querySelector('video, img[class*="EdgeImage"]');
    if (!media) return null;
    const rect = media.getBoundingClientRect();
    const width = media.videoWidth || media.naturalWidth || rect.width;
    const height = media.videoHeight || media.naturalHeight || rect.height;
    return { row, sidebar, region, parent: media.parentElement,
      media, ratio: width > 0 && height > 0 ? width / height : 1 };
  }

  function mark(el, role, styles) {
    if (!el.hasAttribute(original)) el.setAttribute(original, el.getAttribute('style') || '');
    el.setAttribute(marker, role);
    for (const [prop, value] of Object.entries(styles)) el.style.setProperty(prop, value, 'important');
  }

  function prepare(view = detect()) {
    if (!view) return { solo: false };
    if (document.getElementById(styleId)) return { solo: true };
    const { row, sidebar, region, parent, ratio } = view;
    const media = view.media.isConnected ? view.media : parent.querySelector('img[data-archiver-frozen]');
    if (!media) return { solo: false };
    const normal = { 'min-width': '0', 'min-height': '0', height: 'auto',
      'max-height': 'none', overflow: 'visible', transform: 'none' };
    for (let el = row.parentElement; el; el = el.parentElement) {
      mark(el, 'shell', { ...normal, width: '100%', 'max-width': 'none',
        display: 'block', position: 'static', 'box-sizing': 'border-box' });
    }
    mark(row, 'row', { ...normal, display: 'grid', width: '100%',
      'align-items': 'start', 'box-sizing': 'border-box' });
    mark(sidebar, 'sidebar', { ...normal, position: 'static', inset: 'auto',
      translate: 'none', width: '100%', 'max-width': '100%', 'box-sizing': 'border-box',
      'overflow-wrap': 'anywhere' });
    sidebar.querySelectorAll('.mantine-ScrollArea-root, .mantine-ScrollArea-viewport').forEach(el =>
      mark(el, 'scroll', normal));
    mark(region, 'region', { ...normal, width: '100%', display: 'flex',
      'flex-direction': 'column', 'align-self': 'start' });
    // Remove only the primary media's carousel sizing chain. Other slides and
    // unrelated cards retain their own rules.
    for (let el = media.parentElement; el && el !== region; el = el.parentElement) {
      mark(el, 'media-path', { ...normal, width: '100%', 'max-width': '100%',
        display: 'block', flex: '0 1 auto', 'aspect-ratio': 'auto' });
    }
    mark(media, 'media', { display: 'block', width: `min(100%, ${80 * ratio}vh)`,
      height: 'auto', 'max-width': '100%', 'max-height': '80vh',
      'object-fit': 'contain', 'margin-left': 'auto', 'margin-right': 'auto' });
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `[${marker}="row"] { grid-template-columns: minmax(0, 1fr) 450px !important; }
      @media (max-width: 1023px) { [${marker}="row"] { grid-template-columns: minmax(0, 1fr) !important; } }`;
    document.head.appendChild(style);
    return { solo: true };
  }

  function cleanup() {
    document.getElementById(styleId)?.remove();
    document.querySelectorAll(`[${original}]`).forEach(el => {
      const value = el.getAttribute(original);
      if (value) el.setAttribute('style', value); else el.removeAttribute('style');
      el.removeAttribute(original);
      el.removeAttribute(marker);
    });
  }
  window.__archiverPrepareSolo = { detect, prepare, cleanup };
  chrome.runtime.onMessage.addListener(msg => { if (msg?.type === 'ARCHIVER_STOP') cleanup(); });
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
    try {
      if (new URL(url).hostname === 'image.civitai.com') {
        const result = await chrome.runtime.sendMessage({
          type: 'ARCHIVER_FETCH_VIDEO_POSTER', url,
        });
        if (result?.ok && /^data:image\//.test(result.dataUrl)) return result.dataUrl;
      }
    } catch (_) { /* Keep the existing capture fallbacks available. */ }
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

  async function prepareForSave() {
    const solo = window.__archiverPrepareSolo?.detect?.();
    const s1 = await freezeVideosInPlace();
    const s2 = await freezeStandaloneVideos();
    const videos = {
      processed: (s1.processed || 0) + (s2.processed || 0),
      ok:        (s1.ok || 0) + (s2.ok || 0),
      fail:      (s1.fail || 0) + (s2.fail || 0),
      skipped:   (s1.skipped || 0) + (s2.skipped || 0),
      total:     (s1.total || 0) + (s2.total || 0),
    };

    const soloLayout = solo ? await window.__archiverPrepareSolo.prepare(solo) : null;
    const gallery = soloLayout?.solo ? { skipped: true } : await window.__archiverPrepareGallery?.prepare?.();
    const layout = soloLayout?.solo ? soloLayout : await window.__archiverPrepareLayout?.prepare?.();
    const overlays = await window.__archiverPrepareOverlays?.prepare?.();

    await new Promise(resolve => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve);
      else setTimeout(resolve, 16);
    });
    await new Promise(r => setTimeout(r, 50));

    return { videos, gallery, layout, overlays };
  }

  // Message hook: popup will ask us to prepare the DOM before saving.
  // This is the only ARCHIVER_PREPARE_FOR_SAVE responder in the content script.
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
          const stats = await prepareForSave();
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
    module.exports.prepareForSave = prepareForSave;
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

  async function prepare() {
    const root = getGalleryRoot();
    ensureGridStyles(root);
    await new Promise(r => setTimeout(r, 30));
    return { gridStyle: Boolean(document.getElementById(STYLE_ID_GRID)), hasGallery: Boolean(root) };
  }

  window.__archiverPrepareGallery = { prepare, cleanup };

  /* ------------------------- Message integration ------------------------- */
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'ARCHIVER_STOP') {
      cleanup();
    }
  });

  // Safety: restore on navigation
  window.addEventListener('beforeunload', cleanup, { once: true });
})();

/* ------------------------------------------------------------------
 * [Archiver] MHTML static layout preparation
 *  - Chrome's MHTML viewer can lose Civitai's container-query layout.
 *  - Archive mode makes the app shell a normal vertical document flow.
 *  - Styles are reversible on the live page, but persist in the snapshot.
 * ------------------------------------------------------------------ */
(function () {
  const STYLE_ID_LAYOUT = 'archiver-mhtml-layout-fix';
  const ATTR_PREP = 'data-archiver-mhtml-prep';
  const ATTR_ORIGINAL_STYLE = 'data-archiver-original-style';
  const IMAGE_CONTROL_SELECTOR = [
    '[data-tour="model:start"] .absolute.right-2.top-2.z-10',
    '[data-tour="model:start"] .absolute.bottom-0\\.5.right-0\\.5.z-10',
    '[data-tour="model:start"] .absolute.bottom-1.right-0\\.5.z-10',
    '[data-tour="model:start"] [data-activity="remix:model-carousel"]',
    '[data-tour="model:start"] button.absolute.left-3.top-1\\/2',
    '[data-tour="model:start"] button.absolute.right-3.top-1\\/2',
    '#gallery .absolute.right-2.top-2.z-10',
    '#gallery .absolute.bottom-0\\.5.right-0\\.5.z-10',
    '#gallery .absolute.bottom-1.right-0\\.5.z-10',
    '#gallery [data-activity="create:model-card"]',
    '#gallery [data-activity="remix:model-gallery"]',
    '#gallery button.absolute.left-3.top-1\\/2',
    '#gallery button.absolute.right-3.top-1\\/2'
  ].join(', ');

  function rememberStyle(el) {
    if (!el || el.hasAttribute(ATTR_ORIGINAL_STYLE)) return;
    el.setAttribute(ATTR_ORIGINAL_STYLE, el.getAttribute('style') || '');
  }

  function setImportant(el, prop, value) {
    if (!el || !el.style) return;
    rememberStyle(el);
    el.style.setProperty(prop, value, 'important');
  }

  function $$(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function hideIconControls(iconSelector, rootSelector) {
    $$(rootSelector).forEach(root => {
      $$(iconSelector, root).forEach(icon => {
        const control = icon.closest('button, [role="button"], .mantine-ActionIcon-root, .mantine-UnstyledButton-root') || icon.parentElement;
        const overlay = (control || icon).closest('.absolute[class*="bottom-"][class*="right-"]');

        if (!overlay) return;
        if (control) setImportant(control, 'display', 'none');
        setImportant(overlay, 'display', 'none');
      });
    });
  }

  function ensureLayoutStyle() {
    if (document.getElementById(STYLE_ID_LAYOUT)) return;

    const s = document.createElement('style');
    s.id = STYLE_ID_LAYOUT;
    s.textContent = `
      html[${ATTR_PREP}="1"],
      html[${ATTR_PREP}="1"] body,
      html[${ATTR_PREP}="1"] #__next,
      html[${ATTR_PREP}="1"] #main,
      html[${ATTR_PREP}="1"] #__next > .flex,
      html[${ATTR_PREP}="1"] #main > .flex,
      html[${ATTR_PREP}="1"] #main > .flex > .flex,
      html[${ATTR_PREP}="1"] .scroll-area,
      html[${ATTR_PREP}="1"] main {
        box-sizing: border-box !important;
        columns: auto !important;
        contain: none !important;
        container-type: normal !important;
        height: auto !important;
        max-height: none !important;
        min-width: 0 !important;
        min-height: 0 !important;
        overflow: visible !important;
        transform: none !important;
        width: 100% !important;
        max-width: 100% !important;
      }

      html[${ATTR_PREP}="1"] #__next,
      html[${ATTR_PREP}="1"] #__next > .flex,
      html[${ATTR_PREP}="1"] #main,
      html[${ATTR_PREP}="1"] #main > .flex,
      html[${ATTR_PREP}="1"] #main > .flex > .flex,
      html[${ATTR_PREP}="1"] .scroll-area,
      html[${ATTR_PREP}="1"] main {
        align-items: stretch !important;
        display: flex !important;
        flex-flow: column nowrap !important;
        justify-content: flex-start !important;
      }

      html[${ATTR_PREP}="1"] main > *,
      html[${ATTR_PREP}="1"] .scroll-area > footer {
        align-self: stretch !important;
        box-sizing: border-box !important;
        clear: both !important;
        display: block !important;
        flex: 0 0 auto !important;
        float: none !important;
        min-width: 0 !important;
        position: relative !important;
        width: 100% !important;
        max-width: var(--container-size-xl, 82.5rem) !important;
        margin-left: auto !important;
        margin-right: auto !important;
      }

      html[${ATTR_PREP}="1"] main > #gallery,
      html[${ATTR_PREP}="1"] #gallery [class*="MasonryContainer"] {
        box-sizing: border-box !important;
        width: 100% !important;
        max-width: 100% !important;
      }

      html[${ATTR_PREP}="1"] [data-archiver-model-header="1"] {
        align-items: flex-start !important;
        display: flex !important;
        flex-flow: row nowrap !important;
        gap: var(--mantine-spacing-xl, 2rem) !important;
        justify-content: center !important;
        margin: 0 !important;
        width: 100% !important;
      }

      html[${ATTR_PREP}="1"] [data-archiver-model-header="1"] > .mantine-Grid-inner {
        display: contents !important;
      }

      html[${ATTR_PREP}="1"] [data-archiver-model-header="1"] > .mantine-Grid-inner > .mantine-Grid-col,
      html[${ATTR_PREP}="1"] [data-archiver-model-header="1"] > .mantine-Grid-col {
        box-sizing: border-box !important;
        flex: none !important;
        grid-area: auto !important;
        min-width: 0 !important;
        padding: 0 !important;
      }

      html[${ATTR_PREP}="1"] [data-tour="model:discussion"],
      html[${ATTR_PREP}="1"] [data-tour="model:discussion"] .mantine-Grid-container,
      html[${ATTR_PREP}="1"] [data-tour="model:discussion"] .mantine-Grid-root,
      html[${ATTR_PREP}="1"] [data-tour="model:discussion"] .mantine-Grid-inner,
      html[${ATTR_PREP}="1"] [data-tour="model:discussion"] .mantine-Grid-col {
        box-sizing: border-box !important;
        width: 100% !important;
        max-width: 100% !important;
        min-width: 0 !important;
      }

      html[${ATTR_PREP}="1"] [data-tour="model:discussion"] [role="grid"] {
        box-sizing: border-box !important;
        display: flex !important;
        flex-flow: row wrap !important;
        gap: var(--mantine-spacing-md, 1rem) !important;
        height: auto !important;
        max-height: none !important;
        min-height: 0 !important;
        width: 100% !important;
      }

      html[${ATTR_PREP}="1"] [data-tour="model:discussion"] [role="gridcell"] {
        box-sizing: border-box !important;
        flex: 1 1 calc(50% - var(--mantine-spacing-md, 1rem)) !important;
        max-width: 100% !important;
        min-width: min(100%, 280px) !important;
        position: relative !important;
        top: auto !important;
        left: auto !important;
        width: auto !important;
      }

      html[${ATTR_PREP}="1"] [data-archiver-column="main"] {
        flex: 1 1 0 !important;
        max-width: calc(100% - min(26rem, 34%) - var(--mantine-spacing-xl, 2rem)) !important;
        order: 1 !important;
        width: auto !important;
      }

      html[${ATTR_PREP}="1"] [data-archiver-column="sidebar"] {
        flex: 0 0 min(26rem, 34%) !important;
        max-width: 26rem !important;
        order: 2 !important;
        width: min(26rem, 34%) !important;
      }

      html[${ATTR_PREP}="1"] #gallery .mx-auto.flex.justify-center.gap-4 {
        align-items: flex-start !important;
        justify-content: flex-start !important;
        margin-left: auto !important;
        margin-right: auto !important;
        max-width: 100% !important;
        overflow: visible !important;
        width: max-content !important;
      }

      html[${ATTR_PREP}="1"] [class*="ModelCarousel_reactions"],
      html[${ATTR_PREP}="1"] #gallery [class*="ImagesAsPostsCard_reactions"] {
        display: none !important;
      }

      html[${ATTR_PREP}="1"] [data-tour="model:start"] .absolute.right-2.top-2.z-10,
      html[${ATTR_PREP}="1"] [data-tour="model:start"] .absolute.bottom-0\\.5.right-0\\.5.z-10,
      html[${ATTR_PREP}="1"] [data-tour="model:start"] .absolute.bottom-1.right-0\\.5.z-10,
      html[${ATTR_PREP}="1"] [data-tour="model:start"] [data-activity="remix:model-carousel"],
      html[${ATTR_PREP}="1"] [data-tour="model:start"] button.absolute.left-3.top-1\\/2,
      html[${ATTR_PREP}="1"] [data-tour="model:start"] button.absolute.right-3.top-1\\/2,
      html[${ATTR_PREP}="1"] #gallery .absolute.right-2.top-2.z-10,
      html[${ATTR_PREP}="1"] #gallery .absolute.bottom-0\\.5.right-0\\.5.z-10,
      html[${ATTR_PREP}="1"] #gallery .absolute.bottom-1.right-0\\.5.z-10,
      html[${ATTR_PREP}="1"] #gallery [data-activity="create:model-card"],
      html[${ATTR_PREP}="1"] #gallery [data-activity="remix:model-gallery"],
      html[${ATTR_PREP}="1"] #gallery button.absolute.left-3.top-1\\/2,
      html[${ATTR_PREP}="1"] #gallery button.absolute.right-3.top-1\\/2 {
        display: none !important;
      }

      @media (max-width: 900px) {
        html[${ATTR_PREP}="1"] [data-archiver-model-header="1"] {
          display: block !important;
        }

        html[${ATTR_PREP}="1"] [data-archiver-model-header="1"] > .mantine-Grid-inner {
          display: block !important;
        }

        html[${ATTR_PREP}="1"] [data-archiver-model-header="1"] > .mantine-Grid-inner > .mantine-Grid-col,
        html[${ATTR_PREP}="1"] [data-archiver-model-header="1"] > .mantine-Grid-col {
          max-width: 100% !important;
          width: 100% !important;
        }
      }

      html[${ATTR_PREP}="1"] .sticky {
        position: static !important;
        transform: none !important;
      }

      html[${ATTR_PREP}="1"] .mantine-Grid-inner {
        max-width: 100% !important;
      }
    `;
    document.head.appendChild(s);
  }

  function applyStaticInlineLayout() {
    document.documentElement.setAttribute(ATTR_PREP, '1');

    const shellElements = new Set([
      document.documentElement,
      document.body,
      document.getElementById('__next'),
      document.getElementById('main'),
      document.querySelector('.scroll-area'),
      document.querySelector('main')
    ].filter(Boolean));

    for (let el = document.querySelector('main'); el && el !== document.body; el = el.parentElement) {
      shellElements.add(el);
    }

    Array.from(shellElements).forEach(el => {
      setImportant(el, 'box-sizing', 'border-box');
      setImportant(el, 'columns', 'auto');
      setImportant(el, 'contain', 'none');
      setImportant(el, 'container-type', 'normal');
      setImportant(el, 'height', 'auto');
      setImportant(el, 'max-height', 'none');
      setImportant(el, 'min-height', '0');
      setImportant(el, 'min-width', '0');
      setImportant(el, 'overflow', 'visible');
      setImportant(el, 'transform', 'none');
      setImportant(el, 'width', '100%');
      setImportant(el, 'max-width', '100%');
    });

    Array.from(shellElements)
      .filter(Boolean)
      .forEach(el => {
        if (el === document.documentElement || el === document.body) return;
        setImportant(el, 'align-items', 'stretch');
        setImportant(el, 'display', 'flex');
        setImportant(el, 'flex-flow', 'column nowrap');
        setImportant(el, 'justify-content', 'flex-start');
      });

    const main = document.querySelector('main');
    if (main) {
      Array.from(main.children).forEach(el => {
        setImportant(el, 'align-self', 'stretch');
        setImportant(el, 'box-sizing', 'border-box');
        setImportant(el, 'clear', 'both');
        setImportant(el, 'display', 'block');
        setImportant(el, 'flex', '0 0 auto');
        setImportant(el, 'float', 'none');
        setImportant(el, 'min-width', '0');
        setImportant(el, 'position', 'relative');
        setImportant(el, 'width', '100%');
        setImportant(el, 'max-width', el.id === 'gallery' ? '100%' : 'var(--container-size-xl, 82.5rem)');
        setImportant(el, 'margin-left', 'auto');
        setImportant(el, 'margin-right', 'auto');
      });
    }

    $$('.scroll-area > footer, .sticky').forEach(el => {
      setImportant(el, 'clear', 'both');
      setImportant(el, 'display', 'block');
      setImportant(el, 'float', 'none');
      setImportant(el, 'position', 'static');
      setImportant(el, 'transform', 'none');
      setImportant(el, 'width', '100%');
      setImportant(el, 'max-width', '100%');
    });

    $$('#gallery .mx-auto.flex.justify-center.gap-4').forEach(el => {
      setImportant(el, 'align-items', 'flex-start');
      setImportant(el, 'justify-content', 'flex-start');
      setImportant(el, 'margin-left', 'auto');
      setImportant(el, 'margin-right', 'auto');
      setImportant(el, 'max-width', '100%');
      setImportant(el, 'overflow', 'visible');
      setImportant(el, 'width', 'max-content');
    });

    $$('#gallery [class*="MasonryContainer"]').forEach(el => {
      setImportant(el, 'box-sizing', 'border-box');
      setImportant(el, 'width', '100%');
      setImportant(el, 'max-width', '100%');
    });

    $$('[class*="ModelCarousel_reactions"], #gallery [class*="ImagesAsPostsCard_reactions"]').forEach(el => {
      setImportant(el, 'display', 'none');
    });

    $$(IMAGE_CONTROL_SELECTOR).forEach(el => {
      setImportant(el, 'display', 'none');
    });

    hideIconControls('svg.tabler-icon-info-circle', '[data-tour="model:start"], #gallery');
  }

  function restoreModelHeaderLayout() {
    const root = document.querySelector('[data-tour="model:start"]');
    const grid = root?.querySelector('.mantine-Grid-inner');
    const gridRoot = grid?.closest('.mantine-Grid-root');
    if (!grid || !gridRoot) return false;

    const columns = Array.from(grid.children).filter(col => col.classList?.contains('mantine-Grid-col'));
    // Civitai's CSS-module compiler changed the separators and hash position.
    // Match the component and role within a single token, not its generated hash.
    const mainColumn = columns.find(col => Array.from(col.classList).some(token =>
      token.startsWith('ModelVersionDetails') && /(?:_|__)mainSection(?:__|$)/.test(token)));
    // Unknown markup must not turn every column into a narrow sidebar.
    if (!mainColumn || columns.length !== 2) return false;

    gridRoot.setAttribute('data-archiver-model-header', '1');

    setImportant(gridRoot, 'align-items', 'flex-start');
    setImportant(gridRoot, 'display', 'flex');
    setImportant(gridRoot, 'flex-flow', 'row nowrap');
    setImportant(gridRoot, 'gap', 'var(--mantine-spacing-xl, 2rem)');
    setImportant(gridRoot, 'justify-content', 'center');
    setImportant(gridRoot, 'margin', '0');
    setImportant(gridRoot, 'width', '100%');

    setImportant(grid, 'display', 'contents');
    setImportant(grid, 'margin', '0');

    columns.forEach(col => {
      const isMain = col === mainColumn;
      col.setAttribute('data-archiver-column', isMain ? 'main' : 'sidebar');

      setImportant(col, 'box-sizing', 'border-box');
      setImportant(col, 'grid-area', 'auto');
      setImportant(col, 'min-width', '0');
      setImportant(col, 'order', isMain ? '1' : '2');
      setImportant(col, 'padding', '0');

      if (isMain) {
        setImportant(col, 'flex', '1 1 0');
        setImportant(col, 'max-width', 'calc(100% - min(26rem, 34%) - var(--mantine-spacing-xl, 2rem))');
        setImportant(col, 'width', 'auto');
      } else {
        setImportant(col, 'flex', '0 0 min(26rem, 34%)');
        setImportant(col, 'max-width', '26rem');
        setImportant(col, 'width', 'min(26rem, 34%)');
      }
    });

    return true;
  }

  function pinMainSectionHeights() {
    const main = document.querySelector('main');
    if (!main) return 0;

    let pinned = 0;
    Array.from(main.children).forEach(el => {
      const height = Math.ceil(Math.max(el.scrollHeight || 0, el.getBoundingClientRect?.().height || 0));
      if (height <= 0) return;
      setImportant(el, 'min-height', `${height}px`);
      pinned += 1;
    });
    return pinned;
  }

  async function prepare() {
    const headerLayout = restoreModelHeaderLayout();
    ensureLayoutStyle();
    applyStaticInlineLayout();
    await new Promise(resolve => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve);
      else setTimeout(resolve, 16);
    });
    const pinnedSections = pinMainSectionHeights();
    await new Promise(resolve => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve);
      else setTimeout(resolve, 16);
    });
    return {
      layoutStyle: Boolean(document.getElementById(STYLE_ID_LAYOUT)),
      headerLayout,
      inlineStyled: document.querySelectorAll(`[${ATTR_ORIGINAL_STYLE}]`).length,
      pinnedSections,
      sentinel: document.documentElement.getAttribute(ATTR_PREP) === '1'
    };
  }

  function cleanup() {
    const s = document.getElementById(STYLE_ID_LAYOUT);
    if (s) s.remove();

    document.querySelectorAll(`[${ATTR_ORIGINAL_STYLE}]`).forEach(el => {
      const original = el.getAttribute(ATTR_ORIGINAL_STYLE);
      if (original) {
        el.setAttribute('style', original);
      } else {
        el.removeAttribute('style');
      }
      el.removeAttribute(ATTR_ORIGINAL_STYLE);
    });

    document.documentElement.removeAttribute(ATTR_PREP);
    $$('[data-archiver-column]').forEach(el => el.removeAttribute('data-archiver-column'));
    $$('[data-archiver-model-header]').forEach(el => el.removeAttribute('data-archiver-model-header'));
  }

  window.__archiverPrepareLayout = { prepare, cleanup };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ARCHIVER_STOP') {
      cleanup();
    }
  });

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

  async function prepare() {
    const stats = await guardOverlays(getGalleryRoot(), 1200);
    // tiny extra settle so BG will almost always catch overlays in paint
    await new Promise(r => setTimeout(r, 30));
    return stats;
  }

  window.__archiverPrepareOverlays = { prepare, cleanup: cleanupOverlays };

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'ARCHIVER_STOP') {
      cleanupOverlays();
    }
  });

  window.addEventListener('beforeunload', cleanupOverlays, { once: true });
})();
