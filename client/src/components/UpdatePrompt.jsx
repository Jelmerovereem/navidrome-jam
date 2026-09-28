import { useRegisterSW } from 'virtual:pwa-register/react';
import { Icon } from './Icons';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

// Shows a toast when a new app version has been downloaded. Updating is
// user-initiated so a reload never interrupts playback unexpectedly.
export default function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl, registration) {
      // Long-lived installed apps rarely navigate, so check for updates periodically
      if (registration) {
        setInterval(() => registration.update(), UPDATE_CHECK_INTERVAL_MS);
      }
    },
  });

  if (!needRefresh) return null;

  return (
    <div className="toast" role="status">
      <Icon name="refresh" size={18} />
      <span className="toast-text">A new version of Jam is available.</span>
      <button className="btn btn-ghost btn-sm" onClick={() => setNeedRefresh(false)}>Later</button>
      <button className="btn btn-primary btn-sm" onClick={() => updateServiceWorker(true)}>Update</button>
    </div>
  );
}
