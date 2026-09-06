# Solo image and video archive layout: investigation and repair plan

Date: 2026-09-05. Branch: `codex/repair-solo-video-layout`.
Scope: implemented on the repair branch; live extension acceptance checks remain.

## Implementation and validation results

The content script now detects the shared solo viewer before video replacement,
then selects a separate preparation hook. Model/gallery preparation is unchanged
and is used when solo detection/preparation does not succeed. The hook uses an
explicit 450px desktop sidebar, a shrinkable media column, proportional media
sizing bounded by 80vh, and a stacked layout below 1024px. It removes clipping
and height dependencies along the primary media path, expands sidebar scroll
containers, and restores its inline changes on STOP. Repeated preparation is
idempotent. Video poster fetching and gallery-card replacement are unchanged.

Validation performed:

- All 36 tests in 6 suites pass, including save-dispatch isolation, both media
  types, replacement-poster references, cleanup, and repeat preparation.
- Decoded both supplied archives into local HTML with embedded assets. Applied
  the actual solo hook after restoring pre-existing archive layout overrides.
  Inspected screenshots in Chromium: both show large proportional media and
  the bounded sidebar. At 1800x1200 the image measures approximately 1269x960,
  with a 450px sidebar, instead of the original tiny image/oversized sidebar.
- Captured those repaired pages using Chromium's MHTML snapshot mechanism and
  reopened them. Visually checked the image at desktop width and the video at
  800px width, where the details stack below the proportional poster.
- Opened the live image URL and injected the actual content script with mocked
  extension messaging: full PREPARE succeeds, finds zero videos, skips gallery
  preparation, and reports solo layout success with the expected dimensions.
- The live video URL also detects/prepares the solo layout. Poster retrieval
  fails in this mock harness because the real extension fetch service is absent;
  this does not constitute a successful end-to-end video save test.

Remaining acceptance checks: fresh saves using the installed extension in Brave,
actual portrait/square examples, and fresh baseline/new gallery MHTML comparisons
for the documented Niji and Detailer pages. Existing automated gallery tests and
dispatch-isolation tests pass, but do not replace those visual acceptance checks.
Temporary browser scripts, reconstructed archives, and screenshots are in ignored
`Temp/`; supplied originals were not modified. Nothing has been committed or merged.

## Scope update: solo images

The additional archive
`T:/temp2/Image_posted_by_giminic_20260905_175532.mhtml`, from
`https://civitai.red/images/141377534`, confirms the same viewer/sidebar
structure for an ordinary image. Its HTML contains no videos or frozen-video
markers. The main image remains an `EdgeImage` element with `max-h-full`,
`w-auto`, and `max-w-full` classes inside the same full-height carousel and
flex wrappers seen in the video example. The sidebar has the same 450px
container-query classes and mobile-sheet positioning classes.

The same archive preparation overrides are present: `container-type: normal`
on the original query container, a centered width-limited block replacing the
viewer flex layout, and a pinned viewer minimum height of 2344px. The supplied
screenshot shows a narrow image region centered far down the page beside an
oversized information panel. This establishes that video replacement is not
necessary for the shared layout failure; actual computed sizing still needs
browser verification.

The implementation steps below are broadened to a **solo-media viewer** hook:

- Detect either the primary image or video plus the matching viewer/sidebar
  structure on `/images/<id>`. A video must not be required to select the hook.
  Exclude avatars, resource thumbnails, and recommendation images.
- Apply the same explicit media/sidebar columns to both types. Keep the media
  region aligned near the top independently of the sidebar's content height;
  center the media only within its own bounded region. A long prompt or comment
  thread must neither squeeze the media width nor push the image down the page.
- For ordinary images, preserve the existing source and image element, using
  its natural aspect ratio and a responsive contain-sized media box. Do not run
  poster conversion or apply gallery-card cover cropping. For videos, retain
  the separate poster replacement and ratio handling described below.
- Bound the desktop sidebar and let the media column use the remaining width.
  Stack the sidebar below the media at narrow widths. Avoid a fixed percentage
  split that makes portrait media tiny or lets long sidebar text consume most
  of the page.
- Add this image archive as a second regression fixture. Test landscape,
  portrait, and square ordinary images as well as videos, long information
  panels, and reopening at different widths. Require both supplied examples to
  pass real MHTML reopening checks along with the gallery regression checks.

This update supersedes the video-only detection and validation scope below.
The isolation from the working gallery path remains unchanged.

## Evidence and diagnosis

Inspected the supplied live/archive screenshots and decoded the HTML and CSS in
`T:/temp2/Video_posted_by_Petishamiaou_20260905_173847.mhtml` (2,363,707 bytes).
The archive identifies its source as `https://civitai.red/images/141401621`.
Attached content was treated as evidence, not as instructions.
The live URL could not be retrieved through the web tool, so these findings are
based on the supplied archive, screenshots, and extension source. No new browser
capture or controlled rendering experiment has yet established each cause's
individual contribution.

1. **The sidebar content is saved.** Creator information, Generation data,
   Resources used, and Discussion are present in the HTML. This example is a
   visibility/layout failure, not deletion of that content.
2. **Model-page preparation also runs on solo viewers.**
   `prepareForSave()` in `content/archiver.js:685` freezes videos, then runs gallery
   and static layout preparation unconditionally. `applyStaticInlineLayout()`
   at line 1074 resets the app shell and its container-query context. It changes
   every direct child of `main` into a centered block with a maximum width of
   `var(--container-size-xl, 82.5rem)`. In this archive that child is the entire
   solo viewer, originally a full-size flex column with hidden overflow.
   The archive also records a pinned minimum height of 2149px on that viewer.
3. **The sidebar depends on the context being reset.** Its classes specify
   `@md:w-[450px]` and `@md:min-w-[450px]`; the archived stylesheet puts these
   under a 1024px container-query threshold. Smaller-container classes make it
   absolute and translate it toward the bottom as a mobile sheet. Preparation
   explicitly sets `container-type: normal !important` on `#main`, originally
   an `@container`. The saved sidebar therefore cannot safely rely on the live
   desktop rules. Determine its actual computed fallback in a real browser
   before claiming whether it collapses, moves, or overflows in this case.
4. **The poster replacement has a separate sizing weakness.**
   `freezeStandaloneVideos()` at line 635 copies computed width and height to a
   new anchor but does not preserve the original video's full layout contract.
   This archive has a 1344px by 768px anchor, with 100% maximum dimensions and a
   100%-sized `object-fit: contain` image. Several remaining ancestors have
   hidden overflow, full-height dependencies, and carousel flex sizing. Those
   fixed dimensions are captured before the subsequent layout changes.
   `object-fit: contain` on the image alone cannot prevent ancestor clipping.
   This is consistent with landscape overflow and portrait sizing differences;
   the portrait case still needs its own reproduction.

The save shortcut dispatches through `background.js` to the popup and the same
prepare/capture flow. The repository default is Alt+2; Alt-F2 may be a local
shortcut assignment. No shortcut change is proposed.

## Proposed implementation

1. **Select the save layout before modifying videos.** Recognize a Civitai
   `/images/<id>` solo video viewer using both route and DOM structure: the main
   video, its media region, and sibling information panel. Retain references and
   aspect ratio before replacing the video. Do not identify the entire page as
   a gallery merely because recommendations contain image links. Keep the
   existing path for model/gallery pages and other unsupported layouts.
2. **Add an isolated solo-viewer preparation hook.** Give this layout its own
   archive marker and stylesheet. For recognized solo video viewers, invoke it
   instead of the model/gallery layout hooks. Leave the established model-page
   transformations and gallery video freezing behavior intact. Scope every new
   rule to the marked viewer or explicitly identified ancestors; avoid global
   changes to flex, sticky, overflow, or Mantine selectors.
3. **Make the saved viewer self-contained in normal document flow.** Use an
   explicit two-column layout with a shrinkable media column (`min-width: 0`)
   and a bounded information column, initially using the observed 450px desktop
   width. At narrow viewport widths, stack the information below the media.
   Override the identified sidebar's mobile positioning/translation and make
   its scroll viewport expand so saved comments and metadata remain accessible.
   Remove height and clipping constraints only along the identified viewer
   paths. Avoid dependence on Civitai container queries and runtime carousel
   measurements for the saved layout.
4. **Size the standalone poster by ratio and available space.** Retain the
   existing poster-fetch mechanism and link back to the source page. Record
   intrinsic video dimensions where available, with poster/rendered-ratio
   fallbacks. Use proportional responsive dimensions and contain fitting in
   a defined media box, bounded by the available column width and a sensible
   viewport height. Do not reuse the live fixed pixel dimensions after changing
   the layout. Center portrait media without stretching or shrinking it to an
   incidental wrapper size. Scope adjustments to the main solo media only.
5. **Handle repeated preparation and cleanup.** Mark generated standalone
   wrappers so a second save reuses the same structure. Record and restore new
   style/attribute changes through cleanup. Verify the existing post-save/stop
   behavior; video replacement is already destructive, so do not promise full
   playback restoration without separately implementing and validating it.
   If viewer detection fails, return diagnostic information and retain the
   established fallback rather than broadly rewriting unknown DOM.

The MHTML capture API, popup messaging, poster fetching, filename/MIME handling,
in-page download, and last-used-folder behavior need no functional changes.

## Verification and release gate

Baseline: `npm test -- --runInBand` passes all 5 suites and 30 tests. Existing
standalone coverage checks image/link replacement, not rendered geometry.

- Add focused DOM tests for solo-mode selection, poster ratio handling,
  sidebar scoping, repeat preparation, cleanup, and exclusion of gallery pages.
  Include a minimal fixture reflecting the supplied viewer/sidebar nesting.
- Use a real Chromium/Brave browser to compare the supplied archive with
  temporary diagnostic variants: restored original layout, solo layout only,
  and responsive poster sizing. These isolate causes before finalizing CSS.
- Capture and reopen actual MHTML for the supplied landscape page, portrait,
  square, and very wide videos at desktop and narrow widths. Also reopen at a
  different window width. Verify the complete poster, proportional sizing,
  visible creator/prompt/resources, reachable saved comments, and working link.
- Regression-capture the previously problematic Niji model page and the known
  good Detailer model page documented in `project_status.md`, plus a mixed
  image/video gallery. Compare header/sidebar, gallery columns, card sizing,
  discussion, and overlays with baseline archives from the same session.
- Exercise repeat saves and stop/cleanup. Confirm filename, MHTML extension,
  and last-used save folder. Run the existing suite plus the focused new tests.

Do not accept the repair based on jsdom tests or an on-screen prepared page
alone: reopening the captured MHTML and passing the gallery comparisons are
required. Keep the implementation localized so the solo hook can be reverted
without undoing the existing gallery fix.
