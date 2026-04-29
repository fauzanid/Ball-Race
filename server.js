const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// 10 MB cap so multi-image batches (~12 photos at 500 KB each) fit in
// a single POST /api/auctions/:id/images request.
app.use(express.json({ limit: '10mb' }));
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wheel_spins (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        names TEXT[] NOT NULL,
        winner VARCHAR(120) NOT NULL
      )
    `);
    // Physics columns for replayable spins — additive migration
    await pool.query(`
      ALTER TABLE wheel_spins
        ADD COLUMN IF NOT EXISTS start_rotation DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS initial_velocity DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS deceleration DOUBLE PRECISION
    `);
    // Optional per-entry images (parallel to `names`) — additive migration
    await pool.query(`
      ALTER TABLE wheel_spins
        ADD COLUMN IF NOT EXISTS images TEXT[]
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wheel_spins_created ON wheel_spins (created_at DESC)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shipments (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        phone VARCHAR(32) NOT NULL,
        tracking_code VARCHAR(120) NOT NULL,
        courier VARCHAR(60),
        note VARCHAR(255)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_shipments_phone ON shipments (phone)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_shipments_created ON shipments (created_at DESC)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lucky_cards (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        label VARCHAR(120) NOT NULL,
        image_url TEXT
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lucky_cards_created ON lucky_cards (created_at)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lucky_draws (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        card_label VARCHAR(120) NOT NULL,
        image_url TEXT,
        drawn_by VARCHAR(60)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lucky_draws_created ON lucky_draws (created_at DESC)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auctions (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        title VARCHAR(200) NOT NULL,
        description TEXT,
        image_url TEXT,
        starting_price NUMERIC(15,2) NOT NULL DEFAULT 0,
        min_increment NUMERIC(15,2) NOT NULL DEFAULT 0,
        current_bid NUMERIC(15,2),
        current_bidder VARCHAR(120),
        ends_at TIMESTAMPTZ NOT NULL,
        closed BOOLEAN DEFAULT FALSE,
        closed_at TIMESTAMPTZ
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_auctions_closed_ends ON auctions (closed, ends_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_auctions_created ON auctions (created_at DESC)`);
    // Gallery images for an auction. One row per image so add/remove of a
    // single photo doesn't rewrite the whole auction row.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auction_images (
        id SERIAL PRIMARY KEY,
        auction_id INT NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
        image_url TEXT NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_auction_images_auction ON auction_images (auction_id, sort_order)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS prediction_matches (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        label VARCHAR(200) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'open', -- 'open' | 'closed' | 'finished'
        final_home INT,
        final_away INT
      )
    `);
    // Additive migrations for prize fields (safe to re-run)
    await pool.query(`ALTER TABLE prediction_matches ADD COLUMN IF NOT EXISTS prize_label VARCHAR(200)`);
    await pool.query(`ALTER TABLE prediction_matches ADD COLUMN IF NOT EXISTS prize_image TEXT`);
    // Submission window — opens_at gates the start, closes_at gates the
    // cutoff. Both nullable: leaving them null means "no time gate".
    await pool.query(`ALTER TABLE prediction_matches ADD COLUMN IF NOT EXISTS opens_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE prediction_matches ADD COLUMN IF NOT EXISTS closes_at TIMESTAMPTZ`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pred_matches_created ON prediction_matches (created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pred_matches_closes ON prediction_matches (closes_at) WHERE status = 'open' AND closes_at IS NOT NULL`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS prediction_entries (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        match_id INT NOT NULL REFERENCES prediction_matches(id) ON DELETE CASCADE,
        name VARCHAR(80) NOT NULL,
        phone VARCHAR(40) NOT NULL,
        predicted_home INT NOT NULL,
        predicted_away INT NOT NULL
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pred_entries_match ON prediction_entries (match_id, created_at DESC)`);
    // Each (home,away) combination can only be predicted once per match —
    // first user to submit that exact score "claims" it.
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_pred_score ON prediction_entries (match_id, predicted_home, predicted_away)`);
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

// ===== WHEEL SPINS API =====
app.get('/api/wheel-spins', async (req, res) => {
  if (!dbReady) return res.json([]);
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const { rows } = await pool.query(
      `SELECT id, created_at, names, images, winner, start_rotation, initial_velocity, deceleration
       FROM wheel_spins ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/wheel-spins:', err.message);
    res.status(500).json({ error: 'Failed to load spins' });
  }
});

app.post('/api/wheel-spins', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const { names, images, winner, start_rotation, initial_velocity, deceleration } = req.body || {};
    if (!Array.isArray(names) || !names.length || !winner) return res.status(400).json({ error: 'Missing fields' });
    const imageArr = Array.isArray(images) ? images.map(s => (typeof s === 'string' ? s : '')) : null;
    const { rows } = await pool.query(
      `INSERT INTO wheel_spins (names, images, winner, start_rotation, initial_velocity, deceleration)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [names, imageArr, winner,
        typeof start_rotation === 'number' ? start_rotation : null,
        typeof initial_velocity === 'number' ? initial_velocity : null,
        typeof deceleration === 'number' ? deceleration : null]
    );
    res.json({ id: rows[0].id, created_at: rows[0].created_at });
  } catch (err) {
    console.error('POST /api/wheel-spins:', err.message);
    res.status(500).json({ error: 'Failed to save spin' });
  }
});

app.delete('/api/wheel-spins', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    await pool.query('DELETE FROM wheel_spins');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear' });
  }
});

// ===== SHIPMENT TRACKING API =====
function normalizePhone(p) {
  return String(p || '').replace(/[^\d+]/g, '');
}

// Public lookup — viewers query by phone number
app.get('/api/shipments/lookup', async (req, res) => {
  if (!dbReady) return res.json([]);
  const phone = normalizePhone(req.query.phone);
  if (!phone || phone.length < 4) return res.status(400).json({ error: 'Phone required' });
  try {
    const { rows } = await pool.query(
      `SELECT id, created_at, phone, tracking_code, courier, note
       FROM shipments WHERE phone = $1 ORDER BY created_at DESC LIMIT 50`,
      [phone]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/shipments/lookup:', err.message);
    res.status(500).json({ error: 'Failed to lookup' });
  }
});

// Admin list — full inventory
app.get('/api/shipments', requireAdmin, async (req, res) => {
  if (!dbReady) return res.json([]);
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const { rows } = await pool.query(
      `SELECT id, created_at, phone, tracking_code, courier, note
       FROM shipments ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/shipments:', err.message);
    res.status(500).json({ error: 'Failed to load' });
  }
});

app.post('/api/shipments', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const phone = normalizePhone(req.body?.phone);
    const tracking_code = String(req.body?.tracking_code || '').trim();
    const courier = String(req.body?.courier || '').trim() || null;
    const note = String(req.body?.note || '').trim() || null;
    if (!phone || phone.length < 4) return res.status(400).json({ error: 'Invalid phone' });
    if (!tracking_code) return res.status(400).json({ error: 'Tracking code required' });
    const { rows } = await pool.query(
      `INSERT INTO shipments (phone, tracking_code, courier, note)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [phone, tracking_code, courier, note]
    );
    res.json({ id: rows[0].id, created_at: rows[0].created_at });
  } catch (err) {
    console.error('POST /api/shipments:', err.message);
    res.status(500).json({ error: 'Failed to save' });
  }
});

app.delete('/api/shipments/:id', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    await pool.query('DELETE FROM shipments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// ===== LUCKY BOX API =====
app.get('/api/lucky-cards', async (req, res) => {
  if (!dbReady) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT id, created_at, label, image_url FROM lucky_cards ORDER BY created_at ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/lucky-cards:', err.message);
    res.status(500).json({ error: 'Failed to load cards' });
  }
});

app.post('/api/lucky-cards', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const label = String(req.body?.label || '').trim();
    const image_url = String(req.body?.image_url || '').trim() || null;
    if (!label) return res.status(400).json({ error: 'Label required' });
    if (label.length > 120) return res.status(400).json({ error: 'Label too long' });
    if (image_url && image_url.length > 4_000_000) return res.status(413).json({ error: 'Image too large' });
    const { rows } = await pool.query(
      `INSERT INTO lucky_cards (label, image_url) VALUES ($1, $2)
       RETURNING id, created_at, label, image_url`,
      [label, image_url]
    );
    io.emit('lucky-cards-updated');
    res.json(rows[0]);
  } catch (err) {
    console.error('POST /api/lucky-cards:', err.message);
    res.status(500).json({ error: 'Failed to save card' });
  }
});

app.delete('/api/lucky-cards/:id', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    await pool.query('DELETE FROM lucky_cards WHERE id = $1', [req.params.id]);
    io.emit('lucky-cards-updated');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

app.delete('/api/lucky-cards', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    await pool.query('DELETE FROM lucky_cards');
    io.emit('lucky-cards-updated');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear' });
  }
});

app.get('/api/lucky-draws', async (req, res) => {
  if (!dbReady) return res.json([]);
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const { rows } = await pool.query(
      `SELECT id, created_at, card_label, image_url, drawn_by
       FROM lucky_draws ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/lucky-draws:', err.message);
    res.status(500).json({ error: 'Failed to load draws' });
  }
});

// Public: anyone can draw
app.post('/api/lucky-draws', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const card_label = String(req.body?.card_label || '').trim();
    const image_url = String(req.body?.image_url || '').trim() || null;
    const drawn_by = String(req.body?.drawn_by || '').trim().slice(0, 60) || null;
    if (!card_label) return res.status(400).json({ error: 'Card required' });
    const { rows } = await pool.query(
      `INSERT INTO lucky_draws (card_label, image_url, drawn_by)
       VALUES ($1, $2, $3) RETURNING id, created_at, card_label, image_url, drawn_by`,
      [card_label, image_url, drawn_by]
    );
    io.emit('lucky-draw-made', rows[0]);
    res.json(rows[0]);
  } catch (err) {
    console.error('POST /api/lucky-draws:', err.message);
    res.status(500).json({ error: 'Failed to save draw' });
  }
});

app.delete('/api/lucky-draws', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    await pool.query('DELETE FROM lucky_draws');
    io.emit('lucky-draws-cleared');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear' });
  }
});

// ===== AUCTIONS API =====
function rowToAuction(r) {
  return {
    id: r.id,
    created_at: r.created_at,
    title: r.title,
    description: r.description,
    image_url: r.image_url,
    image_count: r.image_count != null ? Number(r.image_count) : 0,
    starting_price: Number(r.starting_price),
    min_increment: Number(r.min_increment || 0),
    current_bid: r.current_bid != null ? Number(r.current_bid) : null,
    current_bidder: r.current_bidder,
    ends_at: r.ends_at,
    closed: !!r.closed,
    closed_at: r.closed_at,
  };
}

app.get('/api/auctions', async (req, res) => {
  if (!dbReady) return res.json({ active: [], history: [] });
  try {
    // Join image counts but never fetch the full gallery here — at 100-200
    // photos per auction the JSON would balloon to hundreds of MB.
    const active = await pool.query(
      `SELECT a.*, COALESCE(i.cnt, 0) AS image_count
         FROM auctions a
         LEFT JOIN (SELECT auction_id, COUNT(*) AS cnt FROM auction_images GROUP BY auction_id) i
           ON i.auction_id = a.id
         WHERE a.closed = FALSE ORDER BY a.ends_at ASC`
    );
    const history = await pool.query(
      `SELECT a.*, COALESCE(i.cnt, 0) AS image_count
         FROM auctions a
         LEFT JOIN (SELECT auction_id, COUNT(*) AS cnt FROM auction_images GROUP BY auction_id) i
           ON i.auction_id = a.id
         WHERE a.closed = TRUE ORDER BY a.closed_at DESC LIMIT 30`
    );
    res.json({
      active: active.rows.map(rowToAuction),
      history: history.rows.map(rowToAuction),
    });
  } catch (err) {
    console.error('GET /api/auctions:', err.message);
    res.status(500).json({ error: 'Failed to load' });
  }
});

// Fetch the full gallery for one auction. Loaded on demand because each
// row contains a base64 data-URL.
app.get('/api/auctions/:id/images', async (req, res) => {
  if (!dbReady) return res.json([]);
  try {
    const id = +req.params.id;
    const { rows } = await pool.query(
      `SELECT id, image_url, sort_order, created_at FROM auction_images
         WHERE auction_id = $1 ORDER BY sort_order ASC, id ASC`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

const MAX_IMAGE_BYTES = 700_000; // ~500 KB binary → ~700 KB base64
const MAX_IMAGES_PER_AUCTION = 250;

app.post('/api/auctions/:id/images', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const id = +req.params.id;
    const incoming = Array.isArray(req.body?.images) ? req.body.images : [];
    if (!incoming.length) return res.status(400).json({ error: 'No images' });
    // Cap individual image + total count
    for (const img of incoming) {
      if (typeof img !== 'string' || !img) return res.status(400).json({ error: 'Bad image' });
      if (img.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'Gambar terlalu besar (maks 500 KB)' });
    }
    const { rows: cnt } = await pool.query('SELECT COUNT(*)::INT AS c FROM auction_images WHERE auction_id = $1', [id]);
    const remaining = MAX_IMAGES_PER_AUCTION - (cnt[0]?.c || 0);
    if (remaining <= 0) return res.status(413).json({ error: `Maksimal ${MAX_IMAGES_PER_AUCTION} foto per lelang` });
    const toInsert = incoming.slice(0, remaining);
    // Bulk insert in one query
    const values = [];
    const params = [];
    let p = 1;
    const startSort = cnt[0]?.c || 0;
    toInsert.forEach((img, i) => {
      values.push(`($${p++}, $${p++}, $${p++})`);
      params.push(id, img, startSort + i);
    });
    const { rows } = await pool.query(
      `INSERT INTO auction_images (auction_id, image_url, sort_order)
         VALUES ${values.join(', ')}
         RETURNING id, image_url, sort_order, created_at`,
      params
    );
    io.emit('auction-images-added', { auction_id: id, count: rows.length });
    res.json({ added: rows.length, dropped: incoming.length - toInsert.length, images: rows });
  } catch (err) {
    console.error('POST images:', err.message);
    res.status(500).json({ error: 'Gagal mengunggah' });
  }
});

app.delete('/api/auctions/images/:imgId', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const imgId = +req.params.imgId;
    const { rows } = await pool.query('DELETE FROM auction_images WHERE id = $1 RETURNING auction_id', [imgId]);
    const auctionId = rows[0]?.auction_id;
    if (auctionId) io.emit('auction-image-deleted', { auction_id: auctionId, image_id: imgId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/api/auctions', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '').trim() || null;
    const image_url = String(req.body?.image_url || '').trim() || null;
    const starting_price = Number(req.body?.starting_price) || 0;
    const min_increment = Number(req.body?.min_increment) || 0;
    const duration_seconds = Math.max(60, Math.min(7 * 24 * 3600, Number(req.body?.duration_seconds) || 3600));
    if (!title) return res.status(400).json({ error: 'Title required' });
    if (image_url && image_url.length > 4_000_000) return res.status(413).json({ error: 'Image too large' });
    const ends_at = new Date(Date.now() + duration_seconds * 1000);
    const { rows } = await pool.query(
      `INSERT INTO auctions (title, description, image_url, starting_price, min_increment, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [title, description, image_url, starting_price, min_increment, ends_at]
    );
    const row = rowToAuction(rows[0]);
    io.emit('auction-created', row);
    res.json(row);
  } catch (err) {
    console.error('POST /api/auctions:', err.message);
    res.status(500).json({ error: 'Failed to create' });
  }
});

app.patch('/api/auctions/:id', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const id = parseInt(req.params.id);
    const fields = [];
    const values = [];
    let i = 1;
    if (req.body?.current_bid !== undefined) {
      fields.push(`current_bid = $${i++}`);
      values.push(Number(req.body.current_bid) || 0);
    }
    if (req.body?.current_bidder !== undefined) {
      fields.push(`current_bidder = $${i++}`);
      values.push(String(req.body.current_bidder || '').trim().slice(0, 120) || null);
    }
    if (req.body?.title !== undefined) {
      fields.push(`title = $${i++}`);
      values.push(String(req.body.title).trim().slice(0, 200));
    }
    if (req.body?.description !== undefined) {
      fields.push(`description = $${i++}`);
      values.push(String(req.body.description || '').trim() || null);
    }
    if (req.body?.image_url !== undefined) {
      const img = String(req.body.image_url || '').trim();
      if (img.length > 4_000_000) return res.status(413).json({ error: 'Image too large' });
      fields.push(`image_url = $${i++}`);
      values.push(img || null);
    }
    if (req.body?.starting_price !== undefined) {
      fields.push(`starting_price = $${i++}`);
      values.push(Number(req.body.starting_price) || 0);
    }
    if (req.body?.min_increment !== undefined) {
      fields.push(`min_increment = $${i++}`);
      values.push(Number(req.body.min_increment) || 0);
    }
    if (req.body?.extend_seconds !== undefined) {
      const ext = Math.min(24 * 3600, Math.max(0, Number(req.body.extend_seconds) || 0));
      fields.push(`ends_at = ends_at + ($${i++} || ' seconds')::interval`);
      values.push(String(ext));
    }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    values.push(id);
    const { rows } = await pool.query(
      `UPDATE auctions SET ${fields.join(', ')} WHERE id = $${i} AND closed = FALSE RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Auction not found or closed' });
    const row = rowToAuction(rows[0]);
    io.emit('auction-updated', row);
    res.json(row);
  } catch (err) {
    console.error('PATCH /api/auctions:', err.message);
    res.status(500).json({ error: 'Failed to update' });
  }
});

app.post('/api/auctions/:id/close', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const { rows } = await pool.query(
      `UPDATE auctions SET closed = TRUE, closed_at = NOW() WHERE id = $1 AND closed = FALSE RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const row = rowToAuction(rows[0]);
    io.emit('auction-closed', row);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: 'Failed to close' });
  }
});

app.delete('/api/auctions/:id', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const id = parseInt(req.params.id);
    await pool.query('DELETE FROM auctions WHERE id = $1', [id]);
    io.emit('auction-deleted', { id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

app.delete('/api/auctions', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const scope = req.query.scope || 'history';
    if (scope === 'all') {
      await pool.query('DELETE FROM auctions');
    } else {
      await pool.query('DELETE FROM auctions WHERE closed = TRUE');
    }
    io.emit('auctions-cleared', { scope });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear' });
  }
});

// ===== SCORE PREDICTIONS =====

async function loadMatchWithStats(id) {
  const { rows } = await pool.query(
    `SELECT m.*, COUNT(e.id)::INT AS entry_count
       FROM prediction_matches m
       LEFT JOIN prediction_entries e ON e.match_id = m.id
       WHERE m.id = $1
       GROUP BY m.id`,
    [id]
  );
  return rows[0] || null;
}

app.get('/api/predictions/matches', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const { rows } = await pool.query(
      `SELECT m.*, COUNT(e.id)::INT AS entry_count
         FROM prediction_matches m
         LEFT JOIN prediction_entries e ON e.match_id = m.id
         GROUP BY m.id
         ORDER BY m.created_at DESC
         LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/predictions/matches:', err.message);
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/predictions/matches/:id', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const id = +req.params.id;
    const match = await loadMatchWithStats(id);
    if (!match) return res.status(404).json({ error: 'Not found' });
    const { rows: entries } = await pool.query(
      `SELECT id, match_id, name, phone, predicted_home, predicted_away, created_at
         FROM prediction_entries WHERE match_id = $1 ORDER BY created_at ASC`,
      [id]
    );
    res.json({ match, entries });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

const MAX_PRIZE_IMAGE_BYTES = 1_400_000; // ~1 MB binary → ~1.4 MB base64

function parseTime(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d;
}

app.post('/api/predictions/matches', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const label = String(req.body.label || '').trim();
    if (!label) return res.status(400).json({ error: 'Label wajib diisi' });
    const prize_label = String(req.body.prize_label || '').trim() || null;
    const prize_image = req.body.prize_image ? String(req.body.prize_image) : null;
    const opens_at = parseTime(req.body.opens_at);
    const closes_at = parseTime(req.body.closes_at);
    if (opens_at && closes_at && opens_at >= closes_at) {
      return res.status(400).json({ error: 'Jam buka harus sebelum jam tutup' });
    }
    if (prize_image && prize_image.length > MAX_PRIZE_IMAGE_BYTES) {
      return res.status(413).json({ error: 'Gambar hadiah terlalu besar (maks 1 MB)' });
    }
    const { rows } = await pool.query(
      `INSERT INTO prediction_matches (label, prize_label, prize_image, opens_at, closes_at) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [label, prize_label, prize_image, opens_at, closes_at]
    );
    const match = { ...rows[0], entry_count: 0 };
    io.emit('prediction-match-created', match);
    res.json(match);
  } catch (err) {
    console.error('POST predictions:', err.message);
    res.status(500).json({ error: 'Failed' });
  }
});

app.patch('/api/predictions/matches/:id', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const id = +req.params.id;
    const { label, status, final_home, final_away, prize_label, prize_image, opens_at, closes_at } = req.body;
    if (prize_image && typeof prize_image === 'string' && prize_image.length > MAX_PRIZE_IMAGE_BYTES) {
      return res.status(413).json({ error: 'Gambar hadiah terlalu besar (maks 1 MB)' });
    }
    const sets = [];
    const params = [];
    let i = 1;
    if (label != null)        { sets.push(`label = $${i++}`);        params.push(String(label).trim()); }
    if (status != null)       { sets.push(`status = $${i++}`);       params.push(String(status));       }
    if (final_home != null)   { sets.push(`final_home = $${i++}`);   params.push(+final_home);          }
    if (final_away != null)   { sets.push(`final_away = $${i++}`);   params.push(+final_away);          }
    if (prize_label != null)  { sets.push(`prize_label = $${i++}`);  params.push(String(prize_label).trim() || null); }
    if (prize_image !== undefined) {
      sets.push(`prize_image = $${i++}`);
      params.push(prize_image ? String(prize_image) : null);
    }
    if (opens_at !== undefined) {
      sets.push(`opens_at = $${i++}`);
      params.push(opens_at === '' || opens_at === null ? null : parseTime(opens_at));
    }
    if (closes_at !== undefined) {
      sets.push(`closes_at = $${i++}`);
      params.push(closes_at === '' || closes_at === null ? null : parseTime(closes_at));
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields' });
    params.push(id);
    await pool.query(`UPDATE prediction_matches SET ${sets.join(', ')} WHERE id = $${i}`, params);
    const match = await loadMatchWithStats(id);
    io.emit('prediction-match-updated', match);
    res.json(match);
  } catch (err) {
    console.error('PATCH predictions:', err.message);
    res.status(500).json({ error: 'Failed' });
  }
});

app.delete('/api/predictions/matches/:id', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const id = +req.params.id;
    await pool.query('DELETE FROM prediction_matches WHERE id = $1', [id]);
    io.emit('prediction-match-deleted', { id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/api/predictions/matches/:id/entries', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const id = +req.params.id;
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').replace(/[^\d+]/g, '');
    const ph = +req.body.predicted_home;
    const pa = +req.body.predicted_away;
    if (!name) return res.status(400).json({ error: 'Nama wajib diisi' });
    if (!phone || phone.length < 4) return res.status(400).json({ error: 'Nomor HP tidak valid' });
    if (!Number.isFinite(ph) || ph < 0 || ph > 99) return res.status(400).json({ error: 'Skor tidak valid' });
    if (!Number.isFinite(pa) || pa < 0 || pa > 99) return res.status(400).json({ error: 'Skor tidak valid' });
    const m = await loadMatchWithStats(id);
    if (!m) return res.status(404).json({ error: 'Match tidak ditemukan' });
    if (m.status !== 'open') return res.status(400).json({ error: 'Prediksi sudah ditutup' });
    // Time-window enforcement: opens_at and closes_at gate the submission
    // window even if status is still 'open'. (auto-close cron flips status
    // periodically, but this guard is the authoritative check at the
    // moment of insert.)
    const now = new Date();
    if (m.opens_at && now < new Date(m.opens_at)) {
      return res.status(400).json({ error: `Prediksi belum dibuka. Mulai jam ${new Date(m.opens_at).toLocaleString('id-ID')}` });
    }
    if (m.closes_at && now > new Date(m.closes_at)) {
      return res.status(400).json({ error: 'Prediksi sudah ditutup (lewat batas waktu)' });
    }
    let entry;
    try {
      const { rows } = await pool.query(
        `INSERT INTO prediction_entries (match_id, name, phone, predicted_home, predicted_away)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [id, name, phone, ph, pa]
      );
      entry = rows[0];
    } catch (insertErr) {
      // Postgres 23505 = unique_violation — the (match,home,away) score
      // is already claimed by another user.
      if (insertErr && insertErr.code === '23505') {
        return res.status(409).json({ error: `Skor ${ph}-${pa} sudah dipilih orang lain. Coba skor lain.` });
      }
      throw insertErr;
    }
    io.emit('prediction-entry-added', entry);
    res.json(entry);
  } catch (err) {
    console.error('POST prediction:', err.message);
    res.status(500).json({ error: 'Gagal menyimpan' });
  }
});

app.delete('/api/predictions/entries/:id', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const id = +req.params.id;
    const { rows } = await pool.query('DELETE FROM prediction_entries WHERE id = $1 RETURNING match_id', [id]);
    const matchId = rows[0]?.match_id;
    io.emit('prediction-entry-deleted', { id, match_id: matchId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// Periodically auto-close auctions whose ends_at has passed
async function autoCloseAuctions() {
  if (!dbReady) return;
  try {
    const { rows } = await pool.query(
      `UPDATE auctions SET closed = TRUE, closed_at = NOW()
       WHERE closed = FALSE AND ends_at <= NOW() RETURNING *`
    );
    for (const r of rows) io.emit('auction-closed', rowToAuction(r));
  } catch (err) {
    console.error('autoCloseAuctions:', err.message);
  }
}
setInterval(autoCloseAuctions, 5000);

// Auto-close prediction matches whose closes_at has passed.
async function autoClosePredictions() {
  if (!dbReady) return;
  try {
    const { rows } = await pool.query(
      `UPDATE prediction_matches SET status = 'closed'
         WHERE status = 'open' AND closes_at IS NOT NULL AND closes_at <= NOW()
         RETURNING *`
    );
    for (const r of rows) {
      const match = await loadMatchWithStats(r.id);
      io.emit('prediction-match-updated', match);
    }
  } catch (err) {
    console.error('autoClosePredictions:', err.message);
  }
}
setInterval(autoClosePredictions, 10000);

// ===== LIVE RACE (single global state) =====
const liveRace = {
  state: 'idle',        // 'idle' | 'setup' | 'countdown' | 'racing' | 'results'
  players: [],          // [{ name, colorIdx }]
  settings: { duration: 10, fairMode: false },
  racers: null,         // during/after race: [{ name, colorIdx }]
  positions: null,      // during race
  phases: null,         // during race: per-racer 'sprinting' | 'running' | 'tired'
  finished: null,       // during race: per-racer bool
  commentary: '',
  commentaryType: '',
  startTime: 0,         // Date.now() when admin started the race — lets late joiners sync their clock
  lastResults: null,    // { results: [...], racers: [...] }
};

function publicState() {
  return {
    state: liveRace.state,
    players: liveRace.players,
    settings: liveRace.settings,
    racers: liveRace.racers,
    positions: liveRace.positions,
    phases: liveRace.phases,
    finished: liveRace.finished,
    commentary: liveRace.commentary,
    commentaryType: liveRace.commentaryType,
    startTime: liveRace.startTime,
    serverNow: Date.now(),
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

  socket.on('race-lobby', data => {
    if (!isAdmin) return;
    liveRace.state = 'lobby';
    liveRace.lastResults = null;
    liveRace.racers = data.racers;
    liveRace.positions = data.racers.map(() => 0);
    socket.broadcast.emit('race-lobby', data);
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
    liveRace.phases    = data.racers.map(() => 'running');
    liveRace.finished  = data.racers.map(() => false);
    liveRace.startTime = Date.now();
    // Tag the broadcast with the authoritative start time so viewers
    // can offset their local clocks instead of using their own performance.now().
    socket.broadcast.emit('race-started', { ...data, startTime: liveRace.startTime, serverNow: Date.now() });
  });

  socket.on('race-update', data => {
    if (!isAdmin) return;
    liveRace.positions      = data.positions;
    liveRace.phases         = data.phases    || liveRace.phases;
    liveRace.finished       = data.finished  || liveRace.finished;
    liveRace.commentary     = data.commentary;
    liveRace.commentaryType = data.commentaryType || '';
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
    liveRace.phases = null;
    liveRace.finished = null;
    liveRace.commentary = '';
    liveRace.commentaryType = '';
    liveRace.startTime = 0;
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
    if (adminSockets.size === 0 && (liveRace.state === 'lobby' || liveRace.state === 'countdown' || liveRace.state === 'racing')) {
      setTimeout(() => {
        if (adminSockets.size === 0 && (liveRace.state === 'lobby' || liveRace.state === 'countdown' || liveRace.state === 'racing')) {
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

const PORT = process.env.PORT || 3001;
initDB().then(() => {
  server.listen(PORT, () => console.log(`Football Race on port ${PORT}`));
});
