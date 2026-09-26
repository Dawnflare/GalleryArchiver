describe('Start and Save at the end of a gallery', () => {
  let handler, scroller, pageHeight, options, imagesLoading;

  const saves = () => chrome.runtime.sendMessage.mock.calls
    .filter(([message]) => message.type === 'ARCHIVER_SAVE_MHTML');
  const start = async (autoSave = true) => {
    handler({ type: 'ARCHIVER_START', autoSave });
    await Promise.resolve();
  };
  const addImage = id => {
    const anchor = document.createElement('a');
    anchor.href = `/images/${id}`;
    anchor.innerHTML = `<img src="https://example.com/${id}.jpg">`;
    document.body.appendChild(anchor);
  };

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
    pageHeight = 1800;
    imagesLoading = false;
    options = { maxItems: 500, scrollDelay: 300, stabilityTimeout: 400 };
    scroller = document.documentElement;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, get: () => pageHeight },
    });
    scroller.scrollTop = 0;
    scroller.scrollTo = jest.fn((x, y) => { scroller.scrollTop = y; });
    scroller.scrollBy = jest.fn((x, y) => {
      scroller.scrollTop = Math.min(Math.max(0, pageHeight - 600), scroller.scrollTop + y);
    });
    jest.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockImplementation(() => !imagesLoading);
    jest.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(100);
    global.chrome = {
      runtime: {
        onMessage: { addListener: jest.fn() },
        sendMessage: jest.fn(),
      },
      storage: { local: { get: jest.fn((defaults, callback) => callback(options)) } },
    };
    require('../content/archiver.js');
    handler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  });

  afterEach(() => {
    handler({ type: 'ARCHIVER_STOP' });
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete scroller.clientHeight;
    delete scroller.scrollHeight;
    delete scroller.scrollTo;
    delete scroller.scrollBy;
  });

  test('saves once with 100 images when the requested limit is 500', async () => {
    for (let id = 0; id < 100; id++) addImage(id);
    await start();
    await jest.advanceTimersByTimeAsync(6000);
    expect(saves()).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(3000);
    expect(saves()).toHaveLength(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'ARCHIVER_STATE', running: false, captured: 100, maxItems: 500,
    });
    expect(document.querySelectorAll('#civitai-archiver-bucket img')).toHaveLength(100);
    await jest.advanceTimersByTimeAsync(10000);
    expect(saves()).toHaveLength(1);
  });

  test('restarts the bottom wait when a delayed next page grows the document', async () => {
    await start();
    await jest.advanceTimersByTimeAsync(5000);
    pageHeight = 3600;
    await jest.advanceTimersByTimeAsync(5000);
    expect(scroller.scrollTop).toBe(3000);
    expect(saves()).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(4000);
    expect(saves()).toHaveLength(1);
  });

  test('restarts the wait for new images even without page growth', async () => {
    await start();
    await jest.advanceTimersByTimeAsync(5000);
    addImage('late');
    await jest.advanceTimersByTimeAsync(5000);
    expect(saves()).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(3000);
    expect(saves()).toHaveLength(1);
  });

  test('waits for images still loading, then saves after capture settles', async () => {
    imagesLoading = true;
    addImage('slow');
    await start();
    await jest.advanceTimersByTimeAsync(10000);
    expect(saves()).toHaveLength(0);
    imagesLoading = false;
    document.querySelector('#civitai-archiver-bucket img').dispatchEvent(new Event('load'));
    await jest.advanceTimersByTimeAsync(3000);
    expect(saves()).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(5000);
    expect(saves()).toHaveLength(1);
  });

  test('does not wait forever for a stalled image request', async () => {
    imagesLoading = true;
    addImage('stalled');
    await start();
    await jest.advanceTimersByTimeAsync(35000);
    expect(saves()).toHaveLength(1);
  });

  test('saves a page shorter than the viewport', async () => {
    pageHeight = 600;
    await start();
    await jest.advanceTimersByTimeAsync(7000);
    expect(saves()).toHaveLength(1);
  });

  test('does not mistake a stalled scroll above the bottom for the end', async () => {
    scroller.scrollBy.mockImplementation(() => {});
    await start();
    await jest.advanceTimersByTimeAsync(15000);
    expect(saves()).toHaveLength(0);
  });

  test('does not automatically save in the Alt+1 workflow', async () => {
    await start(false);
    await jest.advanceTimersByTimeAsync(15000);
    expect(saves()).toHaveLength(0);
  });

  test('manual Stop cancels the pending automatic save', async () => {
    await start();
    await jest.advanceTimersByTimeAsync(5000);
    handler({ type: 'ARCHIVER_STOP' });
    await jest.advanceTimersByTimeAsync(10000);
    expect(saves()).toHaveLength(0);
  });

  test('still saves immediately when the configured limit is reached', async () => {
    options.maxItems = 1;
    addImage('first');
    await start();
    await jest.advanceTimersByTimeAsync(500);
    expect(saves()).toHaveLength(1);
    expect(scroller.scrollTop).toBeLessThan(pageHeight - 600);
  });

  test('restores original page styles after each save and can save a second model version', async () => {
    const htmlStyle = 'height: 100%; overflow-y: hidden;';
    const bodyStyle = 'height: 100%; color: red;';
    document.documentElement.setAttribute('style', htmlStyle);
    document.body.setAttribute('style', bodyStyle);
    for (let version = 1; version <= 2; version++) {
      document.querySelectorAll('a').forEach(el => el.remove());
      addImage(`version-${version}`);
      await start();
      await jest.advanceTimersByTimeAsync(9000);
      expect(saves()).toHaveLength(version);

      const preparing = window.__archiverPrepareLayout.prepare();
      await jest.advanceTimersByTimeAsync(100);
      await preparing;
      // The popup sends Stop to every content-script listener after capture.
      for (const [listener] of chrome.runtime.onMessage.addListener.mock.calls) {
        listener({ type: 'ARCHIVER_STOP' }, {}, () => {});
      }
      expect(document.documentElement.getAttribute('style')).toBe(htmlStyle);
      expect(document.body.getAttribute('style')).toBe(bodyStyle);
      expect(document.querySelectorAll('#civitai-archiver-bucket img')).toHaveLength(1);
    }
  });

  test('Stop after a direct save preserves styles even when capture was never started', async () => {
    document.documentElement.style.height = '100%';
    document.body.style.overflow = 'hidden';
    const preparing = window.__archiverPrepareLayout.prepare();
    await jest.advanceTimersByTimeAsync(100);
    await preparing;
    for (const [listener] of chrome.runtime.onMessage.addListener.mock.calls) {
      listener({ type: 'ARCHIVER_STOP' }, {}, () => {});
    }
    expect(document.documentElement.style.height).toBe('100%');
    expect(document.body.style.overflow).toBe('hidden');
  });

  test.each(['__next', 'app', 'main'])('keeps the original %s page scroller when a nested scroll area exists', async target => {
    document.body.innerHTML = `<main id="${target}" style="overflow-y: hidden"><div class="scroll-area" style="overflow-y: auto"></div></main>`;
    const page = document.querySelector('main');
    const nested = document.querySelector('.scroll-area');
    for (const element of [page, nested]) {
      Object.defineProperties(element, {
        clientHeight: { value: 600 }, scrollHeight: { value: 1800 },
      });
      element.scrollTo = jest.fn((x, y) => { element.scrollTop = y; });
      element.scrollBy = jest.fn((x, y) => { element.scrollTop = Math.min(1200, element.scrollTop + y); });
    }
    await start();
    await jest.advanceTimersByTimeAsync(300);
    expect(page.scrollTop).toBeGreaterThan(0);
    expect(nested.scrollBy).not.toHaveBeenCalled();
    expect(saves()).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(9000);
    expect(page.scrollTop).toBe(1200);
    expect(scroller.scrollBy).not.toHaveBeenCalled();
    expect(saves()).toHaveLength(1);
  });
});
