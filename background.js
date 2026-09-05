// background.js

// Fetch posters in the extension context: page-side fetch/canvas is subject
// to the CDN's CORS headers even when the poster displays normally.
async function fetchVideoPoster(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'image.civitai.com' ||
      parsed.port || parsed.username || parsed.password) {
    throw new Error('Unsupported poster URL');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(parsed.href, {
      credentials: 'omit', redirect: 'follow', signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Poster HTTP ${response.status}`);
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) {
      throw new Error('Poster response is not a supported image');
    }
    const limit = 8 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) {
      throw new Error('Poster too large');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error('Poster too large');
      }
      chunks.push(value);
    }
    if (!size) throw new Error('Empty poster');
    // Service workers have no FileReader. Encode in small batches to avoid
    // exceeding the argument limit for large images.
    let binary = '';
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i += 8192) {
        binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
      }
    }
    return `data:${type};base64,${btoa(binary)}`;
  } finally {
    clearTimeout(timeout);
  }
}

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

  if (msg.type === 'ARCHIVER_FETCH_VIDEO_POSTER') {
    fetchVideoPoster(msg.url)
      .then(dataUrl => sendResponse({ ok: true, dataUrl }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

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
  } else if (command === 'save') {
    await saveMHTML();
  } else if (command === 'startAndSave') {
    await maybeOpenPopup();
    await startAndSave(targetTabId);
  } else if (command === 'saveAllTabs') {
    await saveAllTabs();
  }
});
