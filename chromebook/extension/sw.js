// PhoneBridge service worker: keeps the link page (which owns Bluetooth and the interceptor) open,
// and detaches the debugger from every tab if that page goes away so no tab is left hanging.
const LINK = chrome.runtime.getURL('link.html');

async function linkTabs() { return chrome.tabs.query({ url: LINK }); }

async function openLink(focus) {
  const [tab] = await linkTabs();
  if (tab) {
    if (focus) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: LINK, pinned: true, active: focus });
}

chrome.action.onClicked.addListener(() => openLink(true));
chrome.runtime.onStartup.addListener(() => openLink(false));
chrome.runtime.onInstalled.addListener(() => openLink(true));

chrome.tabs.onRemoved.addListener(async () => {
  if ((await linkTabs()).length) return;
  for (const t of await chrome.debugger.getTargets()) {
    if (t.attached && t.tabId != null) chrome.debugger.detach({ tabId: t.tabId }).catch(() => {});
  }
  chrome.action.setBadgeText({ text: '' });
});
