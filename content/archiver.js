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
    items: new Map(), // key -> { detailUrl, mediaUrl, el, state }
    seenDetailUrls: new Set(), // dedupe by detail link
    allMediaUrls: new Set(), // every media destined for archive
    observer: null,
    scrollTimer: null,
    lastNewItemAt: 0,
    bucket: null,
    scrollEl: null,
    origHtmlStyle: '',
    origBodyStyle: '',
  };

  const SEL_ANCHOR_IMG = 'a[href*="/images/"] img, a[href^="/images/"] img';
  const SEL_ANCHOR_VIDEO = 'a[href*="/images/"] video, a[href^="/images/"] video';
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
      total: state.allMediaUrls.size
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

  async function fetchAsDataUrl(url) {
    try {
      const res = await fetch(url, { mode: 'cors' });
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }

  function finalizeVideo(videoEl) {
    return new Promise((resolve) => {
      const done = () => resolve(true);
      if (videoEl.readyState >= 2) return done(); // HAVE_CURRENT_DATA
      videoEl.addEventListener('loadeddata', done, { once: true });
      videoEl.addEventListener('error', () => resolve(false), { once: true });
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
      state.allMediaUrls.add(absUrl(bestNow));
      postStats();
      postState();

      if (state.captured >= state.maxItems) stopRunning(false, false);
    });

    postStats();
  }

  function processAnchorVideo(anchor, video) {
    if (!state.running || state.captured >= state.maxItems) return;
    const detailUrl = absUrl(anchor.getAttribute('href') || '');
    if (!detailUrl) return;

    if (state.seenDetailUrls.has(detailUrl)) return;
    state.seenDetailUrls.add(detailUrl);
    state.seen++;

    const initialUrl = video.currentSrc || video.src || (video.querySelector('source')?.src) || '';

    stabilityWatcher(video, state.stabilityTimeout, async () => {
      if (!state.running || state.captured >= state.maxItems) return;
      const bestNow = video.currentSrc || video.src || (video.querySelector('source')?.src) || initialUrl;
      if (!bestNow) return;

      const dataUrl = await fetchAsDataUrl(absUrl(bestNow));
      if (!dataUrl) return;

      const cloneVid = document.createElement('video');
      cloneVid.src = dataUrl;
      cloneVid.controls = true;
      state.bucket.appendChild(cloneVid);
      cloneVid.load();
      const ok = await finalizeVideo(cloneVid);
      if (!ok || !state.running) {
        cloneVid.remove();
        return;
      }

      state.captured++;
      state.deduped = state.seenDetailUrls.size;
      state.lastNewItemAt = performance.now();
      state.allMediaUrls.add(absUrl(bestNow));
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

    // VIDEO-based cards
    document.querySelectorAll(SEL_ANCHOR_VIDEO).forEach(video => {
      if (state.captured >= state.maxItems) return;
      const a = video.closest('a');
      if (a) processAnchorVideo(a, video);
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
            state.allMediaUrls.add(absUrl(url));
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
    state.allMediaUrls = new Set();
    // Load options before starting capture
    const opts = await new Promise(resolve => {
    chrome.storage.local.get({ maxItems: 100, scrollDelay: 300, stabilityTimeout: 400 }, resolve);
    });
    state.maxItems = parseInt(opts.maxItems, 10) || 100;
    state.scrollDelay = parseInt(opts.scrollDelay, 10) || 300;
    state.stabilityTimeout = parseInt(opts.stabilityTimeout, 10) || 400;
    // Collect any media already on the page
    document.querySelectorAll('img').forEach(img => {
      const url = pickBestFromSrcset(img) || img.currentSrc || img.src;
      if (url) state.allMediaUrls.add(absUrl(url));
    });
    document.querySelectorAll('video').forEach(v => {
      const url = v.currentSrc || v.src || (v.querySelector('source')?.src);
      if (url) state.allMediaUrls.add(absUrl(url));
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
