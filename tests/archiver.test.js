const path = require('path');

let absUrl, pickBestFromSrcset, isTinyDataURI, returnLivePageViewToTop;

beforeAll(() => {
  global.chrome = {
    runtime: {
      onMessage: { addListener: jest.fn() },
      sendMessage: jest.fn(),
    },
    storage: { local: { get: jest.fn() } },
  };
  ({ absUrl, pickBestFromSrcset, isTinyDataURI, returnLivePageViewToTop } = require('../content/archiver.js'));
});

describe('archiver utility functions', () => {

  test.each([
    'ModelVersionDetails_mainSection__abc',
    'ModelVersionDetails-module-scss-module__Nm3YLG__mainSection',
  ])('MHTML preserves main column order and width for %s', async className => {
    document.body.innerHTML = `<main><section data-tour="model:start">
      <div class="mantine-Grid-root"><div class="mantine-Grid-inner">
        <div id="sidebar" class="mantine-Grid-col"></div>
        <div id="description" class="mantine-Grid-col ${className}" style="color: red"></div>
      </div></div></section></main>`;
    const description = document.getElementById('description');
    const sidebar = document.getElementById('sidebar');
    try {
      await window.__archiverPrepareLayout.prepare();
      expect(description.dataset.archiverColumn).toBe('main');
      expect(description.style.order).toBe('1');
      expect(description.style.flexGrow).toBe('1');
      expect(description.style.width).toBe('auto');
      expect(sidebar.dataset.archiverColumn).toBe('sidebar');
      expect(sidebar.style.order).toBe('2');
      expect(sidebar.style.flexGrow).toBe('0');
    } finally {
      window.__archiverPrepareLayout.cleanup();
    }
    expect(description.getAttribute('style')).toBe('color: red');
    expect(document.querySelector('[data-archiver-column]')).toBeNull();
  });

  test('absUrl converts relative paths to absolute URLs', () => {
    expect(absUrl('/models/736706/epic-gorgeous-details')).toBe('http://localhost/models/736706/epic-gorgeous-details');
  });

  test('pickBestFromSrcset chooses highest-resolution image', () => {
    const img = document.createElement('img');
    img.setAttribute('srcset', 'small.jpg 100w, big.jpg 1000w');
    const result = pickBestFromSrcset(img);
    expect(result).toMatch(/big.jpg$/);
  });

  test('isTinyDataURI detects small data URIs', () => {
    const tiny = 'data:image/png;base64,' + Buffer.from('a'.repeat(10)).toString('base64');
    expect(isTinyDataURI(tiny)).toBe(true);
    const large = 'data:image/png;base64,' + Buffer.from('a'.repeat(2000)).toString('base64');
    expect(isTinyDataURI(large)).toBe(false);
  });

  test('returnLivePageViewToTop scrolls the live page viewport to the top', async () => {
    document.body.innerHTML = `
      <div class="scroll-area">
        <main style="height: 3000px"></main>
      </div>
    `;

    const originalWindowScrollTo = window.scrollTo;
    window.scrollTo = jest.fn();

    const scrollArea = document.querySelector('.scroll-area');
    scrollArea.scrollTop = 640;
    scrollArea.scrollLeft = 20;
    document.documentElement.scrollTop = 320;
    document.body.scrollTop = 160;

    try {
      const result = await returnLivePageViewToTop();

      expect(scrollArea.scrollTop).toBe(0);
      expect(scrollArea.scrollLeft).toBe(0);
      expect(document.documentElement.scrollTop).toBe(0);
      expect(document.body.scrollTop).toBe(0);
      expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
      expect(result.scrolledTargets).toBeGreaterThan(0);
    } finally {
      window.scrollTo = originalWindowScrollTo;
    }
  });

  test('MHTML layout prep hides image reaction overlays', async () => {
    document.body.innerHTML = `
      <main>
        <section data-tour="model:start">
          <div class="mantine-Grid-root">
            <div class="mantine-Grid-inner">
              <div class="mantine-Grid-col ModelVersionDetails_mainSection__abc">
                <div class="ModelCarousel_reactions__abc">0123456789</div>
              </div>
              <div class="mantine-Grid-col"></div>
            </div>
          </div>
        </section>
        <section id="gallery">
          <div class="ImagesAsPostsCard_reactions__abc">0123456789</div>
        </section>
      </main>
    `;

    await window.__archiverPrepareLayout.prepare();

    const headerReactions = document.querySelector('.ModelCarousel_reactions__abc');
    const galleryReactions = document.querySelector('.ImagesAsPostsCard_reactions__abc');

    expect(headerReactions.style.getPropertyValue('display')).toBe('none');
    expect(headerReactions.style.getPropertyPriority('display')).toBe('important');
    expect(galleryReactions.style.getPropertyValue('display')).toBe('none');
    expect(galleryReactions.style.getPropertyPriority('display')).toBe('important');

    window.__archiverPrepareLayout.cleanup();
  });

  test('MHTML layout prep hides inert image controls', async () => {
    document.body.innerHTML = `
      <main>
        <section data-tour="model:start">
          <div class="mantine-Grid-root">
            <div class="mantine-Grid-inner">
              <div class="mantine-Grid-col ModelVersionDetails_mainSection__abc">
                <div id="header-menu" class="absolute right-2 top-2 z-10"></div>
                <div id="header-info" class="absolute bottom-0.5 right-0.5 z-10"></div>
                <div id="header-info-alt" class="absolute bottom-1 right-0.5 z-10"></div>
                <div id="header-info-icon-wrap" class="absolute bottom-2 right-2 z-20">
                  <button id="header-info-icon-button">
                    <svg class="tabler-icon tabler-icon-info-circle"></svg>
                  </button>
                </div>
                <button id="header-remix" data-activity="remix:model-carousel"></button>
                <button id="header-left" class="absolute left-3 top-1/2"></button>
                <button id="header-right" class="absolute right-3 top-1/2"></button>
              </div>
              <div class="mantine-Grid-col"></div>
            </div>
          </div>
        </section>
        <section id="gallery">
          <button id="gallery-heading-info">
            <svg class="tabler-icon tabler-icon-info-circle"></svg>
          </button>
          <div id="gallery-menu" class="absolute right-2 top-2 z-10"></div>
          <div id="gallery-info" class="absolute bottom-0.5 right-0.5 z-10"></div>
          <div id="gallery-info-alt" class="absolute bottom-1 right-0.5 z-10"></div>
          <div id="gallery-info-icon-wrap" class="absolute bottom-2 right-2 z-20">
            <button id="gallery-info-icon-button">
              <svg class="tabler-icon tabler-icon-info-circle"></svg>
            </button>
          </div>
          <button id="gallery-create" data-activity="create:model-card"></button>
          <button id="gallery-remix" data-activity="remix:model-gallery"></button>
          <button id="gallery-left" class="absolute left-3 top-1/2"></button>
          <button id="gallery-right" class="absolute right-3 top-1/2"></button>
        </section>
      </main>
    `;

    await window.__archiverPrepareLayout.prepare();

    [
      'header-menu',
      'header-info',
      'header-info-alt',
      'header-info-icon-wrap',
      'header-info-icon-button',
      'header-remix',
      'header-left',
      'header-right',
      'gallery-menu',
      'gallery-info',
      'gallery-info-alt',
      'gallery-info-icon-wrap',
      'gallery-info-icon-button',
      'gallery-create',
      'gallery-remix',
      'gallery-left',
      'gallery-right'
    ].forEach(id => {
      const el = document.getElementById(id);
      expect(el.style.getPropertyValue('display')).toBe('none');
      expect(el.style.getPropertyPriority('display')).toBe('important');
    });

    expect(document.getElementById('gallery-heading-info').style.getPropertyValue('display')).toBe('');

    window.__archiverPrepareLayout.cleanup();
  });

  test('MHTML layout prep isolates model header grid from discussion section grid', async () => {
    document.body.innerHTML = `
      <main>
        <section data-tour="model:start" class="contentCol mantine-Container-root">
          <div class="mantine-Stack-root">
            <div id="header-grid-root" class="mantine-Grid-root">
              <div id="header-grid-inner" class="mantine-Grid-inner">
                <div id="header-sidebar" class="mantine-Grid-col"></div>
                <div id="header-main" class="mantine-Grid-col ModelVersionDetails_mainSection__abc"></div>
              </div>
            </div>
          </div>
          <div id="discussion-section" data-tour="model:discussion" class="flex flex-col gap-4">
            <div class="mantine-Grid-container">
              <div id="discussion-grid-root" class="mantine-Grid-root">
                <div id="discussion-grid-inner" class="mantine-Grid-inner">
                  <div id="discussion-col" class="mantine-Grid-col">
                    <div class="mantine-Stack-root">
                      <div role="grid">
                        <div role="gridcell" style="width: 580px; top: 0px; left: 0px; position: absolute;">Comment 1</div>
                        <div role="gridcell" style="width: 580px; top: 0px; left: 600px; position: absolute;">Comment 2</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    `;

    const headerGridRoot = document.getElementById('header-grid-root');
    const headerGridInner = document.getElementById('header-grid-inner');
    const headerSidebar = document.getElementById('header-sidebar');
    const headerMain = document.getElementById('header-main');

    const discussionGridRoot = document.getElementById('discussion-grid-root');
    const discussionGridInner = document.getElementById('discussion-grid-inner');
    const discussionCol = document.getElementById('discussion-col');

    try {
      await window.__archiverPrepareLayout.prepare();

      // Header grid gets tagged and transformed
      expect(headerGridRoot.getAttribute('data-archiver-model-header')).toBe('1');
      expect(headerGridRoot.style.display).toBe('flex');
      expect(headerGridInner.style.display).toBe('contents');
      expect(headerMain.dataset.archiverColumn).toBe('main');
      expect(headerSidebar.dataset.archiverColumn).toBe('sidebar');

      // Discussion grid is NOT tagged and NOT collapsed
      expect(discussionGridRoot.getAttribute('data-archiver-model-header')).toBeNull();
      expect(discussionGridRoot.style.display).toBe('');
      expect(discussionGridInner.style.display).toBe('');
      expect(discussionCol.dataset.archiverColumn).toBeUndefined();
      expect(discussionCol.style.flex).toBe('');
      expect(discussionCol.style.width).toBe('');
    } finally {
      window.__archiverPrepareLayout.cleanup();
    }

    expect(headerGridRoot.getAttribute('data-archiver-model-header')).toBeNull();
    expect(headerMain.dataset.archiverColumn).toBeUndefined();
    expect(headerSidebar.dataset.archiverColumn).toBeUndefined();
  });
});
