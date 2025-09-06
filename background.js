// background.js

async function saveMHTML() {
  try {
    if (chrome.action?.openPopup) {
      await chrome.action.openPopup();
    }
  } catch (e) {
    console.warn('openPopup failed:', e);
  }

  try {
    const res = await chrome.runtime.sendMessage({ type: 'ARCHIVER_POPUP_SAVE' });
    if (!res || res.ok !== true) throw new Error(res?.error || 'popup save failed');
  } catch (e) {
    console.error('[BG] save via popup failed:', e);
  }
}

async function saveAllTabs() {
  try {
    if (chrome.action?.openPopup) {
      await chrome.action.openPopup();
    }
  } catch (e) {
    console.warn('openPopup failed:', e);
  }

  try {
    const res = await chrome.runtime.sendMessage({ type: 'ARCHIVER_POPUP_SAVE_ALL_TABS' });
    if (!res || res.ok !== true) throw new Error(res?.error || 'popup save all tabs failed');
  } catch (e) {
    console.error('[BG] save all tabs via popup failed:', e);
  }
}

async function startAndSave(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_START', autoSave: true });
  } catch (e) {
    console.error('startAndSave error:', e);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'ARCHIVER_SAVE_MHTML') {
    saveMHTML()
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === 'ARCHIVER_START_AND_SAVE') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        startAndSave(tab.id);
      }
    })();
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
    await saveMHTML();
  } else if (command === 'startAndSave') {
    await maybeOpenPopup();
    await startAndSave(targetTabId);
  } else if (command === 'saveAllTabs') {
    await saveAllTabs();
  }
});

