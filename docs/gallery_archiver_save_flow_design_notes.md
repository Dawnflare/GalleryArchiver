# GalleryArchiver Save Flow (Brave) — Design Notes & Rationale

## Goal
Replicate Brave’s native behavior when saving from a page (and what SingleFile does):
- Open the OS **Save As** dialog in the **last-used folder**
- Prefill a clean filename like `<tab_title>_<timestamp>.mhtml`
- Produce a valid **.mhtml** file (not `.txt` / `.eml`)

## What didn’t work (and why)

1) **`chrome.downloads.download` with `filename`**  
   - Pros: lets us set a custom filename.  
   - Cons (on this Brave build): dialog tends to open in **Default Downloads**, not the **last-used** folder. Folder selection is browser-controlled; giving a filename often anchors to the default dir.

2) **`chrome.downloads.download` with `data:`/`blob:` URL + `onDeterminingFilename`**  
   - Helped with filename, but **still defaulted to Downloads** on this machine.  
   - Windows sometimes showed **“.txt” or “.eml”** as the “Save as type” when the MIME looked ambiguous.

3) **`showSaveFilePicker` (File System Access API) from the popup**  
   - Would have solved both, but **not available** to this Brave extension popup (throws).  
   - Also inconsistent across channels/policies.

## Final design (what works)

### 1) Capture in the popup
- Use `chrome.pageCapture.saveAsMHTML({ tabId })` to obtain the page as MHTML.
- Normalize to a **typed `Blob`**: `new Blob([...], { type: 'application/x-mimearchive' })` to steer Windows’ “Save as type”.

### 2) Save **from the page context** (content script)
- The popup sends a message with:
  - `type: 'ARCHIVER_SAVE_MHTML_VIA_PAGE'`
  - payload: `{ bytes: ArrayBuffer, mime: 'application/x-mimearchive', suggestedName: '<title>_<ts>.mhtml' }`
- The **content script** reconstructs the Blob and programmatically clicks a **hidden `<a download>`** inside the page:

```js
const blob = new Blob([new Uint8Array(bytes)], { type: mime });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = suggestedName;   // BASENAME ONLY (no directory!)
a.style.display = 'none';
document.body.appendChild(a);
a.click();
// cleanup
setTimeout(() => {
  try { document.body.removeChild(a); } catch {}
  try { URL.revokeObjectURL(url); } catch {}
}, 60000);
```

- Chromium treats this as a **user-initiated page save**, so it opens the Save dialog in the **last-used folder**, honoring our filename + `.mhtml` extension.

### 3) Fallback
- If content-script saving fails (policy, CSP, etc.), the popup **falls back** to:
  ```js
  const blobUrl = URL.createObjectURL(blob);
  chrome.downloads.download({ url: blobUrl, filename: suggestedName, saveAs: true });
  ```
  This preserves the filename but may open in the default Downloads dir.

## Why this works
- **Folder selection is browser-controlled.** Brave preserves “last-used folder” when the download originates from the **page/tab** (like right-click Save As), but not reliably when triggered from **extension UI** (`downloads` API or popup anchors).  
- **`<a download>` from the page** specifically mimics user-initiated page saves. That flips Brave’s internal heuristics to use the **last-used** directory.  
- **Typed Blob** with `application/x-mimearchive` prevents Windows from guessing “Text File (*.txt)” or “E-mail Message (*.eml)”.

## Message contract (popup → content)
- `ARCHIVER_PREPARE_FOR_SAVE` — existing: content script hides/pauses overlays, etc.
- `ARCHIVER_SAVE_MHTML_VIA_PAGE` — **new**:

```ts
interface Payload {
  bytes: ArrayBuffer;                 // raw MHTML bytes
  mime: 'application/x-mimearchive'; // preferred
  suggestedName: string;             // '<title>_<ts>.mhtml' (basename only)
}
```
> We send **ArrayBuffer** (structured-clone friendly) rather than Blob across the extension boundary.

- `ARCHIVER_STOP` — existing: content script cleans up UI.

## Guardrails for Codex (do NOT break these)
- **Keep the in-page save path.** Don’t replace it with `chrome.downloads` or picker-only logic.
- **Do not include any directory path** in `suggestedName` (basename only). Including folders can reset the browser’s folder logic.
- **Keep the MIME** as `application/x-mimearchive` (or `multipart/related` as a secondary). This avoids `.txt`/`.eml` mislabeling on Windows.
- **Keep “Ask where to save each file” expectation.** If the user turns it off, “last-used folder” is moot—document that behavior, don’t fight it.
- **Don’t store absolute paths** in extension storage. We want to honor Brave’s native “last-used” memory, not emulate it.
- **Avoid top-level `await`** in the popup; keep awaits inside `async` handlers.
- **Sanitize filenames** (strip `\/::*?"<>|`, collapse whitespace).
- **Clean up resources**: revoke `URL.createObjectURL` URLs; remove any temporary DOM nodes and listeners.

## Minimal content-script handler (for reference)

```js
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ARCHIVER_SAVE_MHTML_VIA_PAGE') {
    try {
      const { bytes, mime, suggestedName } = msg.payload || {};
      const blob = new Blob([new Uint8Array(bytes)], { type: mime || 'application/x-mimearchive' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = suggestedName;   // basename only
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try { document.body.removeChild(a); } catch {}
        try { URL.revokeObjectURL(url); } catch {}
      }, 60000);
      sendResponse({ ok: true });
    } catch (err) {
      console.error('[Archiver] in-page save failed:', err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return true; // keep the channel alive for sendResponse
  }
});
```

## Regression tests Codex should run
1) **Filename & extension**  
   - Open any page with a long title; click **Save**.  
   - Verify suggested name: `<title>_<YYYYMMDD_HHMMSS>.mhtml`.  
   - File opens correctly as MHTML.

2) **Last-used folder**  
   - Manually save any file to a test folder.  
   - Now run GalleryArchiver **Save**; dialog should open in that folder.

3) **Fallback path**  
   - Temporarily break the in-page handler (e.g., throw) to force fallback.  
   - Confirm filename stays correct (even if folder reverts to Downloads).

4) **Options matrix**  
   - `filenameBase = title | url | domain | custom` all produce sanitized names; timestamps respect the selected format.

5) **No path persistence**  
   - Ensure extension storage never keeps absolute directories.

