describe('preserving virtualized discussion comments for MHTML', () => {
  let grid, scroller, originalStyle;
  const cards = `
    <div role="gridcell" style="position: absolute; top: 0px; left: 0px; width: 300px;">
      <a href="/user/example">Example author</a>
      <div class="mantine-Spoiler-content" style="max-height: 100px;">A complete discussion comment</div>
      <button class="mantine-Spoiler-control">Show more</button>
    </div>
    <div role="gridcell" style="position: absolute; left: 320px;">Another comment</div>`;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    global.chrome = { runtime: { onMessage: { addListener: jest.fn() }, sendMessage: jest.fn() } };
    document.body.innerHTML = `<main><section data-tour="model:discussion">
      <h2>Discussion</h2><div role="grid" style="position: relative; height: 535px; max-height: 535px;"></div>
    </section><section id="gallery"><div role="grid"><div role="gridcell">Gallery card</div></div></section></main>`;
    grid = document.querySelector('[data-tour="model:discussion"] [role="grid"]');
    originalStyle = grid.getAttribute('style');
    scroller = document.querySelector('main');
    scroller.scrollTop = 16000;
    grid.scrollIntoView = jest.fn(() => {
      scroller.scrollTop = 2500;
      setTimeout(() => { grid.innerHTML = cards; }, 300);
    });
    require('../content/archiver.js');
  });

  afterEach(() => {
    window.__archiverPrepareLayout.cleanup();
    jest.useRealTimers();
  });

  test('remounts missing comments and keeps a static copy when the site unmounts them again', async () => {
    const preparation = window.__archiverPrepareLayout.prepare();
    await jest.advanceTimersByTimeAsync(700);
    expect((await preparation).discussionGrids).toBe(1);
    expect(grid.scrollIntoView).toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(16000);
    expect(grid.style.display).toBe('none');

    // Simulate the site removing cards after the viewport is restored.
    grid.replaceChildren();
    const copy = document.querySelector('[data-archiver-discussion]');
    expect(copy.querySelectorAll('[role="gridcell"]')).toHaveLength(2);
    expect(copy.textContent).toContain('A complete discussion comment');
    expect(copy.querySelector('a').getAttribute('href')).toBe('/user/example');
    expect(copy.querySelector('[role="gridcell"]').style.position).toBe('static');
    expect(copy.querySelector('.mantine-Spoiler-content').style.maxHeight).toBe('none');
    expect(copy.querySelector('.mantine-Spoiler-control').style.display).toBe('none');
    expect(document.querySelector('#gallery').textContent).toBe('Gallery card');

    // Repeated preparation must not duplicate archived comments.
    const again = window.__archiverPrepareLayout.prepare();
    await jest.advanceTimersByTimeAsync(100);
    await again;
    expect(document.querySelectorAll('[data-archiver-discussion]')).toHaveLength(1);

    window.__archiverPrepareLayout.cleanup();
    expect(document.querySelector('[data-archiver-discussion]')).toBeNull();
    expect(grid.getAttribute('style')).toBe(originalStyle);
    expect(grid.isConnected).toBe(true);
  });

  test('preserves already loaded comments and restores the live grid on Stop', async () => {
    grid.innerHTML = cards;
    grid.scrollIntoView.mockImplementation(() => {});
    const preparation = window.__archiverPrepareLayout.prepare();
    await jest.advanceTimersByTimeAsync(400);
    await preparation;
    // Use the registered handlers just as the popup does after saving.
    for (const [handler] of chrome.runtime.onMessage.addListener.mock.calls) {
      handler({ type: 'ARCHIVER_STOP' }, {}, () => {});
    }
    expect(document.querySelector('[data-archiver-discussion]')).toBeNull();
    expect(grid.getAttribute('style')).toBe(originalStyle);
    expect(grid.querySelectorAll('[role="gridcell"]')).toHaveLength(2);
  });

  test('finishes without hiding an empty discussion if no comments load', async () => {
    grid.scrollIntoView.mockImplementation(() => { scroller.scrollTop = 2500; });
    const preparation = window.__archiverPrepareLayout.prepare();
    await jest.advanceTimersByTimeAsync(5500);
    expect((await preparation).discussionGrids).toBe(0);
    expect(document.querySelector('[data-archiver-discussion]')).toBeNull();
    expect(grid.getAttribute('style')).toBe(originalStyle);
    expect(scroller.scrollTop).toBe(16000);
  });

  test('collapses the empty model side rail without pinning space below the comments', async () => {
    const section = grid.closest('[data-tour="model:discussion"]');
    const region = document.createElement('div');
    region.style.minHeight = '3583px';
    section.before(region);
    region.innerHTML = `<div data-tour="model:start"></div>
      <div class="Page-module__hash__rail" style="min-height: 600px; position: sticky;"></div>
      <div class="Page-module__hash__rail"><p>Populated sidebar</p></div>
      <div class="other-sidebar"></div>`;
    region.firstElementChild.appendChild(section);
    const emptyRail = region.children[1];
    const originalRailStyle = emptyRail.getAttribute('style');
    Object.defineProperty(region, 'scrollHeight', { value: 3583 });
    grid.innerHTML = cards;
    grid.scrollIntoView.mockImplementation(() => {});

    const preparation = window.__archiverPrepareLayout.prepare();
    await jest.advanceTimersByTimeAsync(400);
    await preparation;
    expect(emptyRail.style.display).toBe('none');
    expect(region.style.minHeight).toBe('0');
    expect(region.children[2].style.display).toBe('');
    expect(region.children[3].style.display).toBe('');

    window.__archiverPrepareLayout.cleanup();
    expect(emptyRail.getAttribute('style')).toBe(originalRailStyle);
    expect(region.style.minHeight).toBe('3583px');
  });
});
