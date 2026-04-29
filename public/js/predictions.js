// ═══════════════════════════════════════════════════════════════════════════
// SCORE PREDICTIONS
// ═══════════════════════════════════════════════════════════════════════════
// Depends on: $, escapeHtml, toast, role, adminToken, socket, currentTab.
// Inline-script socket-handlers below in this file register against the
// shared `socket` global; they fire async so it's safe to register here.

let predictMatches = [];
// Cache of full match details keyed by id (entries arrays). Loaded on demand.
let predictMatchDetails = new Map();
// Phone last typed by the user — autofills the form on next match so they
// don't have to retype it. Stored only in this tab's session.
let predictLastPhone = '';
// Pending prize image for the create form (data URL)
let _predictPendingPrize = '';

async function loadPredictMatches(){
  try {
    const r = await fetch('/api/predictions/matches');
    predictMatches = r.ok ? await r.json() : [];
  } catch { predictMatches = []; }
  renderPredictList();
  // Pre-load entries for any open match so the "already taken" hint
  // is populated before users start typing.
  predictMatches
    .filter(m => m.status === 'open' && (m.entry_count || 0) > 0 && !predictMatchDetails.has(m.id))
    .forEach(m => {
      loadPredictMatchDetail(m.id).then(() => renderPredictList());
    });
}

async function loadPredictMatchDetail(id){
  try {
    const r = await fetch('/api/predictions/matches/' + id);
    if(!r.ok) return null;
    const data = await r.json();
    predictMatchDetails.set(id, data.entries || []);
    return data;
  } catch { return null; }
}

function predictCardHtml(m, entries, isAdmin){
  const status = m.status || 'open';
  const statusLabel = status === 'finished' ? 'Selesai' : status === 'closed' ? 'Ditutup' : 'Terbuka';
  const final = (m.final_home != null && m.final_away != null)
    ? `<div class="predict-final">${m.final_home} – ${m.final_away}</div>` : '';

  // Prize banner — visible to everyone so users know what they're playing for
  let prize = '';
  if(m.prize_image || m.prize_label){
    const kicker = status === 'finished' ? '🏆 Hadiah pemenang' : '🎁 Hadiah';
    if(m.prize_image){
      prize = `<div class="predict-prize">
        <img src="${escapeHtml(m.prize_image)}" alt="" data-act="zoom-prize" data-id="${m.id}">
        <div class="predict-prize-info">
          <div class="predict-prize-kicker">${kicker}</div>
          <div class="predict-prize-label">${escapeHtml(m.prize_label || 'Hadiah eksklusif')}</div>
        </div>
      </div>`;
    } else {
      prize = `<div class="predict-prize no-image">
        <div class="predict-prize-info">
          <div class="predict-prize-kicker">${kicker}</div>
          <div class="predict-prize-label">${escapeHtml(m.prize_label)}</div>
        </div>
      </div>`;
    }
  }

  // Submission window — gates the form even when status='open'
  const now = Date.now();
  const opensAt = m.opens_at ? new Date(m.opens_at).getTime() : null;
  const closesAt = m.closes_at ? new Date(m.closes_at).getTime() : null;
  const beforeOpen = status === 'open' && opensAt && now < opensAt;
  const afterClose = status === 'open' && closesAt && now > closesAt;
  const inWindow = status === 'open' && !beforeOpen && !afterClose;

  let windowInfo = '';
  if(status === 'open'){
    if(beforeOpen){
      windowInfo = `<div class="predict-window-info locked">⏳ Submisi dibuka <b>${formatPredictTime(opensAt)}</b></div>`;
    } else if(closesAt){
      windowInfo = `<div class="predict-window-info live">✅ Buka — tutup <b>${formatPredictTime(closesAt)}</b></div>`;
    } else if(opensAt){
      windowInfo = `<div class="predict-window-info live">✅ Buka sejak <b>${formatPredictTime(opensAt)}</b></div>`;
    }
  } else if(status === 'closed' && closesAt){
    windowInfo = `<div class="predict-window-info">🔒 Ditutup pada <b>${formatPredictTime(closesAt)}</b></div>`;
  }

  let form = '';
  if(inWindow){
    // Show which scores are already claimed so users pick a unique one
    const taken = (entries || []).map(e => `${e.predicted_home}-${e.predicted_away}`);
    const takenHint = taken.length
      ? `<div class="predict-taken col-span-2">Skor sudah dipilih: ${taken.map(s => `<span>${escapeHtml(s)}</span>`).join(' ')}</div>`
      : '';
    form = `<div class="predict-form" data-form="${m.id}">
      <input class="col-span-2" data-f="name" placeholder="Nama Anda" maxlength="80">
      <input class="col-span-2" data-f="phone" placeholder="Nomor HP" inputmode="tel" maxlength="20" value="${escapeHtml(predictLastPhone)}">
      <div class="col-span-2 predict-score-row">
        <input data-f="home" type="number" min="0" max="99" placeholder="0">
        <span class="predict-score-sep">–</span>
        <input data-f="away" type="number" min="0" max="99" placeholder="0">
      </div>
      ${takenHint}
      <button class="btn btn-primary btn-sm col-span-2" data-act="submit" data-id="${m.id}">⚡ Kirim Prediksi</button>
    </div>`;
  } else if(beforeOpen){
    form = `<div class="empty-msg">Tunggu sebentar — submisi belum dibuka.</div>`;
  } else if(afterClose){
    form = `<div class="empty-msg">Submisi sudah ditutup. Tunggu skor akhir.</div>`;
  }

  let entriesHtml = '';
  if(entries && entries.length){
    const isFinished = status === 'finished';
    const fh = m.final_home, fa = m.final_away;
    // Highlight exact-score predictions on finished matches
    const sorted = entries.slice().sort((a,b) => {
      if(isFinished){
        const aExact = a.predicted_home === fh && a.predicted_away === fa ? 0 : 1;
        const bExact = b.predicted_home === fh && b.predicted_away === fa ? 0 : 1;
        if(aExact !== bExact) return aExact - bExact;
      }
      return new Date(a.created_at) - new Date(b.created_at);
    });
    entriesHtml = `<div class="predict-entries">
      <div class="predict-entries-hd">${entries.length} prediksi${isFinished ? ' (yang tepat di atas)' : ''}</div>
      ${sorted.map(e => {
        const exact = isFinished && e.predicted_home === fh && e.predicted_away === fa;
        const adminDel = isAdmin ? `<button class="predict-entry-del" data-act="del-entry" data-id="${e.id}" title="Hapus">×</button>` : '';
        return `<div class="predict-entry${exact ? ' exact' : ''}">
          ${exact ? '🏆 ' : ''}<span class="predict-entry-name">${escapeHtml(e.name)}</span>
          <span class="predict-entry-score">${e.predicted_home} – ${e.predicted_away}</span>
          <span class="predict-entry-phone">${escapeHtml(maskPhone(e.phone))}</span>
          ${adminDel}
        </div>`;
      }).join('')}
    </div>`;
  } else {
    entriesHtml = `<div class="predict-entries"><div class="predict-entries-hd">${m.entry_count || 0} prediksi</div></div>`;
  }

  let adminActions = '';
  if(isAdmin){
    const editPrize = `<button class="btn btn-ghost btn-sm" data-act="edit-prize" data-id="${m.id}">🎁 ${m.prize_image || m.prize_label ? 'Ubah Hadiah' : '+ Hadiah'}</button>`;
    if(status === 'open'){
      adminActions = `<div class="add-row" style="margin-top:8px">
        <button class="btn btn-ghost btn-sm" data-act="close" data-id="${m.id}">⏸ Tutup Prediksi</button>
        ${editPrize}
        <button class="btn btn-ghost btn-sm" data-act="show-entries" data-id="${m.id}">👀 Lihat (${m.entry_count || 0})</button>
        <button class="btn btn-ghost btn-sm" data-act="del-match" data-id="${m.id}" style="color:#ff5577">🗑</button>
      </div>`;
    } else if(status === 'closed'){
      adminActions = `<div class="add-row" style="margin-top:8px">
        <input data-f="fh" type="number" min="0" max="99" placeholder="Skor home" style="max-width:120px">
        <span class="predict-score-sep">–</span>
        <input data-f="fa" type="number" min="0" max="99" placeholder="Skor away" style="max-width:120px">
        <button class="btn btn-primary btn-sm" data-act="finish" data-id="${m.id}">🏁 Set Skor Akhir</button>
        ${editPrize}
        <button class="btn btn-ghost btn-sm" data-act="show-entries" data-id="${m.id}">👀 Lihat (${m.entry_count || 0})</button>
        <button class="btn btn-ghost btn-sm" data-act="del-match" data-id="${m.id}" style="color:#ff5577">🗑</button>
      </div>`;
    } else {
      adminActions = `<div class="add-row" style="margin-top:8px">
        ${editPrize}
        <button class="btn btn-ghost btn-sm" data-act="show-entries" data-id="${m.id}">👀 Lihat (${m.entry_count || 0})</button>
        <button class="btn btn-ghost btn-sm" data-act="del-match" data-id="${m.id}" style="color:#ff5577">🗑 Hapus</button>
      </div>`;
    }
  }

  return `<div class="predict-card ${status}" data-id="${m.id}">
    <div class="predict-card-hd">
      <span class="predict-card-title">${escapeHtml(m.label)}</span>
      <span class="predict-status ${status}">${statusLabel}</span>
    </div>
    ${prize}
    ${windowInfo}
    ${final}
    ${form}
    ${adminActions}
    ${entriesHtml}
  </div>`;
}

function formatPredictTime(ms){
  if(!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString('id-ID', { dateStyle:'short', timeStyle:'short' });
}

function maskPhone(p){
  if(!p) return '';
  if(p.length < 6) return p;
  return p.slice(0, 3) + '****' + p.slice(-3);
}

function renderPredictList(){
  const el = $('predict-list'); if(!el) return;
  if(!predictMatches.length){
    el.innerHTML = `<div class="empty-msg">${role==='admin' ? 'Tambah pertandingan untuk mulai' : 'Belum ada pertandingan'}</div>`;
    return;
  }
  const isAdmin = role === 'admin';
  // For finished matches we always render entries inline (so leaderboard is
  // visible). For open/closed matches, show entries only if cached.
  el.innerHTML = predictMatches.map(m => {
    const entries = (m.status === 'finished' || predictMatchDetails.has(m.id))
      ? (predictMatchDetails.get(m.id) || null)
      : null;
    return predictCardHtml(m, entries, isAdmin);
  }).join('');
  attachPredictHandlers(el);
}

function attachPredictHandlers(scope){
  scope.querySelectorAll('[data-act]').forEach(b => {
    const act = b.dataset.act;
    const id = +b.dataset.id;
    if(act === 'submit')        b.addEventListener('click', () => submitPrediction(id, b));
    else if(act === 'close')    b.addEventListener('click', () => updateMatch(id, { status: 'closed' }));
    else if(act === 'finish')   b.addEventListener('click', () => finishMatch(id, b));
    else if(act === 'del-match')b.addEventListener('click', () => deleteMatch(id));
    else if(act === 'show-entries') b.addEventListener('click', () => toggleEntries(id));
    else if(act === 'del-entry')b.addEventListener('click', () => deleteEntry(id));
    else if(act === 'edit-prize') b.addEventListener('click', () => editMatchPrize(id));
    else if(act === 'zoom-prize') b.addEventListener('click', () => openPredictLightbox(b.getAttribute('src')));
  });
}

// Hidden file input shared by every "Ubah Hadiah" prompt.
let _predictPrizeEditInput = null;
function editMatchPrize(matchId){
  if(role !== 'admin') return;
  const m = predictMatches.find(x => x.id === matchId);
  if(!m) return;
  const newLabel = prompt(`Label hadiah untuk "${m.label}" (kosongkan untuk hapus)`, m.prize_label || '');
  if(newLabel == null) return; // cancel
  // Ask whether to update the image too
  const wantNewImage = m.prize_image
    ? confirm('Upload gambar hadiah baru? OK = pilih file, Cancel = pertahankan/hapus gambar lama')
    : confirm('Tambah gambar hadiah? OK = pilih file, Cancel = lewati');
  const saveText = async (image_value) => {
    const body = { prize_label: newLabel.trim() };
    if(image_value !== undefined) body.prize_image = image_value;
    try {
      const r = await fetch(`/api/predictions/matches/${matchId}`, {
        method:'PATCH',
        headers:{'content-type':'application/json','x-admin-token':adminToken},
        body: JSON.stringify(body)
      });
      if(!r.ok){ const e = await r.json().catch(()=>({})); toast(e.error || 'Gagal update'); return; }
      toast('Hadiah disimpan');
    } catch { toast('Gagal update'); }
  };
  if(!wantNewImage){
    // If user cancelled image picker AND there's an existing image, ask if they want to remove it
    if(m.prize_image && confirm('Hapus gambar hadiah yang ada?')){
      saveText('');
    } else {
      saveText(undefined); // label-only
    }
    return;
  }
  if(!_predictPrizeEditInput){
    _predictPrizeEditInput = document.createElement('input');
    _predictPrizeEditInput.type = 'file';
    _predictPrizeEditInput.accept = 'image/*';
    _predictPrizeEditInput.style.display = 'none';
    document.body.appendChild(_predictPrizeEditInput);
  }
  _predictPrizeEditInput.value = '';
  _predictPrizeEditInput.onchange = () => {
    const file = _predictPrizeEditInput.files?.[0];
    if(!file){ saveText(undefined); return; }
    if(file.size > 1024 * 1024){ toast('Gambar terlalu besar (maks 1MB)'); return; }
    const reader = new FileReader();
    reader.onload = () => saveText(reader.result);
    reader.readAsDataURL(file);
  };
  _predictPrizeEditInput.click();
}

function openPredictLightbox(src){
  if(!src) return;
  let lb = document.getElementById('predict-lightbox');
  if(!lb){
    lb = document.createElement('div');
    lb.id = 'predict-lightbox';
    // Reuse the auction lightbox styling if present, else inline.
    lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.9);display:none;align-items:center;justify-content:center;z-index:1000;padding:20px;cursor:zoom-out';
    lb.innerHTML = '<img alt="" style="max-width:100%;max-height:100%;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,.6)">';
    document.body.appendChild(lb);
    lb.addEventListener('click', () => { lb.style.display = 'none'; });
  }
  lb.querySelector('img').src = src;
  lb.style.display = 'flex';
}

async function submitPrediction(matchId, btn){
  const card = btn.closest('.predict-card');
  if(!card) return;
  const get = (f) => card.querySelector(`[data-f="${f}"]`)?.value || '';
  const name = get('name').trim();
  const phone = get('phone').replace(/[^\d+]/g, '');
  const home = +get('home');
  const away = +get('away');
  if(!name){ toast('Nama wajib diisi'); return; }
  if(!phone || phone.length < 4){ toast('Nomor HP tidak valid'); return; }
  if(!Number.isFinite(home) || home < 0 || home > 99){ toast('Skor home tidak valid'); return; }
  if(!Number.isFinite(away) || away < 0 || away > 99){ toast('Skor away tidak valid'); return; }
  btn.disabled = true;
  try {
    const r = await fetch(`/api/predictions/matches/${matchId}/entries`, {
      method: 'POST',
      headers: { 'content-type':'application/json' },
      body: JSON.stringify({ name, phone, predicted_home: home, predicted_away: away })
    });
    if(!r.ok){ const e = await r.json().catch(()=>({})); toast(e.error || 'Gagal menyimpan'); return; }
    predictLastPhone = phone;
    toast('✓ Prediksi terkirim');
    // Optimistically bump entry count + refresh detail if open
    const m = predictMatches.find(x => x.id === matchId);
    if(m) m.entry_count = (m.entry_count || 0) + 1;
    if(predictMatchDetails.has(matchId)){
      await loadPredictMatchDetail(matchId);
    }
    renderPredictList();
  } catch { toast('Gagal menyimpan'); }
  finally { btn.disabled = false; }
}

async function updateMatch(id, body){
  if(role !== 'admin') return;
  try {
    const r = await fetch(`/api/predictions/matches/${id}`, {
      method:'PATCH',
      headers:{'content-type':'application/json','x-admin-token':adminToken},
      body: JSON.stringify(body)
    });
    if(!r.ok){ toast('Gagal update'); return; }
    toast('Disimpan');
  } catch { toast('Gagal update'); }
}

async function finishMatch(id, btn){
  const card = btn.closest('.predict-card');
  if(!card) return;
  const fh = +card.querySelector('[data-f="fh"]').value;
  const fa = +card.querySelector('[data-f="fa"]').value;
  if(!Number.isFinite(fh) || fh < 0 || !Number.isFinite(fa) || fa < 0){
    toast('Skor akhir tidak valid'); return;
  }
  await updateMatch(id, { status: 'finished', final_home: fh, final_away: fa });
}

async function deleteMatch(id){
  if(role !== 'admin') return;
  if(!confirm('Hapus pertandingan ini? Semua prediksi ikut terhapus.')) return;
  try {
    const r = await fetch(`/api/predictions/matches/${id}`, { method:'DELETE', headers:{'x-admin-token':adminToken} });
    if(!r.ok){ toast('Gagal menghapus'); return; }
    toast('Dihapus');
  } catch { toast('Gagal menghapus'); }
}

async function deleteEntry(id){
  if(role !== 'admin') return;
  if(!confirm('Hapus prediksi ini?')) return;
  try {
    const r = await fetch(`/api/predictions/entries/${id}`, { method:'DELETE', headers:{'x-admin-token':adminToken} });
    if(!r.ok){ toast('Gagal menghapus'); return; }
    toast('Dihapus');
  } catch { toast('Gagal menghapus'); }
}

async function toggleEntries(id){
  if(predictMatchDetails.has(id)){
    predictMatchDetails.delete(id);
    renderPredictList();
    return;
  }
  await loadPredictMatchDetail(id);
  renderPredictList();
}

// datetime-local inputs return naive strings (local time, no tz). Convert
// to a real Date so the server gets ISO-tz format.
function localInputToISO(v){
  if(!v) return '';
  const d = new Date(v); // browser parses as local time
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

// Admin: create new match
$('predict-create-btn')?.addEventListener('click', async () => {
  if(role !== 'admin') return;
  const input = $('predict-label-input');
  const label = input.value.trim();
  if(!label){ toast('Isi nama pertandingan'); return; }
  const prize_label = $('predict-prize-label-input')?.value.trim() || '';
  const prize_image = _predictPendingPrize || '';
  const opens_at = localInputToISO($('predict-opens-input')?.value);
  const closes_at = localInputToISO($('predict-closes-input')?.value);
  try {
    const r = await fetch('/api/predictions/matches', {
      method: 'POST',
      headers: { 'content-type':'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify({ label, prize_label, prize_image, opens_at, closes_at })
    });
    if(!r.ok){ const e = await r.json().catch(()=>({})); toast(e.error || 'Gagal membuat'); return; }
    input.value = '';
    if($('predict-prize-label-input')) $('predict-prize-label-input').value = '';
    _predictPendingPrize = '';
    if($('predict-prize-file-input')) $('predict-prize-file-input').value = '';
    if($('predict-prize-preview-row')) $('predict-prize-preview-row').style.display = 'none';
    if($('predict-opens-input')) $('predict-opens-input').value = '';
    if($('predict-closes-input')) $('predict-closes-input').value = '';
    if($('predict-kickoff-input')) $('predict-kickoff-input').value = '';
    toast('Pertandingan dibuka');
  } catch { toast('Gagal membuat'); }
});

// Convenience: when admin types a kick-off time, auto-fill closes_at to
// 1 hour before kick-off (only if the close field is still empty).
$('predict-kickoff-input')?.addEventListener('change', () => {
  const v = $('predict-kickoff-input').value;
  if(!v) return;
  const closeEl = $('predict-closes-input');
  if(closeEl && !closeEl.value){
    const ko = new Date(v);
    if(!isNaN(ko.getTime())){
      ko.setHours(ko.getHours() - 1);
      // Format back to datetime-local (YYYY-MM-DDTHH:mm)
      const pad = n => String(n).padStart(2, '0');
      closeEl.value = `${ko.getFullYear()}-${pad(ko.getMonth()+1)}-${pad(ko.getDate())}T${pad(ko.getHours())}:${pad(ko.getMinutes())}`;
    }
  }
});
$('predict-label-input')?.addEventListener('keydown', e => {
  if(e.key === 'Enter') $('predict-create-btn').click();
});

// Prize image picker for the create form
$('predict-prize-file-input')?.addEventListener('change', e => {
  const file = e.target.files[0];
  if(!file) return;
  if(file.size > 1024 * 1024){ toast('Gambar terlalu besar (maks 1MB)'); e.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    _predictPendingPrize = reader.result;
    $('predict-prize-preview-img').src = _predictPendingPrize;
    $('predict-prize-preview-name').textContent = file.name;
    $('predict-prize-preview-row').style.display = '';
  };
  reader.readAsDataURL(file);
});
$('predict-prize-clear')?.addEventListener('click', () => {
  _predictPendingPrize = '';
  if($('predict-prize-file-input')) $('predict-prize-file-input').value = '';
  $('predict-prize-preview-row').style.display = 'none';
});

// Tick once per minute so cards flip from "akan dibuka" → "buka" → "tutup"
// without waiting for a socket event. The auto-close cron on the server
// also handles status flipping, but the client-side re-render is what
// actually swaps the form in/out for the user.
setInterval(() => {
  if(typeof currentTab !== 'undefined' && currentTab === 'predict' && predictMatches.length){
    // Only re-render if any match has a window boundary near now
    const now = Date.now();
    const has = predictMatches.some(m => {
      const o = m.opens_at ? new Date(m.opens_at).getTime() : 0;
      const c = m.closes_at ? new Date(m.closes_at).getTime() : 0;
      return (o && Math.abs(o - now) < 65_000) || (c && Math.abs(c - now) < 65_000);
    });
    if(has) renderPredictList();
  }
}, 60_000);

// Socket listeners — apply live updates whenever the tab is open.
if(typeof socket !== 'undefined' && socket){
  const refreshIfActive = () => { if(currentTab === 'predict') renderPredictList(); };
  socket.on('prediction-match-created', m => {
    predictMatches.unshift(m);
    refreshIfActive();
  });
  socket.on('prediction-match-updated', m => {
    if(!m) return;
    const i = predictMatches.findIndex(x => x.id === m.id);
    if(i >= 0) predictMatches[i] = m;
    else predictMatches.unshift(m);
    // For finished matches, fetch entries so the leaderboard renders
    if(m.status === 'finished' && !predictMatchDetails.has(m.id)){
      loadPredictMatchDetail(m.id).then(refreshIfActive);
    } else {
      refreshIfActive();
    }
  });
  socket.on('prediction-match-deleted', ({ id }) => {
    predictMatches = predictMatches.filter(x => x.id !== id);
    predictMatchDetails.delete(id);
    refreshIfActive();
  });
  socket.on('prediction-entry-added', e => {
    const m = predictMatches.find(x => x.id === e.match_id);
    if(m) m.entry_count = (m.entry_count || 0) + 1;
    if(predictMatchDetails.has(e.match_id)){
      const arr = predictMatchDetails.get(e.match_id);
      arr.push(e);
    }
    refreshIfActive();
  });
  socket.on('prediction-entry-deleted', ({ id, match_id }) => {
    if(predictMatchDetails.has(match_id)){
      const arr = predictMatchDetails.get(match_id).filter(x => x.id !== id);
      predictMatchDetails.set(match_id, arr);
    }
    const m = predictMatches.find(x => x.id === match_id);
    if(m) m.entry_count = Math.max(0, (m.entry_count || 0) - 1);
    refreshIfActive();
  });
}
