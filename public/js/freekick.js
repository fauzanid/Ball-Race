// ═══════════════════════════════════════════════════════════════════════════
// FREE KICK — admin-driven, RNG resolves each kick, 2D canvas
// ═══════════════════════════════════════════════════════════════════════════
// Top-down pitch view. Each player gets one free kick from the spot. The
// shot may end as a goal, hit the wall, get saved by the keeper, or fly
// over. All shots are pre-resolved on the admin client; the server is a
// relay so every viewer sees the same outcomes anchored to a shared
// startTime. Depends on host-page globals: $, escapeHtml, toast, role,
// adminToken, socket, currentTab, TEAM_COLORS.

const FK_OUTCOMES = ['goal', 'wall', 'save', 'over'];
// Probability distribution. 50% goal, 15% wall, 25% save, 10% over.
const FK_OUTCOME_WEIGHTS = [0.50, 0.15, 0.25, 0.10];

// Per-shot timeline (ms, all relative to shot start):
//   0     scene reset, kicker spawned, idle pose
//   200   run-up begins
//   900   arrival at ball — wind-up pause
//   1100  ball launches along the curve
//   2000  ball arrives at outcome point; keeper finishes dive
//   2100  GOAL!/BLOK!/SAVE!/MELESET! overlay flashes
//   3200  end of shot, advance to next
const FK_SHOT_MS = 3200;
const FK_RUNUP_START = 200;
const FK_RUNUP_END = 900;
const FK_KICK_LAUNCH = 1100;
const FK_BALL_ARRIVE = 2000;
const FK_OVERLAY_START = 2100;

const fk = {
  state: 'idle',     // 'idle' | 'setup' | 'shooting' | 'results'
  players: [],       // [{ name, colorIdx }]
  shots: [],         // [{ playerIdx, outcome, side: 'L'|'R', keeperGuess: 'L'|'C'|'R' }]
  currentIdx: 0,
  startTime: 0,
  shotTimer: null,
  animFrame: null,
};

// ===== UI helpers =====

function setFreekickView(view){
  $('freekick-setup').style.display       = (view === 'setup')   ? '' : 'none';
  $('freekick-stage').style.display       = (view === 'stage')   ? '' : 'none';
  $('freekick-results-view').style.display = (view === 'results') ? '' : 'none';
  if(view === 'stage') setTimeout(resizeFreekickCanvas, 50);
}

function renderFreekickRoster(){
  const el = $('freekick-roster');
  if(!el) return;
  const isAdmin = role === 'admin';
  el.innerHTML = fk.players.map((p, i) => {
    const color = TEAM_COLORS[p.colorIdx % TEAM_COLORS.length];
    return `<div class="freekick-row" data-i="${i}" style="--team-color:${color};border-left-color:${color}">
      <div class="freekick-num">${i + 1}</div>
      <div class="freekick-color-dot" style="background:${color}"></div>
      <div class="freekick-name">${escapeHtml(p.name || '—')}</div>
      ${isAdmin ? `<button class="freekick-row-rm" data-i="${i}" title="Hapus">×</button>` : ''}
    </div>`;
  }).join('');
  if(isAdmin){
    el.querySelectorAll('.freekick-row-rm').forEach(b => {
      b.addEventListener('click', () => removeFreekickPlayer(+b.dataset.i));
    });
  }
  const kickoff = $('freekick-kickoff');
  const note = $('freekick-viewer-note');
  if(isAdmin){
    if(kickoff) kickoff.style.display = '';
    if(note) note.style.display = 'none';
    const meta = $('freekick-kickoff-meta');
    const startBtn = $('freekick-start-btn');
    const n = fk.players.length;
    if(meta) meta.textContent = n === 0
      ? 'Tambah minimal 1 pemain'
      : `${n} pemain siap untuk menendang`;
    if(startBtn) startBtn.disabled = n < 1;
  } else {
    if(kickoff) kickoff.style.display = 'none';
    if(note) note.style.display = fk.players.length ? 'none' : '';
  }
}

function broadcastFreekickPlayers(){
  if(role !== 'admin' || !socket) return;
  socket.emit('freekick-update-players', fk.players);
}

function pickFreekickColor(){
  const used = new Set(fk.players.map(p => p.colorIdx));
  for(let i = 0; i < TEAM_COLORS.length; i++) if(!used.has(i)) return i;
  return fk.players.length % TEAM_COLORS.length;
}

function addFreekickPlayer(){
  if(role !== 'admin') return;
  const input = $('freekick-name-input');
  const name = (input?.value || '').trim();
  if(!name){ toast('Isi nama pemain'); return; }
  if(fk.players.length >= 12){ toast('Maksimal 12 pemain'); return; }
  fk.players.push({ name, colorIdx: pickFreekickColor() });
  if(input){ input.value = ''; input.focus(); }
  renderFreekickRoster();
  broadcastFreekickPlayers();
}

function removeFreekickPlayer(i){
  if(role !== 'admin') return;
  fk.players.splice(i, 1);
  renderFreekickRoster();
  broadcastFreekickPlayers();
}

function shuffleFreekickPlayers(){
  if(role !== 'admin') return;
  for(let i = fk.players.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [fk.players[i], fk.players[j]] = [fk.players[j], fk.players[i]];
  }
  renderFreekickRoster();
  broadcastFreekickPlayers();
  toast('🔀 Diacak');
}

function clearFreekickPlayers(){
  if(role !== 'admin') return;
  if(!fk.players.length) return;
  if(!confirm('Kosongkan daftar pemain?')) return;
  fk.players = [];
  renderFreekickRoster();
  broadcastFreekickPlayers();
}

// ===== Game logic =====

function pickWeighted(weights){
  let r = Math.random();
  for(let i = 0; i < weights.length; i++){
    r -= weights[i];
    if(r <= 0) return i;
  }
  return weights.length - 1;
}

function rollKick(){
  // Outcome first; then pick a side (L/R for goals/overs, C is the wall
  // path for blocks). Keeper guess matches the side for saves and is
  // away from the side for goals.
  const outcome = FK_OUTCOMES[pickWeighted(FK_OUTCOME_WEIGHTS)];
  const side = Math.random() < 0.5 ? 'L' : 'R';
  let keeperGuess;
  if(outcome === 'save')      keeperGuess = side;
  else if(outcome === 'goal') keeperGuess = side === 'L' ? 'R' : 'L';
  else                        keeperGuess = 'C';
  return { outcome, side, keeperGuess };
}

function startFreekickGame(){
  if(role !== 'admin') return;
  if(fk.players.length < 1){ toast('Tambah pemain dulu'); return; }
  const shots = fk.players.map((_, idx) => ({ playerIdx: idx, ...rollKick() }));
  fk.shots = shots;
  fk.currentIdx = 0;
  fk.state = 'shooting';
  fk.startTime = Date.now();
  if(socket){
    socket.emit('freekick-start', { players: fk.players, shots, startTime: fk.startTime });
  }
  enterFreekickShooting();
}

function enterFreekickShooting(){
  setFreekickView('stage');
  runFreekickShootingLoop();
}

function runFreekickShootingLoop(){
  if(fk.state !== 'shooting') return;
  // Late-join sync — viewers entering mid-game catch up to the shot that
  // should be playing now.
  if(fk.startTime){
    const elapsed = Date.now() - fk.startTime;
    const computedIdx = Math.floor(elapsed / FK_SHOT_MS);
    if(computedIdx > fk.currentIdx) fk.currentIdx = computedIdx;
  }
  if(fk.currentIdx >= fk.shots.length){
    if(role === 'admin') finishFreekickGame();
    return;
  }
  const shot = fk.shots[fk.currentIdx];
  const player = fk.players[shot.playerIdx];
  $('freekick-current-name').textContent = (player?.name || '').toUpperCase() || '—';
  $('freekick-progress').textContent = `${fk.currentIdx + 1} / ${fk.shots.length}`;
  hideFreekickOverlay();
  startFreekickAnimation(shot, player);
  if(fk.shotTimer) clearTimeout(fk.shotTimer);
  const nextShotAt = fk.startTime + (fk.currentIdx + 1) * FK_SHOT_MS;
  const delay = Math.max(50, nextShotAt - Date.now());
  fk.shotTimer = setTimeout(() => {
    fk.currentIdx++;
    runFreekickShootingLoop();
  }, delay);
}

function finishFreekickGame(){
  fk.state = 'results';
  const scorers = fk.shots.filter(s => s.outcome === 'goal').map(s => s.playerIdx);
  const missers = fk.shots.filter(s => s.outcome !== 'goal').map(s => ({ idx: s.playerIdx, outcome: s.outcome }));
  const results = { players: fk.players, shots: fk.shots, scorers, missers };
  if(role === 'admin' && socket) socket.emit('freekick-end', results);
  showFreekickResults(results);
}

function showFreekickResults(results){
  setFreekickView('results');
  cancelFreekickAnimation();
  const scorerEl = $('freekick-results-scorers');
  const misserEl = $('freekick-results-missers');
  const tally = $('freekick-tally');
  const players = results.players;
  scorerEl.innerHTML = results.scorers.map(idx => {
    const p = players[idx]; if(!p) return '';
    const c = TEAM_COLORS[p.colorIdx % TEAM_COLORS.length];
    return `<div class="freekick-result-name" style="--team-color:${c};border-left-color:${c}">${escapeHtml(p.name)}</div>`;
  }).join('');
  misserEl.innerHTML = results.missers.map(m => {
    const p = players[m.idx]; if(!p) return '';
    const c = TEAM_COLORS[p.colorIdx % TEAM_COLORS.length];
    const tag = m.outcome === 'wall' ? 'BLOK'
              : m.outcome === 'save' ? 'SAVE'
              : 'MELESET';
    return `<div class="freekick-result-name" style="--team-color:${c};border-left-color:${c}">
      ${escapeHtml(p.name)}<span class="freekick-result-tag">${tag}</span>
    </div>`;
  }).join('');
  tally.innerHTML = `
    <div class="freekick-tally-cell scored"><div class="freekick-tally-num">${results.scorers.length}</div><div class="freekick-tally-label">Cetak Gol</div></div>
    <div class="freekick-tally-cell missed"><div class="freekick-tally-num">${results.missers.length}</div><div class="freekick-tally-label">Tidak Gol</div></div>
  `;
  document.querySelectorAll('#freekick-screen .freekick-admin-only').forEach(el => {
    el.style.display = role === 'admin' ? '' : 'none';
  });
}

function resetFreekickToSetup(){
  if(role !== 'admin') return;
  if(fk.shotTimer){ clearTimeout(fk.shotTimer); fk.shotTimer = null; }
  cancelFreekickAnimation();
  fk.state = fk.players.length ? 'setup' : 'idle';
  fk.shots = [];
  fk.currentIdx = 0;
  setFreekickView('setup');
  renderFreekickRoster();
  if(socket) socket.emit('freekick-reset');
}

// ===== 2D rendering =====

let fkCanvas = null, fkCtx = null, fkW = 0, fkH = 0, fkDpr = 1;

function resizeFreekickCanvas(){
  fkCanvas = fkCanvas || $('freekick-canvas');
  if(!fkCanvas) return;
  fkCtx = fkCtx || fkCanvas.getContext('2d');
  fkDpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = fkCanvas.getBoundingClientRect();
  fkW = Math.max(320, rect.width);
  fkH = Math.max(400, rect.height);
  fkCanvas.width  = Math.floor(fkW * fkDpr);
  fkCanvas.height = Math.floor(fkH * fkDpr);
  fkCtx.setTransform(fkDpr, 0, 0, fkDpr, 0, 0);
}

// Pitch geometry — built from real football dimensions, in metres, then
// projected to canvas pixels with a fit-to-contain scale. Reference
// values: goal 7.32 × 2.44 m, 6-yard box 18.32 × 5.5 m, 18-yard box
// 40.32 × 16.5 m, penalty spot 11 m from goal line, regulation wall
// distance 9.15 m. The visible window is 60 × 38 m so the full 18-yard
// box plus the free-kick spot and a comfortable run-up area all fit.
const FK_M = {
  FIELD_W: 60,           // visible width in metres
  FIELD_H: 38,           // visible height in metres
  GOAL_LINE_Y: 5,        // distance from top of visible window to the goal line
  GOAL_W: 7.32,
  GOAL_DEPTH: 2.5,       // visual net depth (real ≈ 2 m)
  SIX_W: 18.32,
  SIX_DEPTH: 5.5,
  EIGHTEEN_W: 40.32,
  EIGHTEEN_DEPTH: 16.5,
  PENALTY_SPOT: 11,      // from goal line
  PENALTY_ARC_R: 9.15,
  BALL_DIST: 24,         // free-kick spot distance from goal line
  WALL_DIST: 9.15,       // regulation distance from ball
  // Visual sizes (slightly larger than real for legibility on small canvases)
  BALL_R_M: 0.35,        // real ≈ 0.11 m radius — exaggerated ~3× so it reads
  PLAYER_R_M: 0.5,       // wall/kicker body radius — 4 players ≈ 4 m wall
  KEEPER_W_M: 1.4,       // keeper body width (real shoulder-to-fingertip dive ≈ 2 m)
  KEEPER_H_M: 1.0,       // keeper body depth in top-down view
};

// Projector: returns helpers that turn metres into pixels using a
// fit-to-contain scale so the pitch keeps real proportions on any
// viewport (wider canvases letterbox horizontally, taller canvases
// letterbox vertically).
function pitchGeom(){
  const W = fkW, H = fkH;
  const scale = Math.min(W / FK_M.FIELD_W, H / FK_M.FIELD_H);
  const fieldW = FK_M.FIELD_W * scale;
  const fieldH = FK_M.FIELD_H * scale;
  const offX = (W - fieldW) / 2;
  const offY = (H - fieldH) / 2;
  // Coordinate helpers — mx is metres from horizontal centre (negative = left),
  // my is metres from the top of the visible window.
  const px = mx => offX + (mx + FK_M.FIELD_W / 2) * scale;
  const py = my => offY + my * scale;
  const pl = m => m * scale;
  // Pre-resolved key pixel coords used by every draw call.
  const cx = px(0);
  const goalLeft = px(-FK_M.GOAL_W / 2);
  const goalRight = px(FK_M.GOAL_W / 2);
  const goalLineY = py(FK_M.GOAL_LINE_Y);
  const goalBackY = py(FK_M.GOAL_LINE_Y - FK_M.GOAL_DEPTH);
  const ballY = py(FK_M.GOAL_LINE_Y + FK_M.BALL_DIST);
  const wallY = py(FK_M.GOAL_LINE_Y + FK_M.BALL_DIST - FK_M.WALL_DIST);
  return {
    W, H, scale, offX, offY, fieldW, fieldH,
    px, py, pl,
    cx,
    goalLeft, goalRight,
    goalW: goalRight - goalLeft,
    goalTop: goalBackY,
    goalLineY,
    goalH: goalLineY - goalBackY,
    ballY, wallY,
  };
}

function drawPitch(g){
  const { W, H, cx, px, py, pl, goalLeft, goalRight, goalLineY, goalTop, goalH, goalW } = g;
  // Grass with subtle stripes for depth — eight 4.75 m bands across the
  // 38 m visible field, alternating shade.
  fkCtx.fillStyle = '#1d6e3a';
  fkCtx.fillRect(0, 0, W, H);
  fkCtx.fillStyle = 'rgba(0,0,0,0.06)';
  const stripeM = FK_M.FIELD_H / 8;
  for(let i = 0; i < 8; i += 2){
    const y0 = py(i * stripeM);
    const y1 = py((i + 1) * stripeM);
    fkCtx.fillRect(0, y0, W, y1 - y0);
  }

  // Line width scales with the projection so markings stay legible on
  // both small phones and big TVs.
  const lineW = Math.max(1.5, pl(0.12));
  fkCtx.strokeStyle = 'rgba(255,255,255,0.85)';
  fkCtx.lineWidth = lineW;

  // 18-yard box
  const eighteenLeft = px(-FK_M.EIGHTEEN_W / 2);
  const eighteenWidth = pl(FK_M.EIGHTEEN_W);
  const eighteenBottom = py(FK_M.GOAL_LINE_Y + FK_M.EIGHTEEN_DEPTH);
  fkCtx.strokeRect(eighteenLeft, goalLineY, eighteenWidth, eighteenBottom - goalLineY);
  // 6-yard box
  const sixLeft = px(-FK_M.SIX_W / 2);
  const sixWidth = pl(FK_M.SIX_W);
  const sixBottom = py(FK_M.GOAL_LINE_Y + FK_M.SIX_DEPTH);
  fkCtx.strokeRect(sixLeft, goalLineY, sixWidth, sixBottom - goalLineY);
  // Goal line itself (extended slightly past the box for context)
  fkCtx.beginPath();
  fkCtx.moveTo(0, goalLineY);
  fkCtx.lineTo(W, goalLineY);
  fkCtx.stroke();

  // Penalty arc — only the portion that lies outside the 18-yard box, per
  // FIFA: a 9.15 m radius from the penalty spot, drawn on the field side.
  const penaltyY = py(FK_M.GOAL_LINE_Y + FK_M.PENALTY_SPOT);
  const arcR = pl(FK_M.PENALTY_ARC_R);
  const dyToBoxEdge = eighteenBottom - penaltyY; // positive distance from spot to 18-yard line
  if(dyToBoxEdge < arcR){
    const a = Math.acos(dyToBoxEdge / arcR); // half-angle of the visible arc
    fkCtx.beginPath();
    fkCtx.arc(cx, penaltyY, arcR, Math.PI / 2 - a, Math.PI / 2 + a);
    fkCtx.stroke();
  }
  // Penalty spot (a 0.22 m diameter dot, exaggerated for visibility)
  fkCtx.fillStyle = 'rgba(255,255,255,0.95)';
  fkCtx.beginPath();
  fkCtx.arc(cx, penaltyY, Math.max(2, pl(0.2)), 0, Math.PI * 2);
  fkCtx.fill();

  // Goal posts — 0.12 m thick (regulation), drawn between the back of
  // the net and the goal line.
  const postT = Math.max(2, pl(0.12));
  fkCtx.fillStyle = '#ffffff';
  fkCtx.fillRect(goalLeft - postT / 2, goalTop, postT, goalH);
  fkCtx.fillRect(goalRight - postT / 2, goalTop, postT, goalH);
  // Crossbar (back of the visible goal mouth in top-down)
  fkCtx.fillRect(goalLeft - postT, goalTop - postT, goalW + postT * 2, postT);
  // Net interior (translucent so the keeper still reads in front of it)
  fkCtx.fillStyle = 'rgba(255,255,255,0.18)';
  fkCtx.fillRect(goalLeft, goalTop, goalW, goalH);
  // Net texture — vertical strands every 0.4 m, horizontal every 0.4 m
  fkCtx.strokeStyle = 'rgba(20,20,20,0.32)';
  fkCtx.lineWidth = 1;
  const netStepPx = Math.max(4, pl(0.4));
  for(let x = goalLeft; x <= goalRight; x += netStepPx){
    fkCtx.beginPath(); fkCtx.moveTo(x, goalTop); fkCtx.lineTo(x, goalLineY); fkCtx.stroke();
  }
  for(let y = goalTop; y <= goalLineY; y += netStepPx){
    fkCtx.beginPath(); fkCtx.moveTo(goalLeft, y); fkCtx.lineTo(goalRight, y); fkCtx.stroke();
  }

  // Free-kick spot (where the ball sits) — small white dot
  fkCtx.fillStyle = 'rgba(255,255,255,0.9)';
  fkCtx.beginPath();
  fkCtx.arc(cx, g.ballY, Math.max(2, pl(0.18)), 0, Math.PI * 2);
  fkCtx.fill();
}

function drawWall(g){
  // 4-player wall standing shoulder-to-shoulder, centred on the ball's
  // line to goal. Each player's body is rendered at PLAYER_R_M radius,
  // touching neighbours.
  const r = g.pl(FK_M.PLAYER_R_M);
  const spacing = r * 2;            // shoulder-to-shoulder
  const count = 4;
  const startX = g.cx - (count - 1) * spacing / 2;
  const wallY = g.wallY;
  for(let i = 0; i < count; i++){
    const x = startX + i * spacing;
    // shadow
    fkCtx.fillStyle = 'rgba(0,0,0,0.3)';
    fkCtx.beginPath(); fkCtx.ellipse(x + r * 0.1, wallY + r * 0.7, r * 0.9, r * 0.32, 0, 0, Math.PI * 2); fkCtx.fill();
    // body
    const grad = fkCtx.createRadialGradient(x - r * 0.3, wallY - r * 0.3, r * 0.15, x, wallY, r);
    grad.addColorStop(0, '#5288c8');
    grad.addColorStop(1, '#1a3d6b');
    fkCtx.fillStyle = grad;
    fkCtx.beginPath(); fkCtx.arc(x, wallY, r, 0, Math.PI * 2); fkCtx.fill();
    // top-of-head highlight
    fkCtx.fillStyle = 'rgba(255,255,255,0.18)';
    fkCtx.beginPath(); fkCtx.arc(x - r * 0.25, wallY - r * 0.4, r * 0.3, 0, Math.PI * 2); fkCtx.fill();
  }
}

function drawKeeper(g, t){
  // t in [0,1] — keeper's dive progress (0 = centred, 1 = at guess side).
  // Keeper sits ~0.6 m in front of the goal line and dives toward the
  // post they're guessing.
  const { cx, goalLeft, goalRight, goalLineY } = g;
  const shot = fk.shots[fk.currentIdx];
  const guess = shot?.keeperGuess || 'C';
  const guessOffset = guess === 'L' ? -FK_M.GOAL_W * 0.32
                    : guess === 'R' ? FK_M.GOAL_W * 0.32
                    : 0;
  const targetX = cx + g.pl(guessOffset);
  const x = cx + (targetX - cx) * t;
  const y = goalLineY - g.pl(0.6); // 0.6 m in front of the goal line
  const w = g.pl(FK_M.KEEPER_W_M);
  const h = g.pl(FK_M.KEEPER_H_M);
  // shadow
  fkCtx.fillStyle = 'rgba(0,0,0,0.35)';
  fkCtx.beginPath(); fkCtx.ellipse(x + g.pl(0.1), y + h * 0.6, w * 0.6, h * 0.18, 0, 0, Math.PI * 2); fkCtx.fill();
  // body — gradient capsule, tilts slightly during a dive for visual punch
  fkCtx.save();
  fkCtx.translate(x, y);
  if(t > 0.05) fkCtx.rotate((guess === 'L' ? -1 : guess === 'R' ? 1 : 0) * t * 0.35);
  const grad = fkCtx.createLinearGradient(-w / 2, 0, w / 2, 0);
  grad.addColorStop(0, '#ffd740');
  grad.addColorStop(1, '#cc7700');
  fkCtx.fillStyle = grad;
  fkCtx.beginPath();
  if(typeof fkCtx.roundRect === 'function') fkCtx.roundRect(-w / 2, -h / 2, w, h, h * 0.25);
  else fkCtx.rect(-w / 2, -h / 2, w, h);
  fkCtx.fill();
  // glove on the diving side
  fkCtx.fillStyle = '#ffffff';
  const gloveX = guess === 'L' ? -w / 2 - g.pl(0.2)
               : guess === 'R' ? w / 2 + g.pl(0.2)
               : 0;
  fkCtx.beginPath();
  fkCtx.arc(gloveX, -h * 0.1, g.pl(0.32), 0, Math.PI * 2);
  fkCtx.fill();
  fkCtx.restore();
}

function drawKicker(g, kickerY, color, kickFlash){
  const { cx } = g;
  const r = g.pl(FK_M.PLAYER_R_M);
  // shadow
  fkCtx.fillStyle = 'rgba(0,0,0,0.35)';
  fkCtx.beginPath(); fkCtx.ellipse(cx + r * 0.1, kickerY + r * 0.7, r * 0.9, r * 0.32, 0, 0, Math.PI * 2); fkCtx.fill();
  // body — coloured circle (team colour), with a head highlight
  const grad = fkCtx.createRadialGradient(cx - r * 0.3, kickerY - r * 0.3, r * 0.15, cx, kickerY, r);
  grad.addColorStop(0, color);
  grad.addColorStop(1, color);
  fkCtx.fillStyle = grad;
  fkCtx.beginPath(); fkCtx.arc(cx, kickerY, r, 0, Math.PI * 2); fkCtx.fill();
  // head highlight (suggests a shaved head or hair colour)
  fkCtx.fillStyle = 'rgba(255,255,255,0.22)';
  fkCtx.beginPath(); fkCtx.arc(cx - r * 0.25, kickerY - r * 0.4, r * 0.3, 0, Math.PI * 2); fkCtx.fill();
  // kick flash — radial yellow burst at strike moment
  if(kickFlash > 0){
    fkCtx.fillStyle = `rgba(255,235,160,${kickFlash})`;
    fkCtx.beginPath(); fkCtx.arc(cx, kickerY - r * 0.6, r * 1.6, 0, Math.PI * 2); fkCtx.fill();
  }
}

function drawBall(x, y, g, scale){
  scale = scale || 1;
  // Ball reads as airborne by scaling up slightly at flight peak.
  const r = g.pl(FK_M.BALL_R_M) * scale;
  // shadow stays ground-anchored, slightly offset down-right
  fkCtx.fillStyle = 'rgba(0,0,0,0.35)';
  fkCtx.beginPath(); fkCtx.ellipse(x + r * 0.2, y + r * 1.4, r * 0.7, r * 0.25, 0, 0, Math.PI * 2); fkCtx.fill();
  // body
  fkCtx.fillStyle = '#ffffff';
  fkCtx.beginPath(); fkCtx.arc(x, y, r, 0, Math.PI * 2); fkCtx.fill();
  // Pentagon dots — quick visual cue without spinning the ball
  fkCtx.fillStyle = '#181818';
  fkCtx.beginPath(); fkCtx.arc(x - r * 0.3, y - r * 0.15, r * 0.25, 0, Math.PI * 2); fkCtx.fill();
  fkCtx.beginPath(); fkCtx.arc(x + r * 0.4, y - r * 0.3, r * 0.18, 0, Math.PI * 2); fkCtx.fill();
  fkCtx.beginPath(); fkCtx.arc(x + r * 0.15, y + r * 0.4, r * 0.18, 0, Math.PI * 2); fkCtx.fill();
}

// Quadratic Bezier eval for ball flight curve
function qbez(t, p0, p1, p2){
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

// Compute outcome target point + curve control point in pixel space.
// All offsets are expressed in metres first and projected through the
// geom so curves keep their shape on any canvas size.
function shotTrajectory(g, shot){
  const sideSign = shot.side === 'L' ? -1 : 1;
  const startX = g.cx, startY = g.ballY;
  // Goal-mouth horizontal extents in metres (for picking a target post)
  const halfGoal = FK_M.GOAL_W / 2;
  let endXm, endYm, ctrlXm, ctrlYm;
  if(shot.outcome === 'goal'){
    // Just inside the post, curving in over the bar height — target sits
    // halfway between the goal line and the back of the net so it visibly
    // ends inside the goal.
    endXm = sideSign * halfGoal * 0.85;
    endYm = FK_M.GOAL_LINE_Y - FK_M.GOAL_DEPTH * 0.5;
    // Heavy curve: control point is well off to the side, level with the wall
    ctrlXm = sideSign * (halfGoal * 1.4);
    ctrlYm = FK_M.GOAL_LINE_Y + FK_M.BALL_DIST - FK_M.WALL_DIST - 1.5;
  } else if(shot.outcome === 'wall'){
    // Ball gets blocked just in front of the wall row, slightly off centre.
    endXm = sideSign * 0.6;
    endYm = FK_M.GOAL_LINE_Y + FK_M.BALL_DIST - FK_M.WALL_DIST + 0.5;
    ctrlXm = sideSign * 1.2;
    ctrlYm = (FK_M.GOAL_LINE_Y + FK_M.BALL_DIST + endYm) / 2;
  } else if(shot.outcome === 'save'){
    // Ball reaches the keeper, who is 0.6 m off the goal line on the
    // same side — they cover it.
    endXm = sideSign * halfGoal * 0.62;
    endYm = FK_M.GOAL_LINE_Y - 0.4;
    ctrlXm = sideSign * (halfGoal * 1.1);
    ctrlYm = FK_M.GOAL_LINE_Y + FK_M.BALL_DIST - FK_M.WALL_DIST;
  } else {
    // 'over' — flies above the crossbar (above the back-of-net y) and
    // wide of the post.
    endXm = sideSign * halfGoal * 1.2;
    endYm = FK_M.GOAL_LINE_Y - FK_M.GOAL_DEPTH - 1.5;
    ctrlXm = sideSign * (halfGoal * 1.3);
    ctrlYm = FK_M.GOAL_LINE_Y + FK_M.BALL_DIST - FK_M.WALL_DIST - 2;
  }
  return {
    startX, startY,
    ctrlX: g.px(ctrlXm), ctrlY: g.py(ctrlYm),
    endX:  g.px(endXm),  endY:  g.py(endYm),
  };
}

function startFreekickAnimation(shot, player){
  cancelFreekickAnimation();
  resizeFreekickCanvas();
  const startedAt = fk.startTime + fk.currentIdx * FK_SHOT_MS;
  const color = TEAM_COLORS[(player?.colorIdx || 0) % TEAM_COLORS.length];

  function frame(){
    if(fk.state !== 'shooting'){ fk.animFrame = null; return; }
    const elapsed = Date.now() - startedAt;
    if(elapsed >= FK_SHOT_MS){
      // Hold the final frame until the loop advances
      drawFreekickFrame(shot, color, FK_SHOT_MS);
      fk.animFrame = requestAnimationFrame(frame);
      return;
    }
    drawFreekickFrame(shot, color, elapsed);
    fk.animFrame = requestAnimationFrame(frame);
  }
  fk.animFrame = requestAnimationFrame(frame);
}

function cancelFreekickAnimation(){
  if(fk.animFrame){ cancelAnimationFrame(fk.animFrame); fk.animFrame = null; }
}

function drawFreekickFrame(shot, color, elapsed){
  if(!fkCtx || !fkW || !fkH) resizeFreekickCanvas();
  if(!fkCtx) return;
  const g = pitchGeom();
  drawPitch(g);
  drawWall(g);

  // Kicker run-up — starts 4 m behind the ball, finishes 1 m behind it
  // (roughly where the standing leg plants on a real free kick).
  const runT = elapsed < FK_RUNUP_START ? 0
             : elapsed > FK_RUNUP_END   ? 1
             : (elapsed - FK_RUNUP_START) / (FK_RUNUP_END - FK_RUNUP_START);
  const runStartY = g.ballY + g.pl(4);
  const runEndY = g.ballY + g.pl(1);
  const kickerY = runStartY + (runEndY - runStartY) * runT;
  const kickFlashFor = elapsed >= FK_RUNUP_END && elapsed < FK_KICK_LAUNCH
    ? 1 - (elapsed - FK_RUNUP_END) / (FK_KICK_LAUNCH - FK_RUNUP_END)
    : 0;
  drawKicker(g, kickerY, color, kickFlashFor);

  // Keeper dive — starts a touch before the ball arrives so it reads as
  // a reaction rather than a teleport.
  const keeperT = elapsed < (FK_KICK_LAUNCH + 100) ? 0
                : elapsed > FK_BALL_ARRIVE        ? 1
                : (elapsed - (FK_KICK_LAUNCH + 100)) / (FK_BALL_ARRIVE - FK_KICK_LAUNCH - 100);
  drawKeeper(g, keeperT);

  // Ball
  let bx, by, bs = 1;
  if(elapsed < FK_KICK_LAUNCH){
    bx = g.cx; by = g.ballY;
  } else if(elapsed >= FK_BALL_ARRIVE){
    const traj = shotTrajectory(g, shot);
    bx = traj.endX; by = traj.endY;
  } else {
    const t = (elapsed - FK_KICK_LAUNCH) / (FK_BALL_ARRIVE - FK_KICK_LAUNCH);
    const traj = shotTrajectory(g, shot);
    bx = qbez(t, traj.startX, traj.ctrlX, traj.endX);
    by = qbez(t, traj.startY, traj.ctrlY, traj.endY);
    bs = 1 + Math.sin(t * Math.PI) * 0.25; // peak at mid-flight
  }
  drawBall(bx, by, g, bs);

  // Outcome overlay
  if(elapsed >= FK_OVERLAY_START){
    showFreekickOverlay(shot.outcome);
  }
}

function showFreekickOverlay(outcome){
  const el = $('freekick-result-overlay');
  if(!el) return;
  if(el.dataset.outcome === outcome){ el.classList.add('show'); return; }
  el.dataset.outcome = outcome;
  el.className = 'freekick-result-overlay show ' + (outcome === 'goal' ? 'goal' : 'miss');
  el.textContent = outcome === 'goal' ? 'GOAL!'
                 : outcome === 'wall' ? 'BLOK!'
                 : outcome === 'save' ? 'SAVE!'
                 : 'MELESET!';
}
function hideFreekickOverlay(){
  const el = $('freekick-result-overlay');
  if(!el) return;
  el.classList.remove('show');
  el.dataset.outcome = '';
}

// ===== Bindings =====

window.addEventListener('resize', () => {
  if(currentTab === 'freekick' && fk.state === 'shooting') resizeFreekickCanvas();
});

function enterFreekickTab(){
  // Decide which view to show based on shared game state
  if(fk.state === 'shooting')      setFreekickView('stage'), runFreekickShootingLoop();
  else if(fk.state === 'results')  setFreekickView('results');
  else                             setFreekickView('setup'), renderFreekickRoster();
  // Toggle admin-only UI
  document.querySelectorAll('#freekick-screen .freekick-admin-only').forEach(el => {
    el.style.display = role === 'admin' ? '' : 'none';
  });
}
window.enterFreekickTab = enterFreekickTab;

// DOM wires
$('freekick-add-btn')?.addEventListener('click', addFreekickPlayer);
$('freekick-name-input')?.addEventListener('keydown', e => { if(e.key === 'Enter') addFreekickPlayer(); });
$('freekick-shuffle-btn')?.addEventListener('click', shuffleFreekickPlayers);
$('freekick-clear-btn')?.addEventListener('click', clearFreekickPlayers);
$('freekick-start-btn')?.addEventListener('click', startFreekickGame);
$('freekick-back-btn')?.addEventListener('click', resetFreekickToSetup);
$('freekick-replay-btn')?.addEventListener('click', startFreekickGame);

// Socket bindings — server is a relay so we mirror its events.
if(typeof socket !== 'undefined' && socket){
  socket.on('state-sync', (state) => {
    if(!state || !state.freekick) return;
    const s = state.freekick;
    fk.state = s.state || 'idle';
    fk.players = s.players || [];
    fk.shots = s.shots || [];
    fk.currentIdx = s.currentIdx || 0;
    fk.startTime = s.startTime || 0;
    if(currentTab === 'freekick') enterFreekickTab();
    if(s.state === 'results' && s.lastResults) showFreekickResults(s.lastResults);
  });
  socket.on('freekick-players-updated', (players) => {
    fk.players = players || [];
    if(fk.state === 'idle') fk.state = 'setup';
    if(currentTab === 'freekick') renderFreekickRoster();
  });
  socket.on('freekick-started', (data) => {
    fk.state = 'shooting';
    fk.shots = data.shots;
    fk.players = data.players;
    fk.currentIdx = 0;
    fk.startTime = data.startTime;
    if(currentTab === 'freekick') enterFreekickShooting();
  });
  socket.on('freekick-ended', (data) => {
    fk.state = 'results';
    if(currentTab === 'freekick') showFreekickResults(data);
  });
  socket.on('freekick-reset', () => {
    if(fk.shotTimer){ clearTimeout(fk.shotTimer); fk.shotTimer = null; }
    cancelFreekickAnimation();
    fk.state = fk.players.length ? 'setup' : 'idle';
    fk.shots = [];
    fk.currentIdx = 0;
    if(currentTab === 'freekick') enterFreekickTab();
  });
  socket.on('freekick-aborted', () => {
    if(fk.shotTimer){ clearTimeout(fk.shotTimer); fk.shotTimer = null; }
    cancelFreekickAnimation();
    fk.state = fk.players.length ? 'setup' : 'idle';
    fk.shots = [];
    fk.currentIdx = 0;
    if(currentTab === 'freekick'){ setFreekickView('setup'); renderFreekickRoster(); }
    toast('Permainan dibatalkan');
  });
}
