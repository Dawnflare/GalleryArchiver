// === GalleryArchiver — popup.js (full replacement, v7) ===
// ✅ Opens the native Save dialog in the LAST‑USED folder
// ✅ Prefills a clean filename: <title_or_choice>_<timestamp>.mhtml
// How: capture MHTML in the popup, then ask the **content script** to perform
// an in‑page download (hidden <a download> in the tab). Chromium treats this like
// a user‑initiated save from the page, so it follows the last‑used directory.
// We keep a downloads‑API fallback just in case.
// Logs are prefixed with [GA][POPUP].

console.log('[GA][POPUP] popup loaded (v7 in‑page save)');

// -------------------- helpers --------------------
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sanitize(str) {
  return (str || '')
    .replace(/[\\/:*?"<>|]/g, '') // Windows‑illegal chars
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
    case 'YYYYMMDD_HHMMSS': return `${Y}${M}${D}_${h}${m}${s}`;
    case 'YYYYMMDD_HHMM':   return `${Y}${M}${D}_${h}${m}`;
    case 'YYYYMMDD':        return `${Y}${M}${D}`;
    case 'YYYY-MM-DD_HHMMSS': return `${Y}-${M}-${D}_${h}${m}${s}`;
    case 'YYYY-MM-DD':        return `${Y}-${M}-${D}`;
    default: return '';
  }
}

async function normalizeMHTMLBlob(mhtmlData) {
  // Try to coerce to a typed Blob so Windows picks a sane "Save as type" and keeps .mhtml
  if (mhtmlData instanceof Blob) {
    const buf = await mhtmlData.arrayBuffer();
    return new Blob([buf], { type: 'application/x-mimearchive' });
  }
  if (typeof mhtmlData === 'string') return new Blob([mhtmlData], { type: 'application/x-mimearchive' });
  if (mhtmlData?.data) return new Blob([mhtmlData.data], { type: 'application/x-mimearchive' });
  return new Blob([mhtmlData], { type: 'application/x-mimearchive' });
}

async function sendToContent(type, payload = {}, tabId) {
  let id = tabId;
  if (id == null) {
    const tab = await getActiveTab();
    id = tab.id;
  }
  return chrome.tabs.sendMessage(id, { type, payload });
}

function restoreOptions() {
  chrome.storage.local.get({ maxItems: 200 }, (opts) => {
    const el = document.getElementById('maxItems');
    if (el) el.value = opts.maxItems;
  });

  if (chrome.commands?.getAll) {
    chrome.commands.getAll((commands) => {
      const find = (name) => commands.find((c) => c.name === name)?.shortcut || '';
      const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = `(${val})`; };
      set('startShortcutLabel', find('start') || 'Alt+1');
      set('resetShortcutLabel', find('reset') || 'Alt+Shift+R');
      set('startSaveShortcutLabel', find('startAndSave') || 'Alt+3');
      set('saveShortcutLabel', find('save') || 'Alt+2');
      set('saveAllTabsShortcutLabel', find('saveAllTabs') || 'Alt+4');
    });
  }
}

function saveOptions() {
  const el = document.getElementById('maxItems');
  const maxItems = parseInt(el?.value || '200', 10);
  chrome.storage.local.set({ maxItems });
}

// -------------------- UI event wiring --------------------
const $ = (id) => document.getElementById(id);

$('start')?.addEventListener('click', async () => {
  saveOptions();
  const tab = await getActiveTab();
  chrome.tabs.sendMessage(tab.id, { type: 'ARCHIVER_START' });
});

$('stop')?.addEventListener('click', async () => {
  const tab = await getActiveTab();
  chrome.tabs.sendMessage(tab.id, { type: 'ARCHIVER_STOP' });
});

$('reset')?.addEventListener('click', async () => {
  const tab = await getActiveTab();
  await chrome.tabs.sendMessage(tab.id, { type: 'ARCHIVER_RESET', payload: {} });
  await chrome.tabs.reload(tab.id);
  chrome.runtime.reload();
});

$('startSave')?.addEventListener('click', () => {
  saveOptions();
  chrome.runtime.sendMessage({ type: 'ARCHIVER_START_AND_SAVE' });
});

$('options')?.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

$('save')?.addEventListener('click', async () => {
  console.log('[GA][POPUP] Save clicked');
  try {
    await doSaveInPage();
  } catch (err) {
    console.error('[GA][POPUP] Save error:', err);
  }
});

async function doSaveAllTabs() {
  console.log('[GA][POPUP] Save all tabs clicked');
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    for (const tab of tabs) {
      try {
        await doSaveInPage(tab);
      } catch (err) {
        console.error('[GA][POPUP] Save failed for tab', tab.id, err);
      }
    }
  } catch (err) {
    console.error('[GA][POPUP] Save all tabs error:', err);
    throw err;
  }
}

$('saveAllTabs')?.addEventListener('click', async () => {
  try {
    await doSaveAllTabs();
  } catch {
    // handled in doSaveAllTabs
  }
});

// -------------------- save implementation (in‑page) --------------------
async function doSaveInPage(tabParam) {
  const tab = tabParam || await getActiveTab();
  console.log('[GA][POPUP] Active tab:', { id: tab?.id, title: tab?.title, url: tab?.url });

  // 1) Prepare the page
  try {
    const prep = await sendToContent('ARCHIVER_PREPARE_FOR_SAVE', {}, tab.id);
    console.log('[GA][POPUP] PREPARE result:', prep);
    await new Promise((r) => setTimeout(r, 120));
  } catch (e) {
    console.warn('[GA][POPUP] PREPARE failed (continuing):', e);
  }

  // 2) Capture MHTML → typed Blob
  const raw = await chrome.pageCapture.saveAsMHTML({ tabId: tab.id });
  const blob = await normalizeMHTMLBlob(raw);
  console.log('[GA][POPUP] MHTML blob size(bytes):', blob.size, 'type:', blob.type);

  // 3) Build suggested filename from options
  const opts = await new Promise((resolve) => chrome.storage.local.get({
    filenameBase: 'title',
    customFilename: '',
    timestampFormat: 'YYYYMMDD_HHMMSS'
  }, resolve));

  let baseName = '';
  switch (opts.filenameBase) {
    case 'url':      baseName = sanitize(tab.url); break;
    case 'domain':   try { baseName = sanitize(new URL(tab.url).hostname); } catch { baseName = 'archive'; } break;
    case 'custom':   baseName = sanitize(opts.customFilename) || 'archive'; break;
    case 'title':
    default:         baseName = sanitize(tab.title) || 'archive';
  }
  const ts = formatTimestamp(opts.timestampFormat);
  const suggestedName = `${baseName}${ts ? '_' + ts : ''}.mhtml`;
  console.log('[GA][POPUP] Suggested name:', suggestedName);

  // 4) Send blobUrl to the **content script** to save via in‑page anchor
  const blobUrl = URL.createObjectURL(blob);
  try {
    const res = await sendToContent('ARCHIVER_SAVE_MHTML_VIA_PAGE', {
      suggestedName,
      mime: 'application/x-mimearchive',
      blobUrl,
    }, tab.id);
    console.log('[GA][POPUP] In‑page save response:', res);
    if (!res || res.ok !== true) throw new Error(res?.error || 'in‑page save failed');
  } catch (e) {
    console.warn('[GA][POPUP] In‑page save failed, falling back to downloads API:', e);

    // Fallback: downloads API with blob URL + filename (will likely open default dir)
    const fallbackUrl = URL.createObjectURL(blob);
    const id = await chrome.downloads.download({ url: fallbackUrl, filename: suggestedName, saveAs: true });
    const onChanged = (delta) => {
      if (delta.id === id && delta.state?.current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        URL.revokeObjectURL(fallbackUrl);
        console.log('[GA][POPUP] Fallback download complete');
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  } finally {
    try { URL.revokeObjectURL(blobUrl); } catch {}
  }

  // 5) Tell content to stop overlays, etc.
  await sendToContent('ARCHIVER_STOP', {}, tab.id);
}

// -------------------- live stats wiring --------------------
restoreOptions();
const statusEl = document.getElementById('status');
if (statusEl) statusEl.textContent = '';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'ARCHIVER_STATS') {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = String(v ?? 0); };
    set('seen', msg.seen);
    set('captured', msg.captured);
    set('deduped', msg.deduped);
    set('total', msg.total);
  }
  if (msg?.type === 'ARCHIVER_STATE') {
    const progress = document.getElementById('progress');
    if (progress) {
      progress.max = msg.maxItems ?? 0;
      progress.value = msg.captured ?? 0;
    }
    const status = document.getElementById('status');
    if (status) status.textContent = msg.running ? 'Capturing...' : 'Ready to Save';
  }
  if (msg?.type === 'ARCHIVER_POPUP_SAVE') {
    (async () => {
      try {
        await doSaveInPage();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }
  if (msg?.type === 'ARCHIVER_POPUP_SAVE_ALL_TABS') {
    (async () => {
      try {
        await doSaveAllTabs();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }
});

// Auto‑save support
if (location.hash === '#autosave') {
  setTimeout(() => document.getElementById('save')?.click(), 0);
}
