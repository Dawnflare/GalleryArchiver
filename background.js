// background.js (drop-in)

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

async function saveMHTML(tabId) {
  if (!tabId) return;
  try {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_PREPARE_FOR_SAVE' });
      await new Promise(r => setTimeout(r, 120));
    } catch (e) {
      console.warn('[BG] PREPARE failed (continuing anyway):', e);
    }

    const mhtmlBlob = await chrome.pageCapture.saveAsMHTML({ tabId });
    const ab = await mhtmlBlob.arrayBuffer();
    const bytes = new Uint8Array(ab);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const base64 = btoa(binary);
    const dataUrl = `data:application/x-mimearchive;base64,${base64}`;

    const tab = await chrome.tabs.get(tabId);
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

    let filename = baseFilename;
    if (opts.saveLocation === 'custom' && opts.customSavePath) {
      filename = joinPath(opts.customSavePath, baseFilename);
    } else if (opts.saveLocation === 'last' && opts.lastDownloadDir) {
      filename = joinPath(opts.lastDownloadDir, baseFilename);
    }

    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: true
    });

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
        chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_STOP' });
      }
    };

    if (chrome.downloads.onChanged?.addListener) {
      chrome.downloads.onChanged.addListener(onChanged);
    } else {
      chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_STOP' });
    }
  } catch (e) {
    console.error('[BG] save flow error:', e);
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
    saveMHTML(msg.tabId || sender?.tab?.id)
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
    await maybeOpenPopup();
    await saveMHTML(targetTabId);
  } else if (command === 'startAndSave') {
    await maybeOpenPopup();
    await startAndSave(targetTabId);
  }
});
