/* Content script: core hoarding, anti-placeholder, auto-scroll, freeze */

(() => {
  const state = {
    running: false,
    seen: 0,
    captured: 0,
    deduped: 0,
    maxItems: 100,
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
    chrome.storage.local.get({ maxItems: 100, scrollDelay: 300, stabilityTimeout: 400 }, resolve);
    });
    state.maxItems = parseInt(opts.maxItems, 10) || 100;
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
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'ARCHIVER_START') startRunning();
    if (msg?.type === 'ARCHIVER_STOP') stopRunning(true);
    if (msg?.type === 'ARCHIVER_RESET') {
      stopRunning(false);
      sendResponse();
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
        const to = setTimeout(() => rej(new Error('video load timeout')), 4000);
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
    // 1) Prefer the poster (already optimized on Civitai CDN, tiny and fast)
    if (videoEl.poster) return videoEl.poster;

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
        if (!still) { skipped++; continue; }

        const img = document.createElement('img');
        img.src = still;
        img.alt = 'Video snapshot';
        // Keep sizing consistent with the original gallery cards
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        img.style.display = 'block';

        // Replace the <video> in place; anchor/href stays intact
        v.replaceWith(img);
        v.dataset.archiverFrozen = '1';
        ok++;
      } catch (e) {
        fail++;
      }
    }

    return { processed, ok, fail, skipped, total: vids.length };
  }

  // Message hook: popup will ask us to prepare the DOM before saving
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'ARCHIVER_PREPARE_FOR_SAVE') {
      (async () => {
        try {
          const stats = await freezeVideosInPlace();
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
})();

/* ------------------------------------------------------------------
 * [Archiver] Scope gallery layout to #gallery + bake ▶ onto video stills
 *  - Applies 6-col grid only inside #gallery (header/description unchanged)
 *  - On ARCHIVER_PREPARE_FOR_SAVE: draws a play glyph into the pixels of
 *    any video snapshot image so the icon survives in saved MHTML
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

  /* -------------------------- Play glyph baking -------------------------- */
  function drawPlayOnCanvas(imgEl) {
    // Use displayed size to keep output small and crisp
    const rect    = imgEl.getBoundingClientRect();
    const dispW   = Math.max(1, Math.round(rect.width  || imgEl.naturalWidth  || 450));
    const dispH   = Math.max(1, Math.round(rect.height || imgEl.naturalHeight || 450));

    const c = document.createElement('canvas');
    c.width = dispW; c.height = dispH;
    const ctx = c.getContext('2d');
    try { ctx.drawImage(imgEl, 0, 0, dispW, dispH); } catch (_) { return null; }

    // Badge geometry (top-right)
    const d   = Math.round(Math.min(dispW, dispH) * 0.12); // circle radius
    const pad = Math.max(6, Math.round(d * 0.5));
    const cx  = dispW - pad - d, cy = pad + d;

    // Dark translucent circle
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.beginPath(); ctx.arc(cx, cy, d, 0, Math.PI*2); ctx.fill();

    // White play triangle
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(cx - d * 0.5, cy - d * 0.65);
    ctx.lineTo(cx - d * 0.5, cy + d * 0.65);
    ctx.lineTo(cx + d * 0.6,  cy);
    ctx.closePath(); ctx.fill();

    // JPEG keeps sizes small and blends with photo content
    return c.toDataURL('image/jpeg', 0.9);
  }

  async function bakePlayGlyphs(root) {
    if (!root) return { ok:true, baked:0 };

    // Heuristic: our video stills are data URLs and/or marked by alt text
    const imgs = $$('a[href*="/images/"] img', root).filter(img =>
      (img.src && img.src.startsWith('data:image/')) || /Video snapshot/i.test(img.alt || '')
    ).filter(img => !img.dataset.archiverPlayMarked);

    let baked = 0;
    for (const img of imgs) {
      const url = drawPlayOnCanvas(img);
      if (url) {
        img.src = url;
        img.dataset.archiverPlayMarked = '1';
        baked++;
      }
    }
    return { ok:true, baked };
  }

  /* ------------------------- Message integration ------------------------- */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'ARCHIVER_PREPARE_FOR_SAVE') {
      (async () => {
        try {
          const root = getGalleryRoot();
          ensureGridStyles(root);
          const res = await bakePlayGlyphs(root);
          // tiny settle for paint
          await new Promise(r => setTimeout(r, 30));
          sendResponse(Object.assign({ ok:true }, res));
        } catch (e) {
          sendResponse({ ok:false, error:String(e) });
        }
      })();
      return true; // async
    }
    if (msg.type === 'ARCHIVER_STOP') {
      cleanup();
    }
  });

  // Safety: restore on navigation
  window.addEventListener('beforeunload', cleanup, { once: true });
})();
