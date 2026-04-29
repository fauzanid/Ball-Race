// ═══════════════════════════════════════════════════════════════════════════
// MVP OF THE MONTH
// ═══════════════════════════════════════════════════════════════════════════
// Depends on: $, escapeHtml, toast, role, adminToken, socket, currentTab.
// Server returns the list pre-sorted by points DESC, name ASC, scoped to
// the requested ?month= (defaults to the current calendar month).

let mvpEntries = [];
let mvpAvailableMonths = [];
let mvpSelectedMonth = currentMonthString();
let mvpPrize = null; // { month, prize_label, prize_image }

function currentMonthString(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
// Render "2026-04" → "April 2026"
function formatMonthLabel(m){
  const [y, mm] = m.split('-');
  const names = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  return `${names[+mm - 1]} ${y}`;
}

async function loadMvpMonths(){
  try {
    const r = await fetch('/api/mvp/months');
    mvpAvailableMonths = r.ok ? await r.json() : [currentMonthString()];
  } catch { mvpAvailableMonths = [currentMonthString()]; }
  // Make sure the currently-selected month is in the list (e.g. user just
  // cleared all entries for this month — server might omit it, but admin
  // still needs to see + add to it).
  if(!mvpAvailableMonths.includes(mvpSelectedMonth)) mvpAvailableMonths.unshift(mvpSelectedMonth);
  populateMvpMonthSelect();
}

function populateMvpMonthSelect(){
  const sel = $('mvp-month-select');
  if(!sel) return;
  sel.innerHTML = mvpAvailableMonths.map(m =>
    `<option value="${m}"${m === mvpSelectedMonth ? ' selected' : ''}>${formatMonthLabel(m)}</option>`
  ).join('');
}

async function loadMvpEntries(){
  const tbl = $('mvp-table');
  if(tbl){
    tbl.innerHTML = '<div class="skeleton-list" style="padding:14px;gap:6px">' +
      '<div class="skeleton-row" style="height:48px"></div>'.repeat(4) + '</div>';
  }
  // Load months alongside entries — first call populates the dropdown
  if(!mvpAvailableMonths.length) await loadMvpMonths();
  // Fire entries + prize requests in parallel
  const month = mvpSelectedMonth;
  await Promise.all([
    fetch('/api/mvp?month=' + encodeURIComponent(month))
      .then(r => r.ok ? r.json() : [])
      .then(d => { mvpEntries = d; })
      .catch(() => { mvpEntries = []; }),
    fetch('/api/mvp/prize?month=' + encodeURIComponent(month))
      .then(r => r.ok ? r.json() : null)
      .then(d => { mvpPrize = d; })
      .catch(() => { mvpPrize = null; }),
  ]);
  // Update subtitle so the user always knows which month they're viewing
  const sub = $('mvp-subtitle');
  if(sub){
    const isCurrent = mvpSelectedMonth === currentMonthString();
    sub.textContent = isCurrent
      ? `Klasemen pemain ${formatMonthLabel(mvpSelectedMonth)} (bulan ini).`
      : `Klasemen pemain ${formatMonthLabel(mvpSelectedMonth)}.`;
  }
  renderMvpPrize();
  renderMvpTable();
}

function renderMvpPrize(){
  const el = $('mvp-prize-banner');
  if(!el) return;
  const hasPrize = mvpPrize && (mvpPrize.prize_image || mvpPrize.prize_label);
  if(!hasPrize){
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const kicker = `🏆 Hadiah ${formatMonthLabel(mvpPrize.month || mvpSelectedMonth)}`;
  if(mvpPrize.prize_image){
    el.className = 'mvp-prize';
    el.innerHTML = `
      <img src="${escapeHtml(mvpPrize.prize_image)}" alt="" data-act="zoom">
      <div class="mvp-prize-info">
        <div class="mvp-prize-kicker">${kicker}</div>
        <div class="mvp-prize-label">${escapeHtml(mvpPrize.prize_label || 'Hadiah eksklusif')}</div>
      </div>`;
    el.querySelector('img[data-act="zoom"]')?.addEventListener('click', () => openMvpLightbox(mvpPrize.prize_image));
  } else {
    el.className = 'mvp-prize no-image';
    el.innerHTML = `
      <div class="mvp-prize-info">
        <div class="mvp-prize-kicker">${kicker}</div>
        <div class="mvp-prize-label">${escapeHtml(mvpPrize.prize_label)}</div>
      </div>`;
  }
}

function openMvpLightbox(src){
  if(!src) return;
  let lb = document.getElementById('mvp-lightbox');
  if(!lb){
    lb = document.createElement('div');
    lb.id = 'mvp-lightbox';
    lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.9);display:none;align-items:center;justify-content:center;z-index:1500;padding:20px;cursor:zoom-out';
    lb.innerHTML = '<img alt="" style="max-width:100%;max-height:100%;border-radius:10px;border:3px solid #ffd740;box-shadow:0 0 60px rgba(255,215,64,.4)">';
    document.body.appendChild(lb);
    lb.addEventListener('click', () => { lb.style.display = 'none'; });
  }
  lb.querySelector('img').src = src;
  lb.style.display = 'flex';
}

function renderMvpTable(){
  const el = $('mvp-table');
  if(!el) return;
  const isAdmin = role === 'admin';

  if(!mvpEntries.length){
    el.innerHTML = `<div class="empty-msg" style="padding:32px 16px">${
      isAdmin ? 'Tambah pemain pertama untuk mulai klasemen.' : 'Belum ada pemain di klasemen.'
    }</div>`;
    return;
  }

  // Header
  let html = `<div class="mvp-thead">
    <span>#</span>
    <span>Pemain</span>
    <span class="mvp-pts">Pts</span>
  </div>`;

  // Rows — server already sorts by points DESC, name ASC
  html += mvpEntries.map((p, i) => {
    const rankClass = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : '';
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
    const adminCell = isAdmin
      ? `<div class="mvp-actions">
          <button class="mvp-quick minus" data-act="delta" data-id="${p.id}" data-d="-1" title="-1">−1</button>
          <button class="mvp-quick" data-act="delta" data-id="${p.id}" data-d="1" title="+1">+1</button>
          <button class="mvp-quick" data-act="delta" data-id="${p.id}" data-d="5" title="+5">+5</button>
          <span class="mvp-pts">${p.points}</span>
          <button class="mvp-edit" data-act="edit" data-id="${p.id}" title="Ubah">✎</button>
          <button class="mvp-del" data-act="del" data-id="${p.id}" title="Hapus">×</button>
        </div>`
      : `<span class="mvp-pts">${p.points}</span>`;
    return `<div class="mvp-row ${rankClass}${isAdmin ? ' has-admin' : ''}" data-id="${p.id}">
      <span class="mvp-rank ${rankClass}">${i + 1}</span>
      <span class="mvp-name">${medal ? `<span class="mvp-medal">${medal}</span>` : ''}${escapeHtml(p.name)}</span>
      ${adminCell}
    </div>`;
  }).join('');

  el.innerHTML = html;

  if(isAdmin){
    el.querySelectorAll('[data-act]').forEach(b => {
      const act = b.dataset.act;
      const id = +b.dataset.id;
      if(act === 'delta')      b.addEventListener('click', () => mvpDelta(id, +b.dataset.d));
      else if(act === 'edit')  b.addEventListener('click', () => mvpEdit(id));
      else if(act === 'del')   b.addEventListener('click', () => mvpDelete(id));
    });
  }
}

async function mvpDelta(id, delta){
  if(role !== 'admin') return;
  // Optimistic local update so the UI feels snappy
  const e = mvpEntries.find(x => x.id === id);
  if(e){ e.points = Math.max(0, e.points + delta); mvpEntries.sort(mvpSort); renderMvpTable(); }
  try {
    const r = await fetch(`/api/mvp/${id}`, {
      method:'PATCH',
      headers:{'content-type':'application/json','x-admin-token':adminToken},
      body: JSON.stringify({ delta })
    });
    if(!r.ok) throw 0;
  } catch { toast('Gagal update'); loadMvpEntries(); }
}

async function mvpEdit(id){
  if(role !== 'admin') return;
  const e = mvpEntries.find(x => x.id === id);
  if(!e) return;
  const newName = prompt('Nama pemain', e.name);
  if(newName == null) return;
  const newPtsStr = prompt(`Poin untuk "${newName.trim()}"`, String(e.points));
  if(newPtsStr == null) return;
  const newPts = +newPtsStr;
  if(!Number.isFinite(newPts) || newPts < 0){ toast('Poin tidak valid'); return; }
  try {
    const r = await fetch(`/api/mvp/${id}`, {
      method:'PATCH',
      headers:{'content-type':'application/json','x-admin-token':adminToken},
      body: JSON.stringify({ name: newName.trim(), points: newPts })
    });
    if(!r.ok) throw 0;
    toast('Disimpan');
  } catch { toast('Gagal update'); }
}

async function mvpDelete(id){
  if(role !== 'admin') return;
  const e = mvpEntries.find(x => x.id === id);
  if(!e) return;
  if(!confirm(`Hapus "${e.name}" dari klasemen?`)) return;
  try {
    const r = await fetch(`/api/mvp/${id}`, { method:'DELETE', headers:{'x-admin-token':adminToken} });
    if(!r.ok) throw 0;
  } catch { toast('Gagal menghapus'); }
}

function mvpSort(a, b){
  if(b.points !== a.points) return b.points - a.points;
  return a.name.localeCompare(b.name);
}

// Admin: add new player — always added to the currently-viewed month so
// admins can backfill into past months too if they need to.
$('mvp-add-btn')?.addEventListener('click', async () => {
  if(role !== 'admin') return;
  const nameEl = $('mvp-name-input'), ptsEl = $('mvp-pts-input');
  const name = nameEl.value.trim();
  const points = +ptsEl.value || 0;
  if(!name){ toast('Isi nama pemain'); return; }
  try {
    const r = await fetch('/api/mvp', {
      method:'POST',
      headers:{'content-type':'application/json','x-admin-token':adminToken},
      body: JSON.stringify({ name, points, month: mvpSelectedMonth })
    });
    if(!r.ok){ const e = await r.json().catch(()=>({})); toast(e.error || 'Gagal menambah'); return; }
    nameEl.value = '';
    ptsEl.value = '0';
    nameEl.focus();
  } catch { toast('Gagal menambah'); }
});
$('mvp-name-input')?.addEventListener('keydown', e => { if(e.key === 'Enter') $('mvp-pts-input').focus(); });
$('mvp-pts-input')?.addEventListener('keydown', e => { if(e.key === 'Enter') $('mvp-add-btn').click(); });

// Admin: clear current month only (so historic months stay intact)
$('mvp-clear-btn')?.addEventListener('click', async () => {
  if(role !== 'admin') return;
  if(!mvpEntries.length){ toast('Sudah kosong'); return; }
  if(!confirm(`Kosongkan klasemen ${formatMonthLabel(mvpSelectedMonth)}?`)) return;
  try {
    const r = await fetch('/api/mvp?month=' + encodeURIComponent(mvpSelectedMonth), {
      method:'DELETE', headers:{'x-admin-token':adminToken}
    });
    if(!r.ok) throw 0;
    toast('Klasemen dikosongkan');
  } catch { toast('Gagal menghapus'); }
});

// Month dropdown — viewers and admins both use this to switch months
$('mvp-month-select')?.addEventListener('change', e => {
  mvpSelectedMonth = e.target.value;
  loadMvpEntries();
});

// Admin: prize editor panel. Pure inline UI — no native prompt/confirm.
// State: { label, image_url } reflecting the unsaved form values.
let mvpPrizeDraft = { label: '', image_url: '' };

function openMvpPrizeEditor(){
  if(role !== 'admin') return;
  // Seed the draft from the current saved prize for this month
  mvpPrizeDraft = {
    label: mvpPrize?.prize_label || '',
    image_url: mvpPrize?.prize_image || '',
  };
  $('mvp-prize-editor-month').textContent = formatMonthLabel(mvpSelectedMonth);
  $('mvp-prize-label-input').value = mvpPrizeDraft.label;
  renderMvpPrizeEditorPreview();
  $('mvp-prize-editor').style.display = '';
  $('mvp-prize-toggle-btn').style.display = 'none';
  setTimeout(() => $('mvp-prize-label-input').focus(), 50);
}
function closeMvpPrizeEditor(){
  $('mvp-prize-editor').style.display = 'none';
  $('mvp-prize-toggle-btn').style.display = '';
  // Reset the file input so the same file can be re-picked next time
  if($('mvp-prize-file')) $('mvp-prize-file').value = '';
}
function renderMvpPrizeEditorPreview(){
  const wrap = $('mvp-prize-editor-preview');
  const removeBtn = $('mvp-prize-remove-img');
  if(!wrap) return;
  if(mvpPrizeDraft.image_url){
    wrap.innerHTML = `<img src="${escapeHtml(mvpPrizeDraft.image_url)}" alt="">`;
    if(removeBtn) removeBtn.style.display = '';
  } else {
    wrap.innerHTML = '<div class="mvp-prize-editor-empty">📷 Belum ada gambar</div>';
    if(removeBtn) removeBtn.style.display = 'none';
  }
}

$('mvp-prize-toggle-btn')?.addEventListener('click', openMvpPrizeEditor);
$('mvp-prize-editor-close')?.addEventListener('click', closeMvpPrizeEditor);
$('mvp-prize-cancel')?.addEventListener('click', closeMvpPrizeEditor);

$('mvp-prize-file')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if(!file) return;
  if(file.size > 10 * 1024 * 1024){ toast('Gambar terlalu besar (maks 10MB)'); e.target.value = ''; return; }
  // Show local preview immediately while uploading in background
  const reader = new FileReader();
  reader.onload = () => {
    mvpPrizeDraft.image_url = reader.result; // temporary base64 for preview
    renderMvpPrizeEditorPreview();
  };
  reader.readAsDataURL(file);
  toast('Mengunggah gambar…');
  try {
    const [url] = await uploadImageFiles([file], 'mvp');
    mvpPrizeDraft.image_url = url;
    renderMvpPrizeEditorPreview();
    toast('✓ Gambar diunggah');
  } catch(err){
    toast(err.message || 'Upload gagal');
    // Revert preview to the saved value
    mvpPrizeDraft.image_url = mvpPrize?.prize_image || '';
    renderMvpPrizeEditorPreview();
  }
});

$('mvp-prize-remove-img')?.addEventListener('click', () => {
  mvpPrizeDraft.image_url = '';
  if($('mvp-prize-file')) $('mvp-prize-file').value = '';
  renderMvpPrizeEditorPreview();
});

$('mvp-prize-save')?.addEventListener('click', async () => {
  if(role !== 'admin') return;
  const label = $('mvp-prize-label-input').value.trim();
  const body = {
    month: mvpSelectedMonth,
    prize_label: label,
    prize_image: mvpPrizeDraft.image_url || null,
  };
  // Block save if a base64 preview slipped through (upload should have replaced it)
  if(body.prize_image && body.prize_image.startsWith('data:')){
    toast('Tunggu upload selesai…'); return;
  }
  try {
    const r = await fetch('/api/mvp/prize', {
      method:'PUT',
      headers:{'content-type':'application/json','x-admin-token':adminToken},
      body: JSON.stringify(body)
    });
    if(!r.ok){ const e = await r.json().catch(()=>({})); toast(e.error || 'Gagal menyimpan'); return; }
    toast('✓ Hadiah disimpan');
    closeMvpPrizeEditor();
  } catch { toast('Gagal menyimpan'); }
});

// Live updates: server now broadcasts which month changed. Refetch only
// when the change touched the month we're viewing OR the dropdown needs
// to gain a brand-new month entry.
if(typeof socket !== 'undefined' && socket){
  socket.on('mvp-updated', (payload) => {
    const changedMonth = payload && payload.month;
    if(currentTab === 'mvp'){
      loadMvpMonths().then(() => {
        if(!changedMonth || changedMonth === mvpSelectedMonth) loadMvpEntries();
      });
    }
  });
  socket.on('mvp-prize-updated', (payload) => {
    if(currentTab === 'mvp' && payload?.month === mvpSelectedMonth){
      // Just the prize changed — refetch and re-render that part only
      fetch('/api/mvp/prize?month=' + encodeURIComponent(mvpSelectedMonth))
        .then(r => r.ok ? r.json() : null)
        .then(d => { mvpPrize = d; renderMvpPrize(); })
        .catch(() => {});
    }
  });
}
