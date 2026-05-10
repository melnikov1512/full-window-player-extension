/**
 * Full Window Player — Background Service Worker (MV3)
 * Handles keyboard commands and relays toggle messages to the active tab's content script.
 */

'use strict';

// ─── Command handler ──────────────────────────────────────────────────────────

/**
 * Listen for the keyboard command declared in manifest.json.
 * The `tab` parameter is available in Chrome 114+ but we query for safety.
 */
chrome.commands.onCommand.addListener(async (command, commandTab) => {
  if (command !== 'toggle-fullwindow') return;

  const tab = commandTab ?? (await getActiveTab());
  if (!tab?.id) return;

  sendToggleToTab(tab.id);
});

// ─── Action click handler ─────────────────────────────────────────────────────

/**
 * Primary entry point: clicking the extension icon toggles full-window mode
 * in the active tab. No popup — direct action.
 */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  sendToggleToTab(tab.id);
});

// ─── Message relay ────────────────────────────────────────────────────────────

/**
 * Listen for messages from popup.js or other extension pages.
 * The content script handles its own messages directly; this relay
 * bridges extension pages → content script when needed.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== 'string') return false;

  // Relay state-change notifications (no-op — just acknowledge)
  if (message.action === 'stateChanged') {
    updateBadge(sender.tab?.id, message.isActive);
    return false;
  }

  return false;
});

// ─── Badge / title management ─────────────────────────────────────────────────

/**
 * Update the extension badge and title to reflect active/inactive state.
 * @param {number|undefined} tabId
 * @param {boolean} isActive
 */
function updateBadge(tabId, isActive) {
  const opts = tabId !== undefined ? { tabId } : {};
  chrome.action.setBadgeText({ text: isActive ? 'ON' : '', ...opts }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: isActive ? '#7c3aed' : '#555555', ...opts }).catch(() => {});
  chrome.action.setTitle({
    title: isActive ? 'Full Window Player — ON (click to exit)' : 'Full Window Player (click to activate)',
    ...opts,
  }).catch(() => {});
}

// ─── Tab cleanup ──────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
});

// Set default title on service worker start
chrome.action.setTitle({ title: 'Full Window Player (click to activate)' }).catch(() => {});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Send a toggle message to the content script in the specified tab.
 * @param {number} tabId
 */
function sendToggleToTab(tabId) {
  chrome.tabs.sendMessage(tabId, { action: 'toggle' }).catch((err) => {
    // Content script may not be injected on this page (e.g., chrome:// URLs)
    console.warn('[FWP background] Could not send toggle to tab', tabId, err?.message);
  });
}

/**
 * Query for the currently active tab in the focused window.
 * @returns {Promise<chrome.tabs.Tab|undefined>}
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
