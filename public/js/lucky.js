// ═══════════════════════════════════════════════════════════════════════════
// LUCKY BOX
// ═══════════════════════════════════════════════════════════════════════════
// Depends on: $, escapeHtml, toast, role, adminToken, sfx, currentTab.
// Inline-script socket handlers reference luckyDraws, loadLuckyCards,
// loadLuckyDraws, renderLuckyDraws, resetLuckyStage — those references
// resolve at event-fire time, after this script has loaded.

let luckyCards = [];
let luckyDraws = [];
let luckyOpening = false;
let pendingLuckyImage = '';

async function loadLuckyCards(){
  try { const r = await fetch('/api/lucky-cards'); luckyCards = r.ok ? await r.json() : []; }
  catch { luckyCards = []; }
  renderLuckyCards();
}
async function loadLuckyDraws(){
  try { const r = await fetch('/api/lucky-draws?limit=30'); luckyDraws = r.ok ? await r.json() : []; }
  catch { luckyDraws = []; }
  renderLuckyDraws();
}
function renderLuckyCards(){
  const countEl = $('lucky-card-count');
  if(countEl) countEl.textContent = luckyCards.length;
  const el = $('lucky-card-list'); if(!el) return;
  if(!luckyCards.length){
    el.innerHTML = `<div class="empty-msg">${role==='admin'?'Tambah kartu untuk mengisi kotak':'Kotak masih kosong'}</div>`;
    return;
  }
  const isAdmin = role === 'admin';
  el.innerHTML = luckyCards.map(c => `
    <div class="lucky-row">
      ${c.image_url ? `<img class="lucky-row-img" src="${escapeHtml(c.image_url)}" alt="">` : `<div class="lucky-row-img-empty">🎁</div>`}
      <div class="lucky-row-label">${escapeHtml(c.label)}</div>
      ${isAdmin ? `<button class="lucky-row-del" data-id="${c.id}">Hapus</button>` : '<span></span>'}
    </div>`).join('');
  if(isAdmin) el.querySelectorAll('.lucky-row-del').forEach(b =>
    b.addEventListener('click', () => deleteLuckyCard(+b.dataset.id)));
}
function renderLuckyDraws(){
  const el = $('lucky-draws-list'); if(!el) return;
  if(!luckyDraws.length){ el.innerHTML = '<div class="empty-msg">Belum ada pengundian</div>'; return; }
  el.innerHTML = luckyDraws.map(d => {
    const ds = new Date(d.created_at).toLocaleString('id-ID', { dateStyle:'short', timeStyle:'short' });
    return `<div class="lucky-draw-row">
      ${d.image_url ? `<img class="lucky-draw-row-img" src="${escapeHtml(d.image_url)}" alt="">` : `<div class="lucky-row-img-empty" style="width:36px;height:36px;font-size:18px">🎁</div>`}
      <div class="lucky-draw-row-label">🎉 ${escapeHtml(d.card_label)}</div>
      <span class="lucky-draw-row-meta">${ds}</span>
    </div>`;
  }).join('');
}
async function deleteLuckyCard(id){
  if(role !== 'admin') return;
  try {
    const r = await fetch(`/api/lucky-cards/${id}`, { method:'DELETE', headers:{'x-admin-token': adminToken} });
    if(!r.ok){ toast('Gagal menghapus'); return; }
    luckyCards = luckyCards.filter(c => c.id !== id);
    renderLuckyCards();
  } catch { toast('Gagal menghapus'); }
}
async function clearLuckyCards(){
  if(role !== 'admin') return;
  if(!luckyCards.length){ toast('Sudah kosong'); return; }
  if(!confirm('Hapus semua kartu di kotak?')) return;
  try {
    await fetch('/api/lucky-cards', { method:'DELETE', headers:{'x-admin-token': adminToken} });
    luckyCards = []; renderLuckyCards();
    toast('Kotak dikosongkan');
  } catch { toast('Gagal menghapus'); }
}
async function clearLuckyDraws(){
  if(role !== 'admin') return;
  if(!confirm('Hapus semua riwayat?')) return;
  try {
    await fetch('/api/lucky-draws', { method:'DELETE', headers:{'x-admin-token': adminToken} });
    luckyDraws = []; renderLuckyDraws();
    toast('Riwayat dihapus');
  } catch { toast('Gagal menghapus'); }
}
async function addLuckyCard(){
  if(role !== 'admin') return;
  const label = $('lucky-card-label-input').value.trim();
  if(!label){ toast('Isi nama kartu'); return; }
  const url = $('lucky-card-url-input').value.trim();
  const image_url = pendingLuckyImage || url || '';
  try {
    const r = await fetch('/api/lucky-cards', {
      method: 'POST',
      headers: { 'content-type':'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify({ label, image_url })
    });
    if(!r.ok){ const e = await r.json().catch(()=>({})); throw new Error(e.error || 'fail'); }
    const card = await r.json();
    luckyCards.push(card);
    renderLuckyCards();
    $('lucky-card-label-input').value = '';
    $('lucky-card-url-input').value = '';
    pendingLuckyImage = '';
    $('lucky-card-file-input').value = '';
    $('lucky-form-preview').style.display = 'none';
    toast('Kartu ditambah');
  } catch(e) { toast('Gagal menyimpan'); }
}
function resetLuckyStage(){
  const box = $('lucky-box'), reveal = $('lucky-card-reveal');
  if(!box || !reveal) return;
  box.style.display = '';
  box.classList.remove('shake', 'opening');
  reveal.style.display = 'none';
  $('lucky-status').textContent = '';
  $('lucky-open-btn').disabled = false;
  luckyOpening = false;
}
async function openLuckyBox(){
  if(luckyOpening) return;
  if(!luckyCards.length){ toast('Kotak masih kosong'); return; }
  luckyOpening = true;
  const btn = $('lucky-open-btn');
  btn.disabled = true;
  $('lucky-status').textContent = 'Mengocok...';
  const box = $('lucky-box'), reveal = $('lucky-card-reveal');
  reveal.style.display = 'none';
  box.style.display = '';
  box.classList.remove('opening');
  void box.offsetWidth;
  box.classList.add('shake');
  // Crowd / tick during shake
  if(typeof sfx !== 'undefined' && sfx.enabled){ try { sfx.tick && sfx.tick(); } catch(e){} }

  setTimeout(() => {
    box.classList.remove('shake');
    box.classList.add('opening');
    if(typeof sfx !== 'undefined' && sfx.enabled){ try { sfx.cheer && sfx.cheer(); } catch(e){} }
  }, 1100);

  setTimeout(() => {
    const card = luckyCards[Math.floor(Math.random() * luckyCards.length)];
    box.style.display = 'none';
    const wrap = $('lucky-card-img-wrap');
    const img = $('lucky-card-img');
    let empty = wrap.querySelector('.lucky-card-img-empty');
    if(card.image_url){
      img.src = card.image_url;
      img.style.display = '';
      if(empty) empty.style.display = 'none';
    } else {
      img.style.display = 'none';
      if(!empty){
        empty = document.createElement('div');
        empty.className = 'lucky-card-img-empty';
        empty.textContent = '🎁';
        wrap.appendChild(empty);
      }
      empty.style.display = 'flex';
    }
    $('lucky-card-label').textContent = card.label;
    reveal.style.display = '';
    $('lucky-status').textContent = '🎉 Selamat!';

    fetch('/api/lucky-draws', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({ card_label: card.label, image_url: card.image_url || '' })
    }).then(() => loadLuckyDraws()).catch(()=>{});

    setTimeout(() => { btn.disabled = false; luckyOpening = false; }, 1400);
  }, 1700);
}

$('lucky-card-file-input')?.addEventListener('change', e => {
  const file = e.target.files[0];
  if(!file) return;
  if(file.size > 1024 * 1024){ toast('Gambar terlalu besar (maks 1MB)'); e.target.value=''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    pendingLuckyImage = reader.result;
    $('lucky-form-preview-img').src = pendingLuckyImage;
    $('lucky-form-preview-name').textContent = file.name;
    $('lucky-form-preview').style.display = '';
    $('lucky-card-url-input').value = '';
  };
  reader.readAsDataURL(file);
});
$('lucky-form-clear-img')?.addEventListener('click', () => {
  pendingLuckyImage = '';
  $('lucky-card-file-input').value = '';
  $('lucky-form-preview').style.display = 'none';
});
$('lucky-add-btn')?.addEventListener('click', addLuckyCard);
$('lucky-card-label-input')?.addEventListener('keydown', e => { if(e.key === 'Enter') addLuckyCard(); });
$('lucky-card-url-input')?.addEventListener('keydown', e => { if(e.key === 'Enter') addLuckyCard(); });
$('lucky-clear-cards-btn')?.addEventListener('click', clearLuckyCards);
$('lucky-clear-draws-btn')?.addEventListener('click', clearLuckyDraws);
$('lucky-open-btn')?.addEventListener('click', openLuckyBox);
$('lucky-box')?.addEventListener('click', () => { if(!luckyOpening) openLuckyBox(); });
