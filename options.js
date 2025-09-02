function restoreOptions() {
  chrome.storage.local.get({
    scrollDelay: 300,
    stabilityTimeout: 400
  }, opts => {
    document.getElementById('scrollDelay').value = opts.scrollDelay;
    document.getElementById('stabilityTimeout').value = opts.stabilityTimeout;
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

  chrome.commands.update({ name: 'start', shortcut: startShortcut });
  chrome.commands.update({ name: 'save', shortcut: saveShortcut });
  chrome.commands.update({ name: 'startAndSave', shortcut: startSaveShortcut });
  chrome.commands.update({ name: 'reset', shortcut: resetShortcut });

  chrome.storage.local.set({ scrollDelay, stabilityTimeout }, () => {
    const status = document.getElementById('status');
    status.textContent = 'Options saved.';
    setTimeout(() => status.textContent = '', 1500);
  });
}

document.getElementById('save').addEventListener('click', saveOptions);

document.addEventListener('DOMContentLoaded', restoreOptions);
