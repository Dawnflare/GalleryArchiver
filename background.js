// Background/service worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'ARCHIVER_SAVE_MHTML') {
    const tabId = msg.tabId;
    if (!tabId) return;

    // 1) Ask the content script to inline WEBMs (and posters), then snapshot
    chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_PREPARE_FOR_SAVE' }, () => {
      // small settle delay
      setTimeout(() => {
        chrome.pageCapture.saveAsMHTML({ tabId }, (mhtmlData) => {
          if (chrome.runtime.lastError) {
            console.error('MHTML save error:', chrome.runtime.lastError.message);
            return;
          }
          const url = URL.createObjectURL(mhtmlData);
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          chrome.downloads.download(
            { url, filename: `civitai-archive-${ts}.mhtml` },
            () => setTimeout(() => URL.revokeObjectURL(url), 60_000)
          );
        });
      }, 250);
    });
  }
});
