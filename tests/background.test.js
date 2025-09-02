global.btoa = str => Buffer.from(str, 'binary').toString('base64');

const sendMessage = jest.fn(() => Promise.resolve());
const store = {};

global.chrome = {
  action: { openPopup: jest.fn(() => Promise.resolve()) },
  tabs: {
    query: jest.fn(() => Promise.resolve([{ id: 321 }])),
    get: jest.fn(() => Promise.resolve({ id: 321, title: 'My Tab', url: 'https://example.com/path' })),
    sendMessage,
    reload: jest.fn(),
  },
  pageCapture: { saveAsMHTML: jest.fn(() => Promise.resolve({ arrayBuffer: () => Promise.resolve(Uint8Array.from([116,101,115,116]).buffer) })) },
  downloads: {
    download: jest.fn(() => Promise.resolve(1)),
    search: jest.fn((query, cb) => cb([{ id: query.id, filename: '/tmp/path/file.mhtml' }])),
    onChanged: { addListener: jest.fn(), removeListener: jest.fn() }
  },
  runtime: { onMessage: { addListener: jest.fn() }, reload: jest.fn() },
  commands: { onCommand: { addListener: jest.fn() } },
  storage: {
    local: {
      get: jest.fn((defaults, cb) => cb({ ...defaults, ...store })),
      set: jest.fn((obj, cb) => { Object.assign(store, obj); cb && cb(); })
    }
  }
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

test('save command opens popup then triggers download', async () => {
  chrome.action.openPopup.mockClear();
  chrome.pageCapture.saveAsMHTML.mockClear();
  const handler = chrome.commands.onCommand.addListener.mock.calls[0][0];
  await handler('save');

  expect(chrome.action.openPopup).toHaveBeenCalled();
  expect(chrome.pageCapture.saveAsMHTML).toHaveBeenCalledWith({ tabId: 321 });
  const urlArg = chrome.downloads.download.mock.calls[0][0].url;
  expect(urlArg.startsWith('data:application/x-mimearchive;base64,')).toBe(true);
  const fname = chrome.downloads.download.mock.calls[0][0].filename;
  expect(fname.startsWith('My_Tab_')).toBe(true);
  expect(fname.endsWith('.mhtml')).toBe(true);
});

test('stores and reuses last download directory', async () => {
  Object.keys(store).forEach(k => delete store[k]);
  store.useLastDir = true;
  chrome.downloads.download.mockClear();
  const handler = chrome.commands.onCommand.addListener.mock.calls[0][0];

  await handler('save');
  const listener = chrome.downloads.onChanged.addListener.mock.calls.pop()[0];
  chrome.downloads.search.mockImplementation((q, cb) => cb([{ filename: '/dl/path/first.mhtml' }]));
  listener({ id: 1, state: { current: 'complete' } });
  expect(chrome.storage.local.set).toHaveBeenCalledWith({ lastDownloadDir: '/dl/path' });

  chrome.downloads.download.mockClear();
  await handler('save');
  const opts = chrome.downloads.download.mock.calls[0][0];
  expect(opts.saveAs).toBe(false);
  expect(opts.filename.startsWith('/dl/path/')).toBe(true);
});

