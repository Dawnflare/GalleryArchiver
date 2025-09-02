function restoreOptions() {
  chrome.storage.local.get({
    startShortcut: 'Alt+1',
    resetShortcut: 'Alt+F5',
    saveShortcut: 'Alt+2',
    scrollDelay: 300,
    stabilityTimeout: 400
  }, opts => {
    document.getElementById('startShortcut').value = opts.startShortcut;
    document.getElementById('resetShortcut').value = opts.resetShortcut;
    document.getElementById('saveShortcut').value = opts.saveShortcut;
    document.getElementById('scrollDelay').value = opts.scrollDelay;
    document.getElementById('stabilityTimeout').value = opts.stabilityTimeout;
  });
}

function saveOptions() {
  const startShortcut = document.getElementById('startShortcut').value || 'Alt+1';
  const resetShortcut = document.getElementById('resetShortcut').value || 'Alt+F5';
  const saveShortcut = document.getElementById('saveShortcut').value || 'Alt+2';
  const scrollDelay = parseInt(document.getElementById('scrollDelay').value || '300', 10);
  const stabilityTimeout = parseInt(document.getElementById('stabilityTimeout').value || '400', 10);
  chrome.storage.local.set({ startShortcut, resetShortcut, saveShortcut, scrollDelay, stabilityTimeout }, () => {
    const status = document.getElementById('status');
    status.textContent = 'Options saved.';
    setTimeout(() => status.textContent = '', 1500);
  });
}

document.getElementById('save').addEventListener('click', saveOptions);

document.addEventListener('DOMContentLoaded', restoreOptions);
