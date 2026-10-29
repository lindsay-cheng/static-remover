// Service worker: no audio here. Toolbar click / keyboard shortcut -> ask the
// content script to toggle. Badge reflects per-tab state.

async function setBadge(tabId, enabled) {
  await chrome.action.setBadgeText({ tabId, text: enabled ? 'ON' : '' });
  if (enabled) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#000000' });
  }
}

async function toggle(tab) {
  if (!tab?.id) return;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
    await setBadge(tab.id, !!res?.enabled);
  } catch {
    // No content script in this tab (not YouTube, or still loading).
    await setBadge(tab.id, false);
  }
}

chrome.action.onClicked.addListener(toggle);

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-static-removal') return;
  if (!tab) {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  }
  await toggle(tab);
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'state' && sender.tab?.id != null) {
    setBadge(sender.tab.id, !!msg.enabled);
  }
});
