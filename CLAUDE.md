# CLAUDE.md

**Navidrome Jam** — synchronized music playback for personal music libraries. Extension to Navidrome music server (Spotify Jam for FLAC).

**Critical:** Clients stream audio directly from Navidrome, NOT through the sync server. The sync server only broadcasts playback commands.

## Key Dependencies

**Server**: express, socket.io, express-rate-limit, cors, dotenv, busboy, ssh2-sftp-client, resend (ES modules, no TypeScript)

**Client**: react 19, socket.io-client, crypto-js (MD5 for Subsonic auth), vite 7, eslint

## Commands

### Server
```bash
cd server
npm install && npm run dev    # Dev with hot-reload (node --watch)
npm start                      # Production
```

Environment: Copy `.env.example` to `.env` (all vars listed there and below).

### Client
```bash
cd client
npm install && npm run dev    # Vite dev server (http://localhost:5173)
npm run build                  # Production build → dist/
npm run preview                # Preview production build
```

Environment: Copy `.env.example` to `.env` — needs `VITE_NAVIDROME_URL` and `VITE_JAM_SERVER_URL`.

### Testing
```bash
# Sync only (no Navidrome required):
cd server && npm run dev
# Open server/test-client.html in 2+ browser windows

# Full stack (requires Navidrome):
# Terminal 1: cd server && npm run dev
# Terminal 2: cd client && npm run dev
# Open http://localhost:5173 in 2+ browsers
```

### Linting
```bash
cd client && npm run lint                    # ESLint client
cd server && node --check src/index.js && node --check src/roomManager.js && node --check src/sftpUploader.js
cd client && npm run build                   # Verify production build
```

No automated tests — manual testing with test-client.html or full stack.

## Code Architecture

### Server (`server/src/`)
Three files: `index.js` (Express + Socket.io, REST endpoints, WebSocket handlers, admin panel), `roomManager.js` (room state with grace periods), `sftpUploader.js` (SFTP upload pipeline to the Navidrome music folder).

Key design: room state snapshots to the data volume every 30s + SIGTERM, 5-min grace period for empty rooms, invite codes/waitlist/deleted codes persist to JSON on volume, `canControl()` authorization (host OR co-host), `trust proxy` for running behind a reverse proxy.

### Client (`client/src/`)
Three screens in `App.jsx`: Login → Room Selection → Jam Session.

**PWA**: `vite-plugin-pwa` in `vite.config.js` (manifest + Workbox `generateSW`, `registerType: 'prompt'`). `components/UpdatePrompt.jsx` shows the update toast (never auto-reload — it would cut off playback); `hooks/usePwaInstall.js` captures `beforeinstallprompt` for the Install button. Media Session (lock-screen controls) lives in `App.jsx`. Service worker only runs in production builds (`npm run build && npm run preview`), requires HTTPS or localhost, and must only precache same-origin app files — never Navidrome/sync-server URLs. Icons in `public/icons/`.

Service layer: `navidrome.js` (Subsonic API + MD5 auth), `jamClient.js` (Socket.io wrapper with custom event emitter), `NavidromeContext.jsx`/`JamContext.jsx` (create/destroy on mount/unmount — prevents duplicate listeners during Vite HMR).

**Visual theme**: Modern dark UI (Inter, violet→pink accent). Design tokens as CSS variables in `App.css` (`--bg`, `--surface*`, `--text*`, `--accent*`, `--radius*`). Icons are inline SVGs in `components/Icons.jsx`. Responsive: 3 columns >1024px; single column with Queue/People tabs below.

## Deployment

This repo is a fork — there is no hosted deployment or preview environment wired up.

- **Server**: any host that runs long-lived Node.js processes (VPS + PM2, see `DEPLOYMENT.md`). Not serverless — Socket.io needs persistent connections.
- **Client**: static Vite build (`client/dist`), serve from nginx or any static host.

**CORS**: Socket.io accepts only the comma-separated `CLIENT_URL` origins (or `*` if unset).

### Environment Variables

All server vars (see `server/.env.example`):
- `CLIENT_URL` — client URL(s), comma-separated (CORS; first one is used in invite emails)
- `NAVIDROME_URL`, `NAVIDROME_ADMIN_USER`, `NAVIDROME_ADMIN_PASS` — for registration (if unset, registration disabled gracefully)
- `DATA_DIR` — persistent data directory (defaults to `./data`)
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL` — invite code emails
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID` — waitlist notifications
- `PUBLIC_SERVER_URL` — public server base URL (e.g. `https://jam-api.example.com`) for action token links in Telegram messages
- `SFTP_HOST`, `SFTP_PORT`, `SFTP_USER`, `SFTP_PASS`, `SFTP_MUSIC_PATH` — user uploads to the Navidrome music folder (uploads disabled if unset)
- `COMMUNITIES_API_URL` — optional groups API for room community tags (feature hidden if unset)

## Admin Panel

Server-rendered Win98 HTML at `/admin?key=NAVIDROME_ADMIN_PASS`. Invite codes, waitlist, upload stats, server stats.

## Waitlist + Telegram Notifications

Users without invite codes join a waitlist. Admin gets Telegram notification with inline "Send Code" button — one-click to email invite and remove from waitlist. Uses one-time action tokens (GET endpoints, no webhook needed).

## Design Docs

Check `docs/plans/` before planning new features:
- `2026-02-15-room-settings-design.md` — Kick user + password protection
- `2026-02-15-queue-dnd-design.md` — Queue drag-and-drop reordering
- `2026-02-15-room-history-design.md` — Room history / session logs
- `2026-02-15-strategic-bets.md` — Federation vs Bandcamp strategy

## Branches

- `main` — default branch
- `feature/modern-ui` — modern dark UI redesign

## Reference

Read when working on internals: [Architecture](docs/architecture.md) — Navidrome API endpoints, sync protocol, WebSocket/API patterns, user uploads, persistence.
