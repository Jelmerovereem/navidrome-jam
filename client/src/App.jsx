import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavidrome } from './contexts/NavidromeContext';
import { useJam } from './contexts/JamContext';
import SyncedAudioPlayer from './components/SyncedAudioPlayer';
import { Icon, Logo } from './components/Icons';
import './App.css';

const ROOM_POLL_INTERVAL_MS = 10000;
const RESTART_TRACK_THRESHOLD_S = 3; // seconds before "previous" restarts current track
const SCROBBLE_MAX_S = 240; // scrobble after half the track or 4 minutes, whichever comes first
const NOW_PLAYING_THROTTLE_MS = 30000;

function App() {
  // Get client instances from context
  const navidrome = useNavidrome();
  const jamClient = useJam();
  const audioRef = useRef(null);
  const pendingSyncRef = useRef(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [inviteCode, setInviteCode] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [registerSuccess, setRegisterSuccess] = useState('');
  const [showWaitlist, setShowWaitlist] = useState(false);
  const [waitlistName, setWaitlistName] = useState('');
  const [waitlistEmail, setWaitlistEmail] = useState('');
  const [waitlistMessage, setWaitlistMessage] = useState('');
  const [isJoiningWaitlist, setIsJoiningWaitlist] = useState(false);
  const [waitlistSuccess, setWaitlistSuccess] = useState('');

  const [currentRoom, setCurrentRoom] = useState(null);
  const [roomInput, setRoomInput] = useState('');
  const [roomError, setRoomError] = useState('');
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [isJoiningRoom, setIsJoiningRoom] = useState(false);
  const [activeRooms, setActiveRooms] = useState([]);
  const [codeCopied, setCodeCopied] = useState(false);
  const [communities, setCommunities] = useState([]);

  const [currentTrack, setCurrentTrack] = useState(null);
  const [queue, setQueue] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [canControl, setCanControl] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingTrack, setIsLoadingTrack] = useState(false);

  // Play history for previous track
  const [playHistory, setPlayHistory] = useState([]);

  // Reaction state
  const [_trackReactions, setTrackReactions] = useState({ likes: 0, dislikes: 0 });
  const [userReaction, setUserReaction] = useState(null);
  const [trackStarred, setTrackStarred] = useState(false); // Navidrome persistent star

  // Upload state — queue-based for multi-file uploads
  // Each item: { id, file, status: 'pending'|'uploading'|'done'|'error', progress: 0-100, error?: string, result?: string }
  const [uploadQueue, setUploadQueue] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [myUploads, setMyUploads] = useState([]);
  const [uploadPermanentCount, setUploadPermanentCount] = useState(0);
  const [uploadPermanentQuota, setUploadPermanentQuota] = useState(50);
  const [isLoadingUploads, setIsLoadingUploads] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const uploadQueueRef = useRef([]);

  // Browse state
  const [musicTab, setMusicTab] = useState('browse');
  const [browseMode, setBrowseMode] = useState('artists'); // artists, albums, recent, random, favorites
  const [browseView, setBrowseView] = useState('artists');
  const [artists, setArtists] = useState(null);
  const [albumList, setAlbumList] = useState(null);
  const [favorites, setFavorites] = useState(null);
  const [playlists, setPlaylists] = useState(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const [selectedArtist, setSelectedArtist] = useState(null);
  const [selectedAlbum, setSelectedAlbum] = useState(null);
  const [isLoadingBrowse, setIsLoadingBrowse] = useState(false);
  const [repeatMode, setRepeatMode] = useState(() => {
    return localStorage.getItem('jam_repeat') === 'on';
  });

  // Restore session on mount
  useEffect(() => {
    const restoreSession = async () => {
      try {
        const restored = await navidrome.restoreSession();
        if (restored) {
          setIsAuthenticated(true);
          setUsername(navidrome.username);
          connectToJamServer();
        }
      } catch (error) {
        console.error('Failed to restore session:', error);
      }
    };

    restoreSession();
  }, []);

  // Setup Jam client event listeners
  useEffect(() => {
    // Track the current track ID so sync handler can detect changes
    let syncedTrackId = null;

    const handleRoomState = (room) => {
      setCurrentRoom(room);
      const host = room.hostId === jamClient.userId;
      const cohost = (room.coHosts || []).includes(jamClient.userId);
      setIsHost(host);
      setCanControl(host || cohost);
      setQueue(room.queue || []);
      setIsJoiningRoom(false);
      setIsCreatingRoom(false);

      // On join, load and sync to current playback state
      const ps = room.playbackState;
      if (ps.trackId) {
        syncedTrackId = ps.trackId;
        loadTrack(ps.trackId);
      }
    };

    // Handle sync events — detect track changes and load new tracks
    const handleSyncInApp = (state) => {
      // Store latest sync state so SyncedAudioPlayer can apply it on mount
      pendingSyncRef.current = state;

      if (state.trackId && state.trackId !== syncedTrackId) {
        console.log(`Track changed via sync: ${syncedTrackId} -> ${state.trackId}`);
        syncedTrackId = state.trackId;
        setTrackReactions({ likes: 0, dislikes: 0 });
        setUserReaction(null);
        loadTrack(state.trackId);
      }
    };

    const handleUserJoined = ({ room }) => {
      setCurrentRoom(room);
    };

    const handleUserLeft = ({ room, newHost }) => {
      setCurrentRoom(room);
      const cohost = (room.coHosts || []).includes(jamClient.userId);
      setCanControl(room.hostId === jamClient.userId || cohost);
      if (newHost === jamClient.userId) {
        setIsHost(true);
        setCanControl(true);
        alert('You are now the host!');
      }
    };

    const handleCoHostUpdated = (room) => {
      setCurrentRoom(room);
      const host = room.hostId === jamClient.userId;
      const cohost = (room.coHosts || []).includes(jamClient.userId);
      setIsHost(host);
      setCanControl(host || cohost);
    };

    const handleQueueUpdated = (newQueue) => {
      setQueue(newQueue);
    };

    const handleError = (message) => {
      setRoomError(message);
    };

    const handleTrackReactions = ({ likes, dislikes, reactions }) => {
      setTrackReactions({ likes, dislikes });
      const myReaction = reactions[jamClient.userId] || null;
      setUserReaction(myReaction);
    };

    const handleDisconnected = () => {
      setIsConnected(false);
      setCurrentRoom(null);
    };

    jamClient.on('room-state', handleRoomState);
    jamClient.on('sync', handleSyncInApp);
    jamClient.on('user-joined', handleUserJoined);
    jamClient.on('user-left', handleUserLeft);
    jamClient.on('cohost-updated', handleCoHostUpdated);
    jamClient.on('queue-updated', handleQueueUpdated);
    jamClient.on('error', handleError);
    jamClient.on('disconnected', handleDisconnected);
    jamClient.on('track-reactions', handleTrackReactions);

    return () => {
      jamClient.off('room-state', handleRoomState);
      jamClient.off('sync', handleSyncInApp);
      jamClient.off('user-joined', handleUserJoined);
      jamClient.off('user-left', handleUserLeft);
      jamClient.off('cohost-updated', handleCoHostUpdated);
      jamClient.off('queue-updated', handleQueueUpdated);
      jamClient.off('error', handleError);
      jamClient.off('disconnected', handleDisconnected);
      jamClient.off('track-reactions', handleTrackReactions);
      jamClient.disconnect();
    };
  }, []);

  const fetchActiveRooms = useCallback(async () => {
    try {
      const rooms = await jamClient.listRooms();
      setActiveRooms(rooms);
    } catch {
      // silent — room list is best-effort
    }
  }, [jamClient]);

  // Poll active rooms every 10s when on room selection screen
  useEffect(() => {
    if (!isAuthenticated || currentRoom) return;
    fetchActiveRooms();
    const interval = setInterval(fetchActiveRooms, ROOM_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isAuthenticated, currentRoom, fetchActiveRooms]);

  // Fetch available communities for room tagging
  useEffect(() => {
    if (isAuthenticated) {
      fetch(`${import.meta.env.VITE_JAM_SERVER_URL}/api/communities`)
        .then(r => r.ok ? r.json() : { communities: [] })
        .then(data => {
          setCommunities(data.communities || []);
        })
        .catch(() => {});
    }
  }, [isAuthenticated]);

  const connectToJamServer = async () => {
    try {
      await jamClient.connect();
      setIsConnected(true);
      fetchActiveRooms();
    } catch (error) {
      console.error('Failed to connect to Jam server:', error);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    setIsLoggingIn(true);

    try {
      await navidrome.authenticate(username, password);
      setIsAuthenticated(true);
      setPassword('');
      await connectToJamServer();
    } catch (error) {
      setLoginError(error.message);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setLoginError('');
    setRegisterSuccess('');
    setIsRegistering(true);

    try {
      const result = await jamClient.register(username, password, inviteCode);
      setRegisterSuccess(result.message);
      setInviteCode('');
      setAuthMode('login');
      setPassword('');
    } catch (error) {
      setLoginError(error.message);
    } finally {
      setIsRegistering(false);
    }
  };

  const handleJoinWaitlist = async (e) => {
    e.preventDefault();
    setLoginError('');
    setIsJoiningWaitlist(true);

    try {
      const result = await jamClient.joinWaitlist(waitlistName, waitlistEmail, waitlistMessage || undefined);
      setWaitlistSuccess(`You're #${result.position} on the waitlist! We'll reach out when a spot opens up.`);
      setWaitlistName('');
      setWaitlistEmail('');
      setWaitlistMessage('');
    } catch (error) {
      setLoginError(error.message);
    } finally {
      setIsJoiningWaitlist(false);
    }
  };

  const handleLogout = () => {
    navidrome.logout();
    jamClient.disconnect();
    setIsAuthenticated(false);
    setIsConnected(false);
    setCurrentRoom(null);
    setUsername('');
  };

  const handleCreateRoom = async () => {
    setIsCreatingRoom(true);
    setRoomError('');

    try {
      const community = localStorage.getItem('jam_community') || null;
      const room = await jamClient.createRoom(null, username, community);
      setRoomInput(room.id);
      jamClient.joinRoom(room.id, username);
    } catch (error) {
      setRoomError(error.message);
    } finally {
      setIsCreatingRoom(false);
    }
  };

  const handleJoinRoom = () => {
    if (!roomInput.trim()) {
      setRoomError('Please enter a room code');
      return;
    }

    setIsJoiningRoom(true);
    setRoomError('');

    try {
      jamClient.joinRoom(roomInput.toUpperCase(), username);
    } catch (error) {
      setRoomError(error.message);
      setIsJoiningRoom(false);
    }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setIsSearching(true);

    try {
      const results = await navidrome.search(searchQuery);
      setSearchResults(results);
    } catch (error) {
      console.error('Search error:', error);
    } finally {
      setIsSearching(false);
    }
  };

  // Browse handlers
  const loadArtists = async () => {
    if (artists) return; // Already loaded
    setIsLoadingBrowse(true);
    try {
      const result = await navidrome.getArtists();
      // Flatten the indexed artist list
      const allArtists = [];
      if (result.artists?.index) {
        for (const idx of result.artists.index) {
          if (idx.artist) {
            const artistList = Array.isArray(idx.artist) ? idx.artist : [idx.artist];
            allArtists.push(...artistList);
          }
        }
      }
      setArtists(allArtists);
    } catch (error) {
      console.error('Error loading artists:', error);
    } finally {
      setIsLoadingBrowse(false);
    }
  };

  const loadAlbumList = async (type) => {
    setIsLoadingBrowse(true);
    try {
      const result = await navidrome.getAlbumList(type, 500);
      const rawAlbums = result.albumList2?.album
        ? (Array.isArray(result.albumList2.album) ? result.albumList2.album : [result.albumList2.album])
        : [];

      // Group albums by name+year to merge compilations split by artist
      const grouped = new Map();
      for (const album of rawAlbums) {
        const key = `${album.name}||${album.year || ''}`;
        if (!grouped.has(key)) {
          grouped.set(key, {
            ...album,
            _albumIds: [album.id],
            _songCount: album.songCount || 0,
          });
        } else {
          const existing = grouped.get(key);
          existing._albumIds.push(album.id);
          existing._songCount += album.songCount || 0;
          // Use cover art from the entry with the most tracks
          if ((album.songCount || 0) > (existing.songCount || 0)) {
            existing.coverArt = album.coverArt;
          }
          existing.artist = 'Various Artists';
          existing.songCount = existing._songCount;
        }
      }

      setAlbumList(Array.from(grouped.values()));
    } catch (error) {
      console.error('Error loading album list:', error);
    } finally {
      setIsLoadingBrowse(false);
    }
  };

  const handleBrowseModeChange = (mode) => {
    setBrowseMode(mode);
    setBrowseView(mode === 'artists' ? 'artists' : mode === 'favorites' ? 'favorites' : mode === 'playlists' ? 'playlists' : 'albumList');
    setSelectedArtist(null);
    setSelectedAlbum(null);
    setSelectedPlaylist(null);
    setAlbumList(null);

    if (mode === 'artists') {
      loadArtists();
    } else if (mode === 'favorites') {
      loadFavorites();
    } else if (mode === 'playlists') {
      loadPlaylists();
    } else {
      const typeMap = { albums: 'alphabeticalByName', recent: 'newest', played: 'recent' };
      loadAlbumList(typeMap[mode]);
    }
  };

  const loadFavorites = async () => {
    setIsLoadingBrowse(true);
    try {
      const result = await navidrome.getStarred();
      const songs = result.starred2?.song
        ? (Array.isArray(result.starred2.song) ? result.starred2.song : [result.starred2.song])
        : [];
      setFavorites(songs);
    } catch (error) {
      console.error('Error loading favorites:', error);
      setFavorites([]);
    } finally {
      setIsLoadingBrowse(false);
    }
  };

  const loadPlaylists = async () => {
    setIsLoadingBrowse(true);
    try {
      const result = await navidrome.getPlaylists();
      const list = result.playlists?.playlist;
      setPlaylists(list ? (Array.isArray(list) ? list : [list]) : []);
    } catch (err) {
      console.error('Error loading playlists:', err);
      setPlaylists([]);
    } finally {
      setIsLoadingBrowse(false);
    }
  };

  const fetchPlaylistSongs = async (playlistId) => {
    const result = await navidrome.getPlaylist(playlistId);
    const entry = result.playlist?.entry;
    return entry ? (Array.isArray(entry) ? entry : [entry]) : [];
  };

  // Start the playlist (in order or shuffled), replacing the queue with the rest of it
  const handlePlayPlaylist = async (playlist, shuffle = false) => {
    try {
      let songs = playlist.songs || await fetchPlaylistSongs(playlist.id);
      if (songs.length === 0) return;
      if (shuffle) songs = shuffleArray(songs);
      handlePlayTrack(songs[0], songs);
    } catch (err) {
      console.error('Error playing playlist:', err);
    }
  };

  const handleBrowsePlaylist = async (playlist) => {
    setIsLoadingBrowse(true);
    try {
      const songs = await fetchPlaylistSongs(playlist.id);
      setSelectedPlaylist({ ...playlist, songs });
      setBrowseView('playlistSongs');
    } catch (err) {
      console.error('Error loading playlist:', err);
    } finally {
      setIsLoadingBrowse(false);
    }
  };

  const handleBrowseArtist = async (artist) => {
    setIsLoadingBrowse(true);
    try {
      const result = await navidrome.getArtist(artist.id);
      const albums = result.artist?.album
        ? (Array.isArray(result.artist.album) ? result.artist.album : [result.artist.album])
        : [];
      setSelectedArtist({ ...artist, albums });
      setBrowseView('albums');
    } catch (error) {
      console.error('Error loading artist:', error);
    } finally {
      setIsLoadingBrowse(false);
    }
  };

  const handleBrowseAlbum = async (album) => {
    setIsLoadingBrowse(true);
    try {
      const albumIds = album._albumIds || [album.id];
      const allSongs = [];

      for (const id of albumIds) {
        const result = await navidrome.getAlbum(id);
        const songs = result.album?.song
          ? (Array.isArray(result.album.song) ? result.album.song : [result.album.song])
          : [];
        allSongs.push(...songs);
      }

      // Sort by disc number then track number
      allSongs.sort((a, b) => {
        const discA = a.discNumber || 1;
        const discB = b.discNumber || 1;
        if (discA !== discB) return discA - discB;
        return (a.track || 0) - (b.track || 0);
      });

      setSelectedAlbum({ ...album, songs: allSongs });
      setBrowseView('songs');
    } catch (error) {
      console.error('Error loading album:', error);
    } finally {
      setIsLoadingBrowse(false);
    }
  };

  const handleBrowseBack = () => {
    if (browseView === 'playlistSongs') {
      setSelectedPlaylist(null);
      setBrowseView('playlists');
    } else if (browseView === 'songs') {
      setSelectedAlbum(null);
      if (browseMode === 'artists') {
        setBrowseView('albums');
      } else {
        setBrowseView('albumList');
      }
    } else if (browseView === 'albums') {
      setSelectedArtist(null);
      setBrowseView('artists');
    }
  };

  // Upload constants
  const ALLOWED_EXTENSIONS = ['.mp3', '.flac', '.ogg', '.opus', '.m4a', '.wav', '.aac'];
  const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB

  const getSubsonicAuth = () => ({
    username: navidrome.username,
    token: navidrome.token,
    salt: navidrome.salt,
  });

  const fetchMyUploads = async () => {
    setIsLoadingUploads(true);
    try {
      const data = await jamClient.getMyUploads(getSubsonicAuth());
      setMyUploads(data.uploads || []);
      setUploadPermanentCount(data.permanentCount || 0);
      setUploadPermanentQuota(data.permanentQuota || 50);
    } catch (err) {
      console.error('Failed to fetch uploads:', err);
    } finally {
      setIsLoadingUploads(false);
    }
  };

  const validateFile = (file) => {
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return `Unsupported format. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`;
    }
    if (file.size > MAX_FILE_SIZE) {
      return `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max: 200MB`;
    }
    return null;
  };

  const enqueueFiles = (files) => {
    const newItems = [];
    for (const file of files) {
      const error = validateFile(file);
      if (error) {
        newItems.push({ id: `${Date.now()}-${Math.random()}`, file, status: 'error', progress: 0, error });
      } else {
        newItems.push({ id: `${Date.now()}-${Math.random()}`, file, status: 'pending', progress: 0 });
      }
    }
    setUploadQueue(prev => [...prev, ...newItems]);
  };

  // Process upload queue sequentially
  useEffect(() => {
    uploadQueueRef.current = uploadQueue;
  }, [uploadQueue]);

  useEffect(() => {
    if (isUploading) return;
    const next = uploadQueue.find(item => item.status === 'pending');
    if (!next) return;

    setIsUploading(true);
    // Mark as uploading
    setUploadQueue(prev => prev.map(item =>
      item.id === next.id ? { ...item, status: 'uploading' } : item
    ));

    jamClient.uploadTrack(next.file, getSubsonicAuth(), (progress) => {
      setUploadQueue(prev => prev.map(item =>
        item.id === next.id ? { ...item, progress } : item
      ));
    }).then((result) => {
      setUploadQueue(prev => prev.map(item =>
        item.id === next.id ? { ...item, status: 'done', progress: 100, result: result.filename || next.file.name } : item
      ));
      // Refresh uploads list only after the last file finishes
      const remaining = uploadQueueRef.current.filter(item => item.status === 'pending' && item.id !== next.id);
      if (remaining.length === 0) fetchMyUploads();
      setIsUploading(false);
    }).catch((err) => {
      setUploadQueue(prev => prev.map(item =>
        item.id === next.id ? { ...item, status: 'error', error: err.message } : item
      ));
      setIsUploading(false);
    });
  }, [uploadQueue, isUploading]);

  const clearFinishedUploads = () => {
    setUploadQueue(prev => prev.filter(item => item.status === 'pending' || item.status === 'uploading'));
  };

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) enqueueFiles(files);
    e.target.value = ''; // Reset so same files can be re-selected
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) enqueueFiles(files);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleTogglePermanent = async (filename) => {
    try {
      await jamClient.togglePermanent(filename, getSubsonicAuth());
      fetchMyUploads();
    } catch (err) {
      console.error('Failed to toggle permanent:', err);
    }
  };

  // Load uploads when switching to upload tab
  useEffect(() => {
    if (musicTab === 'upload' && currentRoom) {
      fetchMyUploads();
    }
  }, [musicTab, currentRoom]);

  // Load artists when switching to browse tab
  useEffect(() => {
    if (musicTab === 'browse' && currentRoom) {
      loadArtists();
    }
  }, [musicTab, currentRoom]);

  const loadTrack = async (songId) => {
    setIsLoadingTrack(true);

    try {
      const result = await navidrome.getSong(songId);
      const song = result.song;
      setCurrentTrack({
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        coverArt: song.coverArt ? navidrome.getCoverArtUrl(song.coverArt, 300) : null,
        streamUrl: navidrome.getStreamUrl(song.id)
      });
      setTrackStarred(!!song.starred);
    } catch (error) {
      console.error('Error loading track:', error);
    } finally {
      setIsLoadingTrack(false);
    }
  };

  const handlePlayTrack = (song, albumSongs = null) => {
    if (!canControl) {
      alert('Only the host or co-hosts can control playback');
      return;
    }

    // Push current track to history before switching
    if (currentTrack) {
      setPlayHistory(prev => [...prev, { id: currentTrack.id, title: currentTrack.title, artist: currentTrack.artist, album: currentTrack.album }]);
    }

    // If playing from an album, queue the remaining tracks after this one
    if (albumSongs) {
      const songIndex = albumSongs.findIndex(s => s.id === song.id);
      const remaining = albumSongs.slice(songIndex + 1).map(s => ({
        id: s.id, title: s.title, artist: s.artist, album: s.album
      }));
      jamClient.updateQueue(remaining);
    }

    jamClient.play(song.id, 0);
    loadTrack(song.id);
  };

  // Shuffle the upcoming queue once — the new order syncs to everyone in the room
  const handleShuffleQueue = () => {
    if (!canControl) {
      alert('Only the host or co-hosts can modify the queue');
      return;
    }
    if (queue.length < 2) return;
    jamClient.updateQueue(shuffleArray(queue));
  };

  const handleAddToQueue = (song) => {
    if (!canControl) {
      alert('Only the host or co-hosts can modify the queue');
      return;
    }

    const item = {
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album
    };

    // If nothing is playing, auto-play immediately
    if (!currentTrack) {
      jamClient.updateQueue(queue);
      jamClient.play(song.id, 0);
      loadTrack(song.id);
      return;
    }

    const newQueue = [...queue, item];
    jamClient.updateQueue(newQueue);
  };

  const handleTrackEnded = useCallback(() => {
    if (!canControl) return;

    // Re-append current track to end of queue if repeat is on
    const reappendItem = repeatMode && currentTrack
      ? { id: currentTrack.id, title: currentTrack.title, artist: currentTrack.artist, album: currentTrack.album }
      : null;

    if (queue.length === 0 && !reappendItem) {
      console.log('Queue is empty, playback stopped');
      return;
    }

    // Push current track to history
    if (currentTrack) {
      setPlayHistory(prev => [...prev, { id: currentTrack.id, title: currentTrack.title, artist: currentTrack.artist, album: currentTrack.album }]);
    }

    if (queue.length === 0 && reappendItem) {
      // Queue empty but repeat on — replay current track
      console.log(`Repeat: replaying ${currentTrack.title}`);
      jamClient.play(currentTrack.id, 0);
      loadTrack(currentTrack.id);
      return;
    }

    const nextTrack = queue[0];
    const newQueue = [...queue.slice(1), ...(reappendItem ? [reappendItem] : [])];

    console.log(`Auto-playing next track: ${nextTrack.title}${reappendItem ? ' (repeat on)' : ''}`);

    jamClient.updateQueue(newQueue);
    jamClient.play(nextTrack.id, 0);
    loadTrack(nextTrack.id);
  }, [canControl, queue, jamClient, currentTrack, repeatMode]);

  const handleLeaveRoom = () => {
    jamClient.leaveRoom();

    setCurrentRoom(null);
    setCurrentTrack(null);
    setQueue([]);
    setPlayHistory([]);
    setSearchResults(null);
    setIsHost(false);
    setCanControl(false);
    setIsPlaying(false);
    setTrackReactions({ likes: 0, dislikes: 0 });
    setUserReaction(null);

    console.log('Left room');
  };

  const handlePlayPause = () => {
    if (!canControl) return;

    const audio = audioRef.current;
    if (!audio) return;

    if (audio.paused) {
      jamClient.play(currentTrack.id, audio.currentTime);
    } else {
      jamClient.pause(audio.currentTime);
    }
  };

  const handleNextTrack = useCallback(() => {
    if (!canControl || queue.length === 0) return;

    // Push current track to history
    if (currentTrack) {
      setPlayHistory(prev => [...prev, { id: currentTrack.id, title: currentTrack.title, artist: currentTrack.artist, album: currentTrack.album }]);
    }

    const reappendItem = repeatMode && currentTrack
      ? { id: currentTrack.id, title: currentTrack.title, artist: currentTrack.artist, album: currentTrack.album }
      : null;

    const nextTrack = queue[0];
    const newQueue = [...queue.slice(1), ...(reappendItem ? [reappendItem] : [])];

    jamClient.updateQueue(newQueue);
    jamClient.play(nextTrack.id, 0);
    loadTrack(nextTrack.id);
  }, [canControl, queue, jamClient, currentTrack, repeatMode]);

  const handlePrevTrack = useCallback(() => {
    if (!canControl || !currentTrack) return;

    const audio = audioRef.current;

    // If more than 3 seconds in, restart current track
    if (audio && audio.currentTime > RESTART_TRACK_THRESHOLD_S) {
      audio.currentTime = 0;
      jamClient.play(currentTrack.id, 0);
      return;
    }

    // Otherwise go to previous track from history
    if (playHistory.length === 0) {
      // No history — just restart
      if (audio) {
        audio.currentTime = 0;
        jamClient.play(currentTrack.id, 0);
      }
      return;
    }

    // Pop last track from history, put current track back at front of queue
    const prevTrack = playHistory[playHistory.length - 1];
    setPlayHistory(prev => prev.slice(0, -1));

    const newQueue = [{ id: currentTrack.id, title: currentTrack.title, artist: currentTrack.artist, album: currentTrack.album }, ...queue];
    jamClient.updateQueue(newQueue);

    jamClient.play(prevTrack.id, 0);
    loadTrack(prevTrack.id);
  }, [canControl, currentTrack, jamClient, playHistory, queue]);

  // Report playback to Navidrome like other Subsonic clients: "Now Playing" while
  // audio is playing, and a scrobble once enough of the track has been heard.
  // Each listener reports with their own account.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;

    const trackId = currentTrack.id;
    let startedAt = null;
    let listened = 0;
    let lastPosition = null;
    let lastNowPlayingAt = 0;
    let scrobbled = false;

    const handlePlaying = () => {
      lastPosition = audio.currentTime;
      if (startedAt === null) startedAt = Date.now();
      if (Date.now() - lastNowPlayingAt < NOW_PLAYING_THROTTLE_MS) return;
      lastNowPlayingAt = Date.now();
      navidrome.scrobble(trackId, false).catch(err => console.error('Now playing update failed:', err));
    };

    const handleTimeUpdate = () => {
      if (audio.paused || lastPosition === null) return;
      const delta = audio.currentTime - lastPosition;
      lastPosition = audio.currentTime;
      // Only count normal playback progress, not seeks or sync corrections
      if (delta > 0 && delta < 2) listened += delta;

      const threshold = Math.min(SCROBBLE_MAX_S, (audio.duration || Infinity) / 2);
      if (!scrobbled && listened >= threshold) {
        scrobbled = true;
        navidrome.scrobble(trackId, true, startedAt).catch(err => console.error('Scrobble failed:', err));
      }
    };

    const handlePause = () => {
      lastPosition = null;
    };

    audio.addEventListener('playing', handlePlaying);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('pause', handlePause);
    if (!audio.paused) handlePlaying();

    return () => {
      audio.removeEventListener('playing', handlePlaying);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('pause', handlePause);
    };
  }, [currentTrack, navidrome]);

  const handlePlaybackUpdate = useCallback((time, paused) => {
    setIsPlaying(!paused);
  }, []);

  const likeActive = userReaction === 'like' || (userReaction === null && trackStarred);


  const handleLike = useCallback(() => {
    if (!currentTrack) return;

    if (likeActive) {
      jamClient.removeReaction(currentTrack.id);
      navidrome.unstarTrack(currentTrack.id).catch(err => console.error('Unstar failed:', err));
      setUserReaction(null);
      setTrackStarred(false);
      // Remove from local favorites list
      if (favorites) setFavorites(prev => prev ? prev.filter(s => s.id !== currentTrack.id) : prev);
    } else {
      jamClient.likeTrack(currentTrack.id);
      navidrome.starTrack(currentTrack.id).catch(err => console.error('Star failed:', err));
      setUserReaction('like');
      setTrackStarred(true);
      // Refresh favorites if viewing them (new star won't have full metadata locally)
      if (browseMode === 'favorites') loadFavorites();
    }
  }, [currentTrack, userReaction, likeActive, jamClient, navidrome, favorites, browseMode]);

  const roleLabel = isHost ? 'Host' : canControl ? 'Co-host' : 'Listener';

  const joinRoomById = (roomId) => {
    setRoomInput(roomId);
    setIsJoiningRoom(true);
    setRoomError('');
    try {
      jamClient.joinRoom(roomId, username);
    } catch (e) {
      setRoomError(e.message);
      setIsJoiningRoom(false);
    }
  };

  const handleCopyRoomCode = async () => {
    try {
      await navigator.clipboard.writeText(currentRoom.id);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    } catch {
      // clipboard unavailable (e.g. insecure context) — code is visible anyway
    }
  };

  const handleCommunityChange = (e) => {
    localStorage.setItem('jam_community', e.target.value);
    jamClient.updateCommunity(e.target.value);
  };

  // Append songs to the queue; if nothing is playing, start the first one
  const handleQueueAll = (songs) => {
    const items = songs.map(s => ({ id: s.id, title: s.title, artist: s.artist, album: s.album }));
    if (!currentTrack && items.length > 0) {
      const [first, ...rest] = items;
      jamClient.updateQueue([...queue, ...rest]);
      jamClient.play(first.id, 0);
      loadTrack(first.id);
    } else {
      jamClient.updateQueue([...queue, ...items]);
    }
  };

  const moveQueueItem = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= queue.length) return;
    const newQueue = [...queue];
    [newQueue[index], newQueue[target]] = [newQueue[target], newQueue[index]];
    jamClient.updateQueue(newQueue);
  };

  const removeQueueItem = (index) => {
    jamClient.updateQueue(queue.filter((_, i) => i !== index));
  };

  const toggleRepeat = () => {
    const next = !repeatMode;
    setRepeatMode(next);
    localStorage.setItem('jam_repeat', next ? 'on' : 'off');
  };

  // Keyboard activation for clickable list rows
  const onActivate = (fn) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };

  const renderCover = (coverArt, size, className = '') => (
    coverArt ? (
      <img
        src={navidrome.getCoverArtUrl(coverArt, size)}
        alt=""
        className={`cover ${className}`}
        loading="lazy"
      />
    ) : (
      <div className={`cover cover-placeholder ${className}`}>
        <Icon name="disc" size={Math.min(40, Math.round(size / 4))} />
      </div>
    )
  );

  const renderSongActions = (song, contextSongs = null) => canControl && (
    <div className="song-actions">
      <button
        className="icon-btn"
        onClick={(e) => { e.stopPropagation(); handlePlayTrack(song, contextSongs); }}
        title="Play"
        aria-label={`Play ${song.title}`}
      >
        <Icon name="play" size={16} />
      </button>
      <button
        className="icon-btn"
        onClick={(e) => { e.stopPropagation(); handleAddToQueue(song); }}
        title="Add to queue"
        aria-label={`Add ${song.title} to queue`}
      >
        <Icon name="listPlus" size={18} />
      </button>
    </div>
  );

  const renderTrackRow = (song, { index, contextSongs = null, meta, showThumb = false } = {}) => (
    <li key={song.id} className={`track-row${currentTrack?.id === song.id ? ' is-current' : ''}`}>
      {showThumb
        ? renderCover(song.coverArt, 80, 'track-thumb')
        : <span className="track-num">{index !== undefined ? index : ''}</span>}
      <div className="row-info">
        <strong>{song.title}</strong>
        <span>{meta}</span>
      </div>
      {song.duration ? <span className="track-duration">{formatDuration(song.duration)}</span> : null}
      {renderSongActions(song, contextSongs)}
    </li>
  );

  const renderCollectionActions = (onPlay, onShuffle, onQueue) => canControl && (
    <div className="collection-actions">
      {onPlay && (
        <button className="btn btn-primary btn-sm" onClick={onPlay}>
          <Icon name="play" size={14} /> Play
        </button>
      )}
      {onShuffle && (
        <button className="btn btn-secondary btn-sm" onClick={onShuffle}>
          <Icon name="shuffle" size={14} /> Shuffle
        </button>
      )}
      {onQueue && (
        <button className="btn btn-secondary btn-sm" onClick={onQueue}>
          <Icon name="listPlus" size={14} /> Queue all
        </button>
      )}
    </div>
  );

  const renderPeople = () => (
    <>
      {communities.length > 0 && (isHost || currentRoom.community) && (
        <div className="room-setting">
          <span className="room-setting-label">Community</span>
          {isHost ? (
            <select
              className="select"
              value={currentRoom.community || ''}
              onChange={handleCommunityChange}
              aria-label="Community"
            >
              <option value="">None</option>
              {communities.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          ) : (
            <span className="chip chip-static">
              {communities.find(c => c.id === currentRoom.community)?.name || currentRoom.community}
            </span>
          )}
        </div>
      )}
      <ul className="people-list">
        {currentRoom.users?.map((user) => {
          const userIsHost = user.id === currentRoom.hostId;
          const userIsCoHost = (currentRoom.coHosts || []).includes(user.id);
          return (
            <li key={user.id} className="person">
              <span className="avatar" style={{ '--hue': avatarHue(user.username) }}>
                {(user.username || '?').charAt(0).toUpperCase()}
              </span>
              <span className="person-name">
                {user.username}
                {user.id === jamClient.userId && <span className="you-tag">you</span>}
              </span>
              {userIsHost && <span className="role-badge role-host"><Icon name="crown" size={12} /> Host</span>}
              {userIsCoHost && <span className="role-badge role-cohost">Co-host</span>}
              {isHost && !userIsHost && (
                userIsCoHost ? (
                  <button
                    className="icon-btn icon-btn-sm danger"
                    onClick={() => jamClient.demoteCoHost(user.id)}
                    title="Remove co-host"
                    aria-label={`Remove ${user.username} as co-host`}
                  >
                    <Icon name="userMinus" size={16} />
                  </button>
                ) : (
                  <button
                    className="icon-btn icon-btn-sm"
                    onClick={() => jamClient.promoteCoHost(user.id)}
                    title="Make co-host"
                    aria-label={`Make ${user.username} co-host`}
                  >
                    <Icon name="userPlus" size={16} />
                  </button>
                )
              )}
            </li>
          );
        })}
      </ul>
    </>
  );

  const renderQueue = () => (
    queue.length === 0 ? (
      <div className="empty-state small">
        <Icon name="listMusic" size={28} />
        <p>Queue is empty</p>
        <span>Add songs from the library to keep the music going.</span>
      </div>
    ) : (
      <ol className="queue-list">
        {queue.map((track, index) => (
          <li key={`${track.id}-${index}`} className="queue-item">
            <span className="queue-num">{index + 1}</span>
            <div className="row-info">
              <strong>{track.title}</strong>
              <span>{track.artist}</span>
            </div>
            {canControl && (
              <div className="queue-controls">
                <button
                  className="icon-btn icon-btn-sm"
                  onClick={() => moveQueueItem(index, -1)}
                  disabled={index === 0}
                  title="Move up"
                  aria-label="Move up"
                >
                  <Icon name="chevronUp" size={16} />
                </button>
                <button
                  className="icon-btn icon-btn-sm"
                  onClick={() => moveQueueItem(index, 1)}
                  disabled={index === queue.length - 1}
                  title="Move down"
                  aria-label="Move down"
                >
                  <Icon name="chevronDown" size={16} />
                </button>
                <button
                  className="icon-btn icon-btn-sm danger"
                  onClick={() => removeQueueItem(index)}
                  title="Remove"
                  aria-label="Remove from queue"
                >
                  <Icon name="x" size={16} />
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
    )
  );

  const authFooter = (
    <footer className="auth-footer">
      <span className="auth-footer-server">{navidrome.baseUrl}</span>
      <a href="https://github.com/Jelmerovereem/navidrome-jam" target="_blank" rel="noopener" className="footer-link">
        <Icon name="github" size={14} /> Source on GitHub
      </a>
    </footer>
  );

  // Login screen
  if (!isAuthenticated) {
    return (
      <div className="app auth-screen">
        <div className="auth-card card">
          <div className="auth-brand">
            <Logo size={56} />
            <h1>Navidrome Jam</h1>
            <p>Listen to your library together, perfectly in sync.</p>
          </div>

          {registerSuccess && <div className="alert alert-success">{registerSuccess}</div>}

          <div className="segmented" role="tablist">
            <button
              role="tab"
              aria-selected={authMode === 'login'}
              className={`segmented-btn${authMode === 'login' ? ' active' : ''}`}
              onClick={() => { setAuthMode('login'); setLoginError(''); }}
            >
              Log in
            </button>
            <button
              role="tab"
              aria-selected={authMode === 'signup'}
              className={`segmented-btn${authMode === 'signup' ? ' active' : ''}`}
              onClick={() => { setAuthMode('signup'); setLoginError(''); }}
            >
              Sign up
            </button>
          </div>

          {authMode === 'login' ? (
            <form onSubmit={handleLogin} className="form">
              <label className="field">
                <span>Username</span>
                <input
                  type="text"
                  className="input"
                  placeholder="Your Navidrome username"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  disabled={isLoggingIn}
                />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  className="input"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={isLoggingIn}
                />
              </label>
              <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={isLoggingIn}>
                {isLoggingIn ? <><span className="spinner" /> Logging in…</> : 'Log in'}
              </button>
            </form>
          ) : waitlistSuccess ? (
            <div className="waitlist-confirmed">
              <div className="alert alert-success">{waitlistSuccess}</div>
              <button
                className="btn btn-secondary btn-block"
                onClick={() => { setWaitlistSuccess(''); setShowWaitlist(false); }}
              >
                Back to sign up
              </button>
            </div>
          ) : showWaitlist ? (
            <form onSubmit={handleJoinWaitlist} className="form">
              <div className="form-intro">
                <h2>Join the waitlist</h2>
                <p>We'll email you an invite code when a spot opens up.</p>
              </div>
              <label className="field">
                <span>Name</span>
                <input
                  type="text"
                  className="input"
                  placeholder="Your name"
                  autoComplete="name"
                  value={waitlistName}
                  onChange={(e) => setWaitlistName(e.target.value)}
                  required
                  disabled={isJoiningWaitlist}
                />
              </label>
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  className="input"
                  placeholder="you@example.com"
                  autoComplete="email"
                  value={waitlistEmail}
                  onChange={(e) => setWaitlistEmail(e.target.value)}
                  required
                  disabled={isJoiningWaitlist}
                />
              </label>
              <label className="field">
                <span>Why do you want to join? <em>(optional)</em></span>
                <input
                  type="text"
                  className="input"
                  placeholder="Tell us a bit about yourself"
                  value={waitlistMessage}
                  onChange={(e) => setWaitlistMessage(e.target.value)}
                  disabled={isJoiningWaitlist}
                />
              </label>
              <div className="form-row-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowWaitlist(false)}
                  disabled={isJoiningWaitlist}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={isJoiningWaitlist}>
                  {isJoiningWaitlist ? 'Joining…' : 'Join waitlist'}
                </button>
              </div>
            </form>
          ) : (
            <>
              <form onSubmit={handleRegister} className="form">
                <label className="field">
                  <span>Username</span>
                  <input
                    type="text"
                    className="input"
                    placeholder="Choose a username"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    disabled={isRegistering}
                    minLength={3}
                    maxLength={50}
                  />
                </label>
                <label className="field">
                  <span>Password</span>
                  <input
                    type="password"
                    className="input"
                    placeholder="At least 6 characters"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    disabled={isRegistering}
                    minLength={6}
                  />
                </label>
                <label className="field">
                  <span>Invite code</span>
                  <input
                    type="text"
                    className="input"
                    placeholder="Paste your invite code"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    required
                    disabled={isRegistering}
                  />
                </label>
                <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={isRegistering}>
                  {isRegistering ? <><span className="spinner" /> Creating account…</> : 'Create account'}
                </button>
              </form>
              <div className="auth-switch">
                No invite code?{' '}
                <button
                  className="link-btn"
                  onClick={() => { setShowWaitlist(true); setLoginError(''); }}
                >
                  Join the waitlist
                </button>
              </div>
            </>
          )}

          {loginError && <div className="alert alert-error">{loginError}</div>}
        </div>

        {authFooter}
      </div>
    );
  }

  // Room selection screen
  if (!currentRoom) {
    return (
      <div className="app auth-screen room-screen">
        <div className="room-layout">
          <div className="card room-card">
            <div className="room-card-top">
              <div className="brand">
                <Logo size={32} />
                <span className="brand-name">Navidrome Jam</span>
              </div>
              <button onClick={handleLogout} className="btn btn-ghost btn-sm" title="Log out">
                <Icon name="logOut" size={16} /> Log out
              </button>
            </div>

            <div className="room-greeting">
              <h1>Welcome, {username}</h1>
              <p>Start a new jam or hop into a friend's room.</p>
            </div>

            <button
              className="btn btn-primary btn-lg btn-block"
              onClick={handleCreateRoom}
              disabled={!isConnected || isCreatingRoom || isJoiningRoom}
            >
              <Icon name="plus" size={18} />
              {isCreatingRoom ? 'Creating…' : 'Start a new room'}
            </button>

            <div className="divider-text"><span>or join with a code</span></div>

            <form
              className="join-form"
              onSubmit={(e) => { e.preventDefault(); handleJoinRoom(); }}
            >
              <input
                type="text"
                className="input code-input"
                placeholder="ROOM CODE"
                aria-label="Room code"
                value={roomInput}
                onChange={(e) => setRoomInput(e.target.value.toUpperCase())}
                maxLength={8}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                disabled={isJoiningRoom || isCreatingRoom}
              />
              <button
                type="submit"
                className="btn btn-secondary btn-lg"
                disabled={!isConnected || isJoiningRoom || isCreatingRoom}
              >
                {isJoiningRoom ? 'Joining…' : 'Join'}
              </button>
            </form>

            {roomError && <div className="alert alert-error">{roomError}</div>}
            {!isConnected && (
              <div className="alert alert-warning"><span className="spinner" /> Connecting to Jam server…</div>
            )}
          </div>

          {activeRooms.length > 0 && (
            <section className="card active-rooms">
              <h2>
                <span className="live-dot" /> Live now
                <span className="count-pill">{activeRooms.length}</span>
              </h2>
              <ul className="active-rooms-list">
                {activeRooms.map(room => (
                  <li key={room.id} className="active-room">
                    <div className="active-room-info">
                      <div className="active-room-head">
                        <span className="active-room-code">{room.id}</span>
                        <span className="active-room-meta">
                          {room.hostName} &middot; {room.userCount} {room.userCount === 1 ? 'listener' : 'listeners'}
                        </span>
                      </div>
                      {room.currentTrack && (
                        <span className="active-room-track">
                          {room.currentTrack.playing
                            ? <span className="eq" aria-label="Playing"><span /><span /><span /></span>
                            : <Icon name="pause" size={12} />}
                          <span className="truncate">
                            {room.currentTrack.title}{room.currentTrack.artist ? ` – ${room.currentTrack.artist}` : ''}
                          </span>
                        </span>
                      )}
                    </div>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => joinRoomById(room.id)}
                      disabled={!isConnected || isJoiningRoom || isCreatingRoom}
                    >
                      Join
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {authFooter}
      </div>
    );
  }

  const musicTabs = [
    { id: 'browse', label: 'Library', icon: 'library' },
    { id: 'search', label: 'Search', icon: 'search' },
    { id: 'upload', label: 'Upload', icon: 'upload', className: 'desktop-only' },
    { id: 'queue', label: 'Queue', icon: 'listMusic', count: queue.length, className: 'mobile-only' },
    { id: 'people', label: 'People', icon: 'users', count: currentRoom.users?.length || 0, className: 'mobile-only' },
  ];

  const rootLabel = BROWSE_MODES.find(m => m.id === browseMode)?.label || 'Library';
  const isDrilledIn = browseView === 'albums' || browseView === 'songs' || browseView === 'playlistSongs';
  const albumArtist = selectedArtist?.name || selectedAlbum?.artist;

  // Main jam session screen
  return (
    <div className="app jam-screen">
      <header className="app-header">
        <div className="brand">
          <Logo size={32} />
          <span className="brand-name">Navidrome Jam</span>
        </div>

        <div className="header-center">
          <button className="room-code" onClick={handleCopyRoomCode} title="Copy room code">
            <span className="room-code-label">Room</span>
            <span className="room-code-value">{currentRoom.id}</span>
            <Icon name={codeCopied ? 'check' : 'copy'} size={14} />
          </button>
          <span className={`role-pill role-${isHost ? 'host' : canControl ? 'cohost' : 'listener'}`}>
            {roleLabel}
          </span>
        </div>

        <div className="header-actions">
          <span
            className={`conn-dot${isConnected ? ' online' : ''}`}
            title={isConnected ? 'Connected' : 'Disconnected'}
            aria-label={isConnected ? 'Connected' : 'Disconnected'}
          />
          <span className="header-user">
            <span className="avatar avatar-sm" style={{ '--hue': avatarHue(username) }}>
              {(username || '?').charAt(0).toUpperCase()}
            </span>
            <span className="header-username">{username}</span>
          </span>
          <button onClick={handleLeaveRoom} className="btn btn-ghost btn-sm" title="Leave room">
            <Icon name="logOut" size={16} />
            <span className="hide-sm">Leave</span>
          </button>
        </div>
      </header>

      <div className="main-content">
        {/* Left sidebar: People */}
        <aside className="side-panel people-panel">
          <div className="panel-header">
            <Icon name="users" size={16} />
            <h3>Listening</h3>
            <span className="count-pill">{currentRoom.users?.length || 0}</span>
          </div>
          <div className="panel-body">
            {renderPeople()}
          </div>
        </aside>

        {/* Center: Player and Library */}
        <main className="center-panel">
          <section
            className={`now-playing-card${currentTrack?.coverArt ? ' has-cover' : ''}`}
            style={currentTrack?.coverArt ? { '--cover-url': `url("${currentTrack.coverArt}")` } : undefined}
          >
            {currentTrack ? (
              <>
                <div className="now-playing">
                  {currentTrack.coverArt ? (
                    <img src={currentTrack.coverArt} alt="Album art" className="cover-art" />
                  ) : (
                    <div className="cover-art cover-placeholder"><Icon name="music" size={40} /></div>
                  )}
                  <div className="track-info">
                    <div className="track-eyebrow">
                      {isPlaying
                        ? <><span className="eq"><span /><span /><span /></span> Now playing</>
                        : 'Paused'}
                    </div>
                    <h2 title={currentTrack.title}>{currentTrack.title}</h2>
                    <p className="track-artist">{currentTrack.artist}</p>
                    <p className="track-album">{currentTrack.album}</p>
                  </div>
                  <button
                    className={`icon-btn like-btn${likeActive ? ' active' : ''}`}
                    onClick={handleLike}
                    title={likeActive ? 'Remove like' : 'Like this track'}
                    aria-pressed={likeActive}
                    aria-label={likeActive ? 'Remove like' : 'Like this track'}
                  >
                    <Icon name="heart" size={22} filled={likeActive} />
                  </button>
                </div>

                <SyncedAudioPlayer
                  streamUrl={currentTrack.streamUrl}
                  jamClient={jamClient}
                  isHost={canControl}
                  isConnected={isConnected}
                  onPlaybackUpdate={handlePlaybackUpdate}
                  onEnded={handleTrackEnded}
                  audioRef={audioRef}
                  pendingSyncRef={pendingSyncRef}
                />

                {canControl ? (
                  <div className="transport-controls">
                    <button
                      className="transport-btn"
                      onClick={handleShuffleQueue}
                      disabled={queue.length < 2}
                      title="Shuffle queue"
                      aria-label="Shuffle queue"
                    >
                      <Icon name="shuffle" size={20} />
                    </button>
                    <button
                      className="transport-btn"
                      onClick={handlePrevTrack}
                      title={playHistory.length > 0 ? 'Previous track' : 'Restart track'}
                      aria-label={playHistory.length > 0 ? 'Previous track' : 'Restart track'}
                    >
                      <Icon name="skipBack" size={22} />
                    </button>
                    <button
                      className="transport-btn transport-play-btn"
                      onClick={handlePlayPause}
                      aria-label={isPlaying ? 'Pause' : 'Play'}
                      title={isPlaying ? 'Pause' : 'Play'}
                    >
                      <Icon name={isPlaying ? 'pause' : 'play'} size={26} />
                    </button>
                    <button
                      className="transport-btn"
                      onClick={handleNextTrack}
                      disabled={queue.length === 0}
                      title="Next track"
                      aria-label="Next track"
                    >
                      <Icon name="skipForward" size={22} />
                    </button>
                    <button
                      className={`transport-btn${repeatMode ? ' active' : ''}`}
                      onClick={toggleRepeat}
                      title={repeatMode ? 'Repeat: on' : 'Repeat: off'}
                      aria-label="Repeat"
                      aria-pressed={repeatMode}
                    >
                      <Icon name="repeat" size={20} />
                    </button>
                  </div>
                ) : (
                  <p className="listener-note">The host is in control of playback — sit back and enjoy.</p>
                )}
              </>
            ) : isLoadingTrack ? (
              <div className="empty-state">
                <span className="spinner spinner-lg" />
                <p>Loading track…</p>
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon"><Icon name="music" size={32} /></div>
                <p>Nothing playing yet</p>
                <span>
                  {canControl
                    ? 'Pick a song from the library below to get the jam started.'
                    : 'Waiting for the host to start the music.'}
                </span>
              </div>
            )}
          </section>

          <section className="library-card">
            <nav className="tabs" role="tablist">
              {musicTabs.map(tab => (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={musicTab === tab.id}
                  className={`tab${musicTab === tab.id ? ' active' : ''}${tab.className ? ` ${tab.className}` : ''}`}
                  onClick={() => setMusicTab(tab.id)}
                >
                  <Icon name={tab.icon} size={16} />
                  <span>{tab.label}</span>
                  {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
                </button>
              ))}
            </nav>

            <div className="tab-content">
              {musicTab === 'queue' ? (
                <div className="mobile-panel">
                  {renderQueue()}
                </div>
              ) : musicTab === 'people' ? (
                <div className="mobile-panel">
                  {renderPeople()}
                </div>
              ) : musicTab === 'upload' ? (
                <div className="upload-panel">
                  <div
                    className={`dropzone${isDragOver ? ' dragover' : ''}`}
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                  >
                    <div className="dropzone-icon"><Icon name="upload" size={28} /></div>
                    <p className="dropzone-title">Drag &amp; drop audio files here</p>
                    <p className="dropzone-sub">or</p>
                    <label className="btn btn-secondary">
                      Browse files
                      <input
                        type="file"
                        accept=".mp3,.flac,.ogg,.opus,.m4a,.wav,.aac"
                        onChange={handleFileSelect}
                        style={{ display: 'none' }}
                        multiple
                      />
                    </label>
                    <p className="dropzone-formats">
                      MP3, FLAC, OGG, OPUS, M4A, WAV, AAC · up to 200 MB each
                    </p>
                  </div>

                  {uploadQueue.length > 0 && (
                    <div className="upload-section">
                      <div className="section-header">
                        <h4>
                          {(() => {
                            const done = uploadQueue.filter(i => i.status === 'done').length;
                            const total = uploadQueue.length;
                            const hasActive = uploadQueue.some(i => i.status === 'uploading' || i.status === 'pending');
                            return hasActive ? `Uploading ${done}/${total}…` : `${done}/${total} uploaded`;
                          })()}
                        </h4>
                        {!uploadQueue.some(i => i.status === 'pending' || i.status === 'uploading') && (
                          <button className="btn btn-ghost btn-sm" onClick={clearFinishedUploads}>Clear</button>
                        )}
                      </div>
                      <ul className="upload-queue-list">
                        {uploadQueue.map(item => (
                          <li key={item.id} className={`upload-queue-item upload-queue-${item.status}`}>
                            <span className="upload-queue-name" title={item.file.name}>{item.file.name}</span>
                            {item.status === 'uploading' && (
                              <div className="progress">
                                <div className="progress-fill" style={{ width: `${item.progress}%` }} />
                              </div>
                            )}
                            {item.status === 'done' && <span className="upload-queue-status"><Icon name="check" size={14} /> Done</span>}
                            {item.status === 'pending' && <span className="upload-queue-status">Queued</span>}
                            {item.status === 'error' && <span className="upload-queue-status">{item.error}</span>}
                          </li>
                        ))}
                      </ul>
                      {uploadQueue.every(i => i.status === 'done') && (
                        <div className="alert alert-success">
                          Navidrome will index new files within ~1 minute. Then they will appear in search.
                        </div>
                      )}
                    </div>
                  )}

                  <div className="upload-section">
                    <div className="section-header">
                      <h4>My uploads</h4>
                      <span className="upload-quota">
                        Permanent {uploadPermanentCount}/{uploadPermanentQuota}
                      </span>
                      <button
                        className="icon-btn icon-btn-sm"
                        onClick={fetchMyUploads}
                        disabled={isLoadingUploads}
                        title="Refresh"
                        aria-label="Refresh uploads"
                      >
                        <Icon name="refresh" size={16} />
                      </button>
                    </div>

                    {isLoadingUploads ? (
                      <div className="loading-state"><span className="spinner" /> Loading uploads…</div>
                    ) : myUploads.length === 0 ? (
                      <div className="empty-state small"><p>No uploads yet</p></div>
                    ) : (
                      <ul className="my-uploads-list">
                        {myUploads.map((upload) => (
                          <li key={upload.filename} className="upload-item">
                            <div className="row-info">
                              <strong>{upload.filename}</strong>
                              <span>{new Date(upload.uploadedAt).toLocaleDateString()}</span>
                            </div>
                            <label
                              className="switch"
                              title={upload.permanent ? 'Marked permanent' : 'Will expire after 30 days'}
                            >
                              <input
                                type="checkbox"
                                checked={upload.permanent}
                                onChange={() => handleTogglePermanent(upload.filename)}
                              />
                              <span className="switch-track" />
                              <span className="switch-label">Keep</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ) : musicTab === 'search' ? (
                <div className="search-panel">
                  <form onSubmit={handleSearch} className="search-form">
                    <div className="search-input-wrap">
                      <Icon name="search" size={18} />
                      <input
                        type="search"
                        className="input search-input"
                        placeholder="Songs, albums, artists…"
                        aria-label="Search"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        disabled={isSearching}
                      />
                    </div>
                    <button type="submit" className="btn btn-primary" disabled={isSearching}>
                      {isSearching ? <span className="spinner" /> : 'Search'}
                    </button>
                  </form>

                  {searchResults && (
                    searchResults.searchResult3?.song?.length > 0 ? (
                      <div className="results-section">
                        <h4 className="section-title">Songs</h4>
                        <ul className="track-list">
                          {searchResults.searchResult3.song.map((song) => renderTrackRow(song, {
                            showThumb: true,
                            meta: `${song.artist}${song.album ? ` · ${song.album}` : ''}`,
                          }))}
                        </ul>
                      </div>
                    ) : (
                      <div className="empty-state small"><p>No songs found</p></div>
                    )
                  )}
                </div>
              ) : (
                <div className="browse-panel">
                  <div className="chip-row">
                    {BROWSE_MODES.map(mode => (
                      <button
                        key={mode.id}
                        className={`chip${browseMode === mode.id ? ' active' : ''}`}
                        onClick={() => handleBrowseModeChange(mode.id)}
                      >
                        {mode.id === 'favorites' && <Icon name="heart" size={14} filled={browseMode === 'favorites'} />}
                        {mode.label}
                      </button>
                    ))}
                  </div>

                  {isDrilledIn && (
                    <div className="breadcrumb">
                      <button className="icon-btn icon-btn-sm" onClick={handleBrowseBack} title="Back" aria-label="Back">
                        <Icon name="chevronLeft" size={18} />
                      </button>
                      <button className="crumb" onClick={() => handleBrowseModeChange(browseMode)}>
                        {rootLabel}
                      </button>
                      {selectedPlaylist && (
                        <>
                          <Icon name="chevronRight" size={14} className="crumb-sep" />
                          <span className="crumb current">{selectedPlaylist.name}</span>
                        </>
                      )}
                      {selectedArtist && (
                        <>
                          <Icon name="chevronRight" size={14} className="crumb-sep" />
                          {browseView === 'albums' ? (
                            <span className="crumb current">{selectedArtist.name}</span>
                          ) : (
                            <button className="crumb" onClick={() => { setBrowseView('albums'); setSelectedAlbum(null); }}>
                              {selectedArtist.name}
                            </button>
                          )}
                        </>
                      )}
                      {selectedAlbum && (
                        <>
                          <Icon name="chevronRight" size={14} className="crumb-sep" />
                          <span className="crumb current">{selectedAlbum.name}</span>
                        </>
                      )}
                    </div>
                  )}

                  {isLoadingBrowse && (
                    <div className="loading-state"><span className="spinner" /> Loading…</div>
                  )}

                  {/* Artists list */}
                  {!isLoadingBrowse && browseView === 'artists' && (
                    artists && artists.length > 0 ? (
                      <ul className="list">
                        {artists.map((artist) => (
                          <li
                            key={artist.id}
                            className="list-row clickable"
                            onClick={() => handleBrowseArtist(artist)}
                            onKeyDown={onActivate(() => handleBrowseArtist(artist))}
                            tabIndex={0}
                            role="button"
                          >
                            <span className="avatar avatar-lg" style={{ '--hue': avatarHue(artist.name) }}>
                              {(artist.name || '?').charAt(0).toUpperCase()}
                            </span>
                            <div className="row-info">
                              <strong>{artist.name}</strong>
                              <span>{artist.albumCount} album{artist.albumCount !== 1 ? 's' : ''}</span>
                            </div>
                            <Icon name="chevronRight" size={18} className="row-chevron" />
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="empty-state small"><p>No artists found</p></div>
                    )
                  )}

                  {/* Album grid (Albums A-Z, Recent, Played, or artist drill-down) */}
                  {!isLoadingBrowse && (browseView === 'albumList' || (browseView === 'albums' && selectedArtist)) && (() => {
                    const albums = browseView === 'albums' ? selectedArtist.albums : albumList;
                    return albums && albums.length > 0 ? (
                      <div className="album-grid">
                        {albums.map((album) => (
                          <button
                            key={album.id}
                            className="album-card"
                            onClick={() => handleBrowseAlbum(album)}
                          >
                            {renderCover(album.coverArt, 300, 'album-card-cover')}
                            <strong title={album.name}>{album.name}</strong>
                            <span>
                              {browseView === 'albums'
                                ? `${album.year ? `${album.year} · ` : ''}${album.songCount} track${album.songCount !== 1 ? 's' : ''}`
                                : `${album.artist}${album.year ? ` · ${album.year}` : ''}`}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-state small"><p>No albums found</p></div>
                    );
                  })()}

                  {/* Songs list */}
                  {!isLoadingBrowse && browseView === 'songs' && selectedAlbum && (
                    <>
                      <div className="collection-header">
                        {renderCover(selectedAlbum.coverArt, 300, 'collection-cover')}
                        <div className="collection-meta">
                          <span className="collection-kind">Album</span>
                          <h3>{selectedAlbum.name}</h3>
                          <span>
                            {[albumArtist, selectedAlbum.year, `${selectedAlbum.songs.length} track${selectedAlbum.songs.length !== 1 ? 's' : ''}`]
                              .filter(Boolean).join(' · ')}
                          </span>
                          {selectedAlbum.songs.length > 0 && renderCollectionActions(
                            () => handlePlayPlaylist(selectedAlbum),
                            () => handlePlayPlaylist(selectedAlbum, true),
                            () => handleQueueAll(selectedAlbum.songs),
                          )}
                        </div>
                      </div>

                      {selectedAlbum.songs.length > 0 ? (
                        <ul className="track-list">
                          {selectedAlbum.songs.map((song, index) => renderTrackRow(song, {
                            index: song.track || index + 1,
                            contextSongs: selectedAlbum.songs,
                            meta: song.artist && song.artist !== albumArtist ? song.artist : null,
                          }))}
                        </ul>
                      ) : (
                        <div className="empty-state small"><p>No tracks found</p></div>
                      )}
                    </>
                  )}

                  {/* Playlists list */}
                  {!isLoadingBrowse && browseView === 'playlists' && (
                    playlists && playlists.length > 0 ? (
                      <ul className="list">
                        {playlists.map((playlist) => (
                          <li
                            key={playlist.id}
                            className="list-row clickable"
                            onClick={() => handleBrowsePlaylist(playlist)}
                            onKeyDown={onActivate(() => handleBrowsePlaylist(playlist))}
                            tabIndex={0}
                            role="button"
                          >
                            <span className="tile-icon"><Icon name="listMusic" size={20} /></span>
                            <div className="row-info">
                              <strong>{playlist.name}</strong>
                              <span>{playlist.songCount} track{playlist.songCount !== 1 ? 's' : ''}</span>
                            </div>
                            {canControl && playlist.songCount > 0 && (
                              <div className="song-actions">
                                <button
                                  className="icon-btn"
                                  onClick={(e) => { e.stopPropagation(); handlePlayPlaylist(playlist); }}
                                  title="Play"
                                  aria-label={`Play ${playlist.name}`}
                                >
                                  <Icon name="play" size={16} />
                                </button>
                                <button
                                  className="icon-btn"
                                  onClick={(e) => { e.stopPropagation(); handlePlayPlaylist(playlist, true); }}
                                  title="Shuffle"
                                  aria-label={`Shuffle ${playlist.name}`}
                                >
                                  <Icon name="shuffle" size={16} />
                                </button>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="empty-state small"><p>No playlists found</p></div>
                    )
                  )}

                  {/* Playlist songs */}
                  {!isLoadingBrowse && browseView === 'playlistSongs' && selectedPlaylist && (
                    <>
                      <div className="collection-header">
                        <div className="collection-cover tile-icon tile-icon-lg"><Icon name="listMusic" size={40} /></div>
                        <div className="collection-meta">
                          <span className="collection-kind">Playlist</span>
                          <h3>{selectedPlaylist.name}</h3>
                          <span>{selectedPlaylist.songs.length} track{selectedPlaylist.songs.length !== 1 ? 's' : ''}</span>
                          {selectedPlaylist.songs.length > 0 && renderCollectionActions(
                            () => handlePlayPlaylist(selectedPlaylist),
                            () => handlePlayPlaylist(selectedPlaylist, true),
                            () => handleQueueAll(selectedPlaylist.songs),
                          )}
                        </div>
                      </div>
                      {selectedPlaylist.songs.length > 0 ? (
                        <ul className="track-list">
                          {selectedPlaylist.songs.map((song, index) => renderTrackRow(song, {
                            index: index + 1,
                            contextSongs: selectedPlaylist.songs,
                            meta: `${song.artist} · ${song.album}`,
                          }))}
                        </ul>
                      ) : (
                        <div className="empty-state small"><p>Playlist is empty</p></div>
                      )}
                    </>
                  )}

                  {/* Favorites list */}
                  {!isLoadingBrowse && browseView === 'favorites' && (
                    favorites && favorites.length > 0 ? (
                      <>
                        <div className="section-header">
                          <h4>{favorites.length} liked track{favorites.length !== 1 ? 's' : ''}</h4>
                          {renderCollectionActions(null, null, () => handleQueueAll(favorites))}
                        </div>
                        <ul className="track-list">
                          {favorites.map((song) => renderTrackRow(song, {
                            showThumb: true,
                            meta: `${song.artist} · ${song.album}`,
                          }))}
                        </ul>
                      </>
                    ) : (
                      <div className="empty-state">
                        <div className="empty-icon"><Icon name="heart" size={28} /></div>
                        <p>No liked tracks yet</p>
                        <span>Tap the heart during playback to save a track here.</span>
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          </section>
        </main>

        {/* Right sidebar: Queue */}
        <aside className="side-panel queue-panel">
          <div className="panel-header">
            <Icon name="listMusic" size={16} />
            <h3>Up next</h3>
            <span className="count-pill">{queue.length}</span>
          </div>
          <div className="panel-body">
            {renderQueue()}
          </div>
        </aside>
      </div>
    </div>
  );
}

const BROWSE_MODES = [
  { id: 'favorites', label: 'Liked' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'artists', label: 'Artists' },
  { id: 'albums', label: 'Albums' },
  { id: 'recent', label: 'Recently added' },
  { id: 'played', label: 'Recently played' },
];

// Stable hue per name for avatar colors
function avatarHue(name = '') {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) % 360;
  }
  return hash;
}

// Fisher-Yates shuffle, returns a new array
function shuffleArray(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default App;
