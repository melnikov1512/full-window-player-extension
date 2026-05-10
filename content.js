/**
 * Full Window Player — Content Script
 * Finds the best video player container and stretches it to fill the browser window
 * using CSS (position:fixed) — NOT the Fullscreen API.
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const EXTENSION_ID = 'fwp';
const BODY_ACTIVE_CLASS = 'fwp-fullwindow-active';
const SHADOW_HOST_ID = 'fwp-shadow-host';

/** CSS applied to the player container when active */
const PLAYER_ACTIVE_STYLES = {
  position: 'fixed',
  top: '0',
  left: '0',
  width: '100vw',
  height: '100vh',
  'z-index': '2147483646',
  background: '#000',
  margin: '0',
  padding: '0',
  'border-radius': '0',
  border: 'none',
  'max-width': 'none',
  'max-height': 'none',
  'box-sizing': 'border-box',
};

/** CSS applied to the <video> element when active */
const VIDEO_ACTIVE_STYLES = {
  width: '100%',
  height: '100%',
  'object-fit': 'contain',
  'max-width': '100%',
  'max-height': '100%',
  display: 'block',
};

/**
 * Site-specific configuration keyed by hostname (substring match).
 * playerSelector: explicit player container selector (null = auto-detect)
 * elementsToHide: selectors for layout chrome to hide when active
 * playerWrapperSelector: try this selector first before auto-detect (must contain video)
 * videoParentLevels: how many DOM levels to walk up searching for a container
 */
const SITE_CONFIGS = {
  'kino.pub': {
    // Auto-detect the actual player container from the video element upward.
    // .app-content is the full content area — too broad; auto-detect finds the real player.
    playerSelector: null,
    elementsToHide: ['.app-header', '.app-aside'],
    playerWrapperSelector: null,
    videoParentLevels: 10,
  },
};

// ─── State ────────────────────────────────────────────────────────────────────

let isActive = false;

/** Stores { element → original cssText } to allow clean restore */
const originalStyles = new WeakMap();

/** Elements currently hidden by the extension */
let hiddenElements = [];

/** Reference to the active player container element for clean restore */
let activePlayerContainer = null;

/** Reference to the active video element for clean restore */
let activeVideoEl = null;

/** The MutationObserver waiting for a video element */
let videoWaitObserver = null;
let videoWaitTimeout = null;

/** Shadow DOM host for the floating button */
let shadowHost = null;
let shadowButton = null;

// ─── Site Config Resolution ───────────────────────────────────────────────────

/**
 * Returns the SITE_CONFIG entry matching the current hostname, or null.
 * @returns {{ playerSelector, elementsToHide, playerWrapperSelector, videoParentLevels }|null}
 */
function getSiteConfig() {
  const host = window.location.hostname;
  for (const pattern of Object.keys(SITE_CONFIGS)) {
    if (host === pattern || host.endsWith('.' + pattern)) {
      return SITE_CONFIGS[pattern];
    }
  }
  return null;
}

// ─── Player Detection ─────────────────────────────────────────────────────────

/**
 * Determines whether an element looks like a player wrapper:
 * has meaningful dimensions and player-related class/id names.
 * @param {Element} el
 * @returns {boolean}
 */
function looksLikePlayerContainer(el) {
  if (!el || el === document.body || el === document.documentElement) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 200 || rect.height < 150) return false;
  return true;
}

const PLAYER_SELECTORS = [
  '.plyr',
  '.jw-player',
  '[class*="jw-"]',
  '.video-js',
  '.clappr-container',
  '.clappr-wrapper',
  '[class*="player"]',
  '[id*="player"]',
  '[class*="Player"]',
];

/**
 * Walks up the DOM from videoEl (up to maxLevels steps) looking for a
 * container that matches known player selectors AND has sufficient dimensions.
 * Falls back to the best size-matching candidate, then to the video element itself.
 *
 * Priority:
 *   1. First element matching a PLAYER_SELECTOR with good dimensions
 *   2. First element with good dimensions (stored as sizeCandidate)
 *   3. Direct parent of videoEl
 *   4. videoEl itself
 *
 * @param {HTMLVideoElement} videoEl
 * @param {number} [maxLevels=10]
 * @returns {Element} Best player container
 */
function findPlayerContainer(videoEl, maxLevels = 10) {
  let el = videoEl.parentElement;
  let level = 0;
  /** First element with sufficient size — used as fallback if no selector matched */
  let sizeCandidate = null;

  while (el && el !== document.body && level < maxLevels) {
    const matchesPlayerPattern = PLAYER_SELECTORS.some((sel) => {
      try { return el.matches(sel); } catch { return false; }
    });

    if (looksLikePlayerContainer(el)) {
      if (matchesPlayerPattern) {
        // Best match: known player class + good dimensions — return immediately
        return el;
      }
      // Record first size-matching element as fallback
      if (!sizeCandidate) sizeCandidate = el;
    }

    el = el.parentElement;
    level++;
  }

  // Return size-based candidate, or direct parent, or the video element itself
  return sizeCandidate ?? videoEl.parentElement ?? videoEl;
}

/**
 * For site-specific configs that declare a playerWrapperSelector,
 * tries that selector first. Otherwise falls back to findPlayerContainer().
 *
 * @param {HTMLVideoElement} videoEl
 * @param {{ playerWrapperSelector?: string, videoParentLevels?: number }|null} config
 * @returns {Element}
 */
function resolvePlayerContainer(videoEl, config) {
  if (config?.playerSelector) {
    const el = document.querySelector(config.playerSelector);
    if (el) return el;
  }
  if (config?.playerWrapperSelector) {
    const el = document.querySelector(config.playerWrapperSelector);
    // Only use wrapper if it actually contains the video
    if (el && el.contains(videoEl)) return el;
  }
  const maxLevels = config?.videoParentLevels ?? 10;
  return findPlayerContainer(videoEl, maxLevels);
}

// ─── Style Persistence ────────────────────────────────────────────────────────

/**
 * Save an element's current inline style properties so we can restore them.
 * Stores full cssText for a clean restore.
 *
 * @param {Element} el
 */
function saveStyles(el) {
  if (!originalStyles.has(el)) {
    originalStyles.set(el, el.style.cssText);
  }
}

/**
 * Restore an element's previously saved inline styles.
 * @param {Element} el
 */
function restoreStyles(el) {
  if (originalStyles.has(el)) {
    el.style.cssText = originalStyles.get(el);
    originalStyles.delete(el);
  }
}

/**
 * Apply a plain-object map of CSS properties to an element using
 * setProperty with 'important' priority so we can beat site !important rules.
 *
 * @param {Element} el
 * @param {Record<string, string>} styles
 */
function applyImportantStyles(el, styles) {
  for (const [prop, value] of Object.entries(styles)) {
    el.style.setProperty(prop, value, 'important');
  }
}

// ─── Activate / Deactivate ───────────────────────────────────────────────────

/**
 * Core activation logic — called once a video element is confirmed present.
 * @param {HTMLVideoElement} videoEl
 */
function activateWithVideo(videoEl) {
  const config = getSiteConfig();
  const playerContainer = resolvePlayerContainer(videoEl, config);

  // Save references for clean restore on deactivate
  activePlayerContainer = playerContainer;
  activeVideoEl = videoEl;

  // Save and apply player container styles
  saveStyles(playerContainer);
  applyImportantStyles(playerContainer, PLAYER_ACTIVE_STYLES);

  // Save and apply video element styles
  saveStyles(videoEl);
  applyImportantStyles(videoEl, VIDEO_ACTIVE_STYLES);

  // Hide site-specific layout chrome (header, sidebar, etc.)
  hiddenElements = [];
  const elementsToHide = config?.elementsToHide ?? [];
  for (const selector of elementsToHide) {
    const els = document.querySelectorAll(selector);
    els.forEach((el) => {
      saveStyles(el);
      el.style.setProperty('display', 'none', 'important');
      hiddenElements.push(el);
    });
  }

  // Prevent body scrollbars from showing through
  saveStyles(document.body);
  document.body.classList.add(BODY_ACTIVE_CLASS);

  isActive = true;
  updateButton();

  // Notify background of state change
  safeSendMessage({ action: 'stateChanged', isActive: true });
}

/**
 * Find a video element on the page, waiting up to 10 s if not yet present.
 * Calls `callback` with the element (or null on timeout).
 *
 * @param {(el: HTMLVideoElement|null) => void} callback
 */
function findVideoElement(callback) {
  const existing = document.querySelector('video');
  if (existing) {
    callback(existing);
    return;
  }

  // Video not yet in DOM — watch for it
  videoWaitObserver = new MutationObserver(() => {
    const el = document.querySelector('video');
    if (el) {
      clearTimeout(videoWaitTimeout);
      videoWaitObserver.disconnect();
      videoWaitObserver = null;
      videoWaitTimeout = null;
      callback(el);
    }
  });
  videoWaitObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Timeout after 10 seconds
  videoWaitTimeout = setTimeout(() => {
    videoWaitObserver?.disconnect();
    videoWaitObserver = null;
    videoWaitTimeout = null;
    callback(null);
  }, 10_000);
}

/** Activate full-window mode. Finds video element first if needed. */
function activateFullWindow() {
  if (isActive) return;

  findVideoElement((videoEl) => {
    if (!videoEl) {
      console.warn('[FWP] No video element found within 10 s — cannot activate.');
      return;
    }
    activateWithVideo(videoEl);
  });
}

/** Deactivate full-window mode and restore all original styles. */
function deactivateFullWindow() {
  if (!isActive) return;

  // Cancel any pending video wait
  if (videoWaitObserver) {
    videoWaitObserver.disconnect();
    videoWaitObserver = null;
  }
  if (videoWaitTimeout) {
    clearTimeout(videoWaitTimeout);
    videoWaitTimeout = null;
  }

  // Restore hidden layout elements
  for (const el of hiddenElements) {
    restoreStyles(el);
  }
  hiddenElements = [];

  // Restore body
  document.body.classList.remove(BODY_ACTIVE_CLASS);
  restoreStyles(document.body);

  // Restore video element
  if (activeVideoEl) {
    restoreStyles(activeVideoEl);
    activeVideoEl = null;
  }

  // Restore player container
  if (activePlayerContainer) {
    restoreStyles(activePlayerContainer);
    activePlayerContainer = null;
  }

  isActive = false;
  updateButton();

  safeSendMessage({ action: 'stateChanged', isActive: false });
}

/** Toggle between active and inactive states. */
function toggleFullWindow() {
  if (isActive) {
    deactivateFullWindow();
  } else {
    activateFullWindow();
  }
}

// ─── Floating Button (Shadow DOM) ─────────────────────────────────────────────

const BUTTON_STYLES = `
  :host {
    all: initial;
  }
  .fwp-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.72);
    border: 1.5px solid rgba(255, 255, 255, 0.18);
    color: #fff;
    font-size: 20px;
    cursor: pointer;
    outline: none;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
    transition: background 0.18s, transform 0.12s, box-shadow 0.18s;
    padding: 0;
    line-height: 1;
    -webkit-font-smoothing: antialiased;
    user-select: none;
    box-sizing: border-box;
  }
  .fwp-btn:hover {
    background: rgba(20, 20, 20, 0.92);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
    transform: scale(1.08);
  }
  .fwp-btn:active {
    transform: scale(0.95);
  }
  .fwp-btn[data-active="true"] {
    background: rgba(124, 58, 237, 0.85);
    border-color: rgba(167, 139, 250, 0.5);
  }
  .fwp-btn[data-active="true"]:hover {
    background: rgba(124, 58, 237, 0.95);
  }
`;

/** Inject the floating button inside a Shadow DOM to isolate it from page CSS. */
function injectFloatingButton() {
  // Idempotency guard
  if (document.getElementById(SHADOW_HOST_ID)) return;

  shadowHost = document.createElement('div');
  shadowHost.id = SHADOW_HOST_ID;
  // Host element positioning — outside shadow so page cannot override our z-index
  shadowHost.style.cssText = [
    'position:fixed',
    'bottom:20px',
    'right:20px',
    'z-index:2147483647',
    'pointer-events:auto',
    'display:none', // hidden until video detected
  ].join(';');

  const shadow = shadowHost.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = BUTTON_STYLES;
  shadow.appendChild(style);

  shadowButton = document.createElement('button');
  shadowButton.className = 'fwp-btn';
  shadowButton.setAttribute('title', 'Full Window Player (Ctrl+Shift+F)');
  shadowButton.setAttribute('data-active', 'false');
  shadowButton.textContent = '⛶';
  shadowButton.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFullWindow();
  });

  shadow.appendChild(shadowButton);
  document.body.appendChild(shadowHost);
}

/** Update the floating button's visible state to match isActive. */
function updateButton() {
  if (!shadowButton || !shadowHost) return;
  shadowButton.setAttribute('data-active', String(isActive));
  shadowButton.textContent = isActive ? '✕' : '⛶';
  shadowButton.setAttribute('title', isActive ? 'Exit Full Window (Ctrl+Shift+F)' : 'Full Window Player (Ctrl+Shift+F)');
}

/** Show the floating button (only when a video is present on the page). */
function showButton() {
  if (shadowHost) shadowHost.style.display = '';
}

/** Hide the floating button. */
function hideButton() {
  if (shadowHost) shadowHost.style.display = 'none';
}

// ─── Video Presence Observer ──────────────────────────────────────────────────

/**
 * Watches the DOM for video elements appearing/disappearing.
 * Shows / hides the floating button accordingly.
 */
function startVideoPresenceObserver() {
  const check = () => {
    const hasVideo = !!document.querySelector('video');
    if (hasVideo) {
      showButton();
    } else {
      hideButton();
      // If we're active and the video disappeared, deactivate gracefully
      if (isActive) {
        deactivateFullWindow();
      }
    }
  };

  // Initial check
  check();

  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

// ─── Keyboard Shortcut (content script fallback) ──────────────────────────────

/**
 * Content-script-level keyboard listener as a fallback for when the
 * background service worker is idle or the command API doesn't fire.
 */
document.addEventListener('keydown', (e) => {
  // Ctrl+Shift+F or Cmd+Shift+F on Mac (mirrors manifest.json command)
  const isMac = navigator.platform?.toLowerCase().includes('mac') || navigator.userAgent.includes('Mac');
  const triggerKey = e.key === 'F' || e.key === 'f';
  const hasMod = isMac ? (e.metaKey && e.shiftKey) : (e.ctrlKey && e.shiftKey);

  if (triggerKey && hasMod) {
    e.preventDefault();
    toggleFullWindow();
  }
}, true /* capture phase so we get it before the page */);

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.action !== 'string') return false;

  switch (message.action) {
    case 'toggle':
      toggleFullWindow();
      sendResponse({ isActive });
      break;

    case 'activate':
      activateFullWindow();
      sendResponse({ isActive });
      break;

    case 'deactivate':
      deactivateFullWindow();
      sendResponse({ isActive });
      break;

    case 'getStatus':
      sendResponse({
        isActive,
        hasVideo: !!document.querySelector('video'),
        hostname: window.location.hostname,
        siteSupported: getSiteConfig() !== null,
      });
      break;

    default:
      return false;
  }

  return false; // synchronous response — channel not kept open
});

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Safely send a message to the background service worker.
 * Swallows errors if the extension context is invalidated (e.g., reloaded).
 * @param {Record<string, unknown>} msg
 */
function safeSendMessage(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {
      // Service worker may be idle — not an error condition
    });
  } catch {
    // Extension context invalidated — ignore
  }
}

// ─── Initialisation ───────────────────────────────────────────────────────────

(function init() {
  // Run only in the top-level frame to avoid interference from iframes
  if (window !== window.top) return;

  // Inject floating button into Shadow DOM
  if (document.body) {
    injectFloatingButton();
    startVideoPresenceObserver();
  } else {
    // body not yet available — wait
    document.addEventListener('DOMContentLoaded', () => {
      injectFloatingButton();
      startVideoPresenceObserver();
    });
  }
})();
