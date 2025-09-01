// Background (service worker) — drop‑in replacement
// Adds an explicit PREPARE step before saving MHTML so the content script can
// build the static snapshot (videos inlined as data: URLs) and hide the live app.
//
// Messages expected from popup/content:
//   • ARCHIVER_SAVE_MHTML { tabId? }
//      – Triggers PREPARE in the active tab, then pageCapture.saveAsMHTML
//
// This file is safe to replace your existing background.js with.

/* -------------------------- small helpers -------------------------- */
function withTimeout(promise, ms, onTimeoutValue) {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) resolve(onTimeoutValue);
    }, ms);
    promise.then((v) => { settled = true; clearTimeout(t); resolve(v); })
           .catch(() => { settled = true; clearTimeout(t); resolve(onTimeoutValue); });
  });
}

function sanitizeFilename(s, fallback = 'civitai-archive') {
  if (!s || typeof s !== 'string') return fallback;
  return s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;
}

async function getActiveTab(tabIdMaybe) {
  if (tabIdMaybe) {
    try {
      const t = await chrome.tabs.get(tabIdMaybe);
      return t;
    } catch (_) {}
  }
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t || null;
}

/* ----------------------- prepare step (content) ----------------------- */
function prepareActiveTab(tabId) {
  return new Promise((resolve) => {
    let responded = false;
    try {
      chrome.tabs.sendMessage(
        tabId,
        { type: 'ARCHIVER_PREPARE_FOR_SAVE' },
        (resp) => {
          responded = true;
          if (chrome.runtime.lastError) {
            console.warn('[BG] prepare: sendMessage error:', chrome.runtime.lastError.message);
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: false, error: 'no response' });
          }
        }
      );
    } catch (e) {
      console.warn('[BG] prepare: exception while sending', e);
      return resolve({ ok: false, error: String(e) });
    }
    // Failsafe: if the content script never responds, continue anyway after timeout
    setTimeout(() => { if (!responded) resolve({ ok: false, error: 'timeout' }); }, 4000);
  });
}

/* ----------------------------- saver ----------------------------- */
async function saveCurrentTabAsMHTML(tabIdFromMsg) {
  const tab = await getActiveTab(tabIdFromMsg);
  if (!tab) {
    console.error('[BG] save: no active tab');
    return;
  }
  const tabId = tab.id;
  const title = sanitizeFilename(tab.title, 'civitai-archive');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${title}-${ts}.mhtml`;

  console.log('[BG] prepare: start');
  const prep = await withTimeout(prepareActiveTab(tabId), 4500, { ok: false, error: 'timeout' });
  console.log('[BG] prepare: result', prep);

  // Small settle so the snapshot DOM is the one captured
  await new Promise((r) => setTimeout(r, 150));

  // Capture
  chrome.pageCapture.saveAsMHTML({ tabId }, (blob) => {
    if (chrome.runtime.lastError) {
      console.error('[BG] MHTML save error:', chrome.runtime.lastError.message);
      return;
    }
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename }, () => setTimeout(() => URL.revokeObjectURL(url), 60_000));
  });
}

/* --------------------------- message bus --------------------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return; // ignore

  if (msg.type === 'ARCHIVER_SAVE_MHTML') {
    // Accept optional tabId from the sender; otherwise use active tab
    saveCurrentTabAsMHTML(msg.tabId || (sender.tab && sender.tab.id));
    sendResponse && sendResponse({ ok: true });
    return; // no need to keep the channel open
  }
});
