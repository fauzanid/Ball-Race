// ═══════════════════════════════════════════════════════════════════════════
// MVP OF THE MONTH
// ═══════════════════════════════════════════════════════════════════════════
// Depends on: $, escapeHtml, toast, role, adminToken, socket, currentTab.
// Server returns the list pre-sorted by points DESC, name ASC, scoped to
// the requested ?month= (defaults to the current calendar month).

let mvpEntries = [];
let mvpAvailableMonths = [];
let mvpSelectedMonth = currentMonthString();
// { month, prizes: [{place, label, image}, …] } — always 10 entries (places 1-10),
// label/image may be null when that place is empty.
let mvpPrize = null;
let mvpPublishedAt = null; // ISO string of last snapshot publish for the selected month
let mvpDraft = false;     // admin's live state differs from the published snapshot

const MVP_PLACES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
// Top 3 keep gold/silver/bronze. Places 4-10 share a single muted "r-mid"
// treatment so the visual hierarchy stays clear without 10 distinct hues.
function mvpPrizeMeta(place){
  if (place === 1) return { medal: '🥇', label: 'Juara 1',  rankClass: 'r1', editorClass: 'p1' };
  if (place === 2) return { medal: '🥈', label: 'Juara 2',  rankClass: 'r2', editorClass: 'p2' };
  if (place === 3) return { medal: '🥉', label: 'Juara 3',  rankClass: 'r3', editorClass: 'p3' };
  return { medal: '', label: `Juara ${place}`, rankClass: 'r-mid', editorClass: 'p-mid', rank: place };
}
function mvpPrizeAt(place){
  return mvpPrize?.prizes?.find(p => +p.place === place) || { place, label: null, image: null };
}

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
    fetch('/api/mvp?month=' + encodeURIComponent(month), {
      headers: adminToken ? { 'x-admin-token': adminToken } : {}
    })
      .then(r => r.ok ? r.json() : { entries: [], published_at: null, draft: false })
      .then(d => {
        mvpEntries = d.entries || [];
        mvpPublishedAt = d.published_at || null;
        mvpDraft = !!d.draft;
      })
      .catch(() => { mvpEntries = []; mvpPublishedAt = null; mvpDraft = false; }),
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
  renderMvpPublishBar();
  renderMvpTable();
}

// "Terakhir dipublikasi: 5 menit yang lalu" — relative time keeps the
// bar honest without a live ticker.
function formatRelativeTime(iso){
  if(!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if(!Number.isFinite(ms) || ms < 0) return 'baru saja';
  const s = Math.floor(ms / 1000);
  if(s < 60) return 'baru saja';
  const m = Math.floor(s / 60);
  if(m < 60) return `${m} menit yang lalu`;
  const h = Math.floor(m / 60);
  if(h < 24) return `${h} jam yang lalu`;
  const d = Math.floor(h / 24);
  if(d < 30) return `${d} hari yang lalu`;
  return new Date(iso).toLocaleDateString('id-ID', { day:'numeric', month:'short', year:'numeric' });
}

function renderMvpPublishBar(){
  const el = $('mvp-publish-time');
  if(!el) return;
  const draftBadge = $('mvp-draft-badge');
  if(mvpPublishedAt){
    el.classList.remove('empty');
    el.textContent = `Terakhir dipublikasi: ${formatRelativeTime(mvpPublishedAt)}`;
  } else {
    el.classList.add('empty');
    // Viewers can't click 📸 — give them a non-actionable variant so the
    // bar doesn't look like a CTA they're missing.
    el.textContent = role === 'admin'
      ? 'Belum dipublikasi — klik 📸 Publikasi untuk mengaktifkan tampilan penonton'
      : 'Klasemen belum dipublikasi';
  }
  // Admin-only "Mode draft" pill — appears whenever admin's live state has
  // diverged from the published snapshot, so they know viewers don't yet
  // see the changes they've been making.
  if(draftBadge){
    draftBadge.style.display = (role === 'admin' && mvpDraft) ? '' : 'none';
  }
}

function renderMvpPrize(){
  const list = $('mvp-prize-list');
  if(!list) return;
  const isAdmin = role === 'admin';
  const monthLabel = formatMonthLabel(mvpSelectedMonth);

  // Build the up-to-10 banner cards. For viewers we skip empty places
  // entirely; for admins we render a dashed CTA card so it's obvious
  // where to click to set each prize.
  const cards = [];
  for(const place of MVP_PLACES){
    const prize = mvpPrizeAt(place);
    const meta = mvpPrizeMeta(place);
    const has = !!(prize.image || prize.label);
    if(!has && !isAdmin) continue;
    // Top 3 use the 🥇/🥈/🥉 emoji as a leading badge in the kicker;
    // places 4-10 use a numbered rank badge rendered inline so the place
    // is still obvious without an emoji.
    const kicker = meta.medal
      ? `${meta.medal} Hadiah ${meta.label} · ${monthLabel}`
      : `Hadiah ${meta.label} · ${monthLabel}`;
    const rankBadge = meta.rank
      ? `<span class="mvp-prize-rank-badge" aria-hidden="true">${meta.rank}</span>`
      : '';

    if(!has){
      // Empty CTA: leading icon for top 3, numbered badge for the rest.
      const emptyIcon = meta.medal
        ? `<div class="mvp-prize-empty-icon">${meta.medal}</div>`
        : `<div class="mvp-prize-empty-icon">${meta.rank}</div>`;
      cards.push(`
        <div class="mvp-prize empty ${meta.rankClass}" data-place="${place}">
          ${emptyIcon}
          <div class="mvp-prize-info">
            <div class="mvp-prize-kicker">${escapeHtml(kicker)}</div>
            <div class="mvp-prize-label">Belum ada hadiah — klik untuk atur</div>
          </div>
          <button class="mvp-prize-cta-btn" type="button" data-act="add" data-place="${place}">+ Atur</button>
        </div>`);
      continue;
    }

    const adminActions = isAdmin
      ? `<div class="mvp-prize-actions">
          <button class="mvp-prize-action edit" type="button" data-act="edit" data-place="${place}" title="Ubah hadiah" aria-label="Ubah hadiah">✎</button>
          <button class="mvp-prize-action del"  type="button" data-act="del"  data-place="${place}" title="Hapus hadiah" aria-label="Hapus hadiah">🗑</button>
        </div>`
      : '';
    if(prize.image){
      cards.push(`
        <div class="mvp-prize ${meta.rankClass}" data-place="${place}">
          ${rankBadge}
          <img class="mvp-prize-thumb" src="${escapeHtml(prize.image)}" alt="" data-act="zoom" data-place="${place}">
          <div class="mvp-prize-info">
            <div class="mvp-prize-kicker">${escapeHtml(kicker)}</div>
            <div class="mvp-prize-label">${escapeHtml(prize.label || 'Hadiah eksklusif')}</div>
          </div>
          ${adminActions}
        </div>`);
    } else {
      cards.push(`
        <div class="mvp-prize no-image ${meta.rankClass}" data-place="${place}">
          ${rankBadge}
          <div class="mvp-prize-info">
            <div class="mvp-prize-kicker">${escapeHtml(kicker)}</div>
            <div class="mvp-prize-label">${escapeHtml(prize.label)}</div>
          </div>
          ${adminActions}
        </div>`);
    }
  }

  if(!cards.length){ list.style.display = 'none'; list.innerHTML = ''; return; }
  list.style.display = '';
  list.innerHTML = cards.join('');

  // Wire up listeners. Empty CTAs use whole-card click; populated cards
  // use the icon buttons. ✎ on a populated card focuses that place; the
  // editor still shows all 3 sections.
  list.querySelectorAll('.mvp-prize.empty').forEach(card => {
    const place = +card.dataset.place;
    card.onclick = () => openMvpPrizeEditor(place);
    card.querySelector('[data-act="add"]')?.addEventListener('click', e => {
      e.stopPropagation(); openMvpPrizeEditor(place);
    });
  });
  list.querySelectorAll('img[data-act="zoom"]').forEach(img => {
    img.addEventListener('click', () => openMvpLightbox(img.getAttribute('src')));
  });
  list.querySelectorAll('[data-act="edit"]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation(); openMvpPrizeEditor(+btn.dataset.place);
    });
  });
  list.querySelectorAll('[data-act="del"]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation(); deleteMvpPrize(+btn.dataset.place);
    });
  });
}

async function deleteMvpPrize(place){
  if(role !== 'admin') return;
  if(!MVP_PLACES.includes(place)) return;
  const meta = mvpPrizeMeta(place);
  if(!confirm(`Hapus hadiah ${meta.label} ${formatMonthLabel(mvpSelectedMonth)}?`)) return;
  try {
    const url = '/api/mvp/prize?month=' + encodeURIComponent(mvpSelectedMonth) + '&place=' + place;
    const r = await fetch(url, {
      method:'DELETE',
      headers:{'x-admin-token':adminToken}
    });
    if(!r.ok){ const e = await r.json().catch(()=>({})); toast(e.error || 'Gagal menghapus'); return; }
    toast(`✓ Hadiah ${meta.label} dihapus`);
  } catch { toast('Gagal menghapus'); }
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

// Movement chip — server returns delta = (rank 48h ago) − (rank now).
// Positive = climbed, negative = dropped, 0 = stayed, null = new entry.
function movementChipHtml(m){
  if(m == null) return `<span class="mvp-move new" title="Pemain baru di periode ini">✦ Baru</span>`;
  if(m > 0)    return `<span class="mvp-move up" title="Naik ${m} posisi">▲${m}</span>`;
  if(m < 0)    return `<span class="mvp-move down" title="Turun ${-m} posisi">▼${-m}</span>`;
  return `<span class="mvp-move same" title="Tidak berubah">─</span>`;
}

function renderMvpTable(){
  const el = $('mvp-table');
  if(!el) return;
  const isAdmin = role === 'admin';
  const hasPublish = !!mvpPublishedAt;
  // Toggle the extra grid column on/off based on whether chips will render.
  el.classList.toggle('has-publish', hasPublish);

  if(!mvpEntries.length){
    // Viewer-side empty state distinguishes "no publish yet" from "empty
    // chart" — both look the same to the client (no entries) but the
    // wording is honest about why nothing is visible.
    el.innerHTML = `<div class="empty-msg" style="padding:32px 16px">${
      isAdmin
        ? 'Tambah pemain pertama untuk mulai klasemen.'
        : (mvpPublishedAt ? 'Belum ada pemain di klasemen.' : 'Klasemen belum dipublikasi oleh admin.')
    }</div>`;
    return;
  }

  // Header — empty cell between # and Pemain mirrors the chip column.
  // Only rendered when there's a publish to compare against.
  let html = `<div class="mvp-thead">
    <span>#</span>
    ${hasPublish ? '<span></span>' : ''}
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
    // Hide chips entirely until admin publishes a baseline — otherwise
    // every row would say "✦ Baru" which is misleading (no comparison
    // exists yet, the player isn't actually "new").
    const moveCell = hasPublish
      ? `<span class="mvp-move-cell">${movementChipHtml(p.movement)}</span>`
      : '';
    return `<div class="mvp-row ${rankClass}${isAdmin ? ' has-admin' : ''}" data-id="${p.id}">
      <span class="mvp-rank ${rankClass}">${i + 1}</span>
      ${moveCell}
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
  // Optimistic local update so the UI feels snappy. A rank shift makes
  // every entry's server-computed `movement` stale — without clearing
  // them, the player who just jumped from rank 5 to rank 1 would still
  // show their old "▼1" chip until the socket round-trip lands. Reset
  // all movements to 0 (─) for the in-flight render; the socket
  // refresh recomputes the real values.
  const e = mvpEntries.find(x => x.id === id);
  if(e){
    e.points = Math.max(0, e.points + delta);
    mvpEntries.forEach(x => { if(x.movement != null) x.movement = 0; });
    mvpEntries.sort(mvpSort);
    renderMvpTable();
  }
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
  if(role !== 'admin'){ toast('Login admin dulu'); return; }
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
    const created = await r.json().catch(()=>null);
    nameEl.value = '';
    ptsEl.value = '0';
    nameEl.focus();
    // Refresh locally — socket round-trip usually beats us here, but
    // the explicit reload guarantees the new row renders even if the
    // socket is down or the client just resumed from another tab.
    await loadMvpEntries();
    // 0-pt adds land at the bottom of a sorted list; scroll the new row
    // into view so admin gets visual confirmation that it landed.
    if(created?.id){
      const row = document.querySelector(`.mvp-row[data-id="${created.id}"]`);
      if(row) row.scrollIntoView({ behavior:'smooth', block:'nearest' });
    }
    toast(`✓ ${name} ditambahkan`);
  } catch { toast('Gagal menambah'); }
});
$('mvp-name-input')?.addEventListener('keydown', e => { if(e.key === 'Enter') $('mvp-pts-input').focus(); });
$('mvp-pts-input')?.addEventListener('keydown', e => { if(e.key === 'Enter') $('mvp-add-btn').click(); });

// Admin: publish current standings as the new ▲▼ baseline. Until the
// next publish, viewers see how each player has shifted vs. this snapshot.
$('mvp-publish-btn')?.addEventListener('click', async () => {
  if(role !== 'admin') return;
  if(!mvpEntries.length){ toast('Tambah pemain dulu'); return; }
  const btn = $('mvp-publish-btn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/mvp/publish', {
      method:'POST',
      headers:{'content-type':'application/json','x-admin-token':adminToken},
      body: JSON.stringify({ month: mvpSelectedMonth })
    });
    if(!r.ok){ const e = await r.json().catch(()=>({})); toast(e.error || 'Gagal publikasi'); return; }
    toast('✓ Klasemen dipublikasi');
  } catch { toast('Gagal publikasi'); }
  finally { btn.disabled = false; }
});

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

// Admin: prize editor panel. One panel covers all 10 places — admin edits
// everything and Save commits all places at once. State: per-place
// { label, image_url } reflecting the unsaved form values. The 10 sections
// are JS-generated into #mvp-prize-editor-places on first open so we don't
// have to maintain 10 hardcoded HTML copies.
let mvpPrizeDraft = Object.fromEntries(MVP_PLACES.map(p => [p, { label: '', image_url: '' }]));
let mvpPrizeEditorBuilt = false;

function buildMvpPrizeEditorSections(){
  const wrap = $('mvp-prize-editor-places');
  if(!wrap) return;
  wrap.innerHTML = MVP_PLACES.map(place => {
    const meta = mvpPrizeMeta(place);
    const titleIcon = meta.medal || `<span class="mvp-prize-rank-badge" aria-hidden="true">${meta.rank}</span>`;
    const placeholder = place === 1
      ? 'Label hadiah juara 1 (mis. Voucher Rp 500K)'
      : `Label hadiah juara ${place}`;
    return `
      <div class="mvp-prize-editor-place ${meta.editorClass}" data-place="${place}">
        <span class="mvp-prize-editor-place-title">${titleIcon} ${escapeHtml(meta.label)}</span>
        <input id="mvp-prize-label-input-${place}" placeholder="${escapeHtml(placeholder)}" maxlength="200">
        <div class="mvp-prize-editor-image-row">
          <div class="mvp-prize-editor-preview" id="mvp-prize-editor-preview-${place}">
            <div class="mvp-prize-editor-empty">📷 Belum ada gambar</div>
          </div>
          <div class="mvp-prize-editor-actions">
            <label class="lucky-upload-label" title="Pilih gambar">
              📸 Pilih Gambar
              <input type="file" id="mvp-prize-file-${place}" accept="image/*" style="display:none">
            </label>
            <button class="btn btn-ghost btn-xs mvp-prize-remove-img" id="mvp-prize-remove-img-${place}" type="button" style="display:none;color:#ff5577">🗑 Hapus Gambar</button>
          </div>
        </div>
      </div>`;
  }).join('');

  // Wire up per-place file pickers and remove buttons after the elements exist.
  for(const place of MVP_PLACES){
    $(`mvp-prize-file-${place}`)?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if(!file) return;
      if(file.size > 10 * 1024 * 1024){ toast('Gambar terlalu besar (maks 10MB)'); e.target.value = ''; return; }
      // Show local preview immediately while uploading in background
      const reader = new FileReader();
      reader.onload = () => {
        mvpPrizeDraft[place].image_url = reader.result; // temporary base64 for preview
        renderMvpPrizeEditorPreview(place);
      };
      reader.readAsDataURL(file);
      toast('Mengunggah gambar…');
      try {
        const [url] = await uploadImageFiles([file], 'mvp');
        mvpPrizeDraft[place].image_url = url;
        renderMvpPrizeEditorPreview(place);
        toast('✓ Gambar diunggah');
      } catch(err){
        toast(err.message || 'Upload gagal');
        // Revert preview to the saved value
        mvpPrizeDraft[place].image_url = mvpPrizeAt(place).image || '';
        renderMvpPrizeEditorPreview(place);
      }
    });

    $(`mvp-prize-remove-img-${place}`)?.addEventListener('click', () => {
      mvpPrizeDraft[place].image_url = '';
      const f = $(`mvp-prize-file-${place}`);
      if(f) f.value = '';
      renderMvpPrizeEditorPreview(place);
    });
  }
  mvpPrizeEditorBuilt = true;
}

function openMvpPrizeEditor(focusPlace){
  if(role !== 'admin') return;
  const editor = $('mvp-prize-editor');
  if(!editor) return;
  if(!mvpPrizeEditorBuilt) buildMvpPrizeEditorSections();
  // Seed the draft from the current saved prizes for this month
  for(const place of MVP_PLACES){
    const p = mvpPrizeAt(place);
    mvpPrizeDraft[place] = { label: p.label || '', image_url: p.image || '' };
    const labelInput = $(`mvp-prize-label-input-${place}`);
    if(labelInput) labelInput.value = mvpPrizeDraft[place].label;
    renderMvpPrizeEditorPreview(place);
  }
  $('mvp-prize-editor-month').textContent = formatMonthLabel(mvpSelectedMonth);
  editor.style.display = '';
  // Bring the editor into view, then scroll the focused section to the
  // top of the inner scroll container so the right place is visible
  // even when the admin clicked place 8.
  setTimeout(() => {
    editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const focus = MVP_PLACES.includes(focusPlace) ? focusPlace : 1;
    const section = document.querySelector(`.mvp-prize-editor-place[data-place="${focus}"]`);
    if(section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $(`mvp-prize-label-input-${focus}`)?.focus({ preventScroll: true });
  }, 50);
}
function closeMvpPrizeEditor(){
  const editor = $('mvp-prize-editor');
  if(editor) editor.style.display = 'none';
  // Reset the file inputs so the same file can be re-picked next time
  for(const place of MVP_PLACES){
    const f = $(`mvp-prize-file-${place}`);
    if(f) f.value = '';
  }
}
function renderMvpPrizeEditorPreview(place){
  const wrap = $(`mvp-prize-editor-preview-${place}`);
  const removeBtn = $(`mvp-prize-remove-img-${place}`);
  if(!wrap) return;
  const url = mvpPrizeDraft[place]?.image_url || '';
  if(url){
    wrap.innerHTML = `<img src="${escapeHtml(url)}" alt="">`;
    if(removeBtn) removeBtn.style.display = '';
  } else {
    wrap.innerHTML = '<div class="mvp-prize-editor-empty">📷 Belum ada gambar</div>';
    if(removeBtn) removeBtn.style.display = 'none';
  }
}

$('mvp-prize-editor-close')?.addEventListener('click', closeMvpPrizeEditor);
$('mvp-prize-cancel')?.addEventListener('click', closeMvpPrizeEditor);

$('mvp-prize-save')?.addEventListener('click', async () => {
  if(role !== 'admin') return;
  const prizes = [];
  for(const place of MVP_PLACES){
    const labelEl = $(`mvp-prize-label-input-${place}`);
    const label = (labelEl?.value || '').trim();
    const image = mvpPrizeDraft[place]?.image_url || null;
    // Block save if a base64 preview slipped through (upload should have replaced it)
    if(image && typeof image === 'string' && image.startsWith('data:')){
      toast('Tunggu upload selesai…');
      return;
    }
    prizes.push({ place, label, image });
  }
  try {
    const r = await fetch('/api/mvp/prize', {
      method:'PUT',
      headers:{'content-type':'application/json','x-admin-token':adminToken},
      body: JSON.stringify({ month: mvpSelectedMonth, prizes })
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
