// ═══════════════════════════════════════════════════════════════════════════
// AUCTION
// ═══════════════════════════════════════════════════════════════════════════
// Depends on: $, escapeHtml, toast, role, adminToken, currentTab.
// Inline-script socket handlers reference auctionsActive, auctionsHistory,
// renderAuctionLists, renderAuctionActive — those references resolve at
// event-fire time, after this script has loaded.

let auctionsActive = [];
let auctionsHistory = [];
let pendingAuctionImage = '';
let auctionCountdownTimer = null;

function fmtRupiah(n){
  if(n == null) return '–';
  return 'Rp ' + Math.round(Number(n)).toLocaleString('id-ID');
}
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
  if(isAdmin) attachAuctionActionHandlers(el);
}

function renderAuctionHistory(){
  const el = $('auction-history-list'); if(!el) return;
  if(!auctionsHistory.length){
    el.innerHTML = '<div class="empty-msg">Belum ada lelang selesai</div>';
    return;
  }
  const isAdmin = role === 'admin';
  el.innerHTML = auctionsHistory.map(a => auctionCardHtml(a, true, isAdmin)).join('');
  if(isAdmin) attachAuctionActionHandlers(el);
}

function auctionCardHtml(a, closed, isAdmin){
  const img = a.image_url
    ? `<img class="auction-card-img" src="${escapeHtml(a.image_url)}" alt="">`
    : `<div class="auction-card-img-empty">📦</div>`;
  const desc = a.description ? `<div class="auction-card-desc">${escapeHtml(a.description)}</div>` : '';
  const bid = a.current_bid != null
    ? `<div class="auction-card-price-block"><span class="auction-card-price-label">Tawaran</span><span class="auction-card-price bid">${fmtRupiah(a.current_bid)}</span></div>`
    : '';
  const bidder = a.current_bidder ? `<div class="auction-card-bidder">oleh <strong>${escapeHtml(a.current_bidder)}</strong></div>` : '';
  const winner = closed && a.current_bidder
    ? `<div class="auction-card-winner">🏆 ${escapeHtml(a.current_bidder)} · ${fmtRupiah(a.current_bid)}</div>`
    : (closed ? `<div class="auction-card-winner">Tidak ada penawar</div>` : '');
  const timer = closed
    ? `<div class="auction-card-timer">Selesai</div>`
    : `<div class="auction-card-timer" data-ends="${a.ends_at}">--:--</div>`;
  const galleryButton = a.image_count > 0
    ? `<button class="btn btn-ghost btn-sm" data-act="gallery" data-id="${a.id}">🖼 Lihat Foto (${a.image_count})</button>`
    : '';
  const adminActions = (isAdmin && !closed) ? `
    <div class="auction-card-actions">
      <button class="btn btn-primary btn-sm" data-act="bid" data-id="${a.id}">💰 Update Tawaran</button>
      <button class="btn btn-ghost btn-sm" data-act="extend" data-id="${a.id}" data-sec="300">+5m</button>
      <button class="btn btn-ghost btn-sm" data-act="extend" data-id="${a.id}" data-sec="900">+15m</button>
      <button class="btn btn-ghost btn-sm" data-act="edit" data-id="${a.id}">✎ Edit</button>
      <button class="btn btn-ghost btn-sm" data-act="add-photos" data-id="${a.id}">📷 + Foto</button>
      ${galleryButton}
      <button class="btn btn-ghost btn-sm" data-act="close" data-id="${a.id}">⏹ Tutup</button>
      <button class="btn btn-ghost btn-sm" data-act="delete" data-id="${a.id}" style="color:#ff8888">🗑</button>
    </div>` : (isAdmin && closed ? `
    <div class="auction-card-actions">
      ${galleryButton}
      <button class="btn btn-ghost btn-sm" data-act="delete" data-id="${a.id}" style="color:#ff8888">🗑 Hapus</button>
    </div>` : (galleryButton ? `<div class="auction-card-actions">${galleryButton}</div>` : ''));
  return `<div class="auction-card${closed ? ' closed' : ''}" data-id="${a.id}">
    ${img}
    <div class="auction-card-body">
      <h3 class="auction-card-title">${escapeHtml(a.title)}</h3>
      ${desc}
      <div class="auction-card-prices">
        <div class="auction-card-price-block">
          <span class="auction-card-price-label">Harga awal</span>
          <span class="auction-card-price">${fmtRupiah(a.starting_price)}</span>
        </div>
        ${bid}
      </div>
      ${bidder}
      ${winner}
      ${timer}
      ${adminActions}
      <div class="auction-gallery" id="auction-gallery-${a.id}" style="display:none"></div>
    </div>
  </div>`;
}

function attachAuctionActionHandlers(scope){
  scope.querySelectorAll('[data-act]').forEach(b => {
    const act = b.dataset.act;
    const id = +b.dataset.id;
    if(act === 'bid') b.addEventListener('click', () => promptUpdateBid(id));
    else if(act === 'extend') b.addEventListener('click', () => extendAuction(id, +b.dataset.sec));
    else if(act === 'edit') b.addEventListener('click', () => promptEditAuction(id));
    else if(act === 'close') b.addEventListener('click', () => closeAuction(id));
    else if(act === 'delete') b.addEventListener('click', () => deleteAuction(id));
    else if(act === 'gallery') b.addEventListener('click', () => toggleAuctionGallery(id));
    else if(act === 'add-photos') b.addEventListener('click', () => triggerAddPhotos(id));
  });
}

// Hidden file input we reuse for the "+ Foto" button. Created lazily on first use.
let _auctionPhotoInput = null;
let _auctionPhotoTargetId = null;
function triggerAddPhotos(auctionId){
  if(role !== 'admin') return;
  if(!_auctionPhotoInput){
    _auctionPhotoInput = document.createElement('input');
    _auctionPhotoInput.type = 'file';
    _auctionPhotoInput.accept = 'image/*';
    _auctionPhotoInput.multiple = true;
    _auctionPhotoInput.style.display = 'none';
    document.body.appendChild(_auctionPhotoInput);
    _auctionPhotoInput.addEventListener('change', async (e) => {
      const targetId = _auctionPhotoTargetId;
      _auctionPhotoTargetId = null;
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if(!files.length || !targetId) return;
      await uploadAuctionPhotos(targetId, files);
    });
  }
  _auctionPhotoTargetId = auctionId;
  _auctionPhotoInput.click();
}

// Upload N photos for one auction. Files go through /api/upload first
// (server converts to WebP + stores in R2, returns URLs), then the URLs
// are POSTed to /api/auctions/:id/images in batches of 20.
async function uploadAuctionPhotos(auctionId, files){
  const valid = files.filter(f => f.size <= 10 * 1024 * 1024);
  const dropped = files.length - valid.length;
  const total = valid.length;
  if(!total){
    toast(dropped ? `${dropped} file terlalu besar (maks 10MB)` : 'Tidak ada foto');
    return;
  }
  toast(`Mengunggah ${total} foto…`);
  // Upload to R2 in chunks of 6 to keep request size small + parallelism reasonable
  const CHUNK = 6;
  let urls = [];
  for(let i = 0; i < valid.length; i += CHUNK){
    const chunk = valid.slice(i, i + CHUNK);
    try {
      const got = await uploadImageFiles(chunk, `auctions/${auctionId}`);
      urls = urls.concat(got);
    } catch(err){
      toast(err.message || 'Upload gagal'); return;
    }
  }
  // Now register the URLs against the auction in batches
  let processed = 0;
  for(let i = 0; i < urls.length; i += 20){
    const batch = urls.slice(i, i + 20);
    try {
      const r = await fetch(`/api/auctions/${auctionId}/images`, {
        method: 'POST',
        headers: { 'content-type':'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ images: batch })
      });
      if(!r.ok){ const e = await r.json().catch(()=>({})); toast(e.error || 'Gagal menyimpan'); return; }
      const data = await r.json();
      processed += data.added || 0;
    } catch { toast('Gagal menyimpan'); return; }
  }
  toast(`✓ ${processed} foto diunggah${dropped ? ` (${dropped} terlalu besar)` : ''}`);
  const a = auctionsActive.find(x => x.id === auctionId) || auctionsHistory.find(x => x.id === auctionId);
  if(a) a.image_count = (a.image_count || 0) + processed;
  if(_openGalleries.has(auctionId)){
    _openGalleries.delete(auctionId);
    await toggleAuctionGallery(auctionId);
  }
  renderAuctionLists();
}

const _openGalleries = new Set();
async function toggleAuctionGallery(auctionId){
  const wrap = document.getElementById('auction-gallery-' + auctionId);
  if(!wrap) return;
  if(_openGalleries.has(auctionId)){
    _openGalleries.delete(auctionId);
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  _openGalleries.add(auctionId);
  wrap.style.display = '';
  wrap.innerHTML = '<div class="empty-msg">Memuat foto…</div>';
  try {
    const r = await fetch(`/api/auctions/${auctionId}/images`);
    if(!r.ok){ wrap.innerHTML = '<div class="empty-msg">Gagal memuat</div>'; return; }
    const imgs = await r.json();
    if(!imgs.length){ wrap.innerHTML = '<div class="empty-msg">Belum ada foto</div>'; return; }
    const isAdmin = role === 'admin';
    wrap.innerHTML = imgs.map(im => `
      <div class="auction-gallery-tile" data-img-id="${im.id}">
        <img src="${escapeHtml(im.image_url)}" alt="" loading="lazy">
        ${isAdmin ? `<button class="auction-gallery-del" data-img-id="${im.id}" title="Hapus">×</button>` : ''}
      </div>
    `).join('');
    if(isAdmin){
      wrap.querySelectorAll('.auction-gallery-del').forEach(b => b.addEventListener('click', async () => {
        const imgId = +b.dataset.imgId;
        if(!confirm('Hapus foto ini?')) return;
        try {
          const dr = await fetch(`/api/auctions/images/${imgId}`, { method:'DELETE', headers:{'x-admin-token':adminToken} });
          if(!dr.ok){ toast('Gagal menghapus'); return; }
          // Remove from DOM
          const tile = wrap.querySelector(`.auction-gallery-tile[data-img-id="${imgId}"]`);
          if(tile) tile.remove();
          const a = auctionsActive.find(x => x.id === auctionId) || auctionsHistory.find(x => x.id === auctionId);
          if(a) a.image_count = Math.max(0, (a.image_count || 0) - 1);
          renderAuctionLists();
        } catch { toast('Gagal menghapus'); }
      }));
      // Click image to open in lightbox
      wrap.querySelectorAll('.auction-gallery-tile img').forEach(im => {
        im.addEventListener('click', () => openLightbox(im.src));
      });
    } else {
      // Viewers can still click to enlarge
      wrap.querySelectorAll('.auction-gallery-tile img').forEach(im => {
        im.addEventListener('click', () => openLightbox(im.src));
      });
    }
  } catch { wrap.innerHTML = '<div class="empty-msg">Gagal memuat</div>'; }
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
    document.querySelectorAll('.auction-card-timer[data-ends]').forEach(el => {
      const ends = new Date(el.dataset.ends).getTime();
      const ms = ends - Date.now();
      el.textContent = fmtCountdown(ms);
      const card = el.closest('.auction-card');
      if(card){
        card.classList.toggle('ending', ms > 0 && ms < 60_000);
      }
    });
  }, 1000);
}

async function createAuction(){
  if(role !== 'admin') return;
  const title = $('auction-title-input').value.trim();
  if(!title){ toast('Nama barang wajib diisi'); return; }
  const description = $('auction-desc-input').value.trim();
  const url = $('auction-image-url-input').value.trim();
  const image_url = pendingAuctionImage || url || '';
  const starting_price = Number($('auction-start-price-input').value) || 0;
  const min_increment = Number($('auction-increment-input').value) || 0;
  const hours = Number($('auction-dur-h-input').value) || 0;
  const minutes = Number($('auction-dur-m-input').value) || 0;
  const duration_seconds = hours * 3600 + minutes * 60;
  if(duration_seconds < 60){ toast('Durasi minimal 1 menit'); return; }
  try {
    const r = await fetch('/api/auctions', {
      method: 'POST',
      headers: { 'content-type':'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify({ title, description, image_url, starting_price, min_increment, duration_seconds })
    });
    if(!r.ok){ const e = await r.json().catch(()=>({})); throw new Error(e.error || 'fail'); }
    // Will arrive via socket auction-created
    $('auction-title-input').value = '';
    $('auction-desc-input').value = '';
    $('auction-image-url-input').value = '';
    $('auction-start-price-input').value = '0';
    $('auction-increment-input').value = '0';
    $('auction-dur-h-input').value = '1';
    $('auction-dur-m-input').value = '0';
    pendingAuctionImage = '';
    $('auction-image-file-input').value = '';
    $('auction-form-preview').style.display = 'none';
    $('auction-create-form').style.display = 'none';
    toast('Lelang dimulai');
  } catch(e) { toast('Gagal membuat lelang'); }
}

async function promptUpdateBid(id){
  if(role !== 'admin') return;
  const a = auctionsActive.find(x => x.id === id); if(!a) return;
  const minimum = Math.max(
    a.current_bid != null ? a.current_bid + (a.min_increment || 0) : a.starting_price,
    a.starting_price
  );
  const amountStr = prompt(`Tawaran baru untuk "${a.title}"\nMinimal: ${fmtRupiah(minimum)}`, String(Math.round(minimum)));
  if(amountStr == null) return;
  const amount = Number(String(amountStr).replace(/[^\d.-]/g, ''));
  if(!amount || amount < a.starting_price){ toast('Tawaran tidak valid'); return; }
  const bidder = prompt('Nama penawar', a.current_bidder || '');
  if(bidder == null) return;
  try {
    const r = await fetch(`/api/auctions/${id}`, {
      method:'PATCH',
      headers:{'content-type':'application/json','x-admin-token':adminToken},
      body: JSON.stringify({ current_bid: amount, current_bidder: bidder.trim() })
    });
    if(!r.ok){ toast('Gagal update'); return; }
    toast('Tawaran diperbarui');
  } catch { toast('Gagal update'); }
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
  const title = prompt('Nama barang', a.title);
  if(title == null) return;
  const description = prompt('Deskripsi', a.description || '');
  if(description == null) return;
  try {
    const r = await fetch(`/api/auctions/${id}`, {
      method:'PATCH',
      headers:{'content-type':'application/json','x-admin-token':adminToken},
      body: JSON.stringify({ title: title.trim(), description: description.trim() })
    });
    if(!r.ok){ toast('Gagal update'); return; }
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
    $('auction-image-url-input').value = '';
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
