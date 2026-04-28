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
});
