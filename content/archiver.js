/* Content script: core hoarding, anti-placeholder, auto-scroll, freeze */

(() => {
  const state = {
    running: false,
    seen: 0,
    captured: 0,
    deduped: 0,
    maxItems: 100,
    items: new Map(), // key -> { detailUrl, imageUrl, el, state }
    seenDetailUrls: new Set(), // dedupe by detail link
    observer: null,
    scrollTimer: null,
    lastNewItemAt: 0,
    bucket: null,
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
      // Inline styles so that saved MHTML doesn't rely on extension CSS
      bucket.style.boxSizing = 'border-box';
      bucket.style.padding = '12px';
      bucket.style.gap = '12px';
      bucket.style.display = 'none';
      bucket.style.flexWrap = 'wrap';
      bucket.style.alignItems = 'flex-start';
      document.body.appendChild(bucket);
      state.bucket = bucket;
    }
  }

  function postStats() {
    chrome.runtime.sendMessage({
      type: 'ARCHIVER_STATS',
      seen: state.seen,
      captured: state.captured,
      deduped: state.deduped
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

  function createCardClone(detailUrl, imageUrl) {
    const article = document.createElement('article');
    // Card styling so items render when saved
    article.style.border = '1px solid rgba(255,255,255,0.1)';
    article.style.borderRadius = '8px';
    article.style.padding = '8px';
    article.style.background = '#111';

    const a = document.createElement('a');
    a.href = detailUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.style.textDecoration = 'none';
    a.style.color = 'inherit';

    const img = document.createElement('img');
    img.src = imageUrl;
    img.style.display = 'block';
    img.style.borderRadius = '6px';

    a.appendChild(img);
    article.appendChild(a);
    state.bucket.appendChild(article);
    return img;
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

    const candidateNow = pickBestFromSrcset(img) || img.src || '';
    const initialUrl = candidateNow;

    // Set up stability gate
    stabilityWatcher(img, 400, async () => {
      if (!state.running || state.captured >= state.maxItems) return;
      const bestNow = pickBestFromSrcset(img) || img.src || initialUrl;
      if (!bestNow || isTinyDataURI(bestNow)) return;
      // Create clone with bestNow
      const cloneImg = createCardClone(detailUrl, bestNow);
      const ok = await finalizeIfGood(cloneImg);
      if (!ok || !state.running) return;

      // Quality gate
      try {
        const w = cloneImg.naturalWidth;
        const rendered = Math.max(1, cloneImg.clientWidth || 200);
        if (w < rendered * 0.8) {
          // Low quality relative to displayed size; ignore
          cloneImg.closest('article')?.remove();
          return;
        }
      } catch {}

      state.captured++;
      state.deduped = state.seenDetailUrls.size;
      state.lastNewItemAt = performance.now();
      postStats();

      // Stop if we hit max
      if (state.captured >= state.maxItems) stopRunning(true);
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

          // Build clone
          stabilityWatcher(a, 400, async () => {
            if (!state.running || state.captured >= state.maxItems) return;
            const cloneImg = createCardClone(detailUrl, url);
            const ok = await finalizeIfGood(cloneImg);
            if (!ok || !state.running) return;
            state.captured++;
            state.deduped = state.seenDetailUrls.size;
            state.lastNewItemAt = performance.now();
            postStats();
            if (state.captured >= state.maxItems) stopRunning(true);
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
    return document.scrollingElement || document.documentElement || document.body;
  }

  async function autoScrollLoop() {
    const scrollEl = getScrollElement();
    state.lastNewItemAt = performance.now();
    while (state.running) {
      const before = state.captured;
      scrollEl.scrollBy(0, scrollEl.clientHeight * 0.9);
      await new Promise(r => setTimeout(r, 600));

      scanOnce();

      // If no progress for a while, attempt a nudge; break if truly stalled
      const now = performance.now();
      if (state.captured > before) {
        state.lastNewItemAt = now;
      } else if (now - state.lastNewItemAt > 6000) {
        // try a stutter scroll
        scrollEl.scrollBy(0, 50);
        await new Promise(r => setTimeout(r, 400));
        scanOnce();
        if (performance.now() - state.lastNewItemAt > 10000) {
          // No new items for 10s — stop
          stopRunning(true);
          break;
        }
      }

      if ((scrollEl.scrollTop + scrollEl.clientHeight) >= (scrollEl.scrollHeight - 50)) {
        // likely end of page
        stopRunning(true);
        break;
      }
    }
  }

  function freezePage() {
    ensureBucket();
    // Hide app root if present
    const appRoot = document.querySelector('#__next') || document.querySelector('#app');
    if (appRoot) appRoot.style.display = 'none';
    // Ensure the page can scroll normally once the live app is hidden
    document.documentElement.style.height = 'auto';
    document.documentElement.style.overflowY = 'auto';
    document.body.style.height = 'auto';
    document.body.style.overflowY = 'auto';
    // Reveal bucket with flex layout
    state.bucket.style.display = 'flex';
  }

  async function startRunning() {
    if (state.running) return;
    state.running = true;
    // Load options before starting capture
    const opts = await new Promise(resolve => {
      chrome.storage.local.get({ maxItems: 100 }, resolve);
    });
    state.maxItems = parseInt(opts.maxItems, 10) || 100;
    ensureBucket();
    startObserver();
    scanOnce();
    autoScrollLoop();
  }

  function stopRunning(freeze=false) {
    state.running = false;
    if (freeze) freezePage();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'ARCHIVER_START') startRunning();
    if (msg?.type === 'ARCHIVER_STOP') stopRunning(true);
  });

    // Dev helper (console): window.__civitaiArchiverStart()
    window.__civitaiArchiverStart = startRunning;
    window.__civitaiArchiverStop = () => stopRunning(true);

    if (typeof module !== 'undefined' && module.exports) {
      module.exports = { absUrl, pickBestFromSrcset, isTinyDataURI };
    }
  })();
