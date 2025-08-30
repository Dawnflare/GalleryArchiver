// Background/service worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'ARCHIVER_SAVE_MHTML') {
    const tabId = msg.tabId;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No tabId' });
      return;
    }

    try {
      chrome.pageCapture.saveAsMHTML({ tabId }, (mhtmlData) => {
        if (chrome.runtime.lastError) {
          console.error('MHTML save error:', chrome.runtime.lastError.message);
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        const blob = mhtmlData; // Blob
        const url = URL.createObjectURL(blob);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        chrome.downloads.download(
          {
            url,
            filename: `civitai-archive-${ts}.mhtml`
          },
          () => {
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            sendResponse({ ok: true });
          }
        );
      });
    } catch (e) {
      console.error('saveAsMHTML threw:', e);
      sendResponse({ ok: false, error: String(e) });
    }
    return true; // Keep service worker alive for async sendResponse
  }
});
