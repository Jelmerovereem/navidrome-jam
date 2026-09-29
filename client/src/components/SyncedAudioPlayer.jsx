import { useCallback, useEffect, useRef, useState } from 'react';
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
const HAVE_METADATA = 1;
const HAVE_FUTURE_DATA = 3;
// Start preloading the next track into the standby element this long before the end
const PRELOAD_LEAD_S = 30;
const PRELOAD_RETRY_MS = 5000; // retry a failed preload this often

export default function SyncedAudioPlayer({
  streamUrl,
  trackId,
  nextStreamUrl,
  jamClient,
  isHost,
  isConnected,
  onPlaybackUpdate,
  onEnded,
  audioRef: externalAudioRef,
  pendingSyncRef
}) {
  const internalAudioRef = useRef(null);
  // Use external ref if provided, otherwise use internal ref.
  // It always points at the *active* one of two audio elements: the other is a
  // standby that preloads the next track, so a track change never has to wait on
  // the network. That gap is what let mobile browsers suspend the app when a
  // song ended with the screen locked.
  const audioRef = externalAudioRef || internalAudioRef;
  const elementsRef = useRef([null, null]);
  const activeIndexRef = useRef(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const nextStreamUrlRef = useRef(nextStreamUrl);
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

  const setElement0 = useCallback((el) => {
    elementsRef.current[0] = el;
    if (activeIndexRef.current === 0) audioRef.current = el;
  }, [audioRef]);
  const setElement1 = useCallback((el) => {
    elementsRef.current[1] = el;
    if (activeIndexRef.current === 1) audioRef.current = el;
  }, [audioRef]);

  const standbyElement = () => elementsRef.current[1 - activeIndexRef.current];

  // Make the standby element the active one (it already holds the new track)
  const activateStandby = () => {
    const previous = audioRef.current;
    activeIndexRef.current = 1 - activeIndexRef.current;
    audioRef.current = elementsRef.current[activeIndexRef.current];
    if (previous && !previous.paused) previous.pause();
    setActiveIndex(activeIndexRef.current);
    return audioRef.current;
  };

  const hasPreloaded = (el, url) => !!el && !!url && el.src === url && !el.error;

  useEffect(() => {
    nextStreamUrlRef.current = nextStreamUrl;
  }, [nextStreamUrl]);

  // Point the active element at the current track. Runs before the effects that
  // apply sync state / recovery so they act on the right element.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !streamUrl || audio.src === streamUrl) return;
    const standby = standbyElement();
    if (hasPreloaded(standby, streamUrl)) {
      // Skipped to the track we'd already preloaded: switch instead of reloading
      console.log('Switching to preloaded track');
      activateStandby();
    } else {
      audio.src = streamUrl;
    }
  }, [streamUrl]);

  // Set volume on both audio elements
  useEffect(() => {
    elementsRef.current.forEach(el => { if (el) el.volume = volume; });
  }, [volume]);

  // Initialize audio element
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // Set initial volume
    audio.volume = volume;
    // After a switch the new element's metadata was loaded while it was standby
    if (audio.readyState >= HAVE_METADATA) setDuration(audio.duration);

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
      const standby = standbyElement();
      if (hasPreloaded(standby, nextStreamUrlRef.current)) {
        // Start the preloaded next track right here, in the 'ended' event, so audio
        // never goes idle between tracks (no React render or network round trip).
        // The app then loads that same track as usual, which is a no-op here.
        console.log('Track ended, handing off to preloaded next track');
        standby.currentTime = 0;
        standby.play().catch(err => console.error('Handoff playback error:', err));
        activateStandby();
        shouldPlayRef.current = true;
        setIsPlaying(true);
      } else {
        setIsPlaying(false);
      }
      onEnded?.();
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('durationchange', handleLoadedMetadata);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('durationchange', handleLoadedMetadata);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [onPlaybackUpdate, onEnded, activeIndex]);

  // Preload the next track into the standby element near the end of this one
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !nextStreamUrl) return;
    let lastAttempt = 0;

    const maybePreload = () => {
      const standby = standbyElement();
      if (!standby) return;
      const loaded = standby.src === nextStreamUrl;
      // Already preloaded, or failed very recently (e.g. network blip) — retry later
      if (loaded && (!standby.error || Date.now() - lastAttempt < PRELOAD_RETRY_MS)) return;
      const remaining = (audio.duration || Infinity) - audio.currentTime;
      if (remaining > PRELOAD_LEAD_S) return;
      lastAttempt = Date.now();
      console.log(loaded ? 'Retrying failed preload of next track' : 'Preloading next track');
      standby.preload = 'auto';
      standby.src = nextStreamUrl;
      standby.load();
    };

    maybePreload();
    audio.addEventListener('timeupdate', maybePreload);
    audio.addEventListener('durationchange', maybePreload);
    return () => {
      audio.removeEventListener('timeupdate', maybePreload);
      audio.removeEventListener('durationchange', maybePreload);
    };
  }, [nextStreamUrl, activeIndex]);

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
  }, [streamUrl, trackId, activeIndex]);

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
      {/* Active + standby element; which is which flips on each handoff */}
      <audio ref={setElement0} preload="auto" />
      <audio ref={setElement1} preload="auto" />

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
