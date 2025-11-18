# Tensor.Art Support – Design & Implementation Guide

**Repo:** `Dawnflare/GalleryArchiver`  
**Scope:** Add first-class support for **Tensor.Art** infinite galleries without breaking existing **Civitai** behavior.

---

## 1) Objectives

- Capture **all** images from Tensor.Art infinite/virtualized galleries into the saved **MHTML**, including tiles that were off-screen.
- Keep the **existing Civitai flow** intact (autoscroll, #archiver-cache, PREPARE → pageCapture, yellow ▶ overlay for video posters, scoped layout for Civitai only).
- Avoid layout side-effects on live pages.
- Keep changes localized, testable, and easy to extend to additional hosts.

---

## 2) Constraints & Observations

From diagnostics on `tensor.art`:

- Grid tiles are **virtualized** and **absolutely positioned** (e.g., `transform: translate(...)`).  
  → Off-screen tiles unmount; we must **clone media into a hidden cache** like we do for Civitai so `pageCapture.saveAsMHTML` picks them up.
- Detail **links aren’t present** on grid cards (modal opens instead of navigation).  
  → We can optionally wrap clones in an `<a target="_blank">` to the **CDN image URL** so the MHTML remains navigable.
- Images use **Cloudflare CDN** like:  
  `https://image.tensorartsassets.com/cdn-cgi/image/...`  
  → Safe to `fetch(url) → blob → dataURL` (CORS friendly).
- Videos are rare; we’ll keep the **poster + yellow ▶ overlay** path if `<video>` appears.
- No need to enforce grid layout (unlike Civitai). We will **not** touch layout for Tensor.Art initially.

---

## 3) Approach

Introduce a **host adapter layer** so each site plugs into the same pipeline:

```ts
type Adapter = {
  getGalleryRoot(): HTMLElement | null;
  selectCards(root: HTMLElement): HTMLElement[]; // one per visual tile
  extractMediaFromCard(card: HTMLElement): {
    type: 'image' | 'video';
    href?: string | null;
    imgEl?: HTMLImageElement | null;
    videoEl?: HTMLVideoElement | null;
  };
  ensureLayout?(root: HTMLElement): void; // optional; no-op for Tensor.Art
};
```

- **Autoscroll** & **PREPARE** call into the current host adapter.  
- **Cache-clone** logic stays unchanged: for each card we clone its media into **`#archiver-cache`**; for images we set **`src=data:`**; for videos we derive a **poster**, bake a yellow ▶ overlay (SVG ⟶ PNG/JPEG), and use that image (we intentionally do NOT retain full videos for MHTML size/compat/perf).
- **Civitai** remains on its current selectors and scoped layout rules.  
- **Tensor.Art** uses resilient selectors with **LCA** (lowest common ancestor) detection and **card normalization**.

---

## 4) Adapter Selection

In `archiver.js`:

```js
const HOST = location.hostname.replace(/^www\./, '');

const adapters = {
  'civitai.com': adapterCivitai,     // existing
  'tensor.art' : adapterTensorArt,   // new
};

const A = adapters[HOST] || adapters['civitai.com'];
```

All call sites that previously used hard-coded Civitai selectors should instead call via `A.getGalleryRoot()`, `A.selectCards(root)`, `A.extractMediaFromCard(card)`, and optionally `A.ensureLayout(root)`.

---

## 5) Tensor.Art Adapter Spec

### 5.1 `getGalleryRoot()`
Use LCA across several visible tiles so we’re robust to Tailwind class churn:

```js
function getGalleryRootTensor() {
  // Grab up to ~40 candidate tile images
  const imgs = Array.from(document.querySelectorAll('article img, div[data-index] img')).slice(0, 40);
  if (!imgs.length) return document.querySelector('main') || document.body;

  const cards = imgs.map(img =>
    img.closest('article, div[data-index], [data-rmiz], .card, .group, .relative, .cursor-pointer')
  ).filter(Boolean);

  if (!cards.length) return document.querySelector('main') || document.body;

  const chains = cards.map(n => {
    const v = [];
    for (let x=n; x && x!==document.documentElement; x=x.parentElement) v.push(x);
    return v;
  });

  for (const cand of chains[0]) {
    if (chains.every(chain => chain.includes(cand))) return cand;
  }
  return document.querySelector('main') || document.body;
}
```

### 5.2 `selectCards(root)`
Normalize to one element per visual tile:

```js
function selectCardsTensor(root) {
  const set = new Set();
  root.querySelectorAll('article img, div[data-index] img').forEach(img => {
    const card = img.closest('article, div[data-index]') || img.parentElement;
    if (card) set.add(card);
  });
  return Array.from(set);
}
```

### 5.3 `extractMediaFromCard(card)`
Prefer image; support future video:

```js
function extractMediaFromCardTensor(card) {
  const img = card.querySelector('img');
  if (img) {
    return { type:'image', imgEl: img, href: null };
  }
  const video = card.querySelector('video');
  if (video) {
    return { type:'video', videoEl: video, href: null };
  }
  return { type:'image', imgEl: null, href: null }; // safe no-op
}
```

### 5.4 `ensureLayout(root)`
No changes needed for Tensor.Art initially (leave undefined or no-op).  
(We only scope layout for Civitai as you already implemented.)

---

## 6) Pipeline (unchanged, now adapter-aware)

1. **Autoscroll loop**
   - Uses adapter’s `getGalleryRoot()` + `selectCards()` to detect new tiles.
   - For each new card: pass to **clone pipeline** (see below).

2. **Clone pipeline (cache)**
   - For **image**:  
     - Resolve `const url = img.currentSrc || img.src`.  
     - `fetch(url)` → `blob` → `dataURL` (no canvas)  
     - Create a **clone** `img` for `#archiver-cache` with that **dataURL**.  
     - **Optional link**: if no in-grid anchor exists, wrap clone in `<a target="_blank" rel="noopener noreferrer" href="{url}">` so the MHTML tile is clickable to CDN original.
   - For **video** (if present on Tensor.Art later):  
     - Derive **poster** image URL (or `video.poster`), fetch → draw glyph → dataURL.  
     - Use baked image clone (do not try to embed whole videos).

3. **PREPARE (before save)**
   - Do a final **pass** to ensure every cached clone has **data URLs**.  
   - Run your **Civitai-scoped layout**; Tensor.Art’s `ensureLayout` is no-op.  
   - Run your **baked glyph overlay** pass for posters (already implemented).

4. **Save**
   - Background calls `pageCapture.saveAsMHTML` after PREPARE success (your current flow).

---

## 7) Manifest updates

In `manifest.json`:

```json
{
  "host_permissions": [
    "https://civitai.com/*",
    "https://tensor.art/*",
    "https://image.tensorartsassets.com/*"
  ],
  "content_scripts": [{
    "matches": [
      "https://civitai.com/*",
      "https://tensor.art/*"
    ],
    "js": ["archiver.js"],
    "run_at": "document_idle"
  }]
}
```

(Add `https://www.tensor.art/*` if needed.)

---

## 8) Detailed Implementation Steps

1. **Branch**
   - Create a feature branch:  
     `git checkout -b feat/tensor-art-adapter`

2. **Refactor adapter selection**
   - In `archiver.js`, add the `adapters` map and selector (`A = adapters[HOST] || ...`).
   - Replace hard-coded Civitai selector calls with adapter method calls:
     - `const root = A.getGalleryRoot()`
     - `const cards = A.selectCards(root)`
     - For each `card`, call `A.extractMediaFromCard(card)`

3. **Add Tensor.Art adapter**
   - Add the 4 functions from §5 (only 3 are required; `ensureLayout` can be omitted).
   - Export/assign to `adapterTensorArt` in the map.

4. **Clone pipeline integration**
   - Reuse your existing cache logic (used on Civitai) but gate **href wrapping**:
     - If the adapter’s `extractMediaFromCard(...).href` is `null` and `type==='image'`, use `img.currentSrc || img.src` for wrapping `<a>` (optional, but UX-nice in MHTML).

5. **Baked ▶ overlay**
   - Leave your **glyph baking** logic as is (runs at PREPARE and produces `data-archiver-overlay="badge"` overlay images).  
   - It will only trigger where we marked posters or where the adapter exposes a video poster image.

6. **Manifest**
   - Update `host_permissions` / `matches` (see §7).

7. **Build & test**
   - Load unpacked in Brave/Chrome.  
   - On **Tensor.Art**:
     - Start autoscroll → ensure cards are detected and cache grows.
     - Save MHTML → verify **all grid items** (including off-screen) are in the file; `img.src` should be `data:image/...`.
     - Confirm MHTML tile links open the CDN image (if you enabled wrapping).  
   - On **Civitai**:
     - Regression test: layout scoping is still only for Civitai; yellow ▶ overlay still visible on video posters; saved file content correct.

8. **PR & merge**
   - Commit with clear message (see template in §11).
   - Open PR, review, merge to `main`.

---

## 9) Testing Checklist

- **Tensor.Art**
  - [ ] Autoscroll increases discovered tile count.
  - [ ] `#archiver-cache` fills with clones (check DOM).
  - [ ] Saved MHTML includes **all** images (scroll the file; ensure beyond initial viewport).
  - [ ] `img[src^="data:image/"]` present for cached tiles.
  - [ ] (Optional) Clicking a tile in MHTML opens the CDN image.

- **Civitai**
  - [ ] No change in autoscroll speed/behavior.
  - [ ] 6-column layout scoping still applied only to the gallery area in MHTML.
  - [ ] Yellow ▶ overlay appears on video posters in MHTML.
  - [ ] Live page restores layout after save.

- **Performance**
  - [ ] Save still starts promptly (your current **100/30 ms** timings).
  - [ ] MHTML size scales with number of images; no abnormal bloat.

---

## 10) Troubleshooting

- **Only viewport images captured**  
  Ensure cache-clone path runs for **every discovered card**, and that **`#archiver-cache`** is present **before** PREPARE/save. Confirm data URLs are set on clones (not live tiles).

- **CORS/tainted canvas**  
  Do **not** draw cross-origin images to `<canvas>` unless you first fetched them as a **blob** and drew from a **blob URL**. For plain images, stick to `fetch → dataURL` assignment—**no canvas needed**.

- **Host CSS drift**  
  If Tensor.Art reflows in MHTML oddly, add a minimal, **scoped** style under the **detected gallery root** only (do not touch header). Follow the pattern you used for Civitai’s scoped CSS.

---

## 11) Commit Message Template

```
feat(tensor-art): add adapter-based support for Tensor.Art galleries

- Introduce adapter layer (getGalleryRoot/selectCards/extractMediaFromCard)
- Implement Tensor.Art adapter (LCA-based root, resilient card selection)
- Reuse cache-clone pipeline to embed data URLs for all tiles (virtualized safe)
- Keep Civitai layout scoping and baked ▶ overlays unchanged
- Update manifest for tensor.art + CDN host permissions
- No user-visible changes on Civitai; Tensor.Art galleries now fully captured
```

---

## 12) Future Enhancements

- Add a **“wrap clones with links”** toggle in the popup (on by default for hosts without per-card anchors).
- Optional **quality control**: allow user to choose a max image width for data URL downscaling to cap MHTML size.
- Add a **host capabilities registry** (e.g., `supports.videoPosters`, `wants.layoutScope`) to avoid `if (host===...)` conditionals.

---

### Appendix: Minimal Code Snippets

**Adapter registry & selection (in `archiver.js`)**
```js
const adapterCivitai = /* existing */;
const adapterTensorArt = {
  getGalleryRoot: getGalleryRootTensor,
  selectCards: selectCardsTensor,
  extractMediaFromCard: extractMediaFromCardTensor,
  // ensureLayout: undefined (no-op)
};

const HOST = location.hostname.replace(/^www\./, '');
const adapters = {
  'civitai.com': adapterCivitai,
  'tensor.art' : adapterTensorArt,
};
const A = adapters[HOST] || adapters['civitai.com'];
```

**Using the adapter in discovery/autoscroll**
```js
const root = A.getGalleryRoot();
const cards = A.selectCards(root);
// For each card:
const media = A.extractMediaFromCard(card);
// -> pass to existing clone pipeline (image/video) writing into #archiver-cache
```

**Image clone pipeline (sketch)**
```js
async function cloneImageToCache(img, cacheRoot, maybeHref) {
  const url = img.currentSrc || img.src;
  const blob = await (await fetch(url)).blob();
  const dataUrl = await blobToDataURL(blob);

  const clone = document.createElement('img');
  clone.src = dataUrl;
  clone.alt = img.alt || '';

  let node = clone;
  if (!maybeHref && url) {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.appendChild(clone);
    node = a;
  }
  cacheRoot.appendChild(node);
}
```
