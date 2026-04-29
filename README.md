# ⚽ Football Race

Real-time multiplayer football racing game. Create a room, share the code, and watch the race together live.

Built with Node.js, Express, and Socket.IO.

![Football Race](https://img.shields.io/badge/Node.js-18+-green) ![Socket.IO](https://img.shields.io/badge/Socket.IO-4.7-blue) ![License](https://img.shields.io/badge/license-MIT-yellow)

## Features

### 🏟️ Racing
- **Multiplayer rooms** — Host creates a room, viewers join with a 6-character code
- **Real-time sync** — Viewers watch the race live via WebSocket
- **Spinning footballs** — Canvas-rendered soccer balls with pentagon patterns and team-colored rings
- **Live commentary** — Auto-generated race commentary ("Player 1 takes the lead!")
- **Adjustable duration** — Set any race length from 3 to 60 seconds
- **Fair mode** — Balances wins over time so the same person doesn't always win
- **Sound effects** — Countdown beeps, start whistle, crowd ambience, victory fanfare

### 🔄 Replay
- Full race replay with play/pause, timeline scrubber, and speed controls (0.25x–2x)
- Available for both host and viewers

### 🎡 Wheel of Names
- Spinning wheel for random name picking
- Add names manually or import from race players

### 👥 Team Generator
- Randomly split names into 2–4 teams
- Shuffle and regenerate instantly

### 📋 History & Rooms
- Race history saved locally (last 50 races)
- Save/load player lists as named rooms
- Share player lists via URL

### 📱 Offline Support
- PWA with service worker for offline play
- Works without server in offline mode

## Getting Started

### Local Development

```bash
git clone https://github.com/fauzanid/Ball-Race.git
cd Ball-Race
npm install
npm start
```

Open `http://localhost:3000` in your browser.

### Deploy to Railway

1. Push to GitHub
2. Connect the repo in [Railway](https://railway.app)
3. Railway auto-detects Node.js and deploys
4. Share your public URL — anyone can create or join rooms

### Image Storage on Cloudflare R2 (optional but recommended)

Lucky-card photos, auction galleries, prize images, and wheel images can be
uploaded by admins. Without R2, uploads fall back to base64 in Postgres which
gets heavy fast (especially the auction gallery with 100-200 photos per item).
With R2 configured, uploads are converted to **WebP @ q80** server-side and
stored as objects — typically **5-10× smaller** than the original JPEG/PNG.

**One-time setup on Cloudflare:**

1. Sign in to [dash.cloudflare.com](https://dash.cloudflare.com) → **R2** → enable R2 if you haven't (free tier is 10 GB storage, no egress fees)
2. Click **Create bucket** → name it (e.g. `ball-race`) → Create
3. Open the bucket → **Settings** → **Public access** → **R2.dev subdomain**: enable. Copy the public URL — looks like `https://pub-<hash>.r2.dev`. (Or bind a custom domain if you have one.)
4. Open the bucket → **Settings** → **CORS Policy** → paste:
   ```json
   [{"AllowedOrigins":["*"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":3600}]
   ```
5. Top-right account icon → **R2 → Manage R2 API Tokens** → **Create API token** → choose "Object Read & Write", scope to your bucket → Create. Copy the **Access Key ID** and **Secret Access Key**.
6. Note your **Account ID** (right sidebar of the Cloudflare dashboard). Your endpoint is `https://<account-id>.r2.cloudflarestorage.com`.

**Drop the env vars in Railway** (Project → Variables):

| Variable | Example |
|---|---|
| `R2_ENDPOINT` | `https://abc123…r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | (from step 5) |
| `R2_SECRET_ACCESS_KEY` | (from step 5) |
| `R2_BUCKET` | `ball-race` |
| `R2_PUBLIC_URL` | `https://pub-xxx.r2.dev` (no trailing slash) |

Redeploy. The server logs `R2 not configured — uploads will fall back to base64.` if any are missing; once all five are set, that line goes away and uploads route through R2 with WebP conversion + auto-cleanup on delete.

Existing base64 entries in Postgres keep working — `<img src=>` handles both data URLs and https URLs transparently. No migration needed.

## Project Structure

```
Ball-Race/
├── server.js          # Express + Socket.IO server
├── package.json
└── public/
    ├── index.html     # Full app (HTML/CSS/JS)
    ├── sw.js          # Service worker for offline
    └── manifest.json  # PWA manifest
```

## How Multiplayer Works

| Role | What happens |
|------|-------------|
| **Host** | Creates a room, sets up players, runs the race. Race simulation runs on host's browser and broadcasts positions at 20fps. |
| **Viewer** | Joins with room code, sees players (read-only), watches the race in real-time with smooth interpolation. |

Both host and viewers can watch replays after the race.

## Tech Stack

- **Frontend** — Vanilla HTML/CSS/JS, Canvas API, Web Audio API
- **Backend** — Node.js, Express, Socket.IO
- **Fonts** — Oswald + Barlow Condensed (Google Fonts)
- **Storage** — localStorage for settings, rooms, history, fair mode stats
