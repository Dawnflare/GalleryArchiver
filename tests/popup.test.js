document.body.innerHTML = `
  <span id="startShortcutLabel"></span><button id="start"></button>
  <span id="saveShortcutLabel"></span><button id="save"></button>
  <span id="startSaveShortcutLabel"></span><button id="startSave"></button>
  <span id="resetShortcutLabel"></span><button id="reset"></button>
  <button id="stop"></button>
  <button id="options"></button>
  <input id="maxItems" />
  <span id="seen"></span>
  <span id="captured"></span>
  <span id="deduped"></span>
  <span id="total"></span>
  <progress id="progress"></progress>
  <div id="status"></div>
`;

global.URL.createObjectURL = jest.fn(() => 'blob:fake');
global.URL.revokeObjectURL = jest.fn();

global.chrome = {
  tabs: {
    query: jest.fn(() => Promise.resolve([{ id: 123, title: 'My Tab', url: 'https://example.com/page' }])),
    sendMessage: jest.fn(),
    reload: jest.fn()
  },
  pageCapture: { saveAsMHTML: jest.fn(() => Promise.resolve(new Blob(['test'], { type: 'text/plain' }))) },
  downloads: { download: jest.fn(() => Promise.resolve(1)), search: jest.fn((query, cb) => cb([{ filename: '/tmp/prev.mhtml' }])) },
  storage: { local: { get: jest.fn((defaults, cb) => cb(defaults)), set: jest.fn() } },
  runtime: { onMessage: { addListener: jest.fn() }, reload: jest.fn(), sendMessage: jest.fn(), openOptionsPage: jest.fn() },
  commands: { getAll: jest.fn(cb => cb([
    { name: 'start', shortcut: 'Alt+1' },
    { name: 'reset', shortcut: 'Alt+Shift+R' },
    { name: 'save', shortcut: 'Alt+2' },
    { name: 'startAndSave', shortcut: 'Alt+3' }
  ])) }
};

require('../popup.js');

test('save button triggers page capture and download', async () => {
  document.getElementById('save').click();
  // Wait microtasks for async handlers
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(r => setTimeout(r, 150));
  expect(chrome.pageCapture.saveAsMHTML).toHaveBeenCalledWith({ tabId: 123 });
  // ensure we wrap the captured data with the correct MIME type
  const blobArg = global.URL.createObjectURL.mock.calls[0][0];
  expect(blobArg.type).toBe('application/x-mimearchive');
  expect(chrome.downloads.download).toHaveBeenCalled();
  const fname = chrome.downloads.download.mock.calls[0][0].filename;
  expect(fname.includes('My_Tab_')).toBe(true);
  expect(fname.endsWith('.mhtml')).toBe(true);
});

test('reset button stops autoscroll, reloads the page and extension', async () => {
  chrome.tabs.reload.mockClear();
  chrome.tabs.sendMessage.mockClear();
  chrome.runtime.reload.mockClear();
  document.getElementById('reset').click();
  // wait for async handler to complete
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(123, { type: 'ARCHIVER_RESET', payload: {} });
  expect(chrome.tabs.reload).toHaveBeenCalledWith(123);
  expect(chrome.runtime.reload).toHaveBeenCalled();
  expect(chrome.tabs.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(chrome.tabs.reload.mock.invocationCallOrder[0]);
  expect(chrome.tabs.reload.mock.invocationCallOrder[0]).toBeLessThan(chrome.runtime.reload.mock.invocationCallOrder[0]);
});

test('displays shortcut labels from commands API', async () => {
  await Promise.resolve();
  expect(document.getElementById('startShortcutLabel').textContent).toBe('(Alt+1)');
  expect(document.getElementById('resetShortcutLabel').textContent).toBe('(Alt+Shift+R)');
  expect(document.getElementById('startSaveShortcutLabel').textContent).toBe('(Alt+3)');
  expect(document.getElementById('saveShortcutLabel').textContent).toBe('(Alt+2)');
});

test('startSave button sends start-and-save message', () => {
  chrome.runtime.sendMessage.mockClear();
  document.getElementById('startSave').click();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'ARCHIVER_START_AND_SAVE' });
});

test('options button opens the options page', () => {
  chrome.runtime.openOptionsPage.mockClear();
  document.getElementById('options').click();
  expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();
});
