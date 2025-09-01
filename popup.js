async function getActiveTab() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  return tab;
}

async function sendToContent(type, payload={}) {
  const tab = await getActiveTab();
  return chrome.tabs.sendMessage(tab.id, { type, payload });
}

function restoreOptions() {
  chrome.storage.local.get({ maxItems: 100, scrollDelay: 300, stabilityTimeout: 400 }, (opts) => {
    document.getElementById('maxItems').value = opts.maxItems;
    document.getElementById('scrollDelay').value = opts.scrollDelay;
    document.getElementById('stabilityTimeout').value = opts.stabilityTimeout;
  });
}

function saveOptions() {
  const maxItems = parseInt(document.getElementById('maxItems').value || '100', 10);
  const scrollDelay = parseInt(document.getElementById('scrollDelay').value || '300', 10);
  const stabilityTimeout = parseInt(document.getElementById('stabilityTimeout').value || '400', 10);
  chrome.storage.local.set({ maxItems, scrollDelay, stabilityTimeout });
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

document.getElementById('reset').addEventListener('click', async () => {
  const tab = await getActiveTab();
  await chrome.tabs.sendMessage(tab.id, { type: 'ARCHIVER_RESET', payload: {} });
  await chrome.tabs.reload(tab.id);
  chrome.runtime.reload();
});

document.getElementById('save').addEventListener('click', async () => {
  const tab = await getActiveTab();
  try {
    const mhtmlData = await chrome.pageCapture.saveAsMHTML({ tabId: tab.id });
    // Explicitly set the MIME type so the download uses an .mhtml extension
    const blob = new Blob([mhtmlData], { type: 'application/x-mimearchive' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const downloadId = await chrome.downloads.download({
      url,
      filename: `civitai-archive-${ts}.mhtml`,
      saveAs: true
    });
    const onChanged = delta => {
      if (delta.id === downloadId && delta.state?.current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        sendToContent('ARCHIVER_STOP');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    };
    if (chrome.downloads.onChanged?.addListener) {
      chrome.downloads.onChanged.addListener(onChanged);
    } else {
      // Fallback: immediately stop if downloads API events unavailable
      sendToContent('ARCHIVER_STOP');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  } catch (e) {
    console.error('MHTML save error:', e);
  }
});

restoreOptions();
document.getElementById('status').textContent = '';

// Live stats
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'ARCHIVER_STATS') {
    document.getElementById('seen').textContent = String(msg.seen ?? 0);
    document.getElementById('captured').textContent = String(msg.captured ?? 0);
    document.getElementById('deduped').textContent = String(msg.deduped ?? 0);
    document.getElementById('total').textContent = String(msg.total ?? 0);
  }
  if (msg?.type === 'ARCHIVER_STATE') {
    const progress = document.getElementById('progress');
    progress.max = msg.maxItems ?? 0;
    progress.value = msg.captured ?? 0;
    const statusEl = document.getElementById('status');
    if (msg.running) {
      statusEl.textContent = 'Capturing...';
    } else {
      statusEl.textContent = 'Ready to Save';
    }
  }
});

// --- Add this block at the bottom of your existing popup.js ---

(async function archiverPrepareAndSaveWiring() {
  function $(sel) { return document.querySelector(sel); }
  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }
  function sendToTab(tabId, msg, timeout = 5000) {
    return new Promise((resolve) => {
      let done = false;
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        done = true;
        if (chrome.runtime.lastError) {
          console.warn('[POPUP] sendToTab error:', chrome.runtime.lastError.message);
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || { ok: true });
        }
      });
      setTimeout(() => { if (!done) resolve({ ok: false, error: 'timeout' }); }, timeout);
    });
  }

  // Find your existing Save button (supports either of these IDs).
  const saveBtn = $('#saveBtn') || $('#saveMhtmlBtn');
  if (!saveBtn) {
    console.warn('[POPUP] Save button not found (expected #saveBtn or #saveMhtmlBtn)');
    return;
  }

  saveBtn.addEventListener('click', async (e) => {
    try {
      const tab = await getActiveTab();
      if (!tab) return;

      // 1) Ask content to build snapshot (this inlines videos to data: and hides the live app)
      console.log('[POPUP] prepare → content');
      const prep = await sendToTab(tab.id, { type: 'ARCHIVER_PREPARE_FOR_SAVE' }, 7000);
      console.log('[POPUP] prepare result:', prep);

      // 2) Ask background to run pageCapture.saveAsMHTML for this tab
      await chrome.runtime.sendMessage({ type: 'ARCHIVER_SAVE_MHTML', tabId: tab.id });
      console.log('[POPUP] save request sent to background');
    } catch (err) {
      console.error('[POPUP] prepare/save error:', err);
    }
  }, { once: false });
})();
