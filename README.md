# Gallery Archiver by Dawnflare

Gallery Archiver is a Brave/Chromium extension for saving dynamic gallery pages as a single `.mhtml` archive. It was built for Civitai model and gallery pages, including pages that use infinite scrolling, lazy-loaded images, videos, and layouts that do not save correctly with the browser's native MHTML save.

Supported sites:

- `https://civitai.com/*`
- `https://civitai.red/*`

The extension can autoscroll through galleries, preserve images that would otherwise be unloaded by the page, prepare Civitai layouts for reliable MHTML capture, and open the browser save dialog with a clean archive filename.

## What It Does

- Saves the current page as a single `.mhtml` archive.
- Preserves dynamically loaded Civitai gallery images before they are unloaded by the page.
- Handles many Civitai model pages whose native Brave/Chrome MHTML output has broken columns, overlapping sections, or off-screen galleries.
- Converts gallery videos into still image snapshots where possible, with a visible play badge.
- Opens the save dialog from the page context so Brave/Chromium can reuse the last-used save folder.
- Supports one-click save, start-and-save, and save-all-tabs workflows.
- Provides configurable filenames, timestamps, autoscroll timing, capture limits, and keyboard shortcuts.

## Installation

1. Open Brave or another Chromium browser.
2. Go to `brave://extensions/` or `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this repository folder, `GalleryArchiver/`.
6. Pin the extension if you want quick access to the popup.

The extension requests access only to `civitai.com` and `civitai.red`.

## Basic Workflows

### Save The Current Page

1. Open a Civitai or Civitai Red page.
2. Wait for the visible content you care about to load.
3. Click the extension icon.
4. Click **Save as MHTML**, or press `Alt+2`.
5. Choose where to save the `.mhtml` file.

This is the best workflow for model pages where the visible page is already fully loaded.

### Capture An Infinite Gallery, Then Save

1. Open a gallery page.
2. Set **Max items** in the popup if needed.
3. Click **Start**, or press `Alt+1`.
4. Let the page autoscroll while the extension collects gallery images.
5. Click **Stop** if you want to stop before the limit.
6. Click **Save as MHTML**.

The live counters show how much has been seen and captured.

### Start And Save

Click **Start and Save**, or press `Alt+3`.

This starts the capture process and automatically saves when the configured item limit is reached.

### Save All Tabs

Click **Save all tabs**, or press `Alt+4`.

The extension attempts to save supported HTTP/HTTPS tabs in the current window. Tabs without the needed host permission are skipped.

## Popup Controls

| Control | Default Shortcut | Description |
| --- | --- | --- |
| **Start** | `Alt+1` | Starts autoscroll capture on the active page. |
| **Save as MHTML** | `Alt+2` | Prepares the active page and saves it as `.mhtml`. |
| **Start and Save** | `Alt+3` | Starts capture and saves automatically after the item limit is reached. |
| **Save all tabs** | `Alt+4` | Saves supported tabs in the current browser window. |
| **Reset** | none | Stops capture, resets page state, reloads the tab, and reloads the extension. |
| **Stop** | none | Stops the current capture/autoscroll run. |
| **Options** | none | Opens the extension options page. |

### Popup Counters

- **Seen**: gallery items the scanner has encountered.
- **Captured**: images successfully preserved for the archive.
- **Deduped**: unique gallery detail URLs seen.
- **Total**: total image URLs currently known for the archive.
- **Progress bar**: current captured count relative to **Max items**.

### Max Items

`Max items` controls the capture limit for autoscroll workflows. The default is `200`.

Higher values can produce very large MHTML files and longer save times.

## Options

Open the options page from the popup with **Options**.

### Shortcuts

The options page shows and attempts to update shortcuts for:

- Start
- Save
- Start and Save
- Save all tabs

If your browser does not apply shortcut changes from the options page, manage them through:

- Brave: `brave://extensions/shortcuts`
- Chrome: `chrome://extensions/shortcuts`

### Capture Timing

- **Scroll delay (ms)**: delay between autoscroll steps. Default: `300`.
- **Stability timeout (ms)**: how long an image/card should remain stable before capture. Default: `400`.

Use larger values if a page is loading slowly or images are being captured before high-resolution versions appear.

### Filename Settings

Filename base options:

- browser tab title
- website URL
- domain name only
- custom text

Timestamp options:

- no timestamp
- `YYYYMMDD_HHMMSS`
- `YYYYMMDD_HHMM`
- `YYYYMMDD`
- `YYYY-MM-DD_HHMMSS`
- `YYYY-MM-DD`

Filenames are sanitized for Windows by removing characters that are not allowed in file names.

## How Saving Works

The extension uses `chrome.pageCapture.saveAsMHTML()` to capture the page. Before capture, the content script prepares the page so the saved archive is more stable than the native browser MHTML output.

Preparation includes:

- freezing or replacing gallery videos with still images where possible
- applying Civitai-specific layout fixes for model pages
- making sticky and dynamic layout regions archive-friendly
- hiding broken image reaction overlays that render as repeated digit strings in MHTML
- settling the page briefly before capture

After capture, the popup sends the MHTML blob back into the page and triggers a hidden `<a download>` from the page context. This better matches Brave/Chromium's native save behavior and usually opens the save dialog in the browser's last-used folder.

If in-page saving fails, the extension falls back to the downloads API.

## Known Notes And Limitations

- Very large galleries can produce very large `.mhtml` files.
- Some remote video frames may not be capturable because of browser security and CORS rules.
- Browser MHTML support is imperfect. The extension includes active fixes for known Civitai layout failures, but future Civitai layout/class changes may require updates.
- Saving all tabs depends on browser permission state. Unsupported URLs and tabs without permission are skipped.
- If the browser setting "Ask where to save each file" is disabled, the browser may save directly instead of opening a Save dialog.

## Troubleshooting

### The saved file is missing later gallery images

Use **Start** first and allow the extension to autoscroll through the gallery before saving. Increase **Max items** if needed.

### Images look low resolution or incomplete

Increase **Scroll delay** and **Stability timeout** in Options, then reload the page and try again.

### The save dialog opens in the wrong folder

Make sure the browser is configured to ask where to save files. The extension tries to preserve Brave/Chromium's last-used folder behavior, but final folder selection is controlled by the browser.

### Keyboard shortcuts do not work

Check the browser shortcut page:

- `brave://extensions/shortcuts`
- `chrome://extensions/shortcuts`

Shortcut conflicts with other extensions or browser commands can prevent activation.

### A Civitai page saves with broken layout

Try reloading the page, waiting for visible content to settle, then saving again. If the issue persists, keep the bad MHTML and screenshots for debugging. The project status notes in `docs/project_status.md` describe the known fixed layout issue and useful comparison pages.

## Development

Install dependencies:

```powershell
npm install
```

Run tests:

```powershell
npm test -- --runInBand
```

The test suite uses jsdom. Some canvas/media APIs are not implemented in jsdom, so warnings may appear during tests; the important result is whether the suites pass.

Useful project docs:

- `docs/project_status.md`: current Civitai MHTML layout fix status and history
- `docs/gallery_archiver_save_flow_design_notes.md`: save-flow design notes and guardrails
- `docs/PRD.md`: product requirements notes

## Repository Status

Current extension version in `manifest.json`: `1.1`.

The major Civitai MHTML layout fix is merged to `main` in commit:

```text
0d83f89fb4ec827351341386f7ce00682cd6ced7
```
