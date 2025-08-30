# Civitai Gallery Archiver (Core)

Brave/Chromium extension to capture Civitai infinite-scroll galleries as a **single MHTML** file.  
**Core-only**: MHTML exporter, no enrichment, default max items = 100 for fast iteration.

## Install (dev)
1. Open Brave → `brave://extensions/` → toggle **Developer mode** (top-right).
2. Click **Load unpacked** → select this folder (`civitai-gallery-archiver/`).
3. Pin the extension. Open a Civitai gallery page.
4. Click the toolbar icon → **Start** to capture; **Stop**; **Save as MHTML**.

## Notes
- Works best when you save immediately after stopping (resources stay warm in cache).
- Default Max items = 100 (you can raise it in the popup).

## Roadmap
- Robust selectors & heuristics for different Civitai gallery layouts.
- Size warnings for very large captures.
- Optional single-HTML exporter (later).
