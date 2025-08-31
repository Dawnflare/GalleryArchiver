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
    // New selector for videos inside the same gallery anchors:
    const SEL_ANCHOR_VIDEO = 'a[href*="/images/"] video, a[href^="/images/"] video';

    function absUrl(href) {
      try { return new URL(href, location.origin).toString(); } catch { return href; }
    }

    // --- Helpers ---
    function blobToDataURL(blob) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onloadend = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
    }

    // Return BOTH data URL and the MIME type we actually got back.
    async function fetchAsDataURLWithType(url) {
      const r = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
      if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
      const b = await r.blob();
      const dataUrl = await blobToDataURL(b);
      return { dataUrl, mime: b.type || '' };
    }

    // Prefer WEBM if available, else MP4, else currentSrc/src.
    function findPreferredVideoSource(videoEl) {
      const sources = [...videoEl.querySelectorAll('source')];
      const byType = (t) => sources.find(s => (s.type || '').toLowerCase() === t)?.src;
      const byExt  = (re) => sources.map(s => s.src).find(u => re.test(u || ''));

      return (
        byType('video/webm') ||
        byExt(/\.webm($|\?)/i) ||
        byType('video/mp4') ||
        byExt(/\.mp4($|\?)/i) ||
        videoEl.currentSrc ||
        videoEl.src ||
        null
      );
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

    async function inlineSingleVideoBinary(videoEl, { inlinePoster = true } = {}) {
      try {
        const srcUrl = findPreferredVideoSource(videoEl);
        if (!srcUrl) return { ok: false, reason: 'no-src' };

        // Fetch the video bytes and get the true MIME (CDN may return mp4 even for .webm path)
        const { dataUrl, mime } = await fetchAsDataURLWithType(srcUrl);

        // Poster is optional; inlining improves first frame offline
        let posterAttr = videoEl.poster || null;
        if (inlinePoster && posterAttr) {
          try {
            const poster = await fetchAsDataURLWithType(posterAttr);
            posterAttr = poster.dataUrl;
          } catch {
            /* keep original poster URL if inline fails */
          }
        }

        // Build replacement <video> that autoplays + loops offline (muted is required for autoplay)
        const nv = document.createElement('video');
        nv.muted = true;
        nv.loop = true;
        nv.autoplay = true;
        nv.playsInline = true;
        nv.setAttribute('playsinline', '');
        nv.setAttribute('preload', 'auto');

        // Preserve layout/appearance
        if (videoEl.getAttribute('style')) nv.setAttribute('style', videoEl.getAttribute('style'));
        if (videoEl.className) nv.className = videoEl.className;
        if (posterAttr) nv.setAttribute('poster', posterAttr);

        // Data-source with correct MIME
        const source = document.createElement('source');
        source.src = dataUrl;
        if (mime) source.type = mime;
        nv.appendChild(source);

        videoEl.replaceWith(nv);
        return { ok: true };
      } catch (err) {
        console.error('inlineSingleVideoBinary failed', err);
        return { ok: false, reason: String(err) };
      }
    }

    async function inlineVideosForSnapshot(maxConcurrent = 3) {
      const videos = [...document.querySelectorAll(SEL_ANCHOR_VIDEO)]
        .filter(v => v.closest('a[href*="/images/"], a[href^="/images/"]'));

      let i = 0, inlined = 0, failed = 0;

      async function worker() {
        while (i < videos.length) {
          const v = videos[i++];
          try {
            const res = await inlineSingleVideoBinary(v, { inlinePoster: true });
            if (res.ok) inlined++; else failed++;
          } catch {
            failed++;
          }
        }
      }

      await Promise.all(Array(Math.min(maxConcurrent, videos.length)).fill(0).map(() => worker()));
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
      if (msg?.type === 'ARCHIVER_PREPARE_FOR_SAVE') {
        inlineVideosForSnapshot(3)
          .then((stats) => {
            // If your current flow freezes the page before saving, keep it here or in background.
            // freezePage();
            setTimeout(() => sendResponse({ ok: true, stats }), 150);
          })
          .catch((err) => {
            console.error('prepare-for-save failed', err);
            setTimeout(() => sendResponse({ ok: false, error: String(err) }), 150);
          });
        return true;
      }
    });

    // Dev helper (console): window.__civitaiArchiverStart()
    window.__civitaiArchiverStart = startRunning;
    window.__civitaiArchiverStop = () => stopRunning(true);

      if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
          absUrl,
          pickBestFromSrcset,
          isTinyDataURI,
          blobToDataURL,
          fetchAsDataURLWithType,
          findPreferredVideoSource,
          inlineSingleVideoBinary,
          inlineVideosForSnapshot
        };
      }
  })();
