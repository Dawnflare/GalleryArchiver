# Embedding Looping Videos in MHTML (Civitai Gallery Archiver)

> **Goal:** keep the current image workflow **unchanged**, and add a **prepare-for-save** step that inlines the gallery’s **looping videos** so they play offline inside the saved **.mhtml** file.  
> **Scope:** WEBM-first (but MIME-aware — we embed whatever the CDN returns).  
> **Files touched:** `content/archiver.js` and `background.js` only.

---

## Why this works

- Each video card on Civitai is a real `<video>` with `<source>` elements (WEBM + MP4) and a `poster`.  
- The CDN serves these over HTTPS and sends `Access-Control-Allow-Origin: *`, so we can **fetch the bytes** from the page.  
- Before calling `saveAsMHTML`, we convert the chosen video to a **data URL** and replace the live `<video>` with a functionally identical one (`muted autoplay loop playsinline`) whose `<source>` is that data URL.  
- Result: the MHTML contains the **actual video bytes**, so videos **loop offline** next to the images.

Nothing in the image hoarding / counters / scrolling logic changes.

---

## Changes at a glance

1) **`content/archiver.js`**
   - Add a selector for videos in gallery anchors.
   - Add small helpers to fetch a URL as a data URL and to pick the preferred video source.
   - Add `inlineSingleVideoBinary()` to replace one `<video>` with an inlined-source version.
   - Add `inlineVideosForSnapshot()` (batch inliner with small concurrency).
   - Add a message case: `ARCHIVER_PREPARE_FOR_SAVE` → run the batch inliner (and then you can freeze, if that’s your current flow).

2) **`background.js`**
   - In the `ARCHIVER_SAVE_MHTML` handler, first send `ARCHIVER_PREPARE_FOR_SAVE` to the tab, wait for it to finish, then call `chrome.pageCapture.saveAsMHTML`.

---

## Step-by-step patch

### 1) Edit `content/archiver.js`

Add the **selector + helpers** near your other selectors/utilities:

```js
// New selector for videos inside the same gallery anchors:
const SEL_ANCHOR_VIDEO = 'a[href*="/images/"] video, a[href^="/images/"] video';

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
    byExt(/\\.webm($|\\?)/i) ||
    byType('video/mp4') ||
    byExt(/\\.mp4($|\\?)/i) ||
    videoEl.currentSrc ||
    videoEl.src ||
    null
  );
}
```

Add the **single-video inliner** (place near your other DOM routines).  
It **replaces** one `<video>` with an equivalent element whose `<source>` is a `data:` URL.  
It does **not** touch your archive bucket or counters.

```js
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
    const s = document.createElement('source');
    s.src = dataUrl;
    s.type = mime || (/(\\.webm)(?:$|\\?)/i.test(srcUrl) ? 'video/webm'
                 :    /(\\.mp4)(?:$|\\?)/i.test(srcUrl)  ? 'video/mp4'
                 :    '');
    nv.appendChild(s);

    videoEl.replaceWith(nv);
    return { ok: true, type: s.type };
  } catch (e) {
    console.warn('inlineSingleVideoBinary failed', e);
    return { ok: false, reason: String(e) };
  }
}
```

Add the **batch inliner** (small concurrency) and the **message case**:

```js
async function inlineVideosForSnapshot(maxConcurrent = 3) {
  // Only videos that belong to gallery cards (have a /images/... anchor)
  const videos = [...document.querySelectorAll(SEL_ANCHOR_VIDEO)]
    .filter(v => v.closest('a[href*="/images/"], a[href^="/images/"]'));

  let i = 0, inlined = 0, failed = 0;

  async function worker() {
    while (i < videos.length) {
      const v = videos[i++];
      const res = await inlineSingleVideoBinary(v, { inlinePoster: true });
      if (res.ok) inlined++; else failed++;
    }
  }

  await Promise.all(Array(Math.min(maxConcurrent, videos.length)).fill(0).map(worker));
  return { total: videos.length, inlined, failed };
}

// In your existing chrome.runtime.onMessage listener, ADD this case:
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
    return true; // keep the channel open for async sendResponse
  }

  // ...keep your existing cases (ARCHIVER_START, ARCHIVER_STOP, etc.)
});
```

> ⚠️ Do **not** change any image capture logic, counters, or scrolling routines.

---

### 2) Edit `background.js`

In your `chrome.runtime.onMessage.addListener` where you handle `ARCHIVER_SAVE_MHTML`,  
**prepare first**, then snapshot:

```js
if (msg?.type === 'ARCHIVER_SAVE_MHTML') {
  const tabId = msg.tabId;
  if (!tabId) return;

  // 1) Ask the content script to inline WEBMs (and posters), then snapshot
  chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_PREPARE_FOR_SAVE' }, () => {
    // small settle delay
    setTimeout(() => {
      chrome.pageCapture.saveAsMHTML({ tabId }, (mhtmlData) => {
        if (chrome.runtime.lastError) {
          console.error('MHTML save error:', chrome.runtime.lastError.message);
          return;
        }
        const url = URL.createObjectURL(mhtmlData);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        chrome.downloads.download(
          { url, filename: `civitai-archive-${ts}.mhtml` },
          () => setTimeout(() => URL.revokeObjectURL(url), 60_000)
        );
      });
    }, 250);
  });
}
```

This preserves your current UX: **Start / Stop** behave the same; **Save** now silently inlines videos, then creates the `.mhtml`.

---

## Testing

1. **Reload extension** (`brave://extensions` → Developer mode → **Reload**) and **refresh** a Civitai gallery tab.  
2. Click **Start**; watch counters rise; **Stop** (or hit your cap).  
3. Click **Save as MHTML**.  
4. Open the saved `.mhtml`:
   - Images present as before.  
   - Video cards **auto-play and loop** (muted) inline.  
   - Clicking any card still opens the **`/images/...`** page online.  
5. (Optional) `Ctrl+F` for `data:video/` in the saved file to confirm embedding.

---

## Troubleshooting

- **A video slot is still blank offline**  
  - Open DevTools on the *live* page before saving and check for `inlineSingleVideoBinary failed …`.  
  - Usually a transient fetch error; try again or bump concurrency in `inlineVideosForSnapshot(5)`.

- **Autoplay doesn’t start**  
  - Chromium usually allows autoplay when `muted + playsinline` are set (which we do).  
  - If needed, add a tiny script to call `video.play()` on `DOMContentLoaded`/`visibilitychange`.

- **File size large** — expected; we’re embedding media bytes. You asked for this trade-off.

- **Future CDN CORS change**  
  - If CORS breaks, fetch will fail and we’ll log it; you can either keep a **poster fallback** or revert to leaving external video URLs (less reliable for MHTML).

---

## Notes / Options

- We **prefer WEBM**, but if the CDN actually returns `video/mp4` for the URL you chose, we **embed MP4** (MIME-aware).  
- To strictly embed WEBM only, short-circuit when `mime !== 'video/webm'` and fall back to poster — not recommended given your “embed everything” goal.

---

## Copy-paste summary (what to implement)

- **Add** `SEL_ANCHOR_VIDEO`, `blobToDataURL`, `fetchAsDataURLWithType`, `findPreferredVideoSource` to `content/archiver.js`.  
- **Add** `inlineSingleVideoBinary()` and `inlineVideosForSnapshot()` to `content/archiver.js`.  
- **Extend** the content script’s message listener with the `ARCHIVER_PREPARE_FOR_SAVE` case.  
- **Modify** `background.js` so `ARCHIVER_SAVE_MHTML` first sends `ARCHIVER_PREPARE_FOR_SAVE`, waits, then runs `chrome.pageCapture.saveAsMHTML`.  
- **Do not change** existing image capture, counters, auto-scroll, or popup UI.
