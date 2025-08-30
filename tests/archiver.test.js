const path = require('path');

let absUrl, pickBestFromSrcset, isTinyDataURI;

beforeAll(() => {
  global.chrome = {
    runtime: {
      onMessage: { addListener: jest.fn() },
      sendMessage: jest.fn(),
    },
    storage: { local: { get: jest.fn() } },
  };
  ({ absUrl, pickBestFromSrcset, isTinyDataURI } = require('../content/archiver.js'));
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
});
