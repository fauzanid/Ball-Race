const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '5mb' }));
// Don't cache HTML — users should always see fresh UI after a deploy
app.use(express.static('public', {
  setHeaders(res, filepath) {
    if (filepath.endsWith('.html') || filepath.endsWith('index.html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
    }
  },
}));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const validTokens = new Set();

// ===== DATABASE =====
let pool = null;
let dbReady = false;

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('No DATABASE_URL — running without database');
    return;
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS races (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        room_code VARCHAR(10),
        players TEXT[] NOT NULL,
        colors INT[] NOT NULL,
        winner VARCHAR(100) NOT NULL,
        results JSONB NOT NULL,
        duration INT NOT NULL,
        recording JSONB
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_races_created ON races (created_at DESC)`);
    dbReady = true;
    console.log('Database ready');
  } catch (err) {
    console.error('Database init failed:', err.message);
  }
}

// ===== ADMIN AUTH =====
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || '';
  if (!validTokens.has(token)) return res.status(401).json({ error: 'Admin required' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  const token = crypto.randomBytes(32).toString('hex');
  validTokens.add(token);
  res.json({ token });
});

app.post('/api/admin/logout', (req, res) => {
  const token = req.headers['x-admin-token'] || '';
  validTokens.delete(token);
  res.json({ ok: true });
});

app.post('/api/admin/verify', (req, res) => {
  const token = req.headers['x-admin-token'] || '';
  res.json({ valid: validTokens.has(token) });
});

// ===== RACES API =====
app.get('/api/races', async (req, res) => {
  if (!dbReady) return res.json([]);
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    const { rows } = await pool.query(
      `SELECT id, created_at, room_code, players, colors, winner, results, duration,
              (recording IS NOT NULL) AS has_replay
       FROM races ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/races:', err.message);
    res.status(500).json({ error: 'Failed to load races' });
  }
});

app.get('/api/races/:id', async (req, res) => {
  if (!dbReady) return res.status(404).json({ error: 'No database' });
  try {
    const { rows } = await pool.query('SELECT * FROM races WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Race not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load race' });
  }
});

app.post('/api/races', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const { room_code, players, colors, winner, results, duration, recording } = req.body;
    if (!players || !winner || !results) return res.status(400).json({ error: 'Missing fields' });
    const { rows } = await pool.query(
      `INSERT INTO races (room_code, players, colors, winner, results, duration, recording)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
      [room_code || null, players, colors || [], winner, JSON.stringify(results), duration || 10, recording ? JSON.stringify(recording) : null]
    );
    res.json({ id: rows[0].id, created_at: rows[0].created_at });
  } catch (err) {
    console.error('POST /api/races:', err.message);
    res.status(500).json({ error: 'Failed to save race' });
  }
});

app.delete('/api/races', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    await pool.query('DELETE FROM races');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear' });
  }
});

// ===== LIVE RACE (single global state) =====
const liveRace = {
  state: 'idle',        // 'idle' | 'setup' | 'countdown' | 'racing' | 'results'
  players: [],          // [{ name, colorIdx }]
  settings: { duration: 10, fairMode: false },
  racers: null,         // during/after race: [{ name, colorIdx }]
  positions: null,      // during race
  commentary: '',
  lastResults: null,    // { results: [...], racers: [...] }
};

function publicState() {
  return {
    state: liveRace.state,
    players: liveRace.players,
    settings: liveRace.settings,
    racers: liveRace.racers,
    positions: liveRace.positions,
    commentary: liveRace.commentary,
    lastResults: liveRace.lastResults,
    viewerCount: io.engine.clientsCount,
  };
}

let adminSockets = new Set();

io.on('connection', socket => {
  let isAdmin = false;

  socket.emit('state-sync', publicState());
  io.emit('viewer-count', io.engine.clientsCount);

  socket.on('admin-auth', (token, cb) => {
    if (validTokens.has(token)) {
      isAdmin = true;
      adminSockets.add(socket.id);
      cb && cb({ ok: true });
    } else {
      cb && cb({ ok: false });
    }
  });

  socket.on('admin-logout', () => {
    isAdmin = false;
    adminSockets.delete(socket.id);
  });

  // === ADMIN CONTROLS ===
  socket.on('update-players', players => {
    if (!isAdmin) return;
    liveRace.players = players;
    if (liveRace.state === 'idle') liveRace.state = 'setup';
    io.emit('players-updated', players);
  });

  socket.on('update-settings', settings => {
    if (!isAdmin) return;
    liveRace.settings = { ...liveRace.settings, ...settings };
    io.emit('settings-updated', liveRace.settings);
  });

  socket.on('race-countdown', () => {
    if (!isAdmin) return;
    liveRace.state = 'countdown';
    liveRace.lastResults = null;
    socket.broadcast.emit('race-countdown');
  });

  socket.on('race-start', data => {
    if (!isAdmin) return;
    liveRace.state = 'racing';
    liveRace.racers = data.racers;
    liveRace.positions = data.racers.map(() => 0);
    socket.broadcast.emit('race-started', data);
  });

  socket.on('race-update', data => {
    if (!isAdmin) return;
    liveRace.positions = data.positions;
    liveRace.commentary = data.commentary;
    socket.broadcast.emit('race-frame', data);
  });

  socket.on('race-end', data => {
    if (!isAdmin) return;
    liveRace.state = 'results';
    liveRace.lastResults = data;
    socket.broadcast.emit('race-ended', data);
  });

  socket.on('back-to-setup', () => {
    if (!isAdmin) return;
    liveRace.state = liveRace.players.length > 0 ? 'setup' : 'idle';
    liveRace.racers = null;
    liveRace.positions = null;
    liveRace.commentary = '';
    liveRace.lastResults = null;
    io.emit('back-to-setup');
  });

  socket.on('reset-race', () => {
    if (!isAdmin) return;
    liveRace.state = 'idle';
    liveRace.players = [];
    liveRace.racers = null;
    liveRace.positions = null;
    liveRace.commentary = '';
    liveRace.lastResults = null;
    io.emit('race-reset');
  });

  socket.on('disconnect', () => {
    adminSockets.delete(socket.id);
    io.emit('viewer-count', io.engine.clientsCount);
    // If no admin remains during a race, abort
    if (adminSockets.size === 0 && (liveRace.state === 'countdown' || liveRace.state === 'racing')) {
      setTimeout(() => {
        if (adminSockets.size === 0 && (liveRace.state === 'countdown' || liveRace.state === 'racing')) {
          liveRace.state = liveRace.players.length > 0 ? 'setup' : 'idle';
          liveRace.racers = null;
          liveRace.positions = null;
          liveRace.commentary = '';
          io.emit('race-aborted');
        }
      }, 8000);
    }
  });
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  server.listen(PORT, () => console.log(`Football Race on port ${PORT}`));
});
