// ═══════════════════════════════════════════════════════════════════════════
// AUCTION — live Facebook auction announcements
// ═══════════════════════════════════════════════════════════════════════════
// Depends on: $, escapeHtml, toast, role, adminToken, currentTab.
// Inline-script socket handlers reference auctionsActive, auctionsHistory,
// renderAuctionLists — those references resolve at event-fire time, after
// this script has loaded.

let auctionsActive = [];
let auctionsHistory = [];
let pendingAuctionImage = '';
let auctionCountdownTimer = null;

function fmtCountdown(ms){
  if(ms <= 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  if(d > 0) return `${d}h ${pad(h)}:${pad(m)}:${pad(s)}`;
  if(h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

async function loadAuctions(){
  if(!auctionsActive.length && !auctionsHistory.length){
    const skeleton = '<div class="skeleton-list">' +
      '<div class="skeleton-row tall"></div>'.repeat(2) + '</div>';
    const a = $('auction-active-list'); if(a) a.innerHTML = skeleton;
    const h = $('auction-history-list'); if(h) h.innerHTML = skeleton;
  }
  try {
    const r = await fetch('/api/auctions');
    if(!r.ok) throw 0;
    const data = await r.json();
    auctionsActive = data.active || [];
    auctionsHistory = data.history || [];
  } catch { auctionsActive = []; auctionsHistory = []; }
  renderAuctionLists();
  startAuctionCountdown();
}

function renderAuctionLists(){
  renderAuctionActive();
  renderAuctionHistory();
}

function renderAuctionActive(){
  const el = $('auction-active-list'); if(!el) return;
  $('auction-active-count').textContent = auctionsActive.length;
  if(!auctionsActive.length){
    el.innerHTML = '<div class="empty-msg">Belum ada lelang aktif</div>';
    return;
  }
  const isAdmin = role === 'admin';
  el.innerHTML = auctionsActive.map(a => auctionCardHtml(a, false, isAdmin)).join('');
  attachAuctionHandlers(el, isAdmin);
}

function renderAuctionHistory(){
  const el = $('auction-history-list'); if(!el) return;
  if(!auctionsHistory.length){
    el.innerHTML = '<div class="empty-msg">Belum ada lelang selesai</div>';
    return;
  }
  const isAdmin = role === 'admin';
  el.innerHTML = auctionsHistory.map(a => auctionCardHtml(a, true, isAdmin)).join('');
  attachAuctionHandlers(el, isAdmin);
}

function auctionCardHtml(a, closed, isAdmin){
  // Poster — full-width hero image. Falls back to a placeholder for old
  // rows that predate the poster-required validation.
  const liveBadge = !closed ? `<div class="auction-card-live-badge">Live</div>` : '';
  const countdown = closed
    ? `<div class="auction-card-countdown">Selesai</div>`
    : `<div class="auction-card-countdown" data-ends="${a.ends_at}">--:--</div>`;
  const poster = a.image_url
    ? `<div class="auction-card-poster">
        ${liveBadge}
        ${countdown}
        <img src="${escapeHtml(a.image_url)}" alt="" data-act="zoom">
      </div>`
    : `<div class="auction-card-poster empty">
        ${liveBadge}
        ${countdown}
        📦
      </div>`;

  // Facebook CTA — disabled for closed auctions or rows without a link.
  let cta;
  if(closed){
    cta = `<div class="auction-fb-cta-disabled">Lelang Sudah Selesai</div>`;
  } else if(a.facebook_url){
    cta = `<a class="auction-fb-cta" href="${escapeHtml(a.facebook_url)}" target="_blank" rel="noopener noreferrer">
      <span style="font-size:18px">📺</span> Tonton di Facebook Live
    </a>`;
  } else {
    cta = `<div class="auction-fb-cta-disabled">Link Facebook belum ditambahkan</div>`;
  }

  const title = a.title && a.title !== 'Lelang Live'
    ? `<h3 class="auction-card-title">${escapeHtml(a.title)}</h3>`
    : '';

  // Admin actions — minimal: extend, edit, close, delete (or just delete for closed).
  const adminActions = isAdmin ? (closed
    ? `<div class="auction-card-actions">
        <button class="btn btn-ghost btn-sm" data-act="delete" data-id="${a.id}" style="color:#ff8888">🗑 Hapus</button>
      </div>`
    : `<div class="auction-card-actions">
        <button class="btn btn-ghost btn-sm" data-act="edit" data-id="${a.id}">✎ Edit</button>
        <button class="btn btn-ghost btn-sm" data-act="extend" data-id="${a.id}" data-sec="300">+5m</button>
        <button class="btn btn-ghost btn-sm" data-act="extend" data-id="${a.id}" data-sec="900">+15m</button>
        <button class="btn btn-ghost btn-sm" data-act="close" data-id="${a.id}">⏹ Tutup</button>
        <button class="btn btn-ghost btn-sm" data-act="delete" data-id="${a.id}" style="color:#ff8888">🗑</button>
      </div>`) : '';

  return `<div class="auction-card${closed ? ' closed' : ''}" data-id="${a.id}">
    ${poster}
    <div class="auction-card-body">
      ${title}
      ${cta}
      ${adminActions}
    </div>
  </div>`;
}

function attachAuctionHandlers(scope, isAdmin){
  // Click poster → open lightbox so viewers can see the full poster.
  scope.querySelectorAll('img[data-act="zoom"]').forEach(im => {
    im.addEventListener('click', () => openLightbox(im.src));
  });
  if(!isAdmin) return;
  scope.querySelectorAll('[data-act]').forEach(b => {
    if(b.tagName === 'IMG') return;
    const act = b.dataset.act;
    const id = +b.dataset.id;
    if(act === 'extend')      b.addEventListener('click', () => extendAuction(id, +b.dataset.sec));
    else if(act === 'edit')   b.addEventListener('click', () => promptEditAuction(id));
    else if(act === 'close')  b.addEventListener('click', () => closeAuction(id));
    else if(act === 'delete') b.addEventListener('click', () => deleteAuction(id));
  });
}

function openLightbox(src){
  let lb = document.getElementById('auction-lightbox');
  if(!lb){
    lb = document.createElement('div');
    lb.id = 'auction-lightbox';
    lb.innerHTML = '<img alt=""><button class="lb-close">×</button>';
    document.body.appendChild(lb);
    lb.addEventListener('click', e => { if(e.target === lb || e.target.classList.contains('lb-close')) lb.style.display = 'none'; });
  }
  lb.querySelector('img').src = src;
  lb.style.display = 'flex';
}

function startAuctionCountdown(){
  if(auctionCountdownTimer) return;
  auctionCountdownTimer = setInterval(() => {
    if(currentTab !== 'auction') return;
    document.querySelectorAll('.auction-card-countdown[data-ends]').forEach(el => {
      const ends = new Date(el.dataset.ends).getTime();
      const ms = ends - Date.now();
      el.textContent = fmtCountdown(ms);
      const card = el.closest('.auction-card');
      if(card) card.classList.toggle('ending', ms > 0 && ms < 60_000);
    });
  }, 1000);
}

async function createAuction(){
  if(role !== 'admin') return;
  const title = $('auction-title-input').value.trim();
  const facebook_url = $('auction-fb-url-input').value.trim();
  const image_url = pendingAuctionImage;
  const hours = Number($('auction-dur-h-input').value) || 0;
  const minutes = Number($('auction-dur-m-input').value) || 0;
  const duration_seconds = hours * 3600 + minutes * 60;
  if(!image_url){ toast('Upload poster lelang dulu'); return; }
  if(!facebook_url){ toast('Link Facebook wajib diisi'); return; }
  if(!/^https:\/\//i.test(facebook_url)){ toast('Link Facebook harus diawali https://'); return; }
  if(duration_seconds < 60){ toast('Durasi minimal 1 menit'); return; }
  try {
    const r = await fetch('/api/auctions', {
      method: 'POST',
      headers: { 'content-type':'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify({ title, image_url, facebook_url, duration_seconds })
    });
    if(!r.ok){ const e = await r.json().catch(()=>({})); throw new Error(e.error || 'fail'); }
    // Will arrive via socket auction-created
    $('auction-title-input').value = '';
    $('auction-fb-url-input').value = '';
    $('auction-dur-h-input').value = '1';
    $('auction-dur-m-input').value = '0';
    pendingAuctionImage = '';
    $('auction-image-file-input').value = '';
    $('auction-form-preview').style.display = 'none';
    $('auction-create-form').style.display = 'none';
    toast('Lelang dimulai');
  } catch(e) { toast(e.message || 'Gagal membuat lelang'); }
}

async function extendAuction(id, seconds){
  if(role !== 'admin') return;
  try {
    const r = await fetch(`/api/auctions/${id}`, {
      method:'PATCH',
      headers:{'content-type':'application/json','x-admin-token':adminToken},
      body: JSON.stringify({ extend_seconds: seconds })
    });
    if(!r.ok){ toast('Gagal'); return; }
    toast(`Diperpanjang ${Math.round(seconds/60)} menit`);
  } catch { toast('Gagal'); }
}

async function promptEditAuction(id){
  if(role !== 'admin') return;
  const a = auctionsActive.find(x => x.id === id); if(!a) return;
  const title = prompt('Caption / nama lelang (kosongkan untuk default)', a.title === 'Lelang Live' ? '' : (a.title || ''));
  if(title == null) return;
  const facebook_url = prompt('Link Facebook Live', a.facebook_url || '');
  if(facebook_url == null) return;
  const fb = facebook_url.trim();
  if(fb && !/^https:\/\//i.test(fb)){ toast('Link harus diawali https://'); return; }
  try {
    const r = await fetch(`/api/auctions/${id}`, {
      method:'PATCH',
      headers:{'content-type':'application/json','x-admin-token':adminToken},
      body: JSON.stringify({ title: title.trim(), facebook_url: fb })
    });
    if(!r.ok){ const e = await r.json().catch(()=>({})); toast(e.error || 'Gagal update'); return; }
    toast('Lelang diperbarui');
  } catch { toast('Gagal update'); }
}

async function closeAuction(id){
  if(role !== 'admin') return;
  if(!confirm('Tutup lelang ini sekarang?')) return;
  try {
    const r = await fetch(`/api/auctions/${id}/close`, { method:'POST', headers:{'x-admin-token':adminToken} });
    if(!r.ok){ toast('Gagal menutup'); return; }
    toast('Lelang ditutup');
  } catch { toast('Gagal menutup'); }
}

async function deleteAuction(id){
  if(role !== 'admin') return;
  if(!confirm('Hapus lelang ini? Tidak bisa dibatalkan.')) return;
  try {
    const r = await fetch(`/api/auctions/${id}`, { method:'DELETE', headers:{'x-admin-token':adminToken} });
    if(!r.ok){ toast('Gagal menghapus'); return; }
    toast('Dihapus');
  } catch { toast('Gagal menghapus'); }
}

async function clearAuctionHistory(){
  if(role !== 'admin') return;
  if(!confirm('Hapus semua riwayat lelang?')) return;
  try {
    await fetch('/api/auctions?scope=history', { method:'DELETE', headers:{'x-admin-token':adminToken} });
    auctionsHistory = []; renderAuctionHistory();
    toast('Riwayat dihapus');
  } catch { toast('Gagal menghapus'); }
}

$('auction-toggle-form-btn')?.addEventListener('click', () => {
  const f = $('auction-create-form');
  f.style.display = f.style.display === 'none' ? '' : 'none';
});
$('auction-create-btn')?.addEventListener('click', createAuction);
$('auction-clear-history-btn')?.addEventListener('click', clearAuctionHistory);
$('auction-image-file-input')?.addEventListener('change', async e => {
  const file = e.target.files[0];
  if(!file) return;
  if(file.size > 10 * 1024 * 1024){ toast('Gambar terlalu besar (maks 10MB)'); e.target.value=''; return; }
  // Local preview while uploading to R2
  const reader = new FileReader();
  reader.onload = () => {
    $('auction-form-preview-img').src = reader.result;
    $('auction-form-preview-name').textContent = file.name + ' (mengunggah…)';
    $('auction-form-preview').style.display = '';
  };
  reader.readAsDataURL(file);
  try {
    const [url] = await uploadImageFiles([file], 'auctions');
    pendingAuctionImage = url;
    $('auction-form-preview-img').src = url;
    $('auction-form-preview-name').textContent = file.name;
  } catch(err){
    toast(err.message || 'Upload gagal');
    pendingAuctionImage = '';
    $('auction-form-preview').style.display = 'none';
    e.target.value = '';
  }
});
$('auction-form-clear-img')?.addEventListener('click', () => {
  pendingAuctionImage = '';
  $('auction-image-file-input').value = '';
  $('auction-form-preview').style.display = 'none';
});
