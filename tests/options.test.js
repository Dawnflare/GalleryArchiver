document.body.innerHTML = `
  <input id="startShortcut" value="Alt+1" />
  <input id="saveShortcut" value="Alt+2" />
  <input id="startSaveShortcut" value="Alt+3" />
  <input id="resetShortcut" value="Alt+Shift+R" />
  <input id="scrollDelay" value="300" />
  <input id="stabilityTimeout" value="400" />
  <input type="radio" name="filenameBase" value="url" />
  <input type="radio" name="filenameBase" value="custom" checked />
  <input id="customFilename" value="my page" />
  <input type="radio" name="timestampFormat" value="YYYYMMDD" checked />
  <button id="save"></button>
  <div id="status"></div>
`;

global.chrome = {
  storage: { local: { get: jest.fn((defs, cb) => cb(defs)), set: jest.fn() } },
  commands: { getAll: jest.fn(cb => cb([])) }
};

require('../options.js');

document.dispatchEvent(new Event('DOMContentLoaded'));

const customField = document.getElementById('customFilename');
customField.disabled = false;
customField.value = 'my page';

document.getElementById('save').click();

test('saves options without commands.update', () => {
  expect(chrome.storage.local.set).toHaveBeenCalledWith({
    scrollDelay: 300,
    stabilityTimeout: 400,
    filenameBase: 'custom',
    customFilename: 'my page',
    timestampFormat: 'YYYYMMDD',
    saveLocation: 'last',
    customSavePath: ''
  }, expect.any(Function));
});
