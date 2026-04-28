# GalleryArchiver Civitai MHTML Layout Fix Status

**Date:** April 28, 2026  
**Status:** Fixed, merged to `main`  
**Merged commit:** `0d83f89fb4ec827351341386f7ce00682cd6ced7`  
**PR:** https://github.com/Dawnflare/GalleryArchiver/pull/55

## Original Problem

GalleryArchiver was already producing good MHTML archives for most Civitai model pages on both `civitai.com` and `civitai.red`. A smaller set of model pages consistently saved with severely broken layout. The main bad-page test case was:

- `https://civitai.com/models/534506/niji-semi-realism`

The main good-page comparison case was:

- `https://civitai.com/models/1061826/detailer-or-tool-concept-lora-illustriousxl`

On affected pages, the saved MHTML did not match the live page. Major sections rendered as separate horizontal columns, content overlapped, the gallery flowed off screen, and the viewer had no practical way to scroll to the missing content. At extreme browser zoom levels the layout was still wrong; the columns merely became easier to see.

The same bad layout also happened with Brave's native "Save page as MHTML" behavior. That was an important clue: the extension was not creating the layout bug by itself. The extension needed to actively correct for a browser/MHTML rendering failure on these Civitai pages.

## Root Causes We Found

The investigation uncovered several interacting problems.

### Native MHTML Loses Critical Layout Behavior

Civitai's model pages rely on a modern React/Mantine layout with container-query-driven responsive behavior, flex/grid wrappers, sticky panels, and dynamic masonry/gallery sizing. Chrome/Brave MHTML serialization and offline rendering does not reliably preserve the live layout behavior for the affected pages.

The practical result was that the archived page kept enough CSS to create multiple horizontal layout regions, but lost enough runtime/container context that those regions were sized and stacked incorrectly.

### The Preparation Message Was Not Always Sent

Early testing exposed a separate `popup.js` bug: the save preparation flow could silently stop if the page had no videos. The bad test pages had no videos, so `ARCHIVER_PREPARE_FOR_SAVE` was not always sent. That meant some early layout fixes were never actually running on the affected pages.

This is now fixed. `popup.js` always calls `preparePageForSave()` before `chrome.pageCapture.saveAsMHTML()`, regardless of whether videos are present.

### CSS Injection Alone Was Not Enough

Several attempts injected CSS rules that should have forced normal vertical layout, but the saved MHTML still rendered incorrectly. The final fix therefore uses both:

- an injected archive-mode stylesheet, and
- direct inline `style.setProperty(..., 'important')` changes on the relevant containers before capture.

Inline styles were essential because they survive MHTML serialization more reliably and have stronger specificity than ordinary stylesheet rules.

### The Header Grid Was Reparented In The MHTML DOM

The last major blocker was the model header. On bad pages, the saved MHTML effectively placed the main model content and the right-side details panel in a structure that our earlier selectors did not handle correctly. The details block stayed above the carousel/description instead of beside it.

The fix was to target the full `[data-tour="model:start"] .mantine-Grid-root` wrapper and make `.mantine-Grid-inner` use `display: contents`, so both the normal children and the MHTML-reparented grid columns participate in the same flex row.

### Animated Reaction Counters Rendered As Visible Digit Layers

After the layout was fixed, image reaction overlays still showed broken `number-flow-react` output: emojis followed by repeated `0123456789...` strings. The archived web component exposed all animated digit layers at once.

The fix hides only image-surface reaction strips during MHTML prep:

- header carousel reactions: `ModelCarousel_reactions`
- gallery image card reactions: `ImagesAsPostsCard_reactions`

This removes the broken overlays without hiding unrelated stats or discussion/review content elsewhere on the page.

## Final Implementation

The final fix is centered on a unified save preparation flow in `content/archiver.js` and `popup.js`.

### `popup.js`

`popup.js` now always sends `ARCHIVER_PREPARE_FOR_SAVE` before capturing MHTML:

- `preparePageForSave(tabId)` sends the prepare message.
- The save flow waits briefly after preparation.
- Preparation failures are logged, but capture can still continue as a fallback.

This fixed the no-videos execution bug and made the preparation path deterministic.

### `content/archiver.js`

`content/archiver.js` now has one main `ARCHIVER_PREPARE_FOR_SAVE` responder. It coordinates several preparation hooks:

- video freezing
- gallery preparation
- static MHTML layout preparation
- play-badge overlay preparation

The static layout preparation adds `data-archiver-mhtml-prep="1"` to the document, injects `#archiver-mhtml-layout-fix`, and applies important inline styles to the app shell, main sections, gallery wrappers, and model header grid.

Key layout behaviors:

- app shell wrappers become normal vertical flex flow
- top-level `main` children are centered and stacked vertically
- `#gallery` is allowed full width but its inner masonry row is centered
- sticky elements are made static for archive rendering
- model header grid is restored as a two-column layout
- `.mantine-Grid-inner` uses `display: contents` inside the model header
- model main content and details/sidebar columns are explicitly ordered and sized
- image reaction strips that break in MHTML are hidden

The preparation also records original inline styles in `data-archiver-original-style` so the live page can be restored on `ARCHIVER_STOP`.

### Tests

Tests were updated to cover the new behavior:

- popup tests verify `ARCHIVER_PREPARE_FOR_SAVE` is sent before saving
- archiver tests verify image reaction overlays are hidden during MHTML layout prep

## Verification

The final behavior was tested manually with Alt+2 saves on:

- the bad Niji Semi Realism page
- the good Detailer / Tool / Concept LoRA page

Current result:

- bad page saves with correct overall layout
- model header is back to the live-page-style two-column structure
- suggested resources, discussion, gallery, and footer are vertically ordered
- gallery is visible, centered, scrollable, and not cut off
- reaction emoji/digit overlays are removed from images
- good page still saves correctly

Automated test status:

```text
npm test -- --runInBand
5 test suites passed
19 tests passed
```

The test run still emits expected jsdom warnings for unimplemented canvas/media APIs, but all tests pass.

## Repository Status

The fix was merged into `main` through PR #55:

- feature branch: `codex/mhtml-prepare-refactor`
- merge commit: `0d83f89fb4ec827351341386f7ce00682cd6ced7`
- local `main`, `origin/main`, and `HEAD` were verified to point to the same commit

Workspace cleanup:

- example MHTML/screenshots and debug artifacts were moved under `Temp/`
- `Temp/` is ignored in `.gitignore`
- `.npm-cache/` is ignored in `.gitignore`

## Current Status

The Civitai MHTML layout issue is considered fixed on `main`.

The extension now actively compensates for the native browser MHTML layout failure on the affected Civitai model pages while preserving correct output on previously good pages.

Recommended future follow-up:

- continue testing a broader set of Civitai/Civitai Red model pages
- watch for Civitai class-name or layout changes that could require selector updates
- consider reducing noisy jsdom warnings in the test suite with targeted mocks for canvas/media APIs
