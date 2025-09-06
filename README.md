# Gallery Archiver by Dawnflare

Brave/Chromium extension that hoards infinite‑scroll galleries and saves them as a **single MHTML** file. Built for Civitai but may work on similar gallery pages.

## Features
- **Autoscroll capture** – start the extension and it automatically scrolls through the gallery, collecting high‑resolution images until the limit is reached or you stop it.
- **Start / Stop / Save / Reset / Save all tabs** controls in the popup:
  - **Start** begins capturing and displays live stats (seen, captured, deduped) with a progress bar.
  - **Stop** halts the autoscroll process before the max item limit is reached.
  - **Save** downloads the page as an `.mhtml` archive.
  - **Save all tabs** downloads all open tabs as `.mhtml` archives.
  - **Reset** clears all state, reloads the page, and restarts the extension.
- **Configurable options** – set maximum items in the popup; adjust scroll delay, stability timeout, keyboard shortcuts, and customize archive filenames (tab title, URL, domain, or custom text with optional timestamps) on the options page (shortcuts also appear under `brave://extensions/shortcuts`).

## Install (dev)
1. Open Brave → `brave://extensions/` and enable **Developer mode** (top‑right).
2. Click **Load unpacked** and select this folder (`GalleryArchiver/`).
3. Pin the extension, open a gallery page (e.g. on Civitai), and use the popup controls.

## Notes
- Works best when you save immediately after stopping.
 - Defaults: max items = 200, scroll delay = 300 ms, stability timeout = 400 ms.
 - Adjust these values before pressing **Start**.

## Roadmap
- Robust selectors & heuristics for different gallery layouts (starting with Civitai).
- Size warnings for very large captures.
