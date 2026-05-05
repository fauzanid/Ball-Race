// Load .env for local dev (Railway sets env vars natively, so this is a no-op
// in production unless a .env file is checked in — which it isn't, see .gitignore).
require('dotenv').config();
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const multer = require('multer');
const sharp = require('sharp');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
// Gzip/deflate every text response — typically 70-80% smaller on the wire
// for the inline-HTML bundle and JSON API responses. Configured with the
// default threshold (1 KB) so small replies skip compression overhead.
app.use(compression());

// Trust the first proxy header (Railway / Cloudflare) so rate-limit keys
// off the real client IP instead of the load balancer.
app.set('trust proxy', 1);

// ===== Rate limiters =====
// Tight limiter for admin login — 5 attempts/min/IP makes brute-forcing the
// password infeasible. The default 401 still lets legitimate retries through.
const loginLimiter = rateLimit({
  windowMs: 60_000, max: 5,
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan login. Coba lagi 1 menit lagi.' },
});
// Public submit endpoints — generous for normal users, tight enough that
// a single IP can't flood the DB.
const submitLimiter = rateLimit({
  windowMs: 60_000, max: 15,
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Terlalu banyak request. Coba lagi sebentar lagi.' },
});
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ===== R2 (Cloudflare object storage) =====
// Set these in Railway env vars:
//   R2_ENDPOINT          e.g. https://<accountid>.r2.cloudflarestorage.com
//   R2_ACCESS_KEY_ID
//   R2_SECRET_ACCESS_KEY
//   R2_BUCKET            e.g. ball-race
//   R2_PUBLIC_URL        e.g. https://media.karboluxe.com  (no trailing slash)
const R2_ENDPOINT  = process.env.R2_ENDPOINT  || '';
const R2_BUCKET    = process.env.R2_BUCKET    || '';
const R2_PUBLIC    = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
const r2Configured = !!(R2_ENDPOINT && R2_BUCKET && R2_PUBLIC && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
const r2 = r2Configured ? new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
}) : null;
if (!r2Configured) console.log('R2 not configured — uploads will fall back to base64.');

// ===== Image upload pipeline =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB raw — sharp compresses on the way in
    files: 25,
  },
});

async function processImageToWebp(buffer) {
  // EXIF auto-rotate, fit-1600, strip metadata, WebP q80. Output is
  // typically 200-500 KB regardless of input size.
  return sharp(buffer)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

async function uploadToR2(key, buffer, contentType = 'image/webp') {
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return `${R2_PUBLIC}/${key}`;
}

async function deleteR2Object(url) {
  if (!r2 || !url || !url.startsWith(R2_PUBLIC + '/')) return;
  const key = url.slice(R2_PUBLIC.length + 1);
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (err) {
    console.warn('R2 delete failed', key, err.message);
  }
}

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
    // Live auctions are held on Facebook Live — link viewers to the stream.
    await pool.query(`ALTER TABLE auctions ADD COLUMN IF NOT EXISTS facebook_url TEXT`);
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
    // MVP of the Month — standings tagged by month so viewers can browse
    // past months. Month is stored as 'YYYY-MM' so it sorts as text.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mvp_entries (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        name VARCHAR(80) NOT NULL,
        points INT NOT NULL DEFAULT 0
      )
    `);
    // Additive migration for existing installs
    await pool.query(`ALTER TABLE mvp_entries ADD COLUMN IF NOT EXISTS month VARCHAR(7)`);
    await pool.query(`UPDATE mvp_entries SET month = TO_CHAR(created_at, 'YYYY-MM') WHERE month IS NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mvp_month_points ON mvp_entries (month, points DESC)`);
    // Up to 10 prizes per month (1st through 10th) — admin can attach a
    // label + image per place visible to everyone as motivation. Place 1
    // reuses the original prize_label / prize_image columns so historical
    // rows automatically become the 1st-place prize.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mvp_prizes (
        month VARCHAR(7) PRIMARY KEY,
        prize_label VARCHAR(200),
        prize_image TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    for (let p = 2; p <= 10; p++) {
      await pool.query(`ALTER TABLE mvp_prizes ADD COLUMN IF NOT EXISTS prize_label_${p} VARCHAR(200)`);
      await pool.query(`ALTER TABLE mvp_prizes ADD COLUMN IF NOT EXISTS prize_image_${p} TEXT`);
    }
    // Standings movement — Billboard-style two-publish snapshot per month.
    // `ranks` holds the last published rankings; `prev_ranks` holds the
    // publish before that. ▲▼ chips compare live → prev_ranks while no
    // edits have happened since the last publish (so just-published
    // movements stay visible), and live → ranks after admin edits.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mvp_snapshots (
        month VARCHAR(7) PRIMARY KEY,
        captured_at TIMESTAMPTZ DEFAULT NOW(),
        ranks JSONB NOT NULL,
        prev_ranks JSONB,
        entries JSONB
      )
    `);
    await pool.query(`ALTER TABLE mvp_snapshots ADD COLUMN IF NOT EXISTS prev_ranks JSONB`);
    // `entries` holds the full published list (id, name, points, rank) so
    // viewers see a frozen Billboard-style chart while admin keeps tweaking
    // mvp_entries privately.
    await pool.query(`ALTER TABLE mvp_snapshots ADD COLUMN IF NOT EXISTS entries JSONB`);
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

// Optional admin check — returns true if the request carries a valid admin
// token, false otherwise. Used to decide whether to mask sensitive fields
// in public-readable responses (e.g. predictor phone numbers).
function isAdminReq(req) {
  const token = req.headers['x-admin-token'] || '';
  return validTokens.has(token);
}

// Server-side phone mask: 0812****5678. Keeps first 3 + last 3 digits so the
// admin can still recognize repeat predictors but viewers can't scrape PII.
function maskPhone(p) {
  if (!p || typeof p !== 'string') return '';
  if (p.length < 6) return p;
  return p.slice(0, 3) + '****' + p.slice(-3);
}

// Whitelist for image URLs we'll accept from admin uploads. Blocks
// `javascript:`, `vbscript:`, `file:` and anything else that would be
// XSS-active when rendered as <img src=>. Strict to https + data:image/
// since those are the only schemes our pipeline actually produces.
function isValidImageUrl(s) {
  if (typeof s !== 'string' || !s) return false;
  return /^https:\/\/[^\s]/i.test(s) || /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);/i.test(s);
}

// Permissive https-url check for outbound links (Facebook Live, etc.).
// Blocks javascript:/data:/file: and other XSS-active schemes when this
// value is later rendered as <a href>.
function isValidHttpsUrl(s) {
  if (typeof s !== 'string' || !s) return false;
  try { return new URL(s).protocol === 'https:'; } catch { return false; }
}

// Coerce a route param to a positive integer in the Postgres int4 range;
// returns null on bad input. Used at the route boundary so scanner
// probes ("0 OR 1=1", "1'", etc.) get rejected before they reach the
// DB and clutter the logs with invalid-integer cast errors.
function parseIntId(s) {
  if (typeof s !== 'string' || !/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 2_147_483_647 ? n : null;
}

app.post('/api/admin/login', loginLimiter, (req, res) => {
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

// ===== IMAGE UPLOAD =====
// Accepts one or more files under field name "files" (multipart/form-data).
// Optional `folder` form field controls the R2 key prefix (default: "uploads").
// Returns { results: [{ url, bytes, width, height }] }.
app.post('/api/upload', requireAdmin, upload.array('files', 25), async (req, res) => {
  if (!r2) return res.status(503).json({ error: 'R2 belum dikonfigurasi di server' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files' });
  const folder = String(req.body.folder || 'uploads').replace(/[^a-z0-9_\-/]/gi, '');
  try {
    const results = await Promise.all(req.files.map(async (file) => {
      const webp = await processImageToWebp(file.buffer);
      const meta = await sharp(webp).metadata();
      const hash = crypto.randomBytes(8).toString('hex');
      const key = `${folder}/${Date.now()}-${hash}.webp`;
      const url = await uploadToR2(key, webp, 'image/webp');
      return { url, bytes: webp.length, width: meta.width, height: meta.height };
    }));
    res.json({ results });
  } catch (err) {
    console.error('upload:', err.message);
    res.status(500).json({ error: 'Gagal mengunggah' });
  }
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
  const id = parseIntId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'Race not found' });
  try {
    const { rows } = await pool.query('SELECT * FROM races WHERE id = $1', [id]);
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
  const id = parseIntId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'Not found' });
  try {
    await pool.query('DELETE FROM shipments WHERE id = $1', [id]);
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
    if (image_url && !isValidImageUrl(image_url)) return res.status(400).json({ error: 'Invalid image URL' });
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
  const id = parseIntId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'Not found' });
  try {
    const { rows } = await pool.query('DELETE FROM lucky_cards WHERE id = $1 RETURNING image_url', [id]);
    if (rows[0]?.image_url) deleteR2Object(rows[0].image_url);
    io.emit('lucky-cards-updated');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

app.delete('/api/lucky-cards', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const { rows } = await pool.query('DELETE FROM lucky_cards RETURNING image_url');
    rows.forEach(r => { if (r.image_url) deleteR2Object(r.image_url); });
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
app.post('/api/lucky-draws', submitLimiter, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const card_label = String(req.body?.card_label || '').trim();
    const image_url = String(req.body?.image_url || '').trim() || null;
    const drawn_by = String(req.body?.drawn_by || '').trim().slice(0, 60) || null;
    if (!card_label) return res.status(400).json({ error: 'Card required' });
    if (image_url && !isValidImageUrl(image_url)) return res.status(400).json({ error: 'Invalid image URL' });
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
    image_url: r.image_url,
    facebook_url: r.facebook_url || null,
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
  const id = parseIntId(req.params.id);
  if (id == null) return res.json([]);
  try {
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
  const id = parseIntId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'Not found' });
  try {
    const incoming = Array.isArray(req.body?.images) ? req.body.images : [];
    if (!incoming.length) return res.status(400).json({ error: 'No images' });
    // Cap individual image + total count + validate URL scheme
    for (const img of incoming) {
      if (typeof img !== 'string' || !img) return res.status(400).json({ error: 'Bad image' });
      if (img.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'Gambar terlalu besar (maks 500 KB)' });
      if (!isValidImageUrl(img)) return res.status(400).json({ error: 'Invalid image URL' });
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
    const imgId = parseIntId(req.params.imgId);
    if (imgId == null) return res.status(404).json({ error: 'Not found' });
    const { rows } = await pool.query('DELETE FROM auction_images WHERE id = $1 RETURNING auction_id, image_url', [imgId]);
    const auctionId = rows[0]?.auction_id;
    if (rows[0]?.image_url) deleteR2Object(rows[0].image_url);
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
    const image_url = String(req.body?.image_url || '').trim() || null;
    const facebook_url = String(req.body?.facebook_url || '').trim() || null;
    const duration_seconds = Math.max(60, Math.min(7 * 24 * 3600, Number(req.body?.duration_seconds) || 3600));
    if (!image_url) return res.status(400).json({ error: 'Poster wajib diunggah' });
    if (image_url.length > 4_000_000) return res.status(413).json({ error: 'Image too large' });
    if (!isValidImageUrl(image_url)) return res.status(400).json({ error: 'Invalid image URL' });
    if (facebook_url && !isValidHttpsUrl(facebook_url)) return res.status(400).json({ error: 'Link Facebook harus diawali https://' });
    const ends_at = new Date(Date.now() + duration_seconds * 1000);
    const { rows } = await pool.query(
      `INSERT INTO auctions (title, image_url, facebook_url, ends_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title || 'Lelang Live', image_url, facebook_url, ends_at]
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
  const id = parseIntId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'Auction not found' });
  try {
    const fields = [];
    const values = [];
    let i = 1;
    if (req.body?.title !== undefined) {
      fields.push(`title = $${i++}`);
      values.push(String(req.body.title).trim().slice(0, 200) || 'Lelang Live');
    }
    if (req.body?.facebook_url !== undefined) {
      const fb = String(req.body.facebook_url || '').trim() || null;
      if (fb && !isValidHttpsUrl(fb)) return res.status(400).json({ error: 'Link Facebook harus diawali https://' });
      fields.push(`facebook_url = $${i++}`);
      values.push(fb);
    }
    let oldImageUrl = null;
    let newImageUrl = null;
    if (req.body?.image_url !== undefined) {
      const img = String(req.body.image_url || '').trim();
      if (img.length > 4_000_000) return res.status(413).json({ error: 'Image too large' });
      if (img && !isValidImageUrl(img)) return res.status(400).json({ error: 'Invalid image URL' });
      // Capture the existing image so we can clean it from R2 once the
      // new value is saved. Skipping the lookup if the field isn't being
      // changed avoids an unnecessary query.
      const cur = await pool.query('SELECT image_url FROM auctions WHERE id = $1', [id]);
      oldImageUrl = cur.rows[0]?.image_url || null;
      newImageUrl = img || null;
      fields.push(`image_url = $${i++}`);
      values.push(newImageUrl);
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
    // Successfully updated — now clean up the orphaned R2 object if the
    // image actually changed.
    if (oldImageUrl && oldImageUrl !== newImageUrl) deleteR2Object(oldImageUrl);
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
  const id = parseIntId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'Not found' });
  try {
    const { rows } = await pool.query(
      `UPDATE auctions SET closed = TRUE, closed_at = NOW() WHERE id = $1 AND closed = FALSE RETURNING *`,
      [id]
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
  const id = parseIntId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'Not found' });
  try {
    // Collect every image URL (primary + gallery) before the cascade fires
    const main = await pool.query('SELECT image_url FROM auctions WHERE id = $1', [id]);
    const gal = await pool.query('SELECT image_url FROM auction_images WHERE auction_id = $1', [id]);
    await pool.query('DELETE FROM auctions WHERE id = $1', [id]); // ON DELETE CASCADE handles auction_images
    if (main.rows[0]?.image_url) deleteR2Object(main.rows[0].image_url);
    gal.rows.forEach(r => { if (r.image_url) deleteR2Object(r.image_url); });
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
    // Snapshot URLs before delete so we can clean R2
    const targetSql = scope === 'all'
      ? 'SELECT image_url FROM auctions'
      : 'SELECT image_url FROM auctions WHERE closed = TRUE';
    const galSql = scope === 'all'
      ? 'SELECT image_url FROM auction_images'
      : 'SELECT ai.image_url FROM auction_images ai JOIN auctions a ON a.id = ai.auction_id WHERE a.closed = TRUE';
    const main = await pool.query(targetSql);
    const gal = await pool.query(galSql);
    if (scope === 'all') {
      await pool.query('DELETE FROM auctions');
    } else {
      await pool.query('DELETE FROM auctions WHERE closed = TRUE');
    }
    main.rows.forEach(r => { if (r.image_url) deleteR2Object(r.image_url); });
    gal.rows.forEach(r => { if (r.image_url) deleteR2Object(r.image_url); });
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
  const id = parseIntId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'Not found' });
  try {
    const match = await loadMatchWithStats(id);
    if (!match) return res.status(404).json({ error: 'Not found' });
    const { rows: entries } = await pool.query(
      `SELECT id, match_id, name, phone, predicted_home, predicted_away, created_at
         FROM prediction_entries WHERE match_id = $1 ORDER BY created_at ASC`,
      [id]
    );
    // Public callers get a masked phone; admin sees the full number.
    const admin = isAdminReq(req);
    const safe = entries.map(e => admin ? e : { ...e, phone: maskPhone(e.phone) });
    res.json({ match, entries: safe });
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
    if (prize_image && !isValidImageUrl(prize_image)) {
      return res.status(400).json({ error: 'Invalid prize image URL' });
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
  const id = parseIntId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'Not found' });
  try {
    const { label, status, final_home, final_away, prize_label, prize_image, opens_at, closes_at } = req.body;
    if (prize_image && typeof prize_image === 'string' && prize_image.length > MAX_PRIZE_IMAGE_BYTES) {
      return res.status(413).json({ error: 'Gambar hadiah terlalu besar (maks 1 MB)' });
    }
    if (prize_image && typeof prize_image === 'string' && prize_image && !isValidImageUrl(prize_image)) {
      return res.status(400).json({ error: 'Invalid prize image URL' });
    }
    const sets = [];
    const params = [];
    let i = 1;
    if (label != null)        { sets.push(`label = $${i++}`);        params.push(String(label).trim()); }
    if (status != null)       { sets.push(`status = $${i++}`);       params.push(String(status));       }
    if (final_home != null)   { sets.push(`final_home = $${i++}`);   params.push(+final_home);          }
    if (final_away != null)   { sets.push(`final_away = $${i++}`);   params.push(+final_away);          }
    if (prize_label != null)  { sets.push(`prize_label = $${i++}`);  params.push(String(prize_label).trim() || null); }
    let oldPrizeImage = null;
    if (prize_image !== undefined) {
      // Look up current prize_image so we can clean it from R2 once the
      // new value is saved (only if this is actually a change).
      const cur = await pool.query('SELECT prize_image FROM prediction_matches WHERE id = $1', [id]);
      oldPrizeImage = cur.rows[0]?.prize_image || null;
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
    // Clean up the previous prize image from R2 once the new one is saved
    if (oldPrizeImage && oldPrizeImage !== (prize_image || null)) deleteR2Object(oldPrizeImage);
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
  const id = parseIntId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'Not found' });
  try {
    const { rows } = await pool.query('DELETE FROM prediction_matches WHERE id = $1 RETURNING prize_image', [id]);
    if (rows[0]?.prize_image) deleteR2Object(rows[0].prize_image);
    io.emit('prediction-match-deleted', { id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/api/predictions/matches/:id/entries', submitLimiter, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  const id = parseIntId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'Match not found' });
  try {
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
  const id = parseIntId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'Not found' });
  try {
    const { rows } = await pool.query('DELETE FROM prediction_entries WHERE id = $1 RETURNING match_id', [id]);
    const matchId = rows[0]?.match_id;
    io.emit('prediction-entry-deleted', { id, match_id: matchId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ===== MVP OF THE MONTH =====
function currentMonth() {
  // YYYY-MM in server local time. Use UTC if you'd rather avoid DST jumps.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function isValidMonth(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

// Distinct months that have at least one entry, plus the current month
// (so admins can always start a new month even when it's empty).
app.get('/api/mvp/months', async (req, res) => {
  if (!dbReady) return res.json([currentMonth()]);
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT month FROM mvp_entries WHERE month IS NOT NULL ORDER BY month DESC`
    );
    const months = rows.map(r => r.month);
    const cur = currentMonth();
    if (!months.includes(cur)) months.unshift(cur);
    res.json(months);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// Publish current entries as the frozen public chart for `month`. Captures
// full entry data (so viewers see a Billboard-style snapshot independent
// of admin's working state) plus rank maps for ▲▼ chip comparison. Slides
// the prior `ranks` into `prev_ranks` unless nothing changed since last
// publish (so accidental double-clicks don't erase the transition view).
async function captureMvpSnapshot(month) {
  const { rows } = await pool.query(
    `SELECT id, name, points FROM mvp_entries WHERE month = $1
       ORDER BY points DESC, name ASC`,
    [month]
  );
  const fullEntries = rows.map((r, i) => ({
    id: r.id, name: r.name, points: r.points, rank: i + 1,
  }));
  const newRanks = Object.fromEntries(fullEntries.map(e => [String(e.id), e.rank]));
  const cur = await pool.query(
    `SELECT ranks, prev_ranks FROM mvp_snapshots WHERE month = $1`, [month]
  );
  const oldRanks = cur.rows[0]?.ranks || null;
  const oldPrev = cur.rows[0]?.prev_ranks || null;
  const slidPrev = (oldRanks && ranksEqual(newRanks, oldRanks)) ? oldPrev : oldRanks;
  const result = await pool.query(
    `INSERT INTO mvp_snapshots (month, captured_at, ranks, prev_ranks, entries)
       VALUES ($1, NOW(), $2, $3, $4)
       ON CONFLICT (month) DO UPDATE
         SET captured_at = NOW(),
             ranks = EXCLUDED.ranks,
             prev_ranks = EXCLUDED.prev_ranks,
             entries = EXCLUDED.entries
       RETURNING captured_at`,
    [month, JSON.stringify(newRanks), slidPrev ? JSON.stringify(slidPrev) : null, JSON.stringify(fullEntries)]
  );
  return result.rows[0]?.captured_at || null;
}

// Two rank maps are "equal" when every key matches and every rank matches.
// Used to detect "live state == last publish" — i.e. no edits since the
// last Publish click.
function ranksEqual(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

app.get('/api/mvp', async (req, res) => {
  if (!dbReady) return res.json({ entries: [], published_at: null, draft: false });
  try {
    const month = isValidMonth(req.query.month) ? req.query.month : currentMonth();
    const isAdmin = isAdminReq(req);

    const snap = await pool.query(
      `SELECT captured_at, ranks, prev_ranks, entries FROM mvp_snapshots WHERE month = $1`,
      [month]
    );
    const last = snap.rows[0]?.ranks || null;
    const prev = snap.rows[0]?.prev_ranks || null;
    const publishedEntries = snap.rows[0]?.entries || null;
    const published_at = snap.rows[0]?.captured_at || null;

    if (isAdmin) {
      // Admin sees their live working state — every edit visible to them
      // immediately, with chips comparing live → last (or prev if live
      // hasn't diverged yet, so the just-published transition stays in
      // view). `draft` is true when admin's live state differs from the
      // published snapshot, so the UI can label "Mode draft".
      const { rows } = await pool.query(
        `SELECT id, name, points FROM mvp_entries
           WHERE month = $1 ORDER BY points DESC, name ASC`,
        [month]
      );
      const liveRanks = Object.fromEntries(rows.map((r, i) => [String(r.id), i + 1]));
      let baseline;
      if (!last) baseline = null;
      else if (ranksEqual(liveRanks, last)) baseline = prev || last;
      else baseline = last;
      const entries = rows.map((r, i) => {
        if (!baseline) return { id: r.id, name: r.name, points: r.points, movement: null };
        const prevRank = baseline[String(r.id)];
        return {
          id: r.id, name: r.name, points: r.points,
          movement: prevRank != null ? prevRank - (i + 1) : null,
        };
      });
      const draft = !!last && !ranksEqual(liveRanks, last);
      return res.json({ entries, published_at, draft });
    }

    // Viewer — frozen Billboard view. Show only the published snapshot;
    // unpublished admin edits are invisible. Chips compare published →
    // prev_ranks (the publish before this one), so each ▲▼ reflects the
    // chart-drop transition — exactly like a real chart.
    if (!publishedEntries) {
      return res.json({ entries: [], published_at: null, draft: false });
    }
    const entries = publishedEntries.map(e => ({
      id: e.id, name: e.name, points: e.points,
      movement: prev && prev[String(e.id)] != null ? prev[String(e.id)] - e.rank : null,
    }));
    res.json({ entries, published_at, draft: false });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/api/mvp/publish', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const month = isValidMonth(req.body?.month) ? req.body.month : currentMonth();
    const captured_at = await captureMvpSnapshot(month);
    io.emit('mvp-updated', { month });
    res.json({ ok: true, month, published_at: captured_at });
  } catch (err) {
    res.status(500).json({ error: 'Failed to publish' });
  }
});

app.post('/api/mvp', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const name = String(req.body.name || '').trim();
    const points = Number.isFinite(+req.body.points) ? Math.max(0, +req.body.points) : 0;
    const month = isValidMonth(req.body.month) ? req.body.month : currentMonth();
    if (!name) return res.status(400).json({ error: 'Nama wajib diisi' });
    const { rows } = await pool.query(
      `INSERT INTO mvp_entries (name, points, month) VALUES ($1, $2, $3) RETURNING *`,
      [name, points, month]
    );
    io.emit('mvp-updated', { month });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ===== MVP PRIZE PER MONTH =====
// Up to 10 prizes per month (1st through 10th place). Place 1 lives in
// the legacy `prize_label`/`prize_image` columns; places 2-10 live in
// the `_N` suffixed columns added by the migration.
// Registered BEFORE /api/mvp/:id so DELETE /api/mvp/prize doesn't get
// swallowed by the :id handler with id="prize" → NaN.
const MVP_PRIZE_PLACES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const PRIZE_COLS = Object.fromEntries(MVP_PRIZE_PLACES.map(p => [
  p,
  p === 1
    ? { label: 'prize_label',     image: 'prize_image'     }
    : { label: `prize_label_${p}`, image: `prize_image_${p}` },
]));
const PRIZE_ALL_COLS = MVP_PRIZE_PLACES.flatMap(p => [PRIZE_COLS[p].label, PRIZE_COLS[p].image]);
const PRIZE_ALL_IMG_COLS = MVP_PRIZE_PLACES.map(p => PRIZE_COLS[p].image);
function rowToPrizes(row) {
  return MVP_PRIZE_PLACES.map(place => ({
    place,
    label: row?.[PRIZE_COLS[place].label] || null,
    image: row?.[PRIZE_COLS[place].image] || null,
  }));
}
app.get('/api/mvp/prize', async (req, res) => {
  if (!dbReady) return res.json({ month: currentMonth(), prizes: rowToPrizes(null) });
  try {
    const month = isValidMonth(req.query.month) ? req.query.month : currentMonth();
    const { rows } = await pool.query(
      `SELECT month, ${PRIZE_ALL_COLS.join(', ')}, updated_at
         FROM mvp_prizes WHERE month = $1`,
      [month]
    );
    res.json({ month, prizes: rowToPrizes(rows[0]), updated_at: rows[0]?.updated_at || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.put('/api/mvp/prize', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const month = isValidMonth(req.body.month) ? req.body.month : currentMonth();
    // Accept the new shape `{ prizes: [{place,label,image}, ...] }`.
    const incoming = Array.isArray(req.body.prizes) ? req.body.prizes : [];
    const byPlace = Object.fromEntries(MVP_PRIZE_PLACES.map(p => [p, { label: null, image: null }]));
    for (const p of incoming) {
      const place = +p?.place;
      if (!MVP_PRIZE_PLACES.includes(place)) continue;
      const label = String(p.label || '').trim() || null;
      const image = p.image ? String(p.image) : null;
      if (image && image.length > MAX_PRIZE_IMAGE_BYTES) {
        return res.status(413).json({ error: `Gambar hadiah juara ${place} terlalu besar (maks 1 MB)` });
      }
      if (image && !isValidImageUrl(image)) {
        return res.status(400).json({ error: `Invalid image URL for juara ${place}` });
      }
      byPlace[place] = { label, image };
    }
    // Look up existing images so we can clean stale ones from R2 once the
    // new values are committed (matching the prediction prize pattern).
    const cur = await pool.query(
      `SELECT ${PRIZE_ALL_IMG_COLS.join(', ')} FROM mvp_prizes WHERE month = $1`,
      [month]
    );
    const oldImages = Object.fromEntries(MVP_PRIZE_PLACES.map(p => [
      p, cur.rows[0]?.[PRIZE_COLS[p].image] || null,
    ]));
    // Build INSERT ... ON CONFLICT DO UPDATE for all 21 columns (month +
    // 10×label + 10×image).
    const cols = ['month', ...PRIZE_ALL_COLS, 'updated_at'];
    const params = [month];
    for (const place of MVP_PRIZE_PLACES) {
      params.push(byPlace[place].label, byPlace[place].image);
    }
    const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
    const updates = PRIZE_ALL_COLS.map(c => `${c} = EXCLUDED.${c}`).join(', ');
    await pool.query(
      `INSERT INTO mvp_prizes (${cols.join(', ')})
       VALUES (${placeholders}, NOW())
       ON CONFLICT (month) DO UPDATE SET
         ${updates},
         updated_at = NOW()`,
      params
    );
    for (const place of MVP_PRIZE_PLACES) {
      const oldImg = oldImages[place];
      const newImg = byPlace[place].image;
      if (oldImg && oldImg !== newImg) deleteR2Object(oldImg);
    }
    io.emit('mvp-prize-updated', { month });
    res.json({ ok: true, month, prizes: MVP_PRIZE_PLACES.map(place => ({ place, ...byPlace[place] })) });
  } catch (err) {
    console.error('PUT /api/mvp/prize:', err.message);
    res.status(500).json({ error: 'Failed' });
  }
});

app.delete('/api/mvp/prize', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    const month = isValidMonth(req.query.month) ? req.query.month : null;
    if (!month) return res.status(400).json({ error: 'month required' });
    // Optional `place` param clears just that place; otherwise clear all.
    const placeParam = req.query.place != null ? +req.query.place : null;
    if (placeParam != null && !MVP_PRIZE_PLACES.includes(placeParam)) {
      return res.status(400).json({ error: 'Invalid place' });
    }
    if (placeParam) {
      const cols = PRIZE_COLS[placeParam];
      // Read old image before clearing so we can delete it from R2.
      const before = await pool.query(
        `SELECT ${cols.image} AS img FROM mvp_prizes WHERE month = $1`,
        [month]
      );
      const oldImg = before.rows[0]?.img || null;
      await pool.query(
        `UPDATE mvp_prizes
            SET ${cols.label} = NULL, ${cols.image} = NULL, updated_at = NOW()
          WHERE month = $1`,
        [month]
      );
      if (oldImg) deleteR2Object(oldImg);
    } else {
      const { rows } = await pool.query(
        `DELETE FROM mvp_prizes WHERE month = $1
           RETURNING ${PRIZE_ALL_IMG_COLS.join(', ')}`,
        [month]
      );
      const r = rows[0];
      if (r) for (const c of PRIZE_ALL_IMG_COLS) if (r[c]) deleteR2Object(r[c]);
    }
    io.emit('mvp-prize-updated', { month });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.patch('/api/mvp/:id', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  const id = parseIntId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'Not found' });
  try {
    const { name, points, delta } = req.body;
    const sets = [];
    const params = [];
    let i = 1;
    if (name != null) { sets.push(`name = $${i++}`); params.push(String(name).trim()); }
    if (points != null && Number.isFinite(+points)) { sets.push(`points = $${i++}`); params.push(Math.max(0, +points)); }
    if (delta != null && Number.isFinite(+delta)) { sets.push(`points = GREATEST(0, points + $${i++})`); params.push(+delta); }
    if (!sets.length) return res.status(400).json({ error: 'No fields' });
    sets.push(`updated_at = NOW()`);
    params.push(id);
    const { rows } = await pool.query(
      `UPDATE mvp_entries SET ${sets.join(', ')} WHERE id = $${i} RETURNING month`, params
    );
    io.emit('mvp-updated', { month: rows[0]?.month });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.delete('/api/mvp/:id', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  const id = parseIntId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'Not found' });
  try {
    const { rows } = await pool.query(
      'DELETE FROM mvp_entries WHERE id = $1 RETURNING month', [id]
    );
    io.emit('mvp-updated', { month: rows[0]?.month });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.delete('/api/mvp', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'No database' });
  try {
    // ?month=YYYY-MM clears just that month; no param clears everything.
    // Snapshot entries are wiped alongside so the next view rebuilds a
    // fresh baseline instead of comparing against deleted IDs.
    const month = isValidMonth(req.query.month) ? req.query.month : null;
    if (month) {
      await pool.query('DELETE FROM mvp_entries WHERE month = $1', [month]);
      await pool.query('DELETE FROM mvp_snapshots WHERE month = $1', [month]);
    } else {
      await pool.query('DELETE FROM mvp_entries');
      await pool.query('DELETE FROM mvp_snapshots');
    }
    io.emit('mvp-updated', { month });
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

// ===== PENALTY KICK (parallel game, separate state) =====
const livePenalty = {
  state: 'idle',        // 'idle' | 'setup' | 'shooting' | 'results'
  players: [],          // [{ name, colorIdx }]
  shots: [],            // [{ playerIdx, ballSide: 'L'|'C'|'R', keeperSide: 'L'|'C'|'R', isGoal }]
  currentIdx: 0,        // whose turn (index into shots)
  startTime: 0,
  lastResults: null,    // { players, shots, scorers: [idx], missers: [idx] }
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
    penalty: {
      state: livePenalty.state,
      players: livePenalty.players,
      shots: livePenalty.shots,
      currentIdx: livePenalty.currentIdx,
      startTime: livePenalty.startTime,
      lastResults: livePenalty.lastResults,
    },
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

  // ===== PENALTY KICK =====
  // Each player gets one shot. The admin client RNG-resolves all shots
  // up-front (same pattern race uses — server is just a relay), then
  // emits one result every PENALTY_SHOT_MS so all viewers stay synced.
  socket.on('penalty-update-players', players => {
    if (!isAdmin) return;
    livePenalty.players = players;
    if (livePenalty.state === 'idle') livePenalty.state = 'setup';
    io.emit('penalty-players-updated', players);
  });

  socket.on('penalty-start', data => {
    if (!isAdmin) return;
    livePenalty.state = 'shooting';
    livePenalty.shots = data.shots;
    livePenalty.players = data.players;
    livePenalty.currentIdx = 0;
    livePenalty.startTime = Date.now();
    socket.broadcast.emit('penalty-started', { ...data, startTime: livePenalty.startTime });
  });

  socket.on('penalty-shot-played', data => {
    if (!isAdmin) return;
    livePenalty.currentIdx = data.nextIdx;
    socket.broadcast.emit('penalty-shot-played', data);
  });

  socket.on('penalty-end', data => {
    if (!isAdmin) return;
    livePenalty.state = 'results';
    livePenalty.lastResults = data;
    socket.broadcast.emit('penalty-ended', data);
  });

  socket.on('penalty-reset', () => {
    if (!isAdmin) return;
    livePenalty.state = livePenalty.players.length > 0 ? 'setup' : 'idle';
    livePenalty.shots = [];
    livePenalty.currentIdx = 0;
    livePenalty.lastResults = null;
    livePenalty.startTime = 0;
    io.emit('penalty-reset');
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
    if (adminSockets.size === 0 && livePenalty.state === 'shooting') {
      setTimeout(() => {
        if (adminSockets.size === 0 && livePenalty.state === 'shooting') {
          livePenalty.state = livePenalty.players.length > 0 ? 'setup' : 'idle';
          livePenalty.shots = [];
          livePenalty.currentIdx = 0;
          io.emit('penalty-aborted');
        }
      }, 8000);
    }
  });
});

const PORT = process.env.PORT || 3001;
initDB().then(() => {
  server.listen(PORT, () => console.log(`Football Race on port ${PORT}`));
});
