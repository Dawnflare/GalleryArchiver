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

async function normalizeMHTMLBlob(mhtmlData) {
  if (mhtmlData instanceof Blob) {
    const buf = await mhtmlData.arrayBuffer();
    return new Blob([buf], { type: 'application/x-mimearchive' });
  }
  if (mhtmlData?.arrayBuffer) {
    const buf = await mhtmlData.arrayBuffer();
    return new Blob([buf], { type: 'application/x-mimearchive' });
  }
  if (typeof mhtmlData === 'string') return new Blob([mhtmlData], { type: 'application/x-mimearchive' });
  if (mhtmlData?.data) return new Blob([mhtmlData.data], { type: 'application/x-mimearchive' });
  return new Blob([mhtmlData], { type: 'application/x-mimearchive' });
}

async function saveMHTML(tabId) {
  if (!tabId) return;
  try {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_PREPARE_FOR_SAVE', payload: {} });
      await new Promise(r => setTimeout(r, 120));
    } catch (e) {
      console.warn('[BG] PREPARE failed (continuing anyway):', e);
    }

    const raw = await chrome.pageCapture.saveAsMHTML({ tabId });
    const blob = await normalizeMHTMLBlob(raw);

    const tab = await chrome.tabs.get(tabId);
    const opts = await new Promise(r => chrome.storage.local.get({
      filenameBase: 'title',
      customFilename: '',
      timestampFormat: 'YYYYMMDD_HHMMSS'
    }, r));
    let baseName = '';
    switch (opts.filenameBase) {
      case 'url':
        baseName = sanitize(tab.url);
        break;
      case 'domain':
        try { baseName = sanitize(new URL(tab.url).hostname); } catch { baseName = 'archive'; }
        break;
      case 'custom':
        baseName = sanitize(opts.customFilename) || 'archive';
        break;
      case 'title':
      default:
        baseName = sanitize(tab.title) || 'archive';
    }
    const ts = formatTimestamp(opts.timestampFormat);
    const suggestedName = `${baseName}${ts ? '_' + ts : ''}.mhtml`;

    let blobUrl;
    let bytes;
    if (typeof URL?.createObjectURL === 'function') {
      try { blobUrl = URL.createObjectURL(blob); } catch {}
    }
    if (!blobUrl) {
      // Fallback: send ArrayBuffer so content script can reconstruct Blob
      bytes = await blob.arrayBuffer();
    }

    try {
      const res = await chrome.tabs.sendMessage(tabId, {
        type: 'ARCHIVER_SAVE_MHTML_VIA_PAGE',
        payload: {
          suggestedName,
          mime: 'application/x-mimearchive',
          ...(blobUrl ? { blobUrl } : { bytes }),
        },
      });
      if (!res || res.ok !== true) throw new Error(res?.error || 'in-page save failed');
    } catch (e) {
      console.warn('[BG] In-page save failed, falling back to downloads API:', e);
      let downloadUrl = blobUrl;
      if (!downloadUrl) {
        const ab = bytes || await blob.arrayBuffer();
        const view = new Uint8Array(ab);
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < view.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, view.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binary);
        downloadUrl = `data:application/x-mimearchive;base64,${base64}`;
      }
      const id = await chrome.downloads.download({ url: downloadUrl, filename: suggestedName, saveAs: true });
      const onChanged = (delta) => {
        if (delta.id === id && delta.state?.current === 'complete') {
          chrome.downloads.onChanged.removeListener(onChanged);
          if (blobUrl) {
            try { URL.revokeObjectURL(downloadUrl); } catch {}
          }
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
    } finally {
      if (blobUrl) {
        try { URL.revokeObjectURL(blobUrl); } catch {}
      }
    }

    await chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_STOP' });
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
