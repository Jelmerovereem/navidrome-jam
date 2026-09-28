import { io } from 'socket.io-client';

class JamClient {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.socket = null;
    this.currentRoomId = null;
    this.userId = this.getUserId();
    this.listeners = {};
    // Room to rejoin automatically after a reconnect (e.g. phone was locked)
    this.rejoin = null; // { roomId, username }
    this.joinUsername = null;
    // Timestamp of the last playback state we saw from the server, to tell on
    // rejoin whether anyone changed playback while we were away
    this.lastSyncTimestamp = null;
    this.staleSyncTimestamp = null;
    // Set by the app: () => ({ trackId, position, playing, queue }) | null
    this.getLocalPlayback = null;
    this.isRejoining = false;
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
  }

  /**
   * Get or create user ID
   */
  getUserId() {
    let userId = localStorage.getItem('jam_user_id');
    if (!userId) {
      userId = 'user-' + Math.random().toString(36).substring(2, 18);
      localStorage.setItem('jam_user_id', userId);
    }
    return userId;
  }

  /**
   * Connect to sync server.
   * Resolves on the first successful connection. Socket.io keeps reconnecting
   * after that (and after a failed first attempt); every connect emits
   * 'connected' and every drop emits 'disconnected'.
   */
  connect() {
    if (this.socket) {
      return this.socket.connected ? Promise.resolve() : new Promise((resolve) => {
        this.socket.once('connect', () => resolve());
      });
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      this.socket = io(this.serverUrl);
      // Register server event handlers once — not per (re)connect, which would stack duplicates
      this.setupEventListeners();

      this.socket.on('connect', () => {
        console.log('Connected to Jam server');
        this.emit('connected');
        this.rejoinRoom();
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      this.socket.on('connect_error', (error) => {
        console.error('Connection error:', error.message);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      this.socket.on('disconnect', (reason) => {
        console.log('Disconnected from Jam server:', reason);
        this.isRejoining = false;
        this.emit('disconnected', reason);
        // Server-initiated disconnects are not retried automatically by socket.io
        if (reason === 'io server disconnect') {
          this.socket.connect();
        }
      });

      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    });
  }

  /**
   * When the app comes back to the foreground (e.g. phone unlocked), retry
   * immediately instead of waiting out socket.io's reconnection backoff.
   */
  handleVisibilityChange() {
    if (document.visibilityState === 'visible' && this.socket && !this.socket.connected) {
      console.log('App visible again, reconnecting');
      this.socket.connect();
    }
  }

  /**
   * Re-join the room we were in before the connection dropped
   */
  rejoinRoom() {
    if (!this.rejoin) return;
    console.log(`Rejoining room ${this.rejoin.roomId}`);
    this.isRejoining = true;
    this.socket.emit('join-room', {
      roomId: this.rejoin.roomId,
      userId: this.userId,
      username: this.rejoin.username
    });
  }

  /**
   * After rejoining, decide whose playback state wins. If nobody changed
   * playback on the server while we were away, the server's state is stale and
   * our local playback (which kept going offline, possibly onto later tracks)
   * is newer:
   * - controllers push it to the room
   * - listeners keep playing and wait for the host, instead of snapping back
   * Otherwise (someone else changed playback meanwhile) the server wins.
   * @returns {boolean} whether local state was kept
   */
  reconcileAfterRejoin(room) {
    const local = this.getLocalPlayback?.();
    const serverUnchanged = (room.playbackState?.timestamp ?? null) === this.lastSyncTimestamp;
    if (!local?.trackId || !serverUnchanged) return false;

    const canControl = room.hostId === this.userId || (room.coHosts || []).includes(this.userId);
    if (!canControl && !local.playing) return false;

    // The server re-sends its (stale) state right after room-state; skip it
    this.staleSyncTimestamp = room.playbackState?.timestamp ?? null;

    if (canControl) {
      console.log(`Rejoin: pushing local playback (${local.trackId} @ ${local.position.toFixed(1)}s)`);
      this.sendRoomCommand('update-queue', { queue: local.queue });
      this.sendRoomCommand('play', { trackId: local.trackId, position: local.position });
      if (!local.playing) {
        this.sendRoomCommand('pause', { position: local.position });
      }
    } else {
      console.log(`Rejoin: server state is stale, keeping local playback (${local.trackId})`);
    }
    return true;
  }

  /**
   * Disconnect from server
   */
  disconnect() {
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.rejoin = null;
    this.isRejoining = false;
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.currentRoomId = null;
    }
  }

  /**
   * Setup event listeners for server events
   */
  setupEventListeners() {
    this.socket.on('room-state', ({ room }) => {
      console.log('Received room state:', room);
      const wasRejoining = this.isRejoining;
      this.currentRoomId = room.id;
      this.isRejoining = false;
      // Only remember rooms the server confirmed we joined
      this.rejoin = { roomId: room.id, username: this.joinUsername ?? this.rejoin?.username };

      const reconciled = wasRejoining && this.reconcileAfterRejoin(room);
      this.lastSyncTimestamp = room.playbackState?.timestamp ?? null;
      this.emit('room-state', room, { rejoined: wasRejoining, reconciled });
    });

    this.socket.on('sync', (state) => {
      if (this.staleSyncTimestamp !== null) {
        const stale = state.timestamp === this.staleSyncTimestamp;
        this.staleSyncTimestamp = null;
        if (stale) {
          console.log('Ignoring stale sync after rejoin (local playback is newer)');
          return;
        }
      }
      console.log('Sync command received:', state);
      this.lastSyncTimestamp = state.timestamp;
      this.emit('sync', state);
    });

    this.socket.on('user-joined', ({ user, room }) => {
      console.log('User joined:', user.username);
      this.emit('user-joined', { user, room });
    });

    this.socket.on('user-left', ({ userId, room, newHost }) => {
      console.log('User left:', userId);
      this.emit('user-left', { userId, room, newHost });
    });

    // Room changed without a join/leave (e.g. someone's connection dropped)
    this.socket.on('room-updated', ({ room }) => {
      this.emit('room-updated', room);
    });

    this.socket.on('queue-updated', ({ queue }) => {
      console.log('Queue updated:', queue.length, 'tracks');
      this.emit('queue-updated', queue);
    });

    this.socket.on('cohost-updated', ({ room }) => {
      console.log('Co-host updated:', room.coHosts);
      this.emit('cohost-updated', room);
    });

    this.socket.on('track-reactions', (data) => {
      console.log('Track reactions:', data);
      this.emit('track-reactions', data);
    });

    this.socket.on('error', ({ message }) => {
      console.error('Server error:', message);
      if (this.isRejoining && message === 'Room not found') {
        // Room is gone (grace period expired or server restarted without it)
        this.isRejoining = false;
        this.rejoin = null;
        this.currentRoomId = null;
        this.emit('room-lost', message);
        return;
      }
      this.emit('error', message);
    });
  }

  /**
   * List active rooms
   */
  async listRooms() {
    const response = await fetch(`${this.serverUrl}/api/rooms`);
    if (!response.ok) {
      throw new Error('Failed to fetch rooms');
    }
    const data = await response.json();
    return data.rooms;
  }

  /**
   * Create a new room
   */
  async createRoom(roomId = null, hostName = null, community = null) {
    const response = await fetch(`${this.serverUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, hostName, community })
    });

    if (!response.ok) {
      throw new Error('Failed to create room');
    }

    const data = await response.json();
    return data.room;
  }

  /**
   * Register a new Navidrome user via invite code
   */
  async register(username, password, inviteCode) {
    const response = await fetch(`${this.serverUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, inviteCode })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Registration failed');
    }

    return data;
  }

  /**
   * Join a room
   */
  joinRoom(roomId, username) {
    if (!this.socket || !this.socket.connected) {
      throw new Error('Not connected to server');
    }

    this.joinUsername = username;
    this.socket.emit('join-room', {
      roomId,
      userId: this.userId,
      username
    });
  }

  /**
   * Leave current room (without disconnecting)
   */
  leaveRoom() {
    this.rejoin = null;
    this.isRejoining = false;
    this.currentRoomId = null;
    if (this.socket?.connected) {
      this.socket.emit('leave-room');
    }
  }

  /**
   * Send a command for the current room. While disconnected, commands are
   * dropped rather than buffered: socket.io would replay them on reconnect
   * before we've rejoined the room (the server rejects them), and the latest
   * state is pushed on rejoin anyway (see reconcile in 'room-state').
   * @returns {boolean} whether the command was sent
   */
  sendRoomCommand(event, payload) {
    if (!this.socket?.connected) return false;
    this.socket.emit(event, { roomId: this.currentRoomId, ...payload });
    return true;
  }

  /**
   * Play a track (host only)
   */
  play(trackId, position = 0) {
    if (!this.currentRoomId) {
      throw new Error('Not in a room');
    }

    this.sendRoomCommand('play', {
      trackId,
      position
    });
  }

  /**
   * Pause playback (host only)
   */
  pause(position) {
    if (!this.currentRoomId) {
      throw new Error('Not in a room');
    }

    this.sendRoomCommand('pause', {
      position
    });
  }

  /**
   * Seek to position (host only)
   */
  seek(position) {
    if (!this.currentRoomId) {
      throw new Error('Not in a room');
    }

    this.sendRoomCommand('seek', {
      position
    });
  }

  /**
   * Update queue (host only)
   */
  updateQueue(queue) {
    if (!this.currentRoomId) {
      throw new Error('Not in a room');
    }

    this.sendRoomCommand('update-queue', {
      queue
    });
  }

  /**
   * Promote user to co-host (host only)
   */
  promoteCoHost(userId) {
    if (!this.currentRoomId) {
      throw new Error('Not in a room');
    }

    this.sendRoomCommand('promote-cohost', {
      userId
    });
  }

  /**
   * Demote co-host (host only)
   */
  demoteCoHost(userId) {
    if (!this.currentRoomId) {
      throw new Error('Not in a room');
    }

    this.sendRoomCommand('demote-cohost', {
      userId
    });
  }

  /**
   * Send heartbeat
   */
  sendHeartbeat(position) {
    if (!this.currentRoomId || !this.socket) {
      return;
    }

    this.sendRoomCommand('heartbeat', {
      position
    });
  }

  /**
   * Like the currently playing track
   */
  likeTrack(trackId) {
    if (!this.currentRoomId) {
      throw new Error('Not in a room');
    }
    this.sendRoomCommand('like-track', {
      trackId
    });
  }

  /**
   * Dislike the currently playing track
   */
  dislikeTrack(trackId) {
    if (!this.currentRoomId) {
      throw new Error('Not in a room');
    }
    this.sendRoomCommand('dislike-track', {
      trackId
    });
  }

  /**
   * Remove reaction from the currently playing track
   */
  removeReaction(trackId) {
    if (!this.currentRoomId) {
      throw new Error('Not in a room');
    }
    this.sendRoomCommand('remove-reaction', {
      trackId
    });
  }

  /**
   * Update room community (host only)
   */
  updateCommunity(community) {
    if (!this.currentRoomId) return;
    this.sendRoomCommand('update-community', {
      community: community || null
    });
  }

  /**
   * Subscribe to events
   */
  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  /**
   * Unsubscribe from events
   */
  off(event, callback) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
  }

  /**
   * Emit event to listeners
   */
  emit(event, ...args) {
    if (!this.listeners[event]) return;
    this.listeners[event].forEach(callback => callback(...args));
  }

  /**
   * Upload a track via multipart POST. Uses XMLHttpRequest for progress tracking.
   * @param {File} file - The audio file to upload
   * @param {{ username: string, token: string, salt: string }} auth - Subsonic auth params
   * @param {(progress: number) => void} onProgress - Progress callback (0-100)
   * @returns {Promise<object>} Upload result
   */
  uploadTrack(file, auth, onProgress) {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('file', file);

      const url = `${this.serverUrl}/api/upload?u=${encodeURIComponent(auth.username)}&t=${encodeURIComponent(auth.token)}&s=${encodeURIComponent(auth.salt)}`;

      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });

      xhr.addEventListener('load', () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(data);
          } else {
            reject(new Error(data.error || `Upload failed (${xhr.status})`));
          }
        } catch {
          reject(new Error(`Upload failed (${xhr.status})`));
        }
      });

      xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
      xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

      xhr.send(formData);
    });
  }

  /**
   * Get the current user's uploads.
   * @param {{ username: string, token: string, salt: string }} auth - Subsonic auth params
   * @returns {Promise<object>} { uploads: [], permanentCount: number, permanentQuota: number }
   */
  async getMyUploads(auth) {
    const url = `${this.serverUrl}/api/uploads/mine?u=${encodeURIComponent(auth.username)}&t=${encodeURIComponent(auth.token)}&s=${encodeURIComponent(auth.salt)}`;
    const response = await fetch(url);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to fetch uploads');
    }
    return response.json();
  }

  /**
   * Toggle the permanent flag for a user's upload.
   * @param {string} filename - The filename to toggle
   * @param {{ username: string, token: string, salt: string }} auth - Subsonic auth params
   * @returns {Promise<object>} { permanent: boolean }
   */
  async togglePermanent(filename, auth) {
    const url = `${this.serverUrl}/api/uploads/${encodeURIComponent(filename)}/permanent?u=${encodeURIComponent(auth.username)}&t=${encodeURIComponent(auth.token)}&s=${encodeURIComponent(auth.salt)}`;
    const response = await fetch(url, { method: 'POST' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to toggle permanent');
    }
    return response.json();
  }

  /**
   * Join the waitlist (no auth required)
   */
  async joinWaitlist(name, email, message) {
    const response = await fetch(`${this.serverUrl}/api/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, message })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to join waitlist');
    }

    return data;
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this.socket && this.socket.connected;
  }

  /**
   * Get current room ID
   */
  getRoomId() {
    return this.currentRoomId;
  }
}

export default JamClient;
