function restoreOptions() {
  chrome.storage.local.get({
    scrollDelay: 300,
    stabilityTimeout: 400,
    filenameBase: 'title',
    customFilename: '',
    timestampFormat: 'YYYYMMDD_HHMMSS',
    saveLocation: 'last',
    customSavePath: ''
  }, opts => {
    document.getElementById('scrollDelay').value = opts.scrollDelay;
    document.getElementById('stabilityTimeout').value = opts.stabilityTimeout;
    const baseRadio = document.querySelector(`input[name="filenameBase"][value="${opts.filenameBase}"]`);
    if (baseRadio) baseRadio.checked = true;
    document.getElementById('customFilename').value = opts.customFilename || '';
    document.getElementById('customFilename').disabled = opts.filenameBase !== 'custom';
    const tsRadio = document.querySelector(`input[name="timestampFormat"][value="${opts.timestampFormat}"]`);
    if (tsRadio) tsRadio.checked = true;
    const saveRadio = document.querySelector(`input[name="saveLocation"][value="${opts.saveLocation}"]`);
    if (saveRadio) saveRadio.checked = true;
    const customPathInput = document.getElementById('customSavePath');
    const browseBtn = document.getElementById('browseSavePath');
    if (customPathInput) {
      customPathInput.value = opts.customSavePath || '';
      const isCustom = opts.saveLocation !== 'custom';
      customPathInput.disabled = isCustom;
      if (browseBtn) browseBtn.disabled = isCustom;
    }
  });

  chrome.commands.getAll(commands => {
    const find = name => commands.find(c => c.name === name)?.shortcut || '';
    document.getElementById('startShortcut').value = find('start') || 'Alt+1';
    document.getElementById('saveShortcut').value = find('save') || 'Alt+2';
    document.getElementById('startSaveShortcut').value = find('startAndSave') || 'Alt+3';
    document.getElementById('resetShortcut').value = find('reset') || 'Alt+Shift+R';
  });
}

function saveOptions() {
  const startShortcut = document.getElementById('startShortcut').value || 'Alt+1';
  const saveShortcut = document.getElementById('saveShortcut').value || 'Alt+2';
  const startSaveShortcut = document.getElementById('startSaveShortcut').value || 'Alt+3';
  const resetShortcut = document.getElementById('resetShortcut').value || 'Alt+Shift+R';
  const scrollDelay = parseInt(document.getElementById('scrollDelay').value || '300', 10);
  const stabilityTimeout = parseInt(document.getElementById('stabilityTimeout').value || '400', 10);
  const filenameBase = document.querySelector('input[name="filenameBase"]:checked')?.value || 'title';
  const customFilename = document.getElementById('customFilename').value || '';
  const timestampFormat = document.querySelector('input[name="timestampFormat"]:checked')?.value || 'YYYYMMDD_HHMMSS';
  const saveLocation = document.querySelector('input[name="saveLocation"]:checked')?.value || 'last';
  const customSavePath = document.getElementById('customSavePath')?.value || '';

  const updateShortcut = (name, shortcut) => {
    if (chrome.commands && typeof chrome.commands.update === 'function') {
      try {
        chrome.commands.update({ name, shortcut });
      } catch (e) {
        console.warn('commands.update failed', e);
      }
    }
  };

  updateShortcut('start', startShortcut);
  updateShortcut('save', saveShortcut);
  updateShortcut('startAndSave', startSaveShortcut);
  updateShortcut('reset', resetShortcut);

  chrome.storage.local.set({ scrollDelay, stabilityTimeout, filenameBase, customFilename, timestampFormat, saveLocation, customSavePath }, () => {
    const status = document.getElementById('status');
    status.textContent = 'Options saved.';
    setTimeout(() => status.textContent = '', 1500);
  });
}

document.getElementById('save').addEventListener('click', saveOptions);

document.addEventListener('DOMContentLoaded', restoreOptions);

document.querySelectorAll('input[name="filenameBase"]').forEach(r => {
  r.addEventListener('change', () => {
    const customInput = document.getElementById('customFilename');
    customInput.disabled = document.querySelector('input[name="filenameBase"]:checked').value !== 'custom';
  });
});

document.querySelectorAll('input[name="saveLocation"]').forEach(r => {
  r.addEventListener('change', () => {
    const customInput = document.getElementById('customSavePath');
    const browseBtn = document.getElementById('browseSavePath');
    const isCustom = document.querySelector('input[name="saveLocation"]:checked').value !== 'custom';
    customInput.disabled = isCustom;
    browseBtn.disabled = isCustom;
  });
});

document.getElementById('browseSavePath')?.addEventListener('click', () => {
  const picker = document.getElementById('customSavePathPicker');
  picker?.click();
});

document.getElementById('customSavePathPicker')?.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) {
    const path = file.path || file.webkitRelativePath || '';
    const dir = path.replace(/[/\\][^/\\]*$/, '');
    const input = document.getElementById('customSavePath');
    if (input) input.value = dir;
  }
});
