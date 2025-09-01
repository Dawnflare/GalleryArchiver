# Civitai Gallery Archiver

Brave/Chromium extension that hoards Civitai infinite‑scroll galleries and saves them as a **single MHTML** file.

## Features
- **Autoscroll capture** – start the extension and it automatically scrolls through the gallery, collecting high‑resolution images until the limit is reached or you stop it.
- **Start / Stop / Save / Reset** controls in the popup:
  - **Start** begins capturing and displays live stats (seen, captured, deduped) with a progress bar.
  - **Stop** freezes the page so it can be exported.
  - **Save** downloads the page as an `.mhtml` archive.
  - **Reset** clears all state, reloads the page, and restarts the extension.
- **Configurable options** – set maximum items, scroll delay, and stability timeout directly in the popup.

## Install (dev)
1. Open Brave → `brave://extensions/` and enable **Developer mode** (top‑right).
2. Click **Load unpacked** and select this folder (`civitai-gallery-archiver/`).
3. Pin the extension, open a Civitai gallery page, and use the popup controls.

## Notes
- Works best when you save immediately after stopping (resources stay warm in cache).
- Defaults: max items = 100, scroll delay = 300 ms, stability timeout = 400 ms.
- Change these values in the popup before pressing **Start**.

## Roadmap
- Robust selectors & heuristics for different Civitai gallery layouts.
- Size warnings for very large captures.
- Optional single‑HTML exporter (later).
