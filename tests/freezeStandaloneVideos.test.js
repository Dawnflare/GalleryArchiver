let freezeStandaloneVideos;

beforeAll(() => {
  global.chrome = {
    runtime: { onMessage: { addListener: jest.fn() }, sendMessage: jest.fn() },
    storage: { local: { get: jest.fn() } },
  };
  ({ freezeStandaloneVideos } = require('../content/archiver.js'));
});

beforeEach(() => {
  document.body.innerHTML = '';
});

test('freezes standalone video into anchored snapshot', async () => {
  // Simulate being on an image detail page
  window.history.replaceState({}, '', 'http://localhost/images/123');

  const v = document.createElement('video');
  v.setAttribute('poster', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==');
  v.style.width = '320px';
  v.style.height = '180px';
  document.body.appendChild(v);

  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    get: function() { return desc && desc.get ? desc.get.call(this) : undefined; },
    set: function(val) {
      if (desc && desc.set) desc.set.call(this, val); else this.setAttribute('src', val);
      setTimeout(() => this.dispatchEvent(new Event('load')));
    }
  });

  await freezeStandaloneVideos();

  Object.defineProperty(HTMLImageElement.prototype, 'src', desc);

  const anchor = document.querySelector('a');
  expect(anchor).not.toBeNull();
  expect(anchor.href).toBe(window.location.href);
  const img = anchor.querySelector('img');
  expect(img).not.toBeNull();
  expect(img.dataset.archiverFrozen).toBe('1');
});
