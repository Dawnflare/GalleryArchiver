beforeAll(() => {
  global.chrome = { runtime: { onMessage: { addListener: jest.fn() }, sendMessage: jest.fn() },
    storage: { local: { get: jest.fn() } } };
  require('../content/archiver.js');
});

afterEach(() => window.__archiverPrepareSolo.cleanup());

function fixture(media = '<img class="EdgeImage__image">') {
  window.history.replaceState({}, '', '/images/123');
  document.body.innerHTML = `<main><div style="height:100%"><div id="row">
    <div id="region"><div style="overflow:hidden">${media}</div></div>
    <div id="sidebar" class="@md:w-[450px]"><div class="mantine-ScrollArea-viewport">Prompt</div></div>
    </div></div></main>`;
}

test.each(['img', 'video'])('detects and restores solo %s layout', type => {
  fixture(type === 'img' ? '<img class="EdgeImage__image">' : '<video></video>');
  const before = document.body.innerHTML;
  const hook = window.__archiverPrepareSolo;
  const view = hook.detect();
  expect(view.sidebar.id).toBe('sidebar');
  hook.prepare(view);
  expect(document.getElementById('row').style.display).toBe('grid');
  expect(document.getElementById('sidebar').style.position).toBe('static');
  expect(document.querySelector('[data-archiver-mhtml-prep]')).toBeNull();
  hook.prepare(hook.detect());
  expect(document.querySelectorAll('#archiver-solo-layout')).toHaveLength(1);
  hook.cleanup();
  expect(document.body.innerHTML).toBe(before);
});

test('finds replacement poster using references recorded before freezing', () => {
  fixture('<video></video>');
  const hook = window.__archiverPrepareSolo;
  const view = hook.detect();
  const anchor = document.createElement('a');
  anchor.style.width = '1344px';
  anchor.innerHTML = '<img data-archiver-frozen="1">';
  view.media.replaceWith(anchor);
  expect(hook.prepare(view).solo).toBe(true);
  expect(anchor.style.width).toBe('100%');
  expect(anchor.firstChild.style.objectFit).toBe('contain');
});

test('does not select model galleries or an unrelated image page', () => {
  fixture();
  window.history.replaceState({}, '', '/models/123');
  expect(window.__archiverPrepareSolo.detect()).toBeNull();
  fixture();
  document.getElementById('sidebar').remove();
  expect(window.__archiverPrepareSolo.detect()).toBeNull();
});

test.each([true, false])('save dispatch isolates solo layout: %s', async solo => {
  fixture();
  if (!solo) window.history.replaceState({}, '', '/models/123');
  const gallery = jest.spyOn(window.__archiverPrepareGallery, 'prepare').mockResolvedValue({});
  const layout = jest.spyOn(window.__archiverPrepareLayout, 'prepare').mockResolvedValue({});
  const overlays = jest.spyOn(window.__archiverPrepareOverlays, 'prepare').mockResolvedValue({});
  try {
    const reply = await new Promise(resolve => {
      for (const [listener] of chrome.runtime.onMessage.addListener.mock.calls) {
        listener({type: 'ARCHIVER_PREPARE_FOR_SAVE'}, {}, resolve);
      }
    });
    expect(reply.ok).toBe(true);
    expect(gallery).toHaveBeenCalledTimes(solo ? 0 : 1);
    expect(layout).toHaveBeenCalledTimes(solo ? 0 : 1);
  } finally {
    gallery.mockRestore(); layout.mockRestore(); overlays.mockRestore();
  }
});
