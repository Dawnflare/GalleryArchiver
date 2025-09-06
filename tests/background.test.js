global.chrome = {
  action: { openPopup: jest.fn(() => Promise.resolve()) },
  tabs: {
    query: jest.fn(() => Promise.resolve([{ id: 321 }])),
    sendMessage: jest.fn(),
    reload: jest.fn(),
  },
  runtime: {
    onMessage: { addListener: jest.fn() },
    reload: jest.fn(),
    sendMessage: jest.fn(() => Promise.resolve({ ok: true })),
  },
  commands: { onCommand: { addListener: jest.fn() } },
};

require('../background.js');

test('start command opens popup then starts capture', async () => {
  const handler = chrome.commands.onCommand.addListener.mock.calls[0][0];
  await handler('start');

  expect(chrome.action.openPopup).toHaveBeenCalled();
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(321, { type: 'ARCHIVER_START' });
});

test('save command opens popup then delegates to popup for saving', async () => {
  chrome.action.openPopup.mockClear();
  chrome.runtime.sendMessage.mockClear();
  chrome.tabs.sendMessage.mockClear();
  const handler = chrome.commands.onCommand.addListener.mock.calls[0][0];
  await handler('save');

  expect(chrome.action.openPopup).toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'ARCHIVER_POPUP_SAVE' });
  expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
});

test('saveAllTabs command opens popup then delegates to popup for saving all tabs', async () => {
  chrome.action.openPopup.mockClear();
  chrome.runtime.sendMessage.mockClear();
  const handler = chrome.commands.onCommand.addListener.mock.calls[0][0];
  await handler('saveAllTabs');

  expect(chrome.action.openPopup).toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'ARCHIVER_POPUP_SAVE_ALL_TABS' });
});

