// ═══════════════════════════════════════════════════════════════════════════
// TRACK — shipment lookup (public) + admin management
// ═══════════════════════════════════════════════════════════════════════════
// Depends on globals defined in index.html: $, escapeHtml, toast, role, adminToken

function normPhone(p){ return String(p || '').replace(/[^\d+]/g, ''); }
function fmtPhoneMask(p){
  // Mask middle digits for privacy in admin list (e.g. 0812****5678)
  if(!p || p.length < 6) return p || '';
  return p.slice(0, 4) + '****' + p.slice(-4);
}
function fmtTrackDate(iso){
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}

async function lookupShipment(){
  const phone = normPhone($('track-phone-input').value);
  const out = $('track-lookup-result');
  if(!phone || phone.length < 4){
    out.innerHTML = '<div class="track-result-empty">Masukkan minimal 4 digit nomor</div>';
    return;
  }
  out.innerHTML = '<div class="track-result-empty">Mencari…</div>';
  try {
    const r = await fetch('/api/shipments/lookup?phone=' + encodeURIComponent(phone));
    if(!r.ok){ out.innerHTML = '<div class="track-result-empty">Gagal memuat</div>'; return; }
    const rows = await r.json();
    if(!rows.length){
      out.innerHTML = '<div class="track-result-empty">Tidak ada resi untuk nomor ini</div>';
      return;
    }
    out.innerHTML = rows.map(s => `
      <div class="track-card">
        <div class="track-card-code">${escapeHtml(s.tracking_code)}</div>
        <button class="track-card-copy" data-copy="${escapeHtml(s.tracking_code)}">Salin</button>
        <div class="track-card-meta">
          ${s.courier ? `<span>📦 ${escapeHtml(s.courier)}</span><span class="sep">·</span>` : ''}
          <span>🕒 ${fmtTrackDate(s.created_at)}</span>
        </div>
        ${s.note ? `<div class="track-card-note">${escapeHtml(s.note)}</div>` : ''}
      </div>`).join('');
    out.querySelectorAll('.track-card-copy').forEach(b => b.addEventListener('click', () => {
      const code = b.dataset.copy;
      (navigator.clipboard?.writeText(code) || Promise.reject())
        .then(() => toast('Kode resi disalin'))
        .catch(() => toast(code));
    }));
  } catch(e){
    out.innerHTML = '<div class="track-result-empty">Gagal memuat</div>';
  }
}

async function saveShipment(){
  if(role !== 'admin'){ toast('Khusus admin'); return; }
  const phone = normPhone($('track-add-phone').value);
  const tracking_code = $('track-add-code').value.trim();
  const courier = $('track-add-courier').value.trim();
  const note = $('track-add-note').value.trim();
  if(!phone || phone.length < 4){ toast('Nomor HP tidak valid'); return; }
  if(!tracking_code){ toast('Kode resi wajib diisi'); return; }
  try {
    const r = await fetch('/api/shipments', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify({ phone, tracking_code, courier, note }),
    });
    if(!r.ok){ const e = await r.json().catch(()=>({})); toast(e.error || 'Gagal menyimpan'); return; }
    toast('Resi tersimpan');
    $('track-add-phone').value = '';
    $('track-add-code').value = '';
    $('track-add-courier').value = '';
    $('track-add-note').value = '';
    loadTrackAdminList();
  } catch(e){ toast('Gagal menyimpan'); }
}

async function loadTrackAdminList(){
  if(role !== 'admin') return;
  const el = $('track-admin-list');
  el.innerHTML = '<div class="track-result-empty">Memuat…</div>';
  try {
    const r = await fetch('/api/shipments?limit=200', { headers: { 'x-admin-token': adminToken }});
    if(!r.ok){ el.innerHTML = '<div class="track-result-empty">Gagal memuat</div>'; return; }
    const rows = await r.json();
    if(!rows.length){ el.innerHTML = '<div class="track-result-empty">Belum ada resi</div>'; return; }
    el.innerHTML = rows.map(s => `
      <div class="track-row" data-id="${s.id}">
        <div class="track-row-main">
          <span class="track-row-phone">${escapeHtml(s.phone)}</span>
          <span class="track-row-code">${escapeHtml(s.tracking_code)}</span>
        </div>
        <button class="track-row-del" data-del="${s.id}">×</button>
        <div class="track-row-meta">
          ${s.courier ? `${escapeHtml(s.courier)} · ` : ''}${fmtTrackDate(s.created_at)}${s.note ? ' · ' + escapeHtml(s.note) : ''}
        </div>
      </div>`).join('');
    el.querySelectorAll('.track-row-del').forEach(b => b.addEventListener('click', () => deleteShipment(+b.dataset.del)));
  } catch(e){
    el.innerHTML = '<div class="track-result-empty">Gagal memuat</div>';
  }
}

async function deleteShipment(id){
  if(role !== 'admin') return;
  if(!confirm('Hapus resi ini?')) return;
  try {
    const r = await fetch('/api/shipments/' + id, { method:'DELETE', headers: { 'x-admin-token': adminToken }});
    if(!r.ok){ toast('Gagal menghapus'); return; }
    toast('Dihapus');
    loadTrackAdminList();
  } catch(e){ toast('Gagal menghapus'); }
}

$('track-lookup-btn').addEventListener('click', lookupShipment);
$('track-phone-input').addEventListener('keydown', e => { if(e.key === 'Enter') lookupShipment(); });
$('track-save-btn').addEventListener('click', saveShipment);
$('track-refresh-btn').addEventListener('click', loadTrackAdminList);
['track-add-phone','track-add-code','track-add-courier','track-add-note'].forEach(id => {
  $(id).addEventListener('keydown', e => { if(e.key === 'Enter') saveShipment(); });
});
