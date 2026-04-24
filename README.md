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
