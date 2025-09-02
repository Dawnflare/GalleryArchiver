global.btoa = str => Buffer.from(str, 'binary').toString('base64');

const sendMessage = jest.fn(() => Promise.resolve());

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
    search: jest.fn(() => Promise.resolve([{ filename: '/prev/path/old.mhtml' }])),
    onChanged: { addListener: jest.fn(), removeListener: jest.fn() },
    onDeterminingFilename: { addListener: jest.fn(), removeListener: jest.fn() }
  },
  runtime: { onMessage: { addListener: jest.fn() }, reload: jest.fn() },
  commands: { onCommand: { addListener: jest.fn() } },
  storage: { local: { get: jest.fn((defaults, cb) => cb(defaults)), set: jest.fn() } }
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
  chrome.downloads.search.mockClear();
  const handler = chrome.commands.onCommand.addListener.mock.calls[0][0];
  await handler('save');

  expect(chrome.action.openPopup).toHaveBeenCalled();
  expect(chrome.pageCapture.saveAsMHTML).toHaveBeenCalledWith({ tabId: 321 });
  expect(chrome.downloads.search).not.toHaveBeenCalled();
  const opts = chrome.downloads.download.mock.calls[0][0];
  expect(opts.url.startsWith('data:application/x-mimearchive;base64,')).toBe(true);
  expect(opts.filename).toMatch(/^My_Tab_.*\.mhtml$/);
  expect(opts.saveAs).toBe(true);
});

test('stores last download directory but continues prompting', async () => {
  chrome.downloads.download.mockClear();
  chrome.downloads.onChanged.addListener.mockClear();
  chrome.storage.local.set.mockClear();
  chrome.downloads.search.mockClear();
  chrome.downloads.onDeterminingFilename.addListener.mockClear();

  const handler = chrome.commands.onCommand.addListener.mock.calls[0][0];

  // First save with no stored directory triggers save dialog
  await handler('save');
  const listener = chrome.downloads.onChanged.addListener.mock.calls[0][0];
  await listener({ id: 1, state: { current: 'complete' } });

  expect(chrome.downloads.search).toHaveBeenCalledWith({ id: 1 });
  expect(chrome.storage.local.set).toHaveBeenCalledWith({ lastDownloadDir: '/prev/path' });

  // Simulate stored directory for next save
  chrome.storage.local.get.mockImplementation((defaults, cb) => cb({
    ...defaults,
    lastDownloadDir: '/prev/path'
  }));
  chrome.downloads.download.mockClear();

  await handler('save');
  const opts2 = chrome.downloads.download.mock.calls[0][0];
  expect(opts2.filename).toMatch(/^\/prev\/path\/My_Tab_.*\.mhtml$/);
  expect(opts2.saveAs).toBe(true);
});

test('uses custom save path when configured', async () => {
  chrome.storage.local.get.mockImplementationOnce((defaults, cb) => cb({
    ...defaults,
    saveLocation: 'custom',
    customSavePath: '/my/custom/dir'
  }));
  chrome.downloads.download.mockClear();
  const handler = chrome.commands.onCommand.addListener.mock.calls[0][0];
  await handler('save');
  const opts3 = chrome.downloads.download.mock.calls[0][0];
  expect(opts3.filename).toMatch(/^\/my\/custom\/dir\/My_Tab_.*\.mhtml$/);
  expect(opts3.saveAs).toBe(true);
});

