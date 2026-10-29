// Plain options page: native controls, persisted to chrome.storage.sync,
// picked up live by the content script. Debounced writes (sync quota).

const DEFAULTS = { alpha: 1.0, maxSuppressionDb: 12 };
const alpha = document.getElementById('alpha');
const floor = document.getElementById('floor');
const alphaOut = document.getElementById('alphaOut');
const floorOut = document.getElementById('floorOut');

function render() {
  alphaOut.value = Number(alpha.value).toFixed(1);
  floorOut.value = `${floor.value} dB`;
}

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  alpha.value = s.alpha;
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
    chrome.storage.sync.set({
      alpha: Number(alpha.value),
      maxSuppressionDb: Number(floor.value),
    });
  }, 200);
}

alpha.addEventListener('input', save);
floor.addEventListener('input', save);
init();
