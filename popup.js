async function getActiveTab() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  return tab;
}

async function sendToContent(type, payload={}) {
  const tab = await getActiveTab();
  return chrome.tabs.sendMessage(tab.id, { type, payload });
}

function restoreOptions() {
  chrome.storage.local.get({ maxItems: 100 }, (opts) => {
    document.getElementById('maxItems').value = opts.maxItems;
  });
}

function saveOptions() {
  const maxItems = parseInt(document.getElementById('maxItems').value || '100', 10);
  chrome.storage.local.set({ maxItems });
}

document.getElementById('start').addEventListener('click', async () => {
  saveOptions();
  const tab = await getActiveTab();
  chrome.tabs.sendMessage(tab.id, { type: 'ARCHIVER_START' });
});

document.getElementById('stop').addEventListener('click', async () => {
  const tab = await getActiveTab();
  chrome.tabs.sendMessage(tab.id, { type: 'ARCHIVER_STOP' });
});

document.getElementById('save').addEventListener('click', async () => {
  const tab = await getActiveTab();
  chrome.runtime.sendMessage({ type: 'ARCHIVER_SAVE_MHTML', tabId: tab.id });
});

restoreOptions();

// Live stats
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'ARCHIVER_STATS') {
    document.getElementById('seen').textContent = String(msg.seen ?? 0);
    document.getElementById('captured').textContent = String(msg.captured ?? 0);
    document.getElementById('deduped').textContent = String(msg.deduped ?? 0);
  }
});
