describe('Civitai pagination during save preparation', () => {
  let pagination;
  const marker = '<div id="loader" style="min-height: 36px; grid-column: 1 / -1; display: flex"></div>';
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

  beforeEach(() => {
    jest.resetModules();
    document.body.innerHTML = `<main><section id="gallery"><a href="/images/1"><img src="one.jpg"></a>${marker}</section></main>`;
    global.chrome = { runtime: { onMessage: { addListener: jest.fn() } } };
    require('../content/archiver.js');
    pagination = window.__archiverPagination;
  });

  afterEach(() => pagination.resume());

  test('hides only the pagination marker, including when no spinner is mounted', () => {
    document.querySelector('main').insertAdjacentHTML('beforeend', marker.replace('id="loader"', 'id="outside"'));
    const image = document.querySelector('img');
    expect(pagination.pause()).toEqual({ pausedLoaders: 1 });
    expect(document.getElementById('loader').style.display).toBe('none');
    expect(document.getElementById('loader').style.getPropertyPriority('display')).toBe('important');
    expect(image.style.display).toBe('');
    expect(document.getElementById('outside').style.display).toBe('flex');
  });

  test('keeps markers paused after React replaces them or rewrites their styles', async () => {
    pagination.pause();
    document.getElementById('loader').outerHTML = marker;
    await settle();
    const replacement = document.getElementById('loader');
    expect(replacement.style.display).toBe('none');
    replacement.style.display = 'grid';
    await settle();
    expect(replacement.style.display).toBe('none');
    pagination.resume();
    expect(replacement.style.display).toBe('flex');
    replacement.style.display = 'block';
    await settle();
    expect(replacement.style.display).toBe('block');
  });

  test('resumes with original inline styles and can pause the next model version', async () => {
    const loader = document.getElementById('loader');
    loader.style.setProperty('display', 'grid', 'important');
    pagination.pause();
    pagination.pause();
    pagination.resume();
    expect(loader.style.display).toBe('grid');
    expect(loader.style.getPropertyPriority('display')).toBe('important');
    document.getElementById('gallery').innerHTML = marker;
    pagination.pause();
    await settle();
    expect(document.getElementById('loader').style.display).toBe('none');
  });
});
