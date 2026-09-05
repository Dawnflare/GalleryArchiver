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

describe('video poster downloads', () => {
  const handler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  const url = 'https://image.civitai.com/example/poster.jpeg';
  const request = (target = url) => new Promise(resolve => {
    expect(handler({ type: 'ARCHIVER_FETCH_VIDEO_POSTER', url: target }, {}, resolve)).toBe(true);
  });
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: key => key === 'content-type' ? 'image/jpeg' : null },
      body: { getReader: () => ({ read: jest.fn()
        .mockResolvedValueOnce({ value: new Uint8Array([255, 216, 255]), done: false })
        .mockResolvedValueOnce({ done: true }) }) },
    });
  });
  afterEach(() => { delete global.fetch; });
  test('returns self-contained image bytes through the message channel', async () => {
    expect(await request()).toEqual({ ok: true, dataUrl: 'data:image/jpeg;base64,/9j/' });
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: 'omit', redirect: 'follow' }));
  });
  test.each(['https://example.com/poster.jpg', 'http://image.civitai.com/a', 'https://image.civitai.com.evil.test/a'])('rejects unsupported host %s', async target => {
    expect((await request(target)).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  test('rejects video responses instead of embedding movies', async () => {
    fetch.mockResolvedValue({ ok: true, headers: { get: () => 'video/mp4' } });
    expect((await request()).ok).toBe(false);
  });
  test('reports network errors', async () => {
    fetch.mockRejectedValue(new Error('offline'));
    expect((await request()).ok).toBe(false);
  });
});

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
