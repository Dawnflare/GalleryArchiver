document.body.innerHTML = `
  <button id="start"></button>
  <button id="stop"></button>
  <button id="save"></button>
  <input id="maxItems" />
  <input id="scrollDelay" />
  <input id="stabilityTimeout" />
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
    query: jest.fn(() => Promise.resolve([{ id: 123 }])),
    sendMessage: jest.fn()
  },
  pageCapture: { saveAsMHTML: jest.fn(() => Promise.resolve(new Blob(['test'], { type: 'text/plain' }))) },
  downloads: { download: jest.fn(() => Promise.resolve(1)) },
  storage: { local: { get: jest.fn((defaults, cb) => cb(defaults)), set: jest.fn() } },
  runtime: { onMessage: { addListener: jest.fn() } }
};

require('../popup.js');

test('save button triggers page capture and download', async () => {
  document.getElementById('save').click();
  // Wait microtasks for async handlers
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(chrome.pageCapture.saveAsMHTML).toHaveBeenCalledWith({ tabId: 123 });
  // ensure we wrap the captured data with the correct MIME type
  const blobArg = global.URL.createObjectURL.mock.calls[0][0];
  expect(blobArg.type).toBe('application/x-mimearchive');
  expect(chrome.downloads.download).toHaveBeenCalled();
});
