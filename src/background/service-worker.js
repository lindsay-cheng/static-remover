// Service worker: no audio here. Toolbar click / keyboard shortcut -> ask the
// content script to toggle. Badge reflects per-tab state. Failures are shown
// on the badge ("?") instead of failing silently.

async function setBadge(tabId, enabled) {
  await chrome.action.setBadgeText({ tabId, text: enabled ? 'ON' : '' });
  await chrome.action.setTitle({ tabId, title: 'Toggle static removal' });
  if (enabled) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#000000' });
  }
}

async function showProblem(tabId, reason) {
  await chrome.action.setBadgeText({ tabId, text: '?' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#cc0000' });
  const owned = /InvalidStateError|already connected/i.test(reason || '');
  await chrome.action.setTitle({
    tabId,
    title: owned
      ? 'Static Remover: reload this YouTube tab, then click again'
      : `Static Remover: could not hook this video${reason ? ` (${reason})` : ''}`,
  });
}

// The content script only auto-injects into tabs opened after install. For a
// tab that predates the install, inject it on demand and retry once.
async function ensureContentScript(tabId, url) {
  if (!/^https:\/\/(www\.)?youtube\.com\//.test(url || '')) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/content.js'],
    });
    return true;
  } catch {
    return false;
  }
}

async function toggle(tab) {
  if (!tab?.id) return;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
    if (res?.ok === false) {
      console.warn('[static-remover] toggle failed:', res?.error);
      await showProblem(tab.id, res?.error);
      return;
    }
    await setBadge(tab.id, !!res?.enabled);
    return;
  } catch {
    if (await ensureContentScript(tab.id, tab.url)) {
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
        if (res?.ok === false) {
          await showProblem(tab.id, res?.error);
          return;
        }
        await setBadge(tab.id, !!res?.enabled);
        return;
      } catch {}
    }
    await showProblem(tab.id);
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
