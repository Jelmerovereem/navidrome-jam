import CryptoJS from 'crypto-js';

const SUBSONIC_API_VERSION = '1.16.1';
const SUBSONIC_CLIENT_NAME = 'navidrome-jam';
const SESSION_STORAGE_KEY = 'navidrome_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, renewed on each visit
const LEGACY_SESSION_KEYS = ['navidrome_username', 'navidrome_token', 'navidrome_salt'];

/**
 * Navidrome Subsonic API Client
 *
 * SECURITY: Stores username + salted token (never the password) in localStorage
 * for 7 days since the last visit. Validated with Navidrome on restore, so a
 * changed password invalidates the stored session.
 */
class NavidromeClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.username = null;
    this.token = null;
    this.salt = null;
  }

  /**
   * Generate token and salt for Subsonic API authentication
   */
  generateAuth(password) {
    const salt = Math.random().toString(36).substring(2, 15);
    const token = CryptoJS.MD5(password + salt).toString();
    return { token, salt };
  }

  /**
   * Build Subsonic API URL with auth params
   */
  buildUrl(endpoint, params = {}) {
    const url = new URL(`${this.baseUrl}/rest/${endpoint}`);

    url.searchParams.append('u', this.username);
    url.searchParams.append('t', this.token);
    url.searchParams.append('s', this.salt);
    url.searchParams.append('v', SUBSONIC_API_VERSION);
    url.searchParams.append('c', SUBSONIC_CLIENT_NAME);
    url.searchParams.append('f', 'json');

    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, value);
      }
    });

    return url.toString();
  }

  /**
   * Authenticate with Navidrome
   */
  async authenticate(username, password) {
    const { token, salt } = this.generateAuth(password);

    // Test authentication with ping
    const url = new URL(`${this.baseUrl}/rest/ping`);
    url.searchParams.append('u', username);
    url.searchParams.append('t', token);
    url.searchParams.append('s', salt);
    url.searchParams.append('v', SUBSONIC_API_VERSION);
    url.searchParams.append('c', SUBSONIC_CLIENT_NAME);
    url.searchParams.append('f', 'json');

    const response = await fetch(url);
    const data = await response.json();

    if (data['subsonic-response'].status !== 'ok') {
      throw new Error(data['subsonic-response'].error?.message || 'Authentication failed');
    }

    // Store credentials
    this.username = username;
    this.token = token;
    this.salt = salt;

    this.saveSession();

    return data['subsonic-response'];
  }

  /**
   * Persist current credentials with a fresh 7-day expiry
   */
  saveSession() {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      username: this.username,
      token: this.token,
      salt: this.salt,
      expiresAt: Date.now() + SESSION_TTL_MS
    }));
  }

  /**
   * Read stored credentials, or null if missing/expired/corrupt
   */
  loadStoredSession() {
    try {
      const session = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY));
      if (!session?.username || !session.token || !session.salt) return null;
      if (!session.expiresAt || session.expiresAt < Date.now()) {
        this.clearStoredCredentials();
        return null;
      }
      return session;
    } catch {
      this.clearStoredCredentials();
      return null;
    }
  }

  /**
   * Restore session from localStorage and validate with Navidrome.
   * A successful restore renews the 7-day expiry.
   */
  async restoreSession() {
    // Drop credentials left by the old sessionStorage-based login
    LEGACY_SESSION_KEYS.forEach(key => sessionStorage.removeItem(key));

    const stored = this.loadStoredSession();
    if (!stored) {
      return false;
    }
    const { username, token, salt } = stored;

    // Validate credentials with Navidrome ping
    try {
      const url = new URL(`${this.baseUrl}/rest/ping`);
      url.searchParams.append('u', username);
      url.searchParams.append('t', token);
      url.searchParams.append('s', salt);
      url.searchParams.append('v', SUBSONIC_API_VERSION);
      url.searchParams.append('c', SUBSONIC_CLIENT_NAME);
      url.searchParams.append('f', 'json');

      const response = await fetch(url);
      const data = await response.json();

      if (data['subsonic-response'].status === 'ok') {
        // Credentials are valid, restore session
        this.username = username;
        this.token = token;
        this.salt = salt;
        this.saveSession();
        return true;
      } else {
        // Credentials are invalid (auth failed), clear storage
        console.warn('Stored credentials are invalid, clearing');
        this.clearStoredCredentials();
        return false;
      }
    } catch (error) {
      console.error('Failed to validate stored credentials:', error);
      // On network error, don't clear credentials - server might be temporarily down
      // Restore session optimistically, user will see error if they try to use it
      if (error.name === 'TypeError' || error.message?.includes('fetch')) {
        console.warn('Network error during session validation, restoring optimistically');
        this.username = username;
        this.token = token;
        this.salt = salt;
        return true;
      }
      // For other errors, clear credentials to be safe
      this.clearStoredCredentials();
      return false;
    }
  }

  /**
   * Clear stored credentials
   */
  clearStoredCredentials() {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }

  /**
   * Logout
   */
  logout() {
    this.username = null;
    this.token = null;
    this.salt = null;
    this.clearStoredCredentials();
  }

  /**
   * Check if authenticated
   */
  isAuthenticated() {
    return !!(this.username && this.token && this.salt);
  }

  /**
   * Fetch from Subsonic API
   */
  async fetch(endpoint, params = {}) {
    const url = this.buildUrl(endpoint, params);
    const response = await fetch(url);
    const data = await response.json();

    if (data['subsonic-response'].status !== 'ok') {
      throw new Error(data['subsonic-response'].error?.message || 'API request failed');
    }

    return data['subsonic-response'];
  }

  /**
   * Get streaming URL for a song
   */
  getStreamUrl(songId, format = null, maxBitRate = null) {
    const params = { id: songId };
    if (format) params.format = format;
    if (maxBitRate) params.maxBitRate = maxBitRate;
    return this.buildUrl('stream.view', params);
  }

  /**
   * Get cover art URL
   */
  getCoverArtUrl(id, size = null) {
    const params = { id };
    if (size) params.size = size;
    return this.buildUrl('getCoverArt.view', params);
  }

  /**
   * Get all artists (alphabetically indexed)
   */
  async getArtists() {
    return this.fetch('getArtists.view');
  }

  /**
   * Search for songs, albums, artists
   */
  async search(query, artistCount = 10, albumCount = 10, songCount = 20) {
    return this.fetch('search3.view', {
      query,
      artistCount,
      albumCount,
      songCount
    });
  }

  /**
   * Get album details
   */
  async getAlbum(id) {
    return this.fetch('getAlbum.view', { id });
  }

  /**
   * Get artist details
   */
  async getArtist(id) {
    return this.fetch('getArtist.view', { id });
  }

  /**
   * Get song details
   */
  async getSong(id) {
    return this.fetch('getSong.view', { id });
  }

  /**
   * Get album list (sorted by various criteria)
   * @param {string} type - alphabeticalByName, alphabeticalByArtist, newest, recent, frequent, random, starred
   * @param {number} size - Number of albums to return
   * @param {number} offset - Pagination offset
   */
  async getAlbumList(type = 'alphabeticalByName', size = 50, offset = 0) {
    return this.fetch('getAlbumList2.view', { type, size, offset });
  }

  /**
   * Get random songs
   */
  async getRandomSongs(size = 50, genre = null) {
    const params = { size };
    if (genre) params.genre = genre;
    return this.fetch('getRandomSongs.view', params);
  }

  /**
   * Report playback to Navidrome.
   * submission=false registers "Now Playing" (shows this player as active in Navidrome);
   * submission=true records a play (play count, last played, external scrobblers).
   * @param {number} time - when playback started (ms since epoch)
   */
  async scrobble(id, submission = true, time = Date.now()) {
    return this.fetch('scrobble.view', {
      id,
      submission,
      time
    });
  }

  /**
   * Get all starred (favourited) content
   */
  async getStarred() {
    return this.fetch('getStarred2.view');
  }

  /**
   * Star a track (add to Favourites)
   */
  async starTrack(id) {
    return this.fetch('star.view', { id });
  }

  /**
   * Unstar a track (remove from Favourites)
   */
  async unstarTrack(id) {
    return this.fetch('unstar.view', { id });
  }

  /**
   * Get playlists
   */
  async getPlaylists() {
    return this.fetch('getPlaylists.view');
  }

  /**
   * Get playlist details
   */
  async getPlaylist(id) {
    return this.fetch('getPlaylist.view', { id });
  }
}

export default NavidromeClient;
