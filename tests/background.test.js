global.URL.createObjectURL = jest.fn(() => 'blob:fake');
global.URL.revokeObjectURL = jest.fn();

const sendMessage = jest.fn(() => Promise.resolve());

global.chrome = {
  action: { openPopup: jest.fn(() => Promise.resolve()) },
  tabs: {
    query: jest.fn(() => Promise.resolve([{ id: 321 }])),
    sendMessage,
    reload: jest.fn(),
  },
  pageCapture: { saveAsMHTML: jest.fn(() => Promise.resolve(new Blob(['test'], { type: 'text/plain' }))) },
  downloads: { download: jest.fn(() => Promise.resolve(1)), onChanged: { addListener: jest.fn(), removeListener: jest.fn() } },
  runtime: { onMessage: { addListener: jest.fn() }, reload: jest.fn() },
  commands: { onCommand: { addListener: jest.fn() } }
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
});

