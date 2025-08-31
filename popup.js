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
  try {
    const mhtmlData = await chrome.pageCapture.saveAsMHTML({ tabId: tab.id });
    // Explicitly set the MIME type so the download uses an .mhtml extension
    const blob = new Blob([mhtmlData], { type: 'application/x-mimearchive' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await chrome.downloads.download({
      url,
      filename: `civitai-archive-${ts}.mhtml`,
      saveAs: true
    });
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    console.error('MHTML save error:', e);
  }
});

restoreOptions();

// Live stats
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'ARCHIVER_STATS') {
    document.getElementById('seen').textContent = String(msg.seen ?? 0);
    document.getElementById('loaded').textContent = String(msg.loaded ?? 0);
    document.getElementById('deduped').textContent = String(msg.deduped ?? 0);
  }
});
