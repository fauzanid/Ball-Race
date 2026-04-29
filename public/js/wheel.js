// ═══════════════════════════════════════════════════════════════════════════
// WHEEL
// ═══════════════════════════════════════════════════════════════════════════
// Depends on: $, $wCanvas, wCtx, escapeHtml, toast, role, adminToken,
// sfx, players, TEAM_COLORS, shade, celebrateWheelWin, currentTab,
// and the wheel-state globals declared in index.html (wheelNames,
// wheelRotation, wheelVelocity, wheelDecel, wheelSpinning, wheelLastTime,
// wheelWinnerIdx, wheelPrevSegment, pendingSpinPhysics, isReplayingSpin).

// Wheel entries can be plain strings (legacy) or objects { label, image },
// where `image` is a data URL or remote URL. Helpers normalise access.
function wheelEntryLabel(e){ return typeof e === 'string' ? e : (e?.label ?? ''); }
function wheelEntryImage(e){ return typeof e === 'string' ? null : (e?.image ?? null); }
function wheelEntrySet(i, entry){ wheelNames[i] = entry; }

// Cache HTMLImageElement per data-URL so drawWheel can blit them per frame.
const _wheelImgCache = new Map();
function getWheelImageEl(url){
  if(!url) return null;
  let img = _wheelImgCache.get(url);
  if(img) return img.complete ? img : null;
  img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  _wheelImgCache.set(url, img);
  img.onload = () => { drawWheel(); };
  return null;
}

function renderWheelChips(){
  const el = $('wheel-chips');
  if(!wheelNames.length){
    el.innerHTML = role==='admin'
      ? '<span class="empty-msg">Tambah nama untuk putar</span>'
      : '<span class="empty-msg">Menunggu admin menyiapkan roda</span>';
    return;
  }
  const isAdmin = role === 'admin';
  el.innerHTML = wheelNames.map((n,i)=>{
    const label = wheelEntryLabel(n);
    const img = wheelEntryImage(n);
    const thumb = img ? `<img src="${escapeHtml(img)}" alt="" style="width:18px;height:18px;border-radius:3px;object-fit:cover;margin-right:4px;vertical-align:middle">` : '';
    return `<span class="chip" style="border-left:3px solid ${TEAM_COLORS[i%TEAM_COLORS.length]}">${thumb}${escapeHtml(label)}${isAdmin?`<button class="rm-btn" data-widx="${i}">×</button>`:''}</span>`;
  }).join('');
  if(isAdmin) el.querySelectorAll('.rm-btn').forEach(b => b.addEventListener('click', () => { wheelNames.splice(+b.dataset.widx, 1); resetWheelState(); renderWheelChips(); drawWheel(); }));
}
function resizeWheelCanvas(){const wrap=$wCanvas.parentElement; $wCanvas.width=wrap.clientWidth*devicePixelRatio; $wCanvas.height=wrap.clientWidth*devicePixelRatio;}
function drawWheel(){
  const w=$wCanvas.width,h=$wCanvas.height,cx=w/2,cy=h/2;
  const outerR = Math.min(cx,cy)*.96;
  const r = outerR - 10*devicePixelRatio;
  wCtx.clearRect(0,0,w,h);

  // Outer dark frame
  wCtx.beginPath(); wCtx.arc(cx,cy,outerR,0,Math.PI*2);
  wCtx.fillStyle='#0e0e0c'; wCtx.fill();
  wCtx.strokeStyle='rgba(255,215,64,.4)'; wCtx.lineWidth=2*devicePixelRatio; wCtx.stroke();

  if(wheelNames.length<2){
    // Empty state — subtle pitch-ish dashed inner
    wCtx.beginPath(); wCtx.arc(cx,cy,r,0,Math.PI*2);
    wCtx.fillStyle='#15411f'; wCtx.fill();
    wCtx.setLineDash([6*devicePixelRatio,6*devicePixelRatio]);
    wCtx.strokeStyle='rgba(255,255,255,.15)'; wCtx.lineWidth=2*devicePixelRatio;
    wCtx.beginPath(); wCtx.arc(cx,cy,r*.6,0,Math.PI*2); wCtx.stroke();
    wCtx.setLineDash([]);
    wCtx.fillStyle='rgba(255,255,255,.5)';
    wCtx.font=`italic 900 ${Math.min(18*devicePixelRatio, r*.11)}px 'Archivo Black',sans-serif`;
    wCtx.textAlign='center'; wCtx.textBaseline='middle';
    wCtx.fillText(role==='admin' ? 'TAMBAH MINIMAL 2 NAMA' : 'TUNGGU ADMIN', cx, cy);
    return;
  }

  const n=wheelNames.length, slice=Math.PI*2/n;
  const now = performance.now();

  // Decorative dots on outer ring
  const dotCount = Math.max(n*2, 16);
  for(let i=0;i<dotCount;i++){
    const a = (Math.PI*2*i)/dotCount + wheelRotation*0.1;
    const dx = cx + Math.cos(a)*(outerR-5*devicePixelRatio);
    const dy = cy + Math.sin(a)*(outerR-5*devicePixelRatio);
    wCtx.beginPath(); wCtx.arc(dx,dy,1.8*devicePixelRatio,0,Math.PI*2);
    wCtx.fillStyle = i%2===0 ? 'rgba(255,215,64,.7)' : 'rgba(255,255,255,.2)';
    wCtx.fill();
  }

  // Segments
  wCtx.save(); wCtx.translate(cx,cy); wCtx.rotate(wheelRotation);
  for(let i=0;i<n;i++){
    const sa = i*slice, ea = sa+slice;
    const color = TEAM_COLORS[i%TEAM_COLORS.length];
    const isWinner = wheelWinnerIdx === i && !wheelSpinning;

    // Radial gradient for depth
    const grad = wCtx.createRadialGradient(0,0,r*.12,0,0,r);
    grad.addColorStop(0, shade(color,-30));
    grad.addColorStop(.45, shade(color,-8));
    grad.addColorStop(1, color);

    wCtx.beginPath();
    wCtx.moveTo(0,0);
    wCtx.arc(0,0,r,sa,ea);
    wCtx.closePath();
    wCtx.fillStyle = grad;
    wCtx.fill();

    // Winner pulse overlay
    if(isWinner){
      const pulse = (Math.sin(now/180)+1)/2;
      wCtx.fillStyle = `rgba(255,215,64,${0.18 + pulse*0.22})`;
      wCtx.fill();
    }

    // Outer gloss — brighter at rim, slight inner shadow
    wCtx.save();
    wCtx.beginPath(); wCtx.moveTo(0,0); wCtx.arc(0,0,r,sa,ea); wCtx.closePath();
    wCtx.clip();
    const rimGrad = wCtx.createRadialGradient(0,0,r*.55,0,0,r);
    rimGrad.addColorStop(0, 'rgba(255,255,255,0)');
    rimGrad.addColorStop(1, 'rgba(255,255,255,.18)');
    wCtx.fillStyle = rimGrad;
    wCtx.fillRect(-r,-r,r*2,r*2);
    wCtx.restore();

    // Segment divider (radial line at slice start)
    wCtx.beginPath();
    wCtx.moveTo(0,0);
    wCtx.lineTo(Math.cos(sa)*r, Math.sin(sa)*r);
    wCtx.strokeStyle = 'rgba(0,0,0,.35)';
    wCtx.lineWidth = 2*devicePixelRatio;
    wCtx.stroke();

    // Image (if entry has one) — drawn near outer half of the segment.
    // When the entry has NO label (image-mode entry), the image occupies
    // most of the segment so it reads clearly from across the room.
    const entryImage = wheelEntryImage(wheelNames[i]);
    const entryLabel = wheelEntryLabel(wheelNames[i]);
    const isImageOnly = entryImage && !entryLabel;
    if(entryImage){
      const imgEl = getWheelImageEl(entryImage);
      if(imgEl){
        const imgR = isImageOnly ? r * 0.62 : r * 0.55;
        const imgSize = isImageOnly
          ? Math.min(r * 0.32, slice * imgR * 0.95)
          : Math.min(r * 0.18, slice * imgR * 0.9);
        const ax = sa + slice / 2;
        const ix = Math.cos(ax) * imgR;
        const iy = Math.sin(ax) * imgR;
        wCtx.save();
        wCtx.beginPath();
        wCtx.arc(ix, iy, imgSize, 0, Math.PI * 2);
        wCtx.closePath();
        wCtx.clip();
        wCtx.drawImage(imgEl, ix - imgSize, iy - imgSize, imgSize * 2, imgSize * 2);
        wCtx.restore();
        // Image border ring — thicker for image-only mode
        wCtx.beginPath();
        wCtx.arc(ix, iy, imgSize, 0, Math.PI * 2);
        wCtx.strokeStyle = 'rgba(255,255,255,.9)';
        wCtx.lineWidth = (isImageOnly ? 3 : 2) * devicePixelRatio;
        wCtx.stroke();
      }
    }

    // Name label — skip entirely for image-only entries; otherwise placed
    // closer to center if a thumb is shown to avoid overlap.
    if(!isImageOnly){
      wCtx.save(); wCtx.rotate(sa+slice/2);
      const fs = Math.min(15*devicePixelRatio, r*.11);
      wCtx.fillStyle = '#fff';
      wCtx.font = `italic 800 ${fs}px 'Archivo Black',sans-serif`;
      wCtx.textAlign = 'right'; wCtx.textBaseline = 'middle';
      wCtx.shadowColor = 'rgba(0,0,0,.75)';
      wCtx.shadowBlur = 4*devicePixelRatio;
      let name = entryLabel.toUpperCase();
      const maxLabelEnd = entryImage ? r * 0.42 : r * 0.72;
      const labelEnd = entryImage ? r * 0.36 : r - 16*devicePixelRatio;
      if(wCtx.measureText(name).width > maxLabelEnd){
        while(name.length > 3 && wCtx.measureText(name+'…').width > maxLabelEnd) name = name.slice(0,-1);
        name += '…';
      }
      wCtx.fillText(name, labelEnd, 0);
      wCtx.restore();
    }
  }
  wCtx.restore();

  // Winner rim highlight (drawn in world space so it stays aligned to pointer)
  if(wheelWinnerIdx>=0 && !wheelSpinning){
    const pulse = (Math.sin(now/180)+1)/2;
    const wa = wheelRotation + wheelWinnerIdx*slice;
    wCtx.save();
    wCtx.translate(cx,cy);
    wCtx.beginPath();
    wCtx.arc(0,0,r,wa,wa+slice);
    wCtx.lineTo(0,0);
    wCtx.closePath();
    wCtx.strokeStyle = `rgba(255,215,64,${0.8+pulse*0.2})`;
    wCtx.lineWidth = 4*devicePixelRatio;
    wCtx.stroke();
    wCtx.restore();
  }

  // Center hub
  const hubR = r*.13;
  const hubGrad = wCtx.createRadialGradient(cx-hubR*.4,cy-hubR*.4,0,cx,cy,hubR);
  hubGrad.addColorStop(0,'#3a3a33');
  hubGrad.addColorStop(.7,'#1a1a16');
  hubGrad.addColorStop(1,'#0a0a08');
  wCtx.beginPath(); wCtx.arc(cx,cy,hubR,0,Math.PI*2);
  wCtx.fillStyle = hubGrad; wCtx.fill();
  wCtx.strokeStyle='rgba(255,215,64,.8)';
  wCtx.lineWidth=2*devicePixelRatio; wCtx.stroke();
  // Hub inner dot
  wCtx.beginPath(); wCtx.arc(cx,cy,hubR*.35,0,Math.PI*2);
  wCtx.fillStyle = '#ff4500'; wCtx.fill();
  // Hub highlight
  wCtx.beginPath(); wCtx.arc(cx-hubR*.3,cy-hubR*.3,hubR*.18,0,Math.PI*2);
  wCtx.fillStyle = 'rgba(255,255,255,.35)'; wCtx.fill();
}

function currentWheelSegment(){
  const n = wheelNames.length;
  if(n < 2) return -1;
  let a = (-Math.PI/2 - wheelRotation) % (Math.PI*2);
  if(a<0) a += Math.PI*2;
  return Math.floor(a / (Math.PI*2/n));
}
function spinWheel(){
  if(wheelNames.length<2||wheelSpinning) return;
  const startRot = wheelRotation;
  const vel = 18 + Math.random()*14;   // ~18-32 rad/s
  const dec = 2.0 + Math.random()*1.3;  // ~2-3.3 rad/s²
  pendingSpinPhysics = { start_rotation: startRot, initial_velocity: vel, deceleration: dec };
  isReplayingSpin = false;
  wheelVelocity = vel;
  wheelDecel = dec;
  wheelSpinning = true;
  wheelLastTime = 0;
  wheelWinnerIdx = -1;
  wheelPrevSegment = currentWheelSegment();
  const btn = $('wheel-spin-btn');
  btn.classList.add('spinning');
  btn.disabled = true;
  btn.innerHTML = 'BERPUTAR';
  $('wheel-result').classList.remove('announce');
  $('wheel-result').textContent = '';
  sfx.beep(660,.1,.15);
  requestAnimationFrame(wheelLoop);
}

function replaySpinFromHistory(h){
  if(wheelSpinning) return;
  if(h.initial_velocity == null || h.deceleration == null){ toast('Tidak ada data replay'); return; }
  // Set names list exactly as it was — pair with images if available so the
  // replay shows the same picture entries, not just labels. Image-only
  // entries were saved with positional "Gambar N" placeholder labels;
  // strip those on replay so the wheel re-renders the image prominently.
  const histNames = Array.isArray(h.names) ? h.names : [];
  const histImgs  = Array.isArray(h.images) ? h.images : [];
  wheelNames = histNames.map((n, i) => {
    const img = histImgs[i];
    if(img && /^Gambar \d+$/.test(n)) return { label: '', image: img };
    return img ? { label: n, image: img } : n;
  });
  resetWheelState();
  renderWheelChips();
  // Physics
  wheelRotation = h.start_rotation || 0;
  wheelVelocity = h.initial_velocity;
  wheelDecel    = h.deceleration;
  wheelSpinning = true;
  wheelLastTime = 0;
  wheelWinnerIdx = -1;
  wheelPrevSegment = currentWheelSegment();
  isReplayingSpin = true;
  pendingSpinPhysics = null;
  const btn = $('wheel-spin-btn');
  if(btn){ btn.classList.add('spinning'); btn.disabled = true; btn.innerHTML = 'MEMUTAR ULANG'; }
  const res = $('wheel-result');
  res.classList.remove('announce'); res.textContent = '';
  // Focus the wheel on mobile
  document.getElementById('wheel-canvas')?.scrollIntoView({ behavior:'smooth', block:'center' });
  sfx.beep(660,.08,.12);
  requestAnimationFrame(wheelLoop);
}

function wheelLoop(ts){
  if(!wheelLastTime) wheelLastTime = ts;
  const dt = Math.min(ts-wheelLastTime, 50)/1000;
  wheelLastTime = ts;

  if(wheelSpinning){
    wheelRotation += wheelVelocity * dt;
    wheelVelocity -= wheelDecel * dt;

    // Tick when the pointer crosses a new segment
    const seg = currentWheelSegment();
    if(seg !== wheelPrevSegment && wheelVelocity > 1.2){
      // Pitch scales slightly with speed so it slows musically as it stops
      const pitch = 900 + Math.min(600, wheelVelocity*30);
      sfx.beep(pitch, 0.03, 0.08, 'square');
      const p = $('wheel-pointer') || document.querySelector('.wheel-pointer');
      if(p){ p.classList.remove('ticking'); void p.offsetWidth; p.classList.add('ticking'); }
      wheelPrevSegment = seg;
    }

    if(wheelVelocity <= 0){
      wheelVelocity = 0;
      wheelSpinning = false;
      wheelWinnerIdx = currentWheelSegment();
      const winnerEntry = wheelNames[wheelWinnerIdx];
      const winner = wheelEntryLabel(winnerEntry);
      const winnerImg = wheelEntryImage(winnerEntry);
      const res = $('wheel-result');
      const prefix = isReplayingSpin ? '↻ ' : '🎉 ';
      // Image-only winner: full-size image banner so it reads from across
      // the room. Image+label: inline thumb. Text-only: plain text.
      if(winnerImg && !winner){
        res.innerHTML = `<div class="wheel-winner-image">
          <img src="${escapeHtml(winnerImg)}" alt="" data-act="zoom-winner">
          <div class="wheel-winner-label">${prefix}PEMENANG!</div>
        </div>`;
        // Auto-zoom to fullscreen lightbox for an extra-clear view —
        // delayed so the announce animation completes first.
        setTimeout(() => openWheelWinnerLightbox(winnerImg), 700);
      } else if(winnerImg && winner){
        res.innerHTML = `${prefix}<img src="${escapeHtml(winnerImg)}" alt="" style="height:1.4em;vertical-align:middle;border-radius:5px;margin-right:.3em">${escapeHtml(winner)}!`;
      } else {
        res.textContent = `${prefix}${winner}!`;
      }
      // Click the inline winner image to enlarge it
      res.querySelectorAll('img[data-act="zoom-winner"]').forEach(img => {
        img.addEventListener('click', () => openWheelWinnerLightbox(img.src));
      });
      res.classList.remove('announce'); void res.offsetWidth; res.classList.add('announce');
      const btn = $('wheel-spin-btn');
      btn.classList.remove('spinning');
      // Only admins get the spin button visible; hidden for viewers but we still normalize
      btn.disabled = false;
      btn.innerHTML = '⚡ Putar Lagi';
      sfx.fanfare();
      celebrateWheelWin();
      // Reveal the "Remove Winner" button (admin only)
      const rmBtn = $('wheel-remove-winner-btn');
      if(rmBtn && role === 'admin' && !isReplayingSpin){
        rmBtn.style.display = '';
        rmBtn.innerHTML = winner ? `🗑 Hapus "${winner}"` : '🗑 Hapus Pemenang';
      }
      if(!isReplayingSpin){
        // Image-only entries have empty labels; assign positional fallbacks
        // so history rendering can disambiguate which entry actually won.
        const labels = wheelNames.map((e, j) => wheelEntryLabel(e) || `Gambar ${j+1}`);
        saveWheelSpin(
          labels[wheelWinnerIdx],
          labels,
          pendingSpinPhysics,
          wheelNames.map(e => wheelEntryImage(e) || '')
        );
      }
      isReplayingSpin = false;
      pendingSpinPhysics = null;
    }
  }

  drawWheel();

  // Keep the loop alive while spinning OR to animate the winner pulse
  if(wheelSpinning || wheelWinnerIdx >= 0) requestAnimationFrame(wheelLoop);
}

// Clear winner highlight + reset button when names change or wheel is reset
function resetWheelState(){
  wheelWinnerIdx = -1;
  const res = $('wheel-result');
  if(res){ res.textContent = ''; res.classList.remove('announce'); }
  const btn = $('wheel-spin-btn');
  if(btn){
    btn.classList.remove('spinning');
    btn.disabled = false;
    btn.innerHTML = '⚡ Putar';
  }
  const rmBtn = $('wheel-remove-winner-btn');
  if(rmBtn) rmBtn.style.display = 'none';
}

$('wheel-remove-winner-btn')?.addEventListener('click', () => {
  if(role !== 'admin') return;
  if(wheelWinnerIdx < 0 || wheelWinnerIdx >= wheelNames.length) return;
  const winnerLabel = wheelEntryLabel(wheelNames[wheelWinnerIdx]);
  wheelNames.splice(wheelWinnerIdx, 1);
  resetWheelState();
  renderWheelChips();
  drawWheel();
  toast(`"${winnerLabel}" dihapus`);
});

// ── Wheel history (database) ──
let wheelHistory = [];
async function loadWheelHistory(){
  try { const r = await fetch('/api/wheel-spins?limit=30'); wheelHistory = r.ok ? await r.json() : []; }
  catch { wheelHistory = []; }
  renderWheelHistory();
}
async function saveWheelSpin(winner, names, physics, images){
  if(role !== 'admin') return;    // only admin writes
  try {
    await fetch('/api/wheel-spins', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify({ names, images: images || null, winner, ...(physics || {}) })
    });
    loadWheelHistory();
  } catch(e) { console.error('save wheel spin', e); }
}
function renderWheelHistory(){
  const el = $('wheel-history');
  if(!el) return;
  if(!wheelHistory.length){ el.innerHTML = '<div class="empty-msg">Belum ada putaran</div>'; return; }
  el.innerHTML = wheelHistory.map((h, idx) => {
    const d = new Date(h.created_at);
    const ds = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    const names = Array.isArray(h.names) ? h.names : [];
    const imgs  = Array.isArray(h.images) ? h.images : [];
    const chips = names.map((n, i) => {
      const isWinner = n === h.winner;
      const img = imgs[i];
      const thumb = img ? `<img src="${escapeHtml(img)}" alt="" style="width:14px;height:14px;border-radius:3px;object-fit:cover;margin-right:4px;vertical-align:middle">` : '';
      return `<span class="wheel-hist-chip${isWinner?' winner':''}" style="border-left:3px solid ${TEAM_COLORS[i%TEAM_COLORS.length]}">${isWinner?'🏆 ':''}${thumb}${escapeHtml(n)}</span>`;
    }).join('');
    const canReplay = h.initial_velocity != null && h.deceleration != null;
    const replayBtn = canReplay ? `<button class="wheel-hist-replay" data-idx="${idx}" title="Putar ulang">▶</button>` : '';
    return `<div class="wheel-hist-row" data-idx="${idx}">
      <div class="wheel-hist-summary">
        <span class="wheel-hist-winner">🎉 ${escapeHtml(h.winner)}</span>
        <span class="wheel-hist-meta">${names.length} nama · ${ds}</span>
        ${replayBtn}
        <span class="wheel-hist-toggle" aria-hidden="true">▾</span>
      </div>
      <div class="wheel-hist-details">
        <div class="wheel-hist-label">Peserta roda</div>
        <div class="wheel-hist-chips">${chips}</div>
      </div>
    </div>`;
  }).join('');
  el.querySelectorAll('.wheel-hist-summary').forEach(s => {
    s.addEventListener('click', (e) => {
      if(e.target.closest('.wheel-hist-replay')) return; // don't toggle when hitting replay
      s.parentElement.classList.toggle('open');
    });
  });
  el.querySelectorAll('.wheel-hist-replay').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = +b.dataset.idx;
    const h = wheelHistory[idx];
    if(h) replaySpinFromHistory(h);
  }));
}
async function clearWheelHistory(){
  if(role !== 'admin'){ toast('Khusus admin'); return; }
  try {
    await fetch('/api/wheel-spins', { method:'DELETE', headers:{'x-admin-token': adminToken} });
    wheelHistory = []; renderWheelHistory(); toast('Dihapus');
  } catch { toast('Gagal menghapus'); }
}
$('wheel-add-btn').addEventListener('click', () => {
  if(role!=='admin') return;
  const v = $('wheel-name-input').value.trim();
  if(!v) return;
  wheelNames.push(v);
  $('wheel-name-input').value = '';
  resetWheelState();
  renderWheelChips();
  drawWheel();
  $('wheel-name-input').focus();
});
$('wheel-name-input').addEventListener('keydown', e => { if(e.key==='Enter') $('wheel-add-btn').click(); });
$('wheel-use-players').addEventListener('click', () => { if(role!=='admin')return; wheelNames = players.map((p,i)=>p.name.trim()||'Pemain '+(i+1)); resetWheelState(); renderWheelChips(); drawWheel(); });
$('wheel-shuffle-btn').addEventListener('click', () => {
  if(role!=='admin' || wheelSpinning) return;
  if(wheelNames.length < 2){ toast('Belum cukup nama'); return; }
  for(let i = wheelNames.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [wheelNames[i], wheelNames[j]] = [wheelNames[j], wheelNames[i]];
  }
  resetWheelState(); renderWheelChips(); drawWheel();
  toast('Urutan diacak');
});
$('wheel-reset-btn').addEventListener('click', () => {
  if(role!=='admin' || wheelSpinning) return;
  if(!wheelNames.length){ toast('Sudah kosong'); return; }
  if(!confirm('Hapus semua nama di roda?')) return;
  wheelNames = [];
  resetWheelState(); renderWheelChips(); drawWheel();
  toast('Roda dikosongkan');
});

// Wheel mode toggle (Names / Numbers / Images)
let wheelMode = 'names';
function setWheelMode(mode){
  wheelMode = mode;
  document.querySelectorAll('.wheel-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.querySelectorAll('.wheel-mode-names').forEach(el => el.style.display   = mode === 'names'   ? '' : 'none');
  document.querySelectorAll('.wheel-mode-numbers').forEach(el => el.style.display = mode === 'numbers' ? '' : 'none');
  document.querySelectorAll('.wheel-mode-image').forEach(el => el.style.display   = mode === 'image'   ? '' : 'none');
  // Image grid uses grid display, not block
  if(mode === 'image') $('wheel-image-grid').style.display = 'grid';
  $('wheel-title-mode').textContent = mode === 'names' ? 'Nama' : mode === 'numbers' ? 'Nomor' : 'Gambar';
  if(mode === 'image') renderWheelImageGrid();
}

// Renders the admin-only thumbnail grid for image-mode entries so they
// can be removed individually.
function renderWheelImageGrid(){
  const el = $('wheel-image-grid'); if(!el) return;
  // Show only image-only entries (label is empty / placeholder).
  const tiles = wheelNames.map((entry, i) => {
    const img = wheelEntryImage(entry);
    if(!img) return '';
    return `<div class="img-tile" data-i="${i}">
      <img src="${escapeHtml(img)}" alt="">
      ${role === 'admin' ? `<button data-rm="${i}" title="Hapus">×</button>` : ''}
    </div>`;
  }).filter(Boolean).join('');
  el.innerHTML = tiles || '<div class="empty-msg" style="grid-column:1/-1">Belum ada gambar</div>';
  if(role === 'admin'){
    el.querySelectorAll('button[data-rm]').forEach(b => b.addEventListener('click', () => {
      const i = +b.dataset.rm;
      wheelNames.splice(i, 1);
      resetWheelState(); renderWheelChips(); renderWheelImageGrid(); drawWheel();
    }));
  }
}

// Image-mode upload — accepts multiple files, each becomes a pure-image entry.
$('wheel-img-only-input')?.addEventListener('change', e => {
  if(role !== 'admin') return;
  const files = Array.from(e.target.files || []);
  if(!files.length) return;
  let added = 0;
  let pending = files.length;
  files.forEach(file => {
    if(file.size > 1024 * 1024){ toast(`${file.name}: terlalu besar (maks 1MB)`); pending--; if(!pending) finalize(); return; }
    const reader = new FileReader();
    reader.onload = () => {
      // Image-only entry: empty label so the wheel renders the image
      // prominently without text overlap.
      wheelNames.push({ label: '', image: reader.result });
      added++;
      pending--;
      if(!pending) finalize();
    };
    reader.onerror = () => { pending--; if(!pending) finalize(); };
    reader.readAsDataURL(file);
  });
  function finalize(){
    e.target.value = '';
    if(added){
      resetWheelState(); renderWheelChips(); renderWheelImageGrid(); drawWheel();
      toast(`${added} gambar ditambah`);
    }
  }
});
$('wheel-image-shuffle')?.addEventListener('click', () => {
  if(role!=='admin' || wheelSpinning) return;
  if(wheelNames.length < 2){ toast('Belum cukup gambar'); return; }
  for(let i = wheelNames.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [wheelNames[i], wheelNames[j]] = [wheelNames[j], wheelNames[i]];
  }
  resetWheelState(); renderWheelChips(); renderWheelImageGrid(); drawWheel();
  toast('Urutan diacak');
});
$('wheel-image-reset')?.addEventListener('click', () => {
  if(role!=='admin' || wheelSpinning) return;
  if(!wheelNames.length){ toast('Sudah kosong'); return; }
  if(!confirm('Hapus semua gambar?')) return;
  wheelNames = [];
  resetWheelState(); renderWheelChips(); renderWheelImageGrid(); drawWheel();
  toast('Roda dikosongkan');
});
document.querySelectorAll('.wheel-mode-btn').forEach(b => b.addEventListener('click', () => {
  if(role !== 'admin') return;
  setWheelMode(b.dataset.mode);
}));
$('wheel-num-apply').addEventListener('click', () => {
  if(role !== 'admin') return;
  let min = parseInt($('wheel-num-min').value);
  let max = parseInt($('wheel-num-max').value);
  if(!Number.isFinite(min)) min = 1;
  if(!Number.isFinite(max)) max = 10;
  if(max < min) [min, max] = [max, min];
  if(max - min > 199){ toast('Maksimal 200 angka'); return; }
  wheelNames = [];
  for(let i = min; i <= max; i++) wheelNames.push(String(i));
  resetWheelState(); renderWheelChips(); drawWheel();
});
$('wheel-spin-btn').addEventListener('click', () => { if(role!=='admin')return; spinWheel(); });
$('wheel-clear-hist-btn').addEventListener('click', clearWheelHistory);

// Fullscreen lightbox for image-mode winners — click anywhere or press Esc to dismiss.
function openWheelWinnerLightbox(src){
  if(!src) return;
  let lb = document.getElementById('wheel-winner-lightbox');
  if(!lb){
    lb = document.createElement('div');
    lb.id = 'wheel-winner-lightbox';
    lb.innerHTML = `
      <div class="wwl-banner">🎉 PEMENANG!</div>
      <img alt="">
      <button class="wwl-close" aria-label="Tutup">×</button>
    `;
    document.body.appendChild(lb);
    const close = () => { lb.classList.remove('open'); };
    lb.addEventListener('click', e => {
      if(e.target === lb || e.target.classList.contains('wwl-close')) close();
    });
    document.addEventListener('keydown', e => {
      if(e.key === 'Escape' && lb.classList.contains('open')) close();
    });
  }
  lb.querySelector('img').src = src;
  lb.classList.add('open');
}
