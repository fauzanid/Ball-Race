const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

// ===== DATABASE =====
let pool = null;
let dbReady = false;

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('No DATABASE_URL set — running without database (history will use localStorage only)');
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
    console.log('Database connected and ready');
  } catch (err) {
    console.error('Database init failed:', err.message);
  }
}

// ===== API ROUTES =====
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
    console.error('GET /api/races error:', err.message);
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
    console.error('GET /api/races/:id error:', err.message);
    res.status(500).json({ error: 'Failed to load race' });
  }
});

app.post('/api/races', async (req, res) => {
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
    console.error('POST /api/races error:', err.message);
    res.status(500).json({ error: 'Failed to save race' });
  }
});

app.delete('/api/races', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    await pool.query('DELETE FROM races');
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/races error:', err.message);
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

// ===== SOCKET.IO ROOMS =====
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? genCode() : code;
}

function roomInfo(room) {
  return { players: room.players, settings: room.settings, state: room.state, viewerCount: room.viewers.size + 1 };
}

io.on('connection', socket => {
  let currentRoom = null;
  let isHost = false;

  socket.on('create-room', cb => {
    if (currentRoom) leaveRoom();
    const code = genCode();
    rooms.set(code, { host: socket.id, players: [], settings: {}, viewers: new Set(), state: 'waiting' });
    currentRoom = code; isHost = true;
    socket.join(code);
    cb({ code });
  });

  socket.on('join-room', (code, cb) => {
    if (currentRoom) leaveRoom();
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) { cb({ error: 'Room not found' }); return; }
    currentRoom = code; isHost = false;
    room.viewers.add(socket.id);
    socket.join(code);
    cb({ ok: true, ...roomInfo(room) });
    io.to(code).emit('viewer-count', room.viewers.size + 1);
  });

  socket.on('update-players', players => {
    if (!isHost || !currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) { room.players = players; socket.to(currentRoom).emit('players-updated', players); }
  });

  socket.on('update-settings', settings => {
    if (!isHost || !currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) { room.settings = settings; socket.to(currentRoom).emit('settings-updated', settings); }
  });

  socket.on('race-countdown', () => {
    if (!isHost || !currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) { room.state = 'countdown'; socket.to(currentRoom).emit('race-countdown'); }
  });

  socket.on('race-start', data => {
    if (!isHost || !currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) { room.state = 'racing'; socket.to(currentRoom).emit('race-started', data); }
  });

  socket.on('race-update', data => {
    if (!isHost || !currentRoom) return;
    socket.to(currentRoom).emit('race-frame', data);
  });

  socket.on('race-end', data => {
    if (!isHost || !currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) { room.state = 'results'; room.lastResults = data; socket.to(currentRoom).emit('race-ended', data); }
  });

  socket.on('back-to-setup', () => {
    if (!isHost || !currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) { room.state = 'waiting'; socket.to(currentRoom).emit('back-to-setup'); }
  });

  function leaveRoom() {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) { currentRoom = null; return; }
    if (isHost) { io.to(currentRoom).emit('host-left'); rooms.delete(currentRoom); }
    else { room.viewers.delete(socket.id); socket.to(currentRoom).emit('viewer-count', room.viewers.size + 1); }
    socket.leave(currentRoom);
    currentRoom = null; isHost = false;
  }

  socket.on('leave-room', () => leaveRoom());
  socket.on('disconnect', () => leaveRoom());
});

// ===== START =====
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  server.listen(PORT, () => console.log(`Football Race running on port ${PORT}`));
});
