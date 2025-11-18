const path = require('path');

let absUrl, pickBestFromSrcset, isTinyDataURI, resolveImageUrl;

beforeAll(() => {
  global.chrome = {
    runtime: {
      onMessage: { addListener: jest.fn() },
      sendMessage: jest.fn(),
    },
    storage: { local: { get: jest.fn() } },
  };
  ({ absUrl, pickBestFromSrcset, isTinyDataURI, resolveImageUrl } = require('../content/archiver.js'));
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

  test('resolveImageUrl prefers the displayed currentSrc before srcset candidates', () => {
    const img = document.createElement('img');
    const cdn = 'https://image.tensorartsassets.com/foo/bar.jpg';
    const s3 = 'https://tensor-art.s3.amazonaws.com/foo/bar.jpg';
    img.setAttribute('src', s3);
    img.setAttribute('srcset', `${s3} 2048w, ${cdn} 1024w`);
    Object.defineProperty(img, 'currentSrc', { value: cdn, configurable: true });
    expect(resolveImageUrl(img)).toBe(cdn);
  });
});
