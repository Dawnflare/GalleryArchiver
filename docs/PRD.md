# Civitai Gallery Archiver — PRD (v1.0 Core)

## 1) Problem
Civitai’s React/virtualized galleries create and remove DOM nodes as you scroll. Standard “Save page” tools miss off‑screen items and often capture temporary blurred placeholders instead of final images.

## 2) Goals (v1 Core)
- Produce **one file**: a single **.mhtml** snapshot that contains:
  - All gallery images encountered during an automated scroll session.
  - A **clickable link** on every saved image that points to its dedicated Civitai image page (`/images/...`).
- Ensure saved images are the **final (non‑placeholder)** versions.
- Make the process **hands‑off**: start → auto‑scroll → freeze → save.

## 3) Non‑Goals (explicitly out for v1)
- Enrichment (author/tags/prompt).
- Alternate exporters (e.g., single‑HTML/data‑URI).
- Headless/CLI capture.
- Deep crawling of linked pages.

## 4) Success Criteria / Acceptance Tests
- After capture, opening the saved **.mhtml** offline shows:
  - ≥99% of images encountered while scrolling.
  - Images appear **sharp** (not obvious blur/LQIP placeholders).
  - Each image is wrapped in an anchor to the correct **absolute** Civitai `/images/...` URL and is clickable.
- Order preserved (top → bottom), duplicates removed.
- Works in Brave (Chromium) without special flags.

## 5) User Stories
- Start simple capture → auto‑scrolls and collects images+links → Save as MHTML → single file containing what I saw.
- Stop anytime and save partial progress.
- Default **Max items = 200** for rapid testing (user can raise later).

## 6) UX / Controls (Popup)
- **Buttons:** Start, Stop, Save as MHTML.
- **Status:** Seen / Captured / Deduped counters; basic progress indicator.
- **Options (v1):** Max items (default 200).
- **Global Shortcuts:** Start (Alt+1), Save (Alt+2), Reset (Alt+F5); configurable via options page and Brave's extension shortcuts menu.

## 7) Technical Approach (Overview)
1. **Hoarding to bypass virtualization:** Create an **Archive Bucket** (`#civitai-archiver-bucket`) appended to `document.body`, outside the app’s React root. As cards appear, clone static entries into the bucket; each clone contains a clickable `<a href="…/images/…"><img/></a>`.

2. **Final image only (anti‑placeholder):**
   - Prefer the highest‑quality candidate from `srcset` (fallback to `src`).
   - Maintain a **stability timer** (≈300–500 ms): any change to `src/srcset/style` resets the timer; finalize only after no changes for the window.
   - **Quality gates:** reject tiny data‑URIs; require `naturalWidth` ≥ (rendered width × 0.8); support `background-image` cards by reading computed styles.
   - `await img.decode()` / `load` before counting as captured.

3. **Auto‑scroll with pacing:** Scroll by ~1 viewport height, wait for new items & brief idle, repeat until end / Max items / stop.

4. **Freeze & Save (one shot):** Hide the live app; reveal static grid from the bucket; background calls **`chrome.pageCapture.saveAsMHTML({tabId})`** and downloads the file.

## 8) Architecture (v1)
- **Content Script**: observer, extraction, bucket cloning, stability checks, auto‑scroll, freeze.
- **Background/Service Worker**: handles MHTML save via `pageCapture` + `downloads`.
- **Popup**: start/stop/save + counters + Max items setting.

## 9) Permissions (MV3)
```json
{
  "host_permissions": ["https://civitai.com/*"],
  "permissions": ["activeTab", "scripting", "downloads", "storage", "pageCapture"]
}
```

## 10) Edge Cases
- Blur/LQIP swaps → stability + quality gates + `srcset` best candidate.
- CSS background‑image cards → parse computed style.
- Expiring URLs → save immediately after freeze; keep clones visible.
- Large runs → default cap 200; warn when increasing.

## 11) Milestones
- M0 Scaffold → M1 Clone (manual scroll) → M2 Auto‑scroll → M3 Freeze & Save → M4 Polish.

## 12) Test Plan
- Multiple Civitai gallery pages; verify images + anchors in `.mhtml`.
- Placeholder handling; stopping at 200; larger caps sanity test.
