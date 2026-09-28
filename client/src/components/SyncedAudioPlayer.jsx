import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons';

const DRIFT_THRESHOLD = 0.5; // seconds
const HEARTBEAT_INTERVAL = 2000; // ms
// Stream recovery (network switch, brief outage, server hiccup)
const RECOVERY_BASE_DELAY_MS = 1000;
const RECOVERY_MAX_DELAY_MS = 15000;
const RECOVERY_MAX_ATTEMPTS = 40; // ~8 minutes of retrying at the max delay
const STALL_CHECK_INTERVAL_MS = 2000;
const STALL_TIMEOUT_MS = 12000; // no progress for this long while playing = stuck stream
const MEDIA_ERR_ABORTED = 1;
const HAVE_FUTURE_DATA = 3;

export default function SyncedAudioPlayer({
  streamUrl,
  trackId,
  jamClient,
  isHost,
  isConnected,
  onPlaybackUpdate,
  onEnded,
  audioRef: externalAudioRef,
  pendingSyncRef
}) {
  const internalAudioRef = useRef(null);
  // Use external ref if provided, otherwise use internal ref
  const audioRef = externalAudioRef || internalAudioRef;
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => {
    // Load saved volume from localStorage, default to 1.0 (100%)
    const savedVolume = localStorage.getItem('audio_volume');
    return savedVolume ? parseFloat(savedVolume) : 1.0;
  });
  const heartbeatIntervalRef = useRef(null);
  // Whether playback is meant to be running (survives stream failures/reloads)
  const shouldPlayRef = useRef(false);
  const recoveringRef = useRef(false);
  // Last server sync applied — used to resume at the room's position after a failure
  const lastSyncRef = useRef(null);

  // Set initial volume on audio element
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.volume = volume;
    }
  }, [volume]);

  // Initialize audio element
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // Set initial volume
    audio.volume = volume;

    const handleLoadedMetadata = () => {
      setDuration(audio.duration);
    };

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      onPlaybackUpdate?.(audio.currentTime, audio.paused);
    };

    const handlePlay = () => {
      shouldPlayRef.current = true;
      setIsPlaying(true);
    };
    const handlePause = () => {
      // A reload during recovery isn't a user/host pause
      if (!recoveringRef.current) shouldPlayRef.current = false;
      setIsPlaying(false);
    };
    const handleEnded = () => {
      setIsPlaying(false);
      onEnded?.();
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [onPlaybackUpdate, onEnded]);

  // Apply a sync state to the audio element
  const applySyncState = (state) => {
    const audio = audioRef.current;
    if (!audio) return;

    console.log('Applying sync:', state);
    shouldPlayRef.current = state.playing;
    if (!state.local) lastSyncRef.current = state;

    // Calculate expected position accounting for network latency. Locally started
    // tracks (state.local) begin at `position` however long the stream took to load.
    const latency = Date.now() - state.timestamp;
    const expectedPosition = state.position + (state.playing && !state.local ? latency / 1000 : 0);

    // Check for drift
    const drift = Math.abs(audio.currentTime - expectedPosition);
    console.log(`Drift: ${drift.toFixed(3)}s`);

    if (drift > DRIFT_THRESHOLD) {
      console.log(`Correcting drift: seeking to ${expectedPosition.toFixed(2)}s`);
      audio.currentTime = expectedPosition;
    }

    // Sync play/pause state
    if (state.playing && audio.paused) {
      audio.play().catch(err => console.error('Playback error:', err));
    } else if (!state.playing && !audio.paused) {
      audio.pause();
    }
  };

  // Handle sync commands from server
  useEffect(() => {
    if (!jamClient) return;

    jamClient.on('sync', applySyncState);

    return () => {
      jamClient.off('sync', applySyncState);
    };
  }, [jamClient]);

  // Apply pending sync state on mount (handles join-in-progress)
  useEffect(() => {
    if (!pendingSyncRef?.current) return;

    const audio = audioRef.current;
    if (!audio) return;

    // Wait for audio to be ready enough to seek/play
    const applyPending = () => {
      const pending = pendingSyncRef.current;
      if (pending) {
        console.log('Applying pending sync state on mount');
        applySyncState(pending);
        pendingSyncRef.current = null;
      }
    };

    // Locally started tracks have nothing to seek to, so start right away (play()
    // is queued until data arrives) — keeps back-to-back playback going when the
    // previous track ends in the background
    if (audio.readyState >= 1 || pendingSyncRef.current.local) {
      applyPending();
    } else {
      audio.addEventListener('loadedmetadata', applyPending, { once: true });
      return () => audio.removeEventListener('loadedmetadata', applyPending);
    }
  }, [streamUrl]);

  // Recover from stream failures instead of silently stopping: on a media error
  // or a stall, reload the stream (with backoff) and resume at the room's position
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !streamUrl) return;

    let attempts = 0;
    let retryTimer = null;
    let resumeHandler = null;
    let lastPosition = 0;
    let lastCheckPosition = -1;
    let stalledMs = 0;

    // Where to resume: the room's current position if we know it, else where we were
    const targetPosition = () => {
      const sync = lastSyncRef.current;
      if (shouldPlayRef.current && sync?.trackId === trackId && sync.playing) {
        return sync.position + (Date.now() - sync.timestamp) / 1000;
      }
      return lastPosition;
    };

    const recover = () => {
      retryTimer = null;
      if (!navigator.onLine) return; // 'online' will retry
      attempts++;
      // Still waiting for the first sync of this track? Its own handler seeks/plays.
      const hadPending = !!pendingSyncRef?.current;
      recoveringRef.current = true;

      if (resumeHandler) audio.removeEventListener('loadedmetadata', resumeHandler);
      resumeHandler = () => {
        resumeHandler = null;
        recoveringRef.current = false;
        if (hadPending) return;
        const position = targetPosition();
        if (Number.isFinite(position) && position > 0) {
          audio.currentTime = audio.duration ? Math.min(position, audio.duration) : position;
        }
        if (shouldPlayRef.current) {
          audio.play().catch(err => console.error('Playback error after recovery:', err));
        }
      };
      audio.addEventListener('loadedmetadata', resumeHandler, { once: true });

      console.log(`Audio stream failed, reloading (attempt ${attempts})`);
      audio.load();
    };

    const scheduleRecovery = () => {
      if (retryTimer || attempts >= RECOVERY_MAX_ATTEMPTS) return;
      const delay = Math.min(RECOVERY_BASE_DELAY_MS * 2 ** attempts, RECOVERY_MAX_DELAY_MS);
      retryTimer = setTimeout(recover, delay);
    };

    const handleError = () => {
      const code = audio.error?.code;
      if (!code || code === MEDIA_ERR_ABORTED) return;
      console.warn(`Audio error (code ${code})`);
      recoveringRef.current = false;
      scheduleRecovery();
    };

    const handlePlaying = () => {
      attempts = 0;
      stalledMs = 0;
    };

    const handleTimeUpdate = () => {
      if (!recoveringRef.current) lastPosition = audio.currentTime;
    };

    const handleOnline = () => {
      if (retryTimer || audio.error || stalledMs > 0) {
        clearTimeout(retryTimer);
        recover();
      }
    };

    // Some browsers never fire 'error' on a dropped connection — the stream just hangs
    const watchdog = setInterval(() => {
      const stuck = shouldPlayRef.current && !audio.paused && !recoveringRef.current && !retryTimer &&
        audio.readyState < HAVE_FUTURE_DATA && audio.currentTime === lastCheckPosition;
      lastCheckPosition = audio.currentTime;
      if (!stuck) {
        stalledMs = 0;
        return;
      }
      stalledMs += STALL_CHECK_INTERVAL_MS;
      if (stalledMs >= STALL_TIMEOUT_MS) {
        console.warn(`Audio stalled for ${stalledMs / 1000}s`);
        stalledMs = 0;
        recover();
      }
    }, STALL_CHECK_INTERVAL_MS);

    audio.addEventListener('error', handleError);
    audio.addEventListener('playing', handlePlaying);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    window.addEventListener('online', handleOnline);

    return () => {
      clearInterval(watchdog);
      clearTimeout(retryTimer);
      if (resumeHandler) audio.removeEventListener('loadedmetadata', resumeHandler);
      recoveringRef.current = false;
      audio.removeEventListener('error', handleError);
      audio.removeEventListener('playing', handlePlaying);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      window.removeEventListener('online', handleOnline);
    };
  }, [streamUrl, trackId]);

  // Send heartbeat to server
  useEffect(() => {
    // Only start heartbeat when connected
    if (!jamClient || !isConnected) return;

    console.log('Starting heartbeat interval');

    const sendHeartbeat = () => {
      const audio = audioRef.current;
      const position = audio ? audio.currentTime : 0;
      jamClient.sendHeartbeat(position);
    };

    heartbeatIntervalRef.current = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

    return () => {
      console.log('Stopping heartbeat interval');
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }
    };
  }, [jamClient, isConnected]);

  return (
    <div className="synced-audio-player">
      <audio
        ref={audioRef}
        src={streamUrl}
        preload="auto"
      />

      <div className="seek-row">
        <span className="time">{formatTime(currentTime)}</span>
        <input
          type="range"
          min="0"
          max={duration || 0}
          step="any"
          value={currentTime}
          onChange={(e) => {
            const newPosition = parseFloat(e.target.value);
            const audio = audioRef.current;

            if (audio) {
              audio.currentTime = newPosition;

              // If host, emit seek event to sync with other users
              if (isHost && jamClient) {
                jamClient.seek(newPosition);
              }
            }
          }}
          className="range seek-bar"
          style={{ '--progress': `${duration ? (currentTime / duration) * 100 : 0}%` }}
          disabled={!isHost}
          title={isHost ? 'Drag to seek' : 'Only the host can seek'}
          aria-label="Seek"
        />
        <span className="time">{formatTime(duration)}</span>
      </div>

      <div className="volume-control">
        <Icon name={volume === 0 ? 'volumeOff' : 'volume'} size={18} />
        <input
          id="volume-slider"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={(e) => {
            const newVolume = parseFloat(e.target.value);
            setVolume(newVolume);
            // Save to localStorage for persistence
            localStorage.setItem('audio_volume', newVolume.toString());
          }}
          className="range volume-slider"
          style={{ '--progress': `${volume * 100}%` }}
          title={`Volume: ${Math.round(volume * 100)}%`}
          aria-label="Volume"
        />
        <span className="volume-value">{Math.round(volume * 100)}%</span>
        <span className="sr-only" aria-live="polite">{isPlaying ? 'Playing' : 'Paused'}</span>
      </div>
    </div>
  );
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
