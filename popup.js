async function getActiveTab() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  return tab;
}

function sanitize(str) {
  return (str || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .replace(/\s+/g, '_');
}

function formatTimestamp(fmt) {
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const Y = pad(d.getFullYear(), 4);
  const M = pad(d.getMonth() + 1);
  const D = pad(d.getDate());
  const h = pad(d.getHours());
  const m = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  switch (fmt) {
    case 'YYYYMMDD_HHMMSS':
      return `${Y}${M}${D}_${h}${m}${s}`;
    case 'YYYYMMDD_HHMM':
      return `${Y}${M}${D}_${h}${m}`;
    case 'YYYYMMDD':
      return `${Y}${M}${D}`;
    case 'YYYY-MM-DD_HHMMSS':
      return `${Y}-${M}-${D}_${h}${m}${s}`;
    case 'YYYY-MM-DD':
      return `${Y}-${M}-${D}`;
    default:
      return '';
  }
}

function joinPath(dir, name) {
  if (!dir) return name;
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\\/]+$/, '') + sep + name;
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
    document.getElementById('startSaveShortcutLabel').textContent = `(${find('startAndSave') || 'Alt+3'})`;
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

document.getElementById('startSave').addEventListener('click', () => {
  saveOptions();
  chrome.runtime.sendMessage({ type: 'ARCHIVER_START_AND_SAVE' });
});

document.getElementById('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
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

    const opts = await new Promise(r => chrome.storage.local.get({
      filenameBase: 'title',
      customFilename: '',
      timestampFormat: 'YYYYMMDD_HHMMSS',
      saveLocation: 'last',
      customSavePath: '',
      lastDownloadDir: ''
    }, r));
    let baseName = '';
    switch (opts.filenameBase) {
      case 'url':
        baseName = sanitize(tab.url);
        break;
      case 'domain':
        try { baseName = sanitize(new URL(tab.url).hostname); } catch { baseName = ''; }
        break;
      case 'custom':
        baseName = sanitize(opts.customFilename) || 'archive';
        break;
      case 'title':
      default:
        baseName = sanitize(tab.title) || 'archive';
        break;
    }
      const ts = formatTimestamp(opts.timestampFormat);
      const baseFilename = `${baseName}${ts ? '_' + ts : ''}.mhtml`;
      let saveAs = false;
      let targetDir = '';
      if (opts.saveLocation === 'custom' && opts.customSavePath) {
        targetDir = opts.customSavePath;
      } else if (opts.saveLocation === 'last') {
        if (opts.lastDownloadDir) {
          targetDir = opts.lastDownloadDir;
        } else {
          saveAs = true;
        }
      } else {
        saveAs = opts.saveLocation === 'last';
      }

      let downloadId;
      let listener;
      if (targetDir && chrome.downloads.onDeterminingFilename?.addListener) {
        listener = (item, suggest) => {
          if (!downloadId || item.id === downloadId) {
            if (typeof suggest === 'function') {
              suggest({ filename: joinPath(targetDir, baseFilename) });
            }
            chrome.downloads.onDeterminingFilename.removeListener(listener);
          }
        };
        chrome.downloads.onDeterminingFilename.addListener(listener);
      }

      downloadId = await chrome.downloads.download({
        url,
        filename: baseFilename,
        saveAs
      });
      if (downloadId === undefined && listener) {
        chrome.downloads.onDeterminingFilename.removeListener(listener);
      }

    // After download completes, stop (same as your branch)
    const onChanged = async delta => {
      if (delta.id === downloadId && delta.state?.current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        try {
          const [item] = await chrome.downloads.search({ id: downloadId });
          const dir = item?.filename?.replace(/[\\/][^\\/]*$/, '');
          if (dir) chrome.storage.local.set({ lastDownloadDir: dir });
        } catch (err) {
          console.warn('failed to capture last dir', err);
        }
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
