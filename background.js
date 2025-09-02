// background.js (drop-in)

async function saveMHTML(tabId) {
  if (!tabId) return;
  try {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_PREPARE_FOR_SAVE' });
      await new Promise(r => setTimeout(r, 120));
    } catch (e) {
      console.warn('[BG] PREPARE failed (continuing anyway):', e);
    }

    const mhtmlData = await chrome.pageCapture.saveAsMHTML({ tabId });
    const blob = new Blob([mhtmlData], { type: 'application/x-mimearchive' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const downloadId = await chrome.downloads.download({
      url,
      filename: `civitai-archive-${stamp}.mhtml`,
      saveAs: true
    });

    const onChanged = delta => {
      if (delta.id === downloadId && delta.state?.current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_STOP' });
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    };

    if (chrome.downloads.onChanged?.addListener) {
      chrome.downloads.onChanged.addListener(onChanged);
    } else {
      chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_STOP' });
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  } catch (e) {
    console.error('[BG] save flow error:', e);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'ARCHIVER_SAVE_MHTML') {
    saveMHTML(msg.tabId || sender?.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const targetTabId = tab.id;

  const maybeOpenPopup = async () => {
    try {
      if (chrome.action?.openPopup) {
        await chrome.action.openPopup();
      }
    } catch (e) {
      console.warn('openPopup failed:', e);
    }
  };

  if (command === 'start') {
    await maybeOpenPopup();
    chrome.tabs.sendMessage(targetTabId, { type: 'ARCHIVER_START' });
  } else if (command === 'reset') {
    await maybeOpenPopup();
    await chrome.tabs.sendMessage(targetTabId, { type: 'ARCHIVER_RESET', payload: {} });
    await chrome.tabs.reload(targetTabId);
    chrome.runtime.reload();
  } else if (command === 'save') {
    await maybeOpenPopup();
    await saveMHTML(targetTabId);
  }
});
