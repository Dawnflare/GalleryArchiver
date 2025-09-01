/* Content script (debug build v3)
 * Goals
 *  - Keep existing image capture & autoscroll behaviour from your main branch.
 *  - At SAVE time build a STATIC SNAPSHOT container that we fully control,
 *    which contains:
 *      • <img> clones for images (remote src is fine — MHTML captures them)
 *      • <video src="data:..."> for videos (inline bytes so they play offline)
 *  - Hide the live React app during snapshot so React cannot revert our changes.
 *  - Add clear logs and a couple of dev helpers.
 */

(() => {
  const DEBUG = true;
  const log  = (...a) => { if (DEBUG) console.log('[Archiver]', ...a); };
  const warn = (...a) => console.warn('[Archiver]', ...a);

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
    snapshotEl: null,
  };

  // --- selectors ---
  const SEL_ANCHOR_IMG = 'a[href*="/images/"] img, a[href^="/images/"] img';
  const SEL_ANCHOR_BG  = 'a[href*="/images/"], a[href^="/images/"]';
  const SEL_ANY_VIDEO  = 'video';

  // --- utils ---
  const absUrl = (href) => { try { return new URL(href, location.origin).toString(); } catch { return href; } };

  function ensureBucket() {
    if (!state.bucket) {
      const d = document.createElement('div');
      d.id = 'civitai-archiver-bucket';
      d.style.display = 'none';
      document.body.appendChild(d);
      state.bucket = d;
    }
  }

  function postStats() { chrome.runtime.sendMessage({ type:'ARCHIVER_STATS', seen:state.seen, captured:state.captured, deduped:state.deduped, total:state.allImageUrls.size }); }
  function postState() { chrome.runtime.sendMessage({ type:'ARCHIVER_STATE', running:state.running, captured:state.captured, maxItems:state.maxItems }); }

  const blobToDataURL = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onloadend = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
  async function fetchAsDataURLWithType(url) { const r = await fetch(url, { mode:'cors', credentials:'omit', cache:'force-cache' }); if (!r.ok) throw new Error('fetch '+r.status); const b = await r.blob(); return { dataUrl: await blobToDataURL(b), mime: b.type || '' }; }

  function pickBestFromSrcset(img) {
    const ss = img.getAttribute('srcset');
    if (!ss) return img.currentSrc || img.src || null;
    const candidates = ss.split(',').map(s => s.trim()).map(token => {
      const m = token.match(/^(.*)\s+(\d+)(w|x)$/);
      if (m) return { url: absUrl(m[1].trim()), width: parseInt(m[2], 10) };
      return { url: absUrl(token.split(/\s+/)[0]), width: 0 };
    }).sort((a,b) => b.width - a.width);
    return candidates[0]?.url || img.currentSrc || img.src || null;
  }

  function finalizeIfGood(imgEl) { return new Promise((resolve) => { const done = () => resolve(true); if (imgEl.complete && imgEl.naturalWidth>0) return done(); imgEl.addEventListener('load', done, { once:true }); imgEl.addEventListener('error', () => resolve(false), { once:true }); }); }

  function stabilityWatcher(targetEl, timeoutMs, onStable) {
    let timer = null;
    const mo = new MutationObserver(() => { if (timer) clearTimeout(timer); timer = setTimeout(() => { mo.disconnect(); onStable(); }, timeoutMs); });
    mo.observe(targetEl, { attributes:true, attributeFilter:['src','srcset','style','class'] });
    timer = setTimeout(() => { mo.disconnect(); onStable(); }, timeoutMs);
  }

  function findPreferredVideoSource(videoEl) {
    const sources = [...videoEl.querySelectorAll('source')];
    const byType = (t) => sources.find(s => (s.type||'').toLowerCase() === t)?.src;
    const byExt  = (re) => sources.map(s => s.src).find(u => re.test(u||''));
    return (
      byType('video/webm') || byExt(/\.webm($|\?)/i) ||
      byType('video/mp4')  || byExt(/\.mp4($|\?)/i)  ||
      videoEl.currentSrc || videoEl.src || null
    );
  }

  // --- image capture (unchanged from your main branch) ---
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
      const style = getComputedStyle(a); const bg = style.backgroundImage;
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

  // --- observer & scrolling (kept close to main branch) ---
  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(() => { if (!state.running || state.captured >= state.maxItems) return; scanOnce(); });
    state.observer.observe(document.documentElement, { childList:true, subtree:true, attributes:true });
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
    log('autoscroll using:', scrollEl.tagName, scrollEl.id || scrollEl.className || '');
    state.lastNewItemAt = performance.now();
    while (state.running) {
      const before = state.captured;
      try { scrollEl.scrollBy(0, scrollEl.clientHeight * 0.9); } catch { window.scrollBy(0, window.innerHeight * 0.9); }
      await new Promise(r => setTimeout(r, state.scrollDelay));
      if (!state.running) break;
      scanOnce();
      const now = performance.now();
      if (state.captured > before) state.lastNewItemAt = now;
      else if (now - state.lastNewItemAt > 6000) {
        try { scrollEl.scrollBy(0, 60); } catch { window.scrollBy(0, 60); }
        await new Promise(r => setTimeout(r, state.scrollDelay));
        scanOnce();
      }
    }
  }

  function applyScrollStyles() {
    state.origHtmlStyle = document.documentElement.getAttribute('style') || '';
    state.origBodyStyle = document.body.getAttribute('style') || '';
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
    // Show our snapshot, hide the live app.
    if (state.snapshotEl) state.snapshotEl.style.display = '';
    const app = document.querySelector('body > div#app, body > div#__next, main') || document.body;
    if (app) app.style.visibility = 'hidden';
  }

  function unfreezePage() {
    const app = document.querySelector('body > div#app, body > div#__next, main') || document.body;
    if (app) app.style.removeProperty('visibility');
    if (state.snapshotEl) state.snapshotEl.style.display = 'none';
  }

  // --- SNAPSHOT BUILD ---
  async function buildSnapshotContainer() {
    // Remove any previous snapshot
    if (state.snapshotEl) state.snapshotEl.remove();

    const wrap = document.createElement('div');
    wrap.id = 'archiver-snapshot';
    wrap.style.cssText = [
      'position: relative;',
      'z-index: 99999;',
      'padding: 24px;',
      'display: grid;',
      'grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));',
      'gap: 12px;',
      'background: #111;',
      'color: #eee;',
    ].join('');

    const cards = collectGalleryCards();
    log('snapshot: cards found', cards.length);

    for (const c of cards) {
      const a = document.createElement('a');
      a.href = c.href || '#';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.cssText = 'display:block; border-radius:10px; overflow:hidden; background:#222;';

      if (c.kind === 'video') {
        try {
          const { dataUrl } = await fetchAsDataURLWithType(c.videoSrc);
          const v = document.createElement('video');
          v.setAttribute('muted',''); v.muted = true; // ensures autoplay
          v.setAttribute('autoplay',''); v.autoplay = true;
          v.setAttribute('loop',''); v.loop = true;
          v.setAttribute('playsinline',''); v.playsInline = true;
          v.setAttribute('preload','auto');
          if (c.poster) v.setAttribute('poster', c.poster);
          v.src = dataUrl;
          v.style.width = '100%'; v.style.height = '100%'; v.style.objectFit = 'cover';
          a.appendChild(v);
        } catch (e) {
          const fallback = document.createElement('div');
          fallback.textContent = 'Video failed: ' + (e?.message||e);
          fallback.style.padding='8px';
          a.appendChild(fallback);
        }
      } else {
        const img = document.createElement('img');
        img.src = c.imgSrc;
        img.loading = 'eager';
        img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'cover';
        a.appendChild(img);
      }
      wrap.appendChild(a);
    }

    document.body.appendChild(wrap);
    state.snapshotEl = wrap;
    return { total: cards.length };
  }

  function collectGalleryCards() {
    const out = [];

    // 1) video cards
    document.querySelectorAll(SEL_ANY_VIDEO).forEach(v => {
      const anchor = findDetailAnchorNearby(v);
      const src = findPreferredVideoSource(v);
      if (src) out.push({ kind:'video', videoSrc: src, poster: v.poster || null, href: anchor?.href || null });
    });

    // 2) image cards (img inside anchor)
    document.querySelectorAll(SEL_ANCHOR_IMG).forEach(img => {
      const a = img.closest('a');
      const src = pickBestFromSrcset(img) || img.src || img.currentSrc;
      if (a && src) out.push({ kind:'img', imgSrc: absUrl(src), href: absUrl(a.href) });
    });

    // 3) image cards (CSS background)
    document.querySelectorAll(SEL_ANCHOR_BG).forEach(a => {
      const m = getComputedStyle(a).backgroundImage.match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1]) out.push({ kind:'img', imgSrc: absUrl(m[1]), href: absUrl(a.href) });
    });

    // Dedup by href+src
    const seen = new Set();
    return out.filter(c => {
      const key = (c.href||'') + '|' + (c.kind==='video' ? c.videoSrc : c.imgSrc);
      if (seen.has(key)) return false; seen.add(key); return true;
    });
  }

  function findDetailAnchorNearby(el) {
    let n = el; for (let d=0; n && d<6; d++) { const a = n.querySelector?.('a[href*="/images/"], a[href^="/images/"]'); if (a) return a; n = n.parentElement; }
    return el.closest && el.closest('a[href*="/images/"], a[href^="/images/"]') || null;
  }

  // --- lifecycle ---
  async function startRunning() {
    if (state.running) return;
    state.running = true;
    state.seen = 0; state.captured = 0; state.deduped = 0;
    state.seenDetailUrls.clear(); state.allImageUrls = new Set();

    const opts = await new Promise(resolve => chrome.storage.local.get({ maxItems:100, scrollDelay:300, stabilityTimeout:400 }, resolve));
    state.maxItems = parseInt(opts.maxItems,10)||100;
    state.scrollDelay = parseInt(opts.scrollDelay,10)||300;
    state.stabilityTimeout = parseInt(opts.stabilityTimeout,10)||400;

    document.querySelectorAll('img').forEach(img => { const url = pickBestFromSrcset(img)||img.currentSrc||img.src; if (url) state.allImageUrls.add(absUrl(url)); });
    postStats(); postState(); ensureBucket(); startObserver();
    state.scrollEl = getScrollElement(); try { state.scrollEl.scrollTo(0, 0); } catch {}
    scanOnce();
    applyScrollStyles();
    autoScrollLoop();
  }

  function stopRunning(freeze=false, restoreStyles=true) {
    state.running = false;
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    if (state.scrollTimer) { clearTimeout(state.scrollTimer); state.scrollTimer = null; }
    state.scrollEl = null;
    if (freeze) {
      // freeze will be handled during prepare (we show snapshot then)
    } else if (restoreStyles) {
      restoreScrollStyles(); if (state.bucket) { state.bucket.remove(); state.bucket=null; }
      if (state.snapshotEl) { state.snapshotEl.remove(); state.snapshotEl=null; }
    }
    postState();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'ARCHIVER_START') startRunning();
    if (msg?.type === 'ARCHIVER_STOP') stopRunning(true);
    if (msg?.type === 'ARCHIVER_RESET') { stopRunning(false); sendResponse(); }
    if (msg?.type === 'ARCHIVER_PREPARE_FOR_SAVE') {
      (async () => {
        try {
          const cards = await buildSnapshotContainer();
          freezePage();
          // Give layout a short settle so pageCapture sees the snapshot
          await new Promise(r => setTimeout(r, 300));
          log('prepare: snapshot ready', cards);
          sendResponse({ ok:true, stats:{ snapshot: cards.total } });
        } catch (e) {
          warn('prepare failed', e);
          sendResponse({ ok:false, error:String(e) });
        }
      })();
      return true;
    }
  });

  // Dev helpers
  window.__archiverBuildSnapshot = buildSnapshotContainer;
  window.__archiverStart = startRunning;
  window.__archiverStop  = () => stopRunning(true);
})();
