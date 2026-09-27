describe('Start and Save at the end of a gallery', () => {
  let handler, scroller, pageHeight, options, imagesLoading, prepareForSave;

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
    scroller.scrollTo = jest.fn(({ top }) => { scroller.scrollTop = top; });
    scroller.scrollBy = jest.fn(({ top }) => {
      scroller.scrollTop = Math.min(Math.max(0, pageHeight - 600), scroller.scrollTop + top);
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
    ({ prepareForSave } = require('../content/archiver.js'));
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

  test('stops scrolling at the limit throughout slow save preparation', async () => {
    options.maxItems = 2;
    document.body.innerHTML = '<section id="gallery"><div id="loader" style="min-height: 36px; grid-column: 1 / -1"></div></section>';
    addImage('first');
    addImage('second');
    await start();
    await jest.advanceTimersByTimeAsync(500);
    expect(saves()).toHaveLength(1);
    expect(document.getElementById('loader').style.display).toBe('none');
    expect(jest.getTimerCount()).toBe(0);
    const scrollCalls = scroller.scrollBy.mock.calls.length;
    const collected = document.querySelectorAll('#civitai-archiver-bucket img');
    expect(collected).toHaveLength(2);
    const realPrepare = window.__archiverPrepareGallery.prepare;
    let finishPreparation;
    window.__archiverPrepareGallery.prepare = jest.fn(() => new Promise(resolve => { finishPreparation = resolve; }));
    try {
      const preparing = prepareForSave();
      await jest.advanceTimersByTimeAsync(100);
      pageHeight += 6000;
      addImage('during-preparation');
      await jest.advanceTimersByTimeAsync(10000);
      expect(scroller.scrollBy).toHaveBeenCalledTimes(scrollCalls);
      expect(document.querySelectorAll('#civitai-archiver-bucket img')).toHaveLength(2);
      expect(saves()).toHaveLength(1);
      finishPreparation({});
      await jest.advanceTimersByTimeAsync(2000);
      await preparing;
    } finally {
      window.__archiverPrepareGallery.prepare = realPrepare;
    }
  });

  test('manual save pauses an active capture before preparing the page', async () => {
    document.body.innerHTML = '<section id="gallery"><div id="loader" style="min-height: 36px; grid-column: 1 / -1"></div></section>';
    addImage('captured');
    await start();
    await jest.advanceTimersByTimeAsync(500);
    const scrollCalls = scroller.scrollBy.mock.calls.length;
    const preparing = prepareForSave();
    expect(document.getElementById('loader').style.display).toBe('none');
    await jest.advanceTimersByTimeAsync(10000);
    await preparing;
    expect(scroller.scrollBy).toHaveBeenCalledTimes(scrollCalls);
    expect(document.querySelectorAll('#civitai-archiver-bucket img')).toHaveLength(1);
    expect(saves()).toHaveLength(0);
    handler({ type: 'ARCHIVER_STOP' });
    expect(document.getElementById('loader').style.display).toBe('');
  });

  test('a stopped loop and pending images cannot join an immediate new run', async () => {
    addImage('previous-run');
    await start();
    handler({ type: 'ARCHIVER_STOP' });
    document.querySelector('a').remove();
    await start();
    scroller.scrollBy.mockClear();
    await jest.advanceTimersByTimeAsync(600);
    expect(scroller.scrollBy).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('#civitai-archiver-bucket img')).toHaveLength(0);
    expect(scroller.scrollBy).toHaveBeenCalledWith({ top: 540, behavior: 'instant' });
  });

  test('save preparation cancels a start still waiting for options', async () => {
    let finishOptions;
    chrome.storage.local.get.mockImplementation((defaults, callback) => { finishOptions = callback; });
    await start();
    const preparing = prepareForSave();
    finishOptions(options);
    await jest.advanceTimersByTimeAsync(2000);
    await preparing;
    expect(scroller.scrollBy).not.toHaveBeenCalled();
    expect(document.querySelector('#civitai-archiver-bucket')).toBeNull();
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
    pageHeight = 600; // The document itself cannot scroll in this layout.
    document.body.innerHTML = `<main id="${target}" style="overflow-y: hidden"><div class="scroll-area" style="overflow-y: auto"></div></main>`;
    const page = document.querySelector('main');
    const nested = document.querySelector('.scroll-area');
    for (const element of [page, nested]) {
      Object.defineProperties(element, {
        clientHeight: { value: 600 }, scrollHeight: { value: 1800 },
      });
      element.scrollTo = jest.fn(({ top }) => { element.scrollTop = top; });
      element.scrollBy = jest.fn(({ top }) => { element.scrollTop = Math.min(1200, element.scrollTop + top); });
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

  test('scrolls the viewport instead of a main element with non-scrollable overflow', async () => {
    document.body.innerHTML = '<main style="overflow-y: visible"></main>';
    const main = document.querySelector('main');
    Object.defineProperties(main, {
      clientHeight: { value: 1800 }, scrollHeight: { value: 1808 },
    });
    main.scrollTo = jest.fn();
    main.scrollBy = jest.fn();
    await start();
    await jest.advanceTimersByTimeAsync(9000);
    expect(scroller.scrollTop).toBe(1200);
    expect(main.scrollBy).not.toHaveBeenCalled();
    expect(saves()).toHaveLength(1);
  });

  test('chooses the scroll target after applying capture styles', async () => {
    document.body.innerHTML = '<main style="overflow-y: auto"></main>';
    const main = document.querySelector('main');
    Object.defineProperties(main, {
      clientHeight: { get: () => document.body.style.height === 'auto' ? 1800 : 600 },
      scrollHeight: { value: 1800 },
    });
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true, get: () => document.body.style.height === 'auto' ? 1800 : 600,
    });
    main.scrollTo = jest.fn();
    main.scrollBy = jest.fn();
    await start();
    await jest.advanceTimersByTimeAsync(9000);
    expect(scroller.scrollTop).toBe(1200);
    expect(main.scrollBy).not.toHaveBeenCalled();
    expect(saves()).toHaveLength(1);
  });

  test('uses the gallery viewport when the document cannot scroll', async () => {
    pageHeight = 600;
    document.body.innerHTML = '<div class="scroll-area" style="overflow-y: auto"><main style="overflow-y: visible"></main></div>';
    const viewport = document.querySelector('.scroll-area');
    const main = document.querySelector('main');
    Object.defineProperties(viewport, {
      clientHeight: { value: 600 }, scrollHeight: { value: 1800 },
    });
    Object.defineProperties(main, {
      clientHeight: { value: 1800 }, scrollHeight: { value: 1808 },
    });
    main.scrollTo = jest.fn();
    main.scrollBy = jest.fn();
    viewport.scrollTo = jest.fn(({ top }) => { viewport.scrollTop = top; });
    viewport.scrollBy = jest.fn(({ top }) => { viewport.scrollTop = Math.min(1200, viewport.scrollTop + top); });
    await start();
    await jest.advanceTimersByTimeAsync(9000);
    expect(viewport.scrollTop).toBe(1200);
    expect(main.scrollBy).not.toHaveBeenCalled();
    expect(saves()).toHaveLength(1);
  });
});
