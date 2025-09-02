async function getActiveTab() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  return tab;
}

async function sendToContent(type, payload={}) {
  const tab = await getActiveTab();
  return chrome.tabs.sendMessage(tab.id, { type, payload });
}
function restoreOptions() {
  chrome.storage.local.get({
    maxItems: 200
  }, (opts) => {
    document.getElementById('maxItems').value = opts.maxItems;
  });

  chrome.commands.getAll(commands => {
    const find = name => commands.find(c => c.name === name)?.shortcut || '';
    document.getElementById('startShortcutLabel').textContent = `(${find('start') || 'Alt+1'})`;
    document.getElementById('resetShortcutLabel').textContent = `(${find('reset') || 'Alt+Shift+R'})`;
    document.getElementById('saveShortcutLabel').textContent = `(${find('save') || 'Alt+2'})`;
  });
}

function saveOptions() {
  const maxItems = parseInt(document.getElementById('maxItems').value || '200', 10);
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

document.getElementById('reset').addEventListener('click', async () => {
  const tab = await getActiveTab();
  await chrome.tabs.sendMessage(tab.id, { type: 'ARCHIVER_RESET', payload: {} });
  await chrome.tabs.reload(tab.id);
  chrome.runtime.reload();
});

document.getElementById('save').addEventListener('click', async () => {
  const tab = await getActiveTab();

  // 1) Ask content to freeze videos into still images
  try {
    const prep = await sendToContent('ARCHIVER_PREPARE_FOR_SAVE', {});
    console.log('[POPUP] PREPARE result:', prep);
    // tiny settle so the DOM paints before capture
    await new Promise(r => setTimeout(r, 120));
  } catch (e) {
    console.warn('[POPUP] PREPARE failed (continuing anyway):', e);
  }

  try {
    // 2) Save page → MHTML (unchanged logic from your main branch)
    const mhtmlData = await chrome.pageCapture.saveAsMHTML({ tabId: tab.id });
    const blob = new Blob([mhtmlData], { type: 'application/x-mimearchive' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const downloadId = await chrome.downloads.download({
      url,
      filename: `civitai-archive-${ts}.mhtml`,
      saveAs: true
    });

    // After download completes, stop (same as your branch)
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
