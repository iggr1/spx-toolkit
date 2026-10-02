const SETTINGS = {
  deliveryHistory: 'spxToolkitDeliveryHistoryEnabled',
  ehaShortcuts: 'spxToolkitEhaShortcutsEnabled'
};
const AUTOADD_BLOCK_STORAGE_KEY = 'spxToolkitAutoAddBlocked';

const DEFAULTS = {
  [SETTINGS.deliveryHistory]: true,
  [SETTINGS.ehaShortcuts]: true
};

const openPanelBtn = document.getElementById('openPanel');
const deliveryHistorySwitch = document.getElementById('deliveryHistorySwitch');
const ehaShortcutsSwitch = document.getElementById('ehaShortcutsSwitch');
const autoAddSwitch = document.getElementById('autoAddSwitch');
const savedMsg = document.getElementById('savedMsg');

openPanelBtn.addEventListener('click', async () => {
  await chrome.windows.create({
    url: chrome.runtime.getURL('panel.html'),
    type: 'popup',
    width: 1280,
    height: 840,
    focused: true
  });
});

async function loadSettings() {
  const [current, autoAddState] = await Promise.all([
    chrome.storage.local.get(DEFAULTS),
    chrome.storage.session.get({
      [AUTOADD_BLOCK_STORAGE_KEY]: false
    })
  ]);
  deliveryHistorySwitch.checked = current[SETTINGS.deliveryHistory] !== false;
  ehaShortcutsSwitch.checked = current[SETTINGS.ehaShortcuts] !== false;
  autoAddSwitch.checked = autoAddState[AUTOADD_BLOCK_STORAGE_KEY] === true;
}

async function saveSetting(key, value) {
  await chrome.storage.local.set({ [key]: value });
  showSaved();
}

async function setAutoAddBlocked(blocked) {
  await chrome.storage.session.set({
    [AUTOADD_BLOCK_STORAGE_KEY]: blocked === true
  });
  const response = await chrome.runtime.sendMessage({
    type: 'SPX_SET_AUTOADD_BLOCKED',
    blocked: blocked === true
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'Não foi possível atualizar o Auto Add.');
  }

  showSaved();
}

function showSaved() {
  savedMsg.textContent = 'Configuração salva';
  window.clearTimeout(showSaved.timer);
  showSaved.timer = window.setTimeout(() => {
    savedMsg.textContent = '';
  }, 1200);
}

deliveryHistorySwitch.addEventListener('change', () => {
  saveSetting(SETTINGS.deliveryHistory, deliveryHistorySwitch.checked);
});

ehaShortcutsSwitch.addEventListener('change', () => {
  saveSetting(SETTINGS.ehaShortcuts, ehaShortcutsSwitch.checked);
});

autoAddSwitch.addEventListener('change', async () => {
  const requestedState = autoAddSwitch.checked;
  autoAddSwitch.disabled = true;
  try {
    await setAutoAddBlocked(requestedState);
  } catch (error) {
    autoAddSwitch.checked = !requestedState;
    await chrome.storage.session.set({
      [AUTOADD_BLOCK_STORAGE_KEY]: !requestedState
    }).catch(() => {});
    savedMsg.textContent = String(error?.message || error);
  } finally {
    autoAddSwitch.disabled = false;
  }
});

loadSettings();
