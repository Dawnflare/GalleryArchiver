global.btoa = str => Buffer.from(str, 'binary').toString('base64');
global.Blob = require('buffer').Blob;
global.URL.createObjectURL = jest.fn(() => 'blob:fake');
global.URL.revokeObjectURL = jest.fn();

const sendMessage = jest.fn((tabId, msg) => {
  if (msg.type === 'ARCHIVER_SAVE_MHTML_VIA_PAGE') return Promise.resolve({ ok: true });
  return Promise.resolve({});
});

global.chrome = {
  action: { openPopup: jest.fn(() => Promise.resolve()) },
  tabs: {
    query: jest.fn(() => Promise.resolve([{ id: 321 }])),
    get: jest.fn(() => Promise.resolve({ id: 321, title: 'My Tab', url: 'https://example.com/path' })),
    sendMessage,
    reload: jest.fn(),
  },
  pageCapture: { saveAsMHTML: jest.fn(() => Promise.resolve(new Blob(['test'], { type: 'text/plain' }))) },
  downloads: { download: jest.fn(() => Promise.resolve(1)), onChanged: { addListener: jest.fn(), removeListener: jest.fn() } },
  runtime: { onMessage: { addListener: jest.fn() }, reload: jest.fn() },
  commands: { onCommand: { addListener: jest.fn() } },
  storage: { local: { get: jest.fn((defaults, cb) => cb(defaults)) } }
};

require('../background.js');

test('start command opens popup then starts capture', async () => {
  const handler = chrome.commands.onCommand.addListener.mock.calls[0][0];
  await handler('start');

  expect(chrome.action.openPopup).toHaveBeenCalled();
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(321, { type: 'ARCHIVER_START' });
});

test('reset command opens popup then reloads tab and extension', async () => {
  chrome.action.openPopup.mockClear();
  chrome.tabs.sendMessage.mockClear();
  chrome.tabs.reload.mockClear();
  chrome.runtime.reload.mockClear();
  const handler = chrome.commands.onCommand.addListener.mock.calls[0][0];
  await handler('reset');

  expect(chrome.action.openPopup).toHaveBeenCalled();
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(321, { type: 'ARCHIVER_RESET', payload: {} });
  expect(chrome.tabs.reload).toHaveBeenCalledWith(321);
  expect(chrome.runtime.reload).toHaveBeenCalled();
});

test('save command opens popup then saves via page context', async () => {
  chrome.action.openPopup.mockClear();
  chrome.pageCapture.saveAsMHTML.mockClear();
  chrome.tabs.sendMessage.mockClear();
  chrome.downloads.download.mockClear();
  const handler = chrome.commands.onCommand.addListener.mock.calls[0][0];
  await handler('save');

  expect(chrome.action.openPopup).toHaveBeenCalled();
  expect(chrome.pageCapture.saveAsMHTML).toHaveBeenCalledWith({ tabId: 321 });

  const calls = chrome.tabs.sendMessage.mock.calls;
  const prepareCall = calls.find(([, msg]) => msg.type === 'ARCHIVER_PREPARE_FOR_SAVE');
  expect(prepareCall).toBeTruthy();

  const saveCall = calls.find(([, msg]) => msg.type === 'ARCHIVER_SAVE_MHTML_VIA_PAGE');
  expect(saveCall).toBeTruthy();
  expect(saveCall[0]).toBe(321);
  expect(saveCall[1].payload.blobUrl).toBe('blob:fake');
  expect(saveCall[1].payload.mime).toBe('application/x-mimearchive');
  const fname = saveCall[1].payload.suggestedName;
  expect(fname.startsWith('My_Tab_')).toBe(true);
  expect(fname.endsWith('.mhtml')).toBe(true);

  const stopCall = calls.find(([, msg]) => msg.type === 'ARCHIVER_STOP');
  expect(stopCall).toBeTruthy();

  expect(chrome.downloads.download).not.toHaveBeenCalled();
});

