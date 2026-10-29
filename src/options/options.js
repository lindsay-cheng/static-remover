// Plain options page: native controls, persisted to chrome.storage.sync,
// picked up live by the content script. Debounced writes (sync quota).

const DEFAULTS = { maxSuppressionDb: 15 };
const floor = document.getElementById('floor');
const floorOut = document.getElementById('floorOut');

function render() {
  floorOut.value = `${floor.value} dB`;
}

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  floor.value = s.maxSuppressionDb;
  render();

  const cmds = await chrome.commands.getAll();
  const c = cmds.find((x) => x.name === 'toggle-static-removal');
  document.getElementById('shortcut').textContent = c?.shortcut
    ? `Shortcut: ${c.shortcut} (change at chrome://extensions/shortcuts)`
    : 'Shortcut unassigned (set it at chrome://extensions/shortcuts)';
}

let timer;
function save() {
  render();
  clearTimeout(timer);
  timer = setTimeout(() => {
    chrome.storage.sync.set({ maxSuppressionDb: Number(floor.value) });
  }, 200);
}

floor.addEventListener('input', save);
init();
