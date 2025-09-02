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

test('save command opens popup then saves', async () => {
  const handler = chrome.commands.onCommand.addListener.mock.calls[0][0];
  await handler('save');

  expect(chrome.action.openPopup).toHaveBeenCalled();
  expect(chrome.pageCapture.saveAsMHTML).toHaveBeenCalledWith({ tabId: 321 });
  expect(chrome.tabs.query.mock.invocationCallOrder[0]).toBeLessThan(chrome.action.openPopup.mock.invocationCallOrder[0]);
});

