import { useSyncExternalStore } from 'react';

// Captured at module load so an early `beforeinstallprompt` (fired before React
// mounts) isn't missed.
let deferredPrompt = null;
const listeners = new Set();
const notify = () => listeners.forEach(fn => fn());

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

// iOS has no install prompt — users must use Share → Add to Home Screen
const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let snapshot = { canInstall: false, isStandalone: isStandalone(), showIOSHint: false };
const updateSnapshot = () => {
  const standalone = isStandalone();
  snapshot = {
    canInstall: !!deferredPrompt && !standalone,
    isStandalone: standalone,
    showIOSHint: isIOS() && !standalone,
  };
  notify();
};
updateSnapshot();

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // show our own button instead of the browser mini-infobar
  deferredPrompt = e;
  updateSnapshot();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  updateSnapshot();
});

window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', updateSnapshot);

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export async function promptInstall() {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  deferredPrompt = null; // a prompt can only be used once
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  updateSnapshot();
  return outcome === 'accepted';
}

export function usePwaInstall() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
