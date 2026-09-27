# Gallery growth during save preparation

The extension's scroll loop was already stopping at the capture limit. The
remaining problem is the website's pagination loop, which can fetch without
another scroll event.

Civitai's [InViewLoader](https://github.com/civitai/civitai/blob/main/src/components/InView/InViewLoader.tsx)
uses an IntersectionObserver rooted in its scroll area, with a 400px margin.
While `inView` is true, it calls `loadFn` again after each response and a 500ms
cooldown. [ImagesAsPostsInfinite](https://github.com/civitai/civitai/blob/main/src/components/Image/AsPosts/ImagesAsPostsInfinite.tsx)
passes `fetchNextPage` to that component. Its wrapper has inline
`min-height: 36px` and `grid-column: 1 / -1` even when no spinner is mounted.

Archive preparation expands `.scroll-area` to the full content height with
visible overflow. This can keep the loader inside its observer root forever.
Cancelling extension scroll timers does not change the site's `inView` state.

The repair hides that specific marker inside `#gallery` at the capture limit
and before manual preparation. Native intersection detection then reports it
out of view. A mutation observer reapplies the pause when React replaces a
marker or rewrites its style. Cleanup restores the original display after
restoring the live layout, and a new capture also releases the pause. Images,
video poster requests, and discussion visibility observers remain available.
An already-requested batch may finish; this is not an exact cap on every image
in the archive.

## Verification

`tests/fixtures/preparation-infinite-loader.html` reproduces the site's
visibility-driven loader using native IntersectionObserver, a nested scroll
root, and a 500ms repeated batch callback. It supplies a mock extension message
channel so the real `content/archiver.js` can be injected into Chromium.

In Playwright, start capture through `listeners[0]` with `ARCHIVER_START` and
`autoSave: true`, wait for `metrics.saves === 1`, then call
`module.exports.prepareForSave()` and wait five additional seconds. Compare
`metrics` before and after. For the control, replace
`window.__archiverPagination.pause` with a no-op before starting capture.

Observed in Chromium:

| Condition | Images before/after | Batch requests before/after | Scroll events before/after |
| --- | --- | --- | --- |
| Scroll cancellation alone | 50 / 350 | 2 / 14 | 2 / 2 |
| Pagination pause enabled | 50 / 50 | 2 / 2 | 2 / 2 |

After cleanup, the scroll root returned to 400px and scrolling to its bottom
loaded another batch (50 to 75 images). Jest covers marker replacement, style
restoration, repeated pauses, the capture limit, and manual preparation.

This verifies the mechanism in a browser fixture; the user's affected live
page and its resulting MHTML size still require confirmation. The marker
recognition is specific to the Civitai model-gallery markup above and should
be revisited if that markup changes.
