# Navidrome Jam

Synchronized music playback for listening to the same music with friends in real-time. Built as an extension to [Navidrome](https://www.navidrome.org/). Features a modern, mobile-friendly dark UI.

<img width="1200" height="630" alt="og-image" src="https://github.com/user-attachments/assets/6eba935c-632b-407e-b905-6d334d6a0eab" />

## Motivation

Spotify Jam lets you listen to music together, but it requires Spotify Premium and doesn't support your own music library (FLAC files). This project enables synchronized playback of your personal music collection with friends while gaming or hanging out.

## Architecture

```
              ┌──────────────────┐
              │  Jam Sync Server │
              │   (WebSocket)    │
              └──────────────────┘
                ▲              ▲
     sync cmds  │              │  sync cmds
                │              │
          ┌─────┴─────┐   ┌────┴──────┐
          │  Client 1 │   │  Client 2 │
          │  (Web UI) │   │  (Web UI) │
          └─────┬─────┘   └────┬──────┘
                │              │
     audio HTTP │              │ audio HTTP
                ▼              ▼
              ┌──────────────────┐
              │    Navidrome     │
              │  (Your server)   │
              └──────────────────┘
```

### Components

1. **Navidrome** - Your existing music server (self-hosted or managed). Clients stream audio directly from it via the Subsonic API — the sync server never touches audio data.
2. **Jam Sync Server** - Lightweight WebSocket server that broadcasts playback commands (play/pause/seek/timestamp). Room state snapshots to a persistent volume every 30s and on shutdown, so sessions survive server restarts.
3. **Web Client** - React SPA that handles Navidrome auth, audio playback, and room UI. Connects to both Navidrome (for music) and the sync server (for coordination).

## Features

- Synchronized play/pause/seek across all participants (<500ms drift)
- Shared queue with reordering, auto-play, repeat mode, shuffle, and album auto-queue
- Host controls with co-host delegation
- Library browser — Artists, Albums A-Z, Recently Added, Recently Played, Favorites
- Music search integrated with Navidrome library
- **User uploads** — Upload music through the web client (streams via SFTP to Navidrome, auto-indexed)
- **Likes** — Like tracks to save them to your Navidrome favorites (persists across rooms/sessions)
- Liked uploads are protected from auto-cleanup
- Supports FLAC and all formats Navidrome handles
- **Playlists** — Pick a Navidrome playlist and play it for the room (in order or shuffled), or add it to the queue
- Invite-code-based self-service registration
- Room resilience — automatic reconnect + rejoin (e.g. after a locked phone), 30-second grace so hosts keep their role, 5-minute grace for empty rooms, state snapshots to persistent volume
- Modern dark UI with album-art grid, blurred-cover now-playing view, and SVG icons
- Mobile-friendly layout (Queue/People tabs on ≤1024px screens)
- **Installable app (PWA)** — install from the browser ("Install app" on the login screen, or Share → Add to Home Screen on iOS); lock-screen / media-key controls with track artwork

## Tech Stack

- **Navidrome**: Go-based music server (existing)
- **Sync Server**: Node.js + Express + Socket.io
- **Client**: React + Vite
- **Protocol**: WebSocket for real-time communication, Subsonic API for music streaming

## Deployment

The sync server needs persistent WebSocket connections, so host it on a VPS or any platform that runs long-lived Node.js processes (not serverless functions). The client is a static Vite build and can be served from anywhere (e.g. nginx on the same VPS).

### VPS (Self-Hosted)

```bash
curl -fsSL https://raw.githubusercontent.com/Jelmerovereem/navidrome-jam/main/install.sh | bash
```

📖 [VPS Deployment Guide](./DEPLOYMENT.md)

---

## Local Development

### Prerequisites

1. **Navidrome** - Install and configure Navidrome
   ```bash
   # See: https://www.navidrome.org/docs/installation/
   ```

2. **Node.js 18+** - Required for sync server and client

### Quick Start

1. Clone the repository:
   ```bash
   git clone https://github.com/Jelmerovereem/navidrome-jam.git
   cd navidrome-jam
   ```

2. Install server dependencies:
   ```bash
   cd server
   npm install
   cp .env.example .env
   # Edit .env if needed
   ```

3. Install client dependencies:
   ```bash
   cd ../client
   npm install
   cp .env.example .env
   # Edit .env to point to your Navidrome instance
   ```

4. Start the sync server:
   ```bash
   cd ../server
   npm run dev
   ```

5. In a new terminal, start the client:
   ```bash
   cd client
   npm run dev
   ```

6. Open http://localhost:5173 in your browser

See [QUICKSTART.md](./QUICKSTART.md) for detailed testing instructions.

## Security

This project implements several security measures:
- Input validation and sanitization to prevent XSS attacks
- Rate limiting to prevent abuse
- Token-based authentication with Navidrome
- Session validation on restore

For detailed security considerations, see [SECURITY.md](./SECURITY.md).

## Development

### Project Structure

```
navidrome-jam/
├── server/           # WebSocket sync server (Node.js + Socket.io)
│   ├── src/
│   │   ├── index.js         # Main server with validation & rate limiting
│   │   ├── roomManager.js   # Room state management & cleanup
│   │   └── sftpUploader.js  # SFTP upload pipeline to the Navidrome music folder
│   └── test-client.html     # HTML test client
├── client/           # React web client
│   ├── src/
│   │   ├── components/      # React components
│   │   │   ├── SyncedAudioPlayer.jsx  # Audio player with volume control
│   │   │   ├── ErrorBoundary.jsx      # Error handling wrapper
│   │   │   ├── catData.js             # Avatar definitions + paw SVG (Boo)
│   │   │   ├── CatPicker.jsx          # Avatar selection overlay (Boo)
│   │   │   ├── CatDanceFloor.jsx      # Animated avatar strip (Boo)
│   │   │   └── PawButton.jsx          # Hold-to-activate paw button (Boo)
│   │   ├── contexts/        # React contexts
│   │   │   ├── NavidromeContext.jsx   # Navidrome client provider
│   │   │   └── JamContext.jsx         # Jam client provider
│   │   ├── services/        # API clients
│   │   │   ├── navidrome.js          # Navidrome Subsonic API client
│   │   │   └── jamClient.js          # WebSocket client wrapper
│   │   └── App.jsx          # Main app with loading states
│   └── public/
│       ├── favicon.svg            # Win98 music note favicon
│       ├── og-image.svg           # OG image source (Win98 scene)
│       └── og-image.png           # Rasterized OG image for social previews
├── docs/             # Documentation
├── QUICKSTART.md     # Quick start guide
└── SECURITY.md       # Security considerations
```

### Running Tests

Test the sync server with the HTML test client:
```bash
cd server
npm run dev
# Open test-client.html in two browser windows
```

Test with the full stack:
```bash
# Terminal 1: Sync server
cd server && npm run dev

# Terminal 2: Web client
cd client && npm run dev

# Open http://localhost:5173 in two browsers
```

## Roadmap

- **Room settings** — Private/public rooms, password protection, permission levels
- **Automated tests** — Jest for sync server, Vitest + React Testing Library for client
- **TypeScript migration** — Full codebase migration (server + client)

## Changelog

### 2026-09-28 — Installable PWA

- **Installable app**: Web app manifest, icons (incl. maskable + Apple touch icon), and a Workbox service worker that precaches the app shell. Opens offline to the login screen; Navidrome and the sync server are always fetched live.
- **Install button**: Shown on login/room screens when the browser supports installing; iOS gets an "Add to Home Screen" hint.
- **Update prompt**: New versions download in the background and apply only when you tap *Update*, so playback is never interrupted by a reload.
- **Media Session**: Track title/artist/artwork on the lock screen and in OS media controls; hosts/co-hosts can play/pause/skip from there.
- **Reconnect fix**: The app no longer gets stuck on "Connecting to Jam server…" after a phone was locked. It reconnects on its own, rejoins the room, and shows a banner meanwhile. The server keeps a dropped user (and their host/co-host role) for 30 seconds before removing them; others see them as "reconnecting…".
- **Deployment**: PWAs require HTTPS (localhost is exempt). `nginx.conf` serves `sw.js` and `manifest.webmanifest` with `no-cache` so installed apps pick up updates.

### 2026-09-28 — Modern UI

- **Redesign**: Replaced the Windows 98 / GeoCities theme with a modern dark UI — design tokens, inline SVG icon set, album-art grid, collection headers with Play / Shuffle / Queue all, blurred-cover now-playing card.
- **Mobile**: Compact player, larger touch targets, safe-area insets, two-column album grid on phones.
- **Fork cleanup**: Removed upstream hosting config (Vercel, Railway) and domain references. Upload SFTP env vars renamed to `SFTP_*`; communities proxy now opt-in via `COMMUNITIES_API_URL`.

### 2026-02-15 — Playlists, Room Resilience

- **Playlist browsing**: Browse and queue Navidrome playlists from the library browser.
- **Room grace period**: Rooms stay alive for 5 minutes after the last user disconnects (e.g., LTE handoff while driving). Queue, playback position, and room code are preserved for seamless rejoin.
- **Room state snapshots**: Active rooms snapshot to persistent volume every 30s and on shutdown. Sessions survive server restarts and redeploys.
- **Community selector**: Moved from room creation dialog to room header bar for easier access.

### 2026-02-15 — User Uploads, Persistent Likes, Favorites

- **User uploads**: Upload audio files through the web client. Files stream to Navidrome via SFTP and are auto-indexed. 30-day auto-cleanup with permanent flag (50/user).
- **Persistent likes**: Like button syncs to Navidrome favorites via `star.view`/`unstar.view` Subsonic API. Likes persist across rooms and sessions — if you liked a track before, the button stays active when you encounter it again.
- **Liked upload protection**: Uploaded files with at least one like are exempt from 30-day auto-cleanup.
- **Favorites browse mode**: New "Favorites" option in the library browser dropdown — shows all your starred tracks from Navidrome.
- **Recently Played**: Replaced "Random" with "Recently Played" in the browse dropdown (random shuffle button still available on album views).
- **SVG transport icons**: Replaced CSS pixel art with SVG mask-image icons (Bootstrap Icons for like, Lucide-style for repeat). Monochrome by default, colored when active.

### 2026-02-14 — Jam With Boo (Valentine's Edition)

- **Jam With Boo**: Valentine's Day edition. Separate branch (`feature/jam-with-boo`) with its own domain, OG images, and favicon.
- **Kawaii avatars**: 9 characters powered by [react-kawaii](https://github.com/elizabetdev/react-kawaii) (Cat, Ghost, Planet, IceCream, Mug, Backpack, SpeechBubble, Chocolate, Browser). Avatar picker on join, visible in user list and dance strip.
- **Paw hold climax**: Hold the paw button for 8 seconds — when 2+ users hold simultaneously, avatars converge into a heart burst with screen flash. Climax persists as long as everyone keeps holding.
- **Dance strip**: Animated avatar row above the now-playing bar. Avatars bounce when music plays, converge during paw hold, and burst apart on climax.
- **Valentine theme**: Pink/rose accent colors layered over the Win98 base. Custom OG image and favicon for social sharing.
- **Multi-origin CORS**: Server `CLIENT_URL` now supports comma-separated origins (e.g., `https://jam.example.com,https://boo.example.com`).

### 2026-02-11 — Browse Modes, Mobile Layout, Compilation Handling

- **Browse modes**: Library browser now supports four modes via dropdown — Artists (default), Albums A-Z, Recently Added, and Random (with shuffle button). Albums fetched via `getAlbumList2.view`.
- **Compilation album grouping**: Albums with the same name and year are merged into a single entry showing "Various Artists". Clicking opens a combined tracklist from all sub-albums, sorted by disc/track number.
- **Artist names in tracklists**: Album song view shows per-track artist when it differs from the album artist — essential for compilations and soundtracks.
- **Mobile tabs**: Queue and People tabs appear on screens ≤1024px, rendering full queue management and user list inline (desktop sidebar panels unchanged).
- **License**: Changed from MIT to Apache-2.0.

### 2026-02-10 — Sync Fixes, Repeat, Active Rooms, Admin Dashboard

- **Sync fixes**: Fixed three interrelated bugs — no playback on join, wrong track on host change, race condition when sync arrives before audio element mounts. Server now sends sync event on join; client detects track changes and applies deferred sync via `pendingSyncRef`.
- **Repeat mode**: Toggle auto-repeat so the room plays forever. Finished tracks re-append to queue tail. Empty queue + repeat = single-track loop. State persisted in localStorage.
- **Album auto-queue**: Playing a track from album browse view now queues all remaining album tracks, so next/prev buttons work within the album.
- **Active rooms**: Room selection screen shows currently active rooms with host name, listener count, and current track. Auto-refreshes every 10 seconds.
- **Admin dashboard**: Server-rendered Win98-styled page at `/admin` for invite code management — view code status (available/used/who used it), generate new codes, delete codes. Protected by admin password.
- **Social sharing**: OG meta tags, Twitter Cards, custom Win98 favicon (SVG), and OG image with Winamp player scene for rich link previews in messengers.
- **GitHub link**: Repo link added to login and room selection screens.

### 2026-02-10 — Co-hosts, Library Browser, Transport Controls

- **Co-host system**: Host can promote/demote users to co-host. Co-hosts get full playback and queue control. Server validates with `canControl()` (host OR co-host). Co-host status cleaned up on user leave.
- **Library browser**: Browse tab with artist/album/song navigation. Breadcrumb navigation (Library > Artist > Album). "Queue All" button on album view. Win98 folder icons and album thumbnails.
- **Transport controls**: Winamp-style prev/play-pause/next buttons with CSS-drawn icons in a dark recessed panel. Play/pause updates reactively via audio element callbacks.
- **Queue reordering**: Move tracks up/down or remove them. Unicode arrow buttons.
- **Play history**: Previous track button navigates actual history (3-second threshold — restart vs go back).
- **Bug fixes**: Queue All only adding last track (stale state closure), invisible username in users list (CSS color inheritance), queue disconnected from player (auto-play on first add).

### 2026-02-09 — Initial Release

- Synchronized music playback rooms with WebSocket sync
- Navidrome Subsonic API integration (search, stream, metadata)
- Invite-code-based self-service registration
- Windows 98 / GeoCities retro UI theme

## Contributing

Contributions welcome! Open an issue or PR.

## License

Apache-2.0

## Acknowledgments

- [Navidrome](https://www.navidrome.org/) - The excellent music server this builds upon
- Inspired by Spotify Jam
