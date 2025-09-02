// background.js (drop-in)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // Save the active tab as MHTML (with a PREPARE step first)
  if (msg.type === 'ARCHIVER_SAVE_MHTML') {
    (async () => {
      try {
        // Determine the tab to save
        const tabId = msg.tabId || sender?.tab?.id;
        if (!tabId) {
          console.warn('[BG] no tabId for save');
          sendResponse({ ok: false, error: 'no tabId' });
          return;
        }

        console.log('[BG] ARCHIVER_SAVE_MHTML received → PREPARE start');

        // Ask content to prepare (overlays, layout tweaks, etc.)
        const prep = await new Promise((resolve) => {
          let done = false;

          chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_PREPARE_FOR_SAVE' }, (resp) => {
            done = true;
            if (chrome.runtime.lastError) {
              console.warn('[BG] PREPARE error:', chrome.runtime.lastError.message);
              resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(resp || { ok: true });
            }
          });

          // Failsafe timeout
          setTimeout(() => { if (!done) resolve({ ok: false, error: 'timeout' }); }, 1500);
        });

        console.log('[BG] PREPARE result:', prep);

        // Small settle to let the DOM paint before snapshot
        await new Promise((r) => setTimeout(r, 100));

        // Capture → Blob
        chrome.pageCapture.saveAsMHTML({ tabId }, async (blob) => {
          if (!blob) {
            console.error('[BG] pageCapture returned empty blob');
            sendResponse({ ok: false, error: 'empty blob' });
            return;
          }

          console.log('[BG] converting blob to object URL');
          const url = URL.createObjectURL(blob);

          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `civitai-archive-${stamp}.mhtml`;

          try {
            const id = await chrome.downloads.download({
              url,
              filename,
              saveAs: true
            });
            console.log('[BG] download started:', id);
            // keep URL alive a little while
            setTimeout(() => URL.revokeObjectURL(url), 30000);
            sendResponse({ ok: true, downloadId: id });
          } catch (e) {
            console.error('[BG] download error:', e);
            sendResponse({ ok: false, error: String(e) });
          }
        });
      } catch (e) {
        console.error('[BG] save flow error:', e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();

    // async response
    return true;
  }
});
