/* Content script: core hoarding, anti-placeholder, auto-scroll */

(() => {
  const state = {
    running: false,
    seen: 0,
    maxItems: 100,
    items: new Map(), // key -> { detailUrl, imageUrl, el, state }
    seenDetailUrls: new Set(), // dedupe by detail link
    observer: null,
    scrollTimer: null,
    lastNewItemAt: 0,
    scrollEl: null,
  };

  const SEL_ANCHOR_IMG = 'a[href*="/images/"] img, a[href^="/images/"] img';
  const SEL_ANCHOR_BG = 'a[href*="/images/"], a[href^="/images/"]';

  function absUrl(href) {
    try { return new URL(href, location.origin).toString(); } catch { return href; }
  }

  function postStats() {
    chrome.runtime.sendMessage({
      type: 'ARCHIVER_STATS',
      seen: state.seen,
      loaded: state.seenDetailUrls.size,
      deduped: state.seenDetailUrls.size
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

  function processAnchorImg(anchor, img) {
    if (!state.running || state.seenDetailUrls.size >= state.maxItems) return;
    const detailUrl = absUrl(anchor.getAttribute('href') || '');
    if (!detailUrl) return;

    const bestUrl = pickBestFromSrcset(img) || img.src || '';
    if (!bestUrl || isTinyDataURI(bestUrl)) return;

    if (state.seenDetailUrls.has(detailUrl)) return;
    state.seenDetailUrls.add(detailUrl);
    state.seen++;
    state.lastNewItemAt = performance.now();
    postStats();

    if (state.seenDetailUrls.size >= state.maxItems) stopRunning();
  }

  function scanOnce() {
    if (!state.running || state.seenDetailUrls.size >= state.maxItems) return;
    // IMG-based cards
    document.querySelectorAll(SEL_ANCHOR_IMG).forEach(img => {
      if (state.seenDetailUrls.size >= state.maxItems) return;
      const a = img.closest('a');
      if (a) processAnchorImg(a, img);
    });

    // CSS background-image anchors (fallback)
    document.querySelectorAll(SEL_ANCHOR_BG).forEach(a => {
      if (state.seenDetailUrls.size >= state.maxItems) return;
      const style = getComputedStyle(a);
      const bg = style.backgroundImage;
      if (bg && bg !== 'none') {
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        if (m && m[1]) {
          const url = absUrl(m[1]);
          if (!url || isTinyDataURI(url)) return;
          const detailUrl = absUrl(a.getAttribute('href') || '');
          if (!detailUrl || state.seenDetailUrls.has(detailUrl)) return;
          state.seenDetailUrls.add(detailUrl);
          state.seen++;
          state.lastNewItemAt = performance.now();
          postStats();
          if (state.seenDetailUrls.size >= state.maxItems) stopRunning();
        }
      }
    });
  }

  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(() => {
      if (!state.running || state.seenDetailUrls.size >= state.maxItems) return;
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
      const before = state.seenDetailUrls.size;
      scrollEl.scrollBy(0, scrollEl.clientHeight * 0.9);
      await new Promise(r => setTimeout(r, 600));

      scanOnce();

      // If no progress for a while, attempt a nudge; break if truly stalled
      const now = performance.now();
      if (state.seenDetailUrls.size > before) {
        state.lastNewItemAt = now;
      } else if (now - state.lastNewItemAt > 6000) {
        // try a stutter scroll
        scrollEl.scrollBy(0, 50);
        await new Promise(r => setTimeout(r, 400));
        scanOnce();
        if (performance.now() - state.lastNewItemAt > 10000) {
          // No new items for 10s — stop
          stopRunning();
          break;
        }
      }

      const canScroll = (scrollEl.scrollHeight - scrollEl.clientHeight) > 100;
      const nearBottom = (scrollEl.scrollTop + scrollEl.clientHeight) >= (scrollEl.scrollHeight - 50);
      if (canScroll && nearBottom) {
        // likely end of page
        stopRunning();
        break;
      }
    }
  }

  async function startRunning() {
    if (state.running) return;
    state.running = true;
    // Load options before starting capture
    const opts = await new Promise(resolve => {
      chrome.storage.local.get({ maxItems: 100 }, resolve);
    });
    state.maxItems = parseInt(opts.maxItems, 10) || 100;
    startObserver();
    state.scrollEl = getScrollElement();
    state.scrollEl.scrollTo(0, 0);
    scanOnce();
    autoScrollLoop();
  }

  function stopRunning() {
    state.running = false;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'ARCHIVER_START') startRunning();
    if (msg?.type === 'ARCHIVER_STOP') stopRunning();
  });

    // Dev helper (console): window.__civitaiArchiverStart()
    window.__civitaiArchiverStart = startRunning;
    window.__civitaiArchiverStop = stopRunning;

    if (typeof module !== 'undefined' && module.exports) {
      module.exports = { absUrl, pickBestFromSrcset, isTinyDataURI };
    }
  })();
