// ═══════════════════════════════════════════════════════════════════════════
// SUBMIT ROLE — seller-badge pengajuan (submit + lookup + admin review)
// ═══════════════════════════════════════════════════════════════════════════
// Depends on globals defined in index.html: $, escapeHtml, toast, role, adminToken, socket

const TIER_LABEL = {
  select: '🛡️ Select Seller',
  elite:  '💎 Elite Seller',
  star:   '⭐ Star Seller',
};
const STATUS_LABEL = {
  pending:  'Menunggu Review',
  approved: 'Disetujui',
  rejected: 'Ditolak',
};

let _sellerAdminFilter = 'pending';

const TIER_ORDER = ['star', 'elite', 'select'];
const TIER_HEADING = {
  star:   '⭐ Star Seller',
  elite:  '💎 Elite Seller',
  select: '🛡️ Select Seller',
};
const TIER_ICON = { star: '⭐', elite: '💎', select: '🛡️' };
const TIER_EMPTY = {
  star:   'Belum ada Star Seller terverifikasi.',
  elite:  'Belum ada Elite Seller terverifikasi.',
  select: 'Belum ada Select Seller terverifikasi.',
};

function _fmtApprovedDate(iso){
  if(!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('id-ID', {day:'2-digit', month:'short', year:'numeric'});
  } catch { return ''; }
}

function _renderSellerBoard(rows){
  const el = $('seller-approved-board');
  if(!el) return;
  const groups = { star: [], elite: [], select: [] };
  for(const r of rows){ if(groups[r.tier]) groups[r.tier].push(r); }
  el.innerHTML = TIER_ORDER.map(tier => {
    const items = groups[tier];
    const body = items.length
      ? items.map(r => `
          <a class="seller-chip" href="${escapeHtml(r.fb_url)}" target="_blank" rel="noopener noreferrer">
            <span class="seller-chip-icon">${TIER_ICON[tier]}</span>
            <span class="seller-chip-body">
              <span class="seller-chip-name">${escapeHtml(r.fb_name)}</span>
              <span class="seller-chip-date">Disetujui ${escapeHtml(_fmtApprovedDate(r.reviewed_at))}</span>
            </span>
            <span class="seller-chip-go">↗</span>
          </a>`).join('')
      : `<div class="seller-group-empty">${escapeHtml(TIER_EMPTY[tier])}</div>`;
    return `
      <div class="seller-group" data-tier="${tier}">
        <div class="seller-group-hd">
          <span>${escapeHtml(TIER_HEADING[tier])}</span>
          <span class="seller-group-count">${items.length}</span>
        </div>
        <div class="seller-group-body">${body}</div>
      </div>`;
  }).join('');
}

async function loadApprovedSellers(){
  const el = $('seller-approved-board');
  if(!el) return;
  try {
    const r = await fetch('/api/role-submissions/approved');
    if(!r.ok){ el.innerHTML = '<div class="seller-board-empty">Gagal memuat daftar seller.</div>'; return; }
    const rows = await r.json();
    _renderSellerBoard(rows);
  } catch(err){
    el.innerHTML = '<div class="seller-board-empty">Gagal terhubung ke server.</div>';
  }
}

function _fmtSellerDate(iso){
  if(!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('id-ID', {day:'2-digit', month:'short', year:'numeric'}) +
         ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}

function _setSellerMsg(kind, text){
  const el = $('seller-submit-msg');
  if(!el) return;
  if(!text){ el.style.display = 'none'; el.textContent = ''; el.className = 'seller-msg'; return; }
  el.style.display = '';
  el.className = 'seller-msg ' + (kind === 'ok' ? 'ok' : 'err');
  el.textContent = text;
}

function _isFacebookUrl(s){
  if(typeof s !== 'string') return false;
  try {
    const u = new URL(s);
    if(u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'facebook.com' || h.endsWith('.facebook.com') || h === 'fb.com' || h.endsWith('.fb.com');
  } catch { return false; }
}

async function submitSellerForm(e){
  if(e) e.preventDefault();
  const btn = $('seller-submit-btn');
  const fb_name = $('seller-fb-name').value.trim();
  const fb_url = $('seller-fb-url').value.trim();
  const tier = $('seller-tier').value;
  _setSellerMsg(null, '');
  if(!fb_name){ _setSellerMsg('err', 'Nama Facebook wajib diisi.'); $('seller-fb-name').focus(); return; }
  if(!fb_url){ _setSellerMsg('err', 'Link Profile Facebook wajib diisi.'); $('seller-fb-url').focus(); return; }
  if(!_isFacebookUrl(fb_url)){ _setSellerMsg('err', 'Link harus berupa URL Facebook yang valid (https://...facebook.com/...).'); $('seller-fb-url').focus(); return; }
  if(!tier){ _setSellerMsg('err', 'Silakan pilih badge yang diajukan.'); $('seller-tier').focus(); return; }

  btn.disabled = true; btn.textContent = 'Mengirim…';
  try {
    const r = await fetch('/api/role-submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fb_name, fb_url, tier }),
    });
    const data = await r.json().catch(() => ({}));
    if(!r.ok){
      _setSellerMsg('err', data.error || 'Gagal menyimpan pengajuan.');
      return;
    }
    _setSellerMsg('ok', `Pengajuan terkirim! ID #${data.id}. Tim akan meninjau dalam beberapa hari kerja. Anda bisa cek status di bawah dengan link FB Anda.`);
    $('seller-fb-name').value = '';
    $('seller-fb-url').value = '';
    $('seller-tier').value = '';
    if(role === 'admin' && typeof loadSellerAdminList === 'function') loadSellerAdminList();
  } catch(err){
    _setSellerMsg('err', 'Gagal terhubung ke server.');
  } finally {
    btn.disabled = false; btn.textContent = 'Kirim Pengajuan';
  }
}

function _statusBadge(status){
  return `<span class="seller-status ${escapeHtml(status)}">${escapeHtml(STATUS_LABEL[status] || status)}</span>`;
}

function _renderLookupCard(row){
  const tierLabel = TIER_LABEL[row.tier] || row.tier;
  const reviewed = row.reviewed_at ? `<span>· Direview ${escapeHtml(_fmtSellerDate(row.reviewed_at))}</span>` : '';
  const note = row.admin_note ? `<div class="seller-sub-note">${escapeHtml(row.admin_note)}</div>` : '';
  return `
    <div class="seller-sub-card">
      <div class="seller-sub-row">
        <div class="seller-sub-tier">${escapeHtml(tierLabel)}</div>
        ${_statusBadge(row.status)}
      </div>
      <div class="seller-sub-meta">
        <span>#${row.id}</span>
        <span>· Dikirim ${escapeHtml(_fmtSellerDate(row.created_at))}</span>
        ${reviewed}
      </div>
      ${note}
    </div>`;
}

async function lookupSellerStatus(){
  const url = $('seller-lookup-url').value.trim();
  const out = $('seller-lookup-result');
  if(!url){ out.innerHTML = '<div class="seller-admin-empty">Masukkan link Facebook Anda.</div>'; return; }
  if(!_isFacebookUrl(url)){ out.innerHTML = '<div class="seller-admin-empty">Link Facebook tidak valid.</div>'; return; }
  out.innerHTML = '<div class="seller-admin-empty">Mencari…</div>';
  try {
    const r = await fetch('/api/role-submissions/lookup?fb_url=' + encodeURIComponent(url));
    if(!r.ok){ out.innerHTML = '<div class="seller-admin-empty">Gagal memuat.</div>'; return; }
    const rows = await r.json();
    if(!rows.length){
      out.innerHTML = '<div class="seller-admin-empty">Belum ada pengajuan untuk link ini.</div>';
      return;
    }
    out.innerHTML = rows.map(_renderLookupCard).join('');
  } catch(err){
    out.innerHTML = '<div class="seller-admin-empty">Gagal terhubung ke server.</div>';
  }
}

function _renderAdminCard(row){
  const tierLabel = TIER_LABEL[row.tier] || row.tier;
  const reviewed = row.reviewed_at ? ` · Direview ${escapeHtml(_fmtSellerDate(row.reviewed_at))}` : '';
  const note = row.admin_note ? `<div class="seller-sub-note">${escapeHtml(row.admin_note)}</div>` : '';
  const isPending = row.status === 'pending';
  const actions = isPending
    ? `<div class="seller-admin-actions">
         <input class="seller-admin-note-input" placeholder="Catatan (opsional)" maxlength="500" data-note-for="${row.id}">
         <button class="btn-approve" data-approve="${row.id}">✓ Setujui</button>
         <button class="btn-reject" data-reject="${row.id}">✕ Tolak</button>
         <button class="btn btn-ghost btn-xs" data-delete="${row.id}" title="Hapus">🗑</button>
       </div>`
    : `<div class="seller-admin-actions">
         <button class="btn btn-ghost btn-xs" data-reopen="${row.id}">↺ Kembalikan ke Pending</button>
         <button class="btn btn-ghost btn-xs" data-delete="${row.id}">🗑 Hapus</button>
       </div>`;
  return `
    <div class="seller-sub-card" data-row-id="${row.id}">
      <div class="seller-sub-row">
        <div>
          <div class="seller-sub-name">${escapeHtml(row.fb_name)}</div>
          <div class="seller-sub-tier">${escapeHtml(tierLabel)}</div>
        </div>
        ${_statusBadge(row.status)}
      </div>
      <a class="seller-sub-link" href="${escapeHtml(row.fb_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.fb_url)}</a>
      <div class="seller-sub-meta">
        <span>#${row.id}</span>
        <span>· Dikirim ${escapeHtml(_fmtSellerDate(row.created_at))}${reviewed}</span>
      </div>
      ${note}
      ${actions}
    </div>`;
}

async function loadSellerAdminList(){
  if(role !== 'admin') return;
  const el = $('seller-admin-list');
  if(!el) return;
  el.innerHTML = '<div class="seller-admin-empty">Memuat…</div>';
  try {
    const r = await fetch('/api/role-submissions?status=' + encodeURIComponent(_sellerAdminFilter), {
      headers: { 'x-admin-token': adminToken },
    });
    if(!r.ok){ el.innerHTML = '<div class="seller-admin-empty">Gagal memuat.</div>'; return; }
    const rows = await r.json();
    if(!rows.length){
      el.innerHTML = '<div class="seller-admin-empty">Tidak ada pengajuan pada filter ini.</div>';
      return;
    }
    el.innerHTML = rows.map(_renderAdminCard).join('');
  } catch(err){
    el.innerHTML = '<div class="seller-admin-empty">Gagal terhubung ke server.</div>';
  }
}

async function _patchSubmission(id, status, noteInput){
  if(role !== 'admin') return;
  const admin_note = noteInput ? (noteInput.value || '').trim() : '';
  try {
    const r = await fetch('/api/role-submissions/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify({ status, admin_note }),
    });
    if(!r.ok){ const e = await r.json().catch(()=>({})); toast(e.error || 'Gagal memperbarui'); return; }
    toast(status === 'approved' ? 'Disetujui' : status === 'rejected' ? 'Ditolak' : 'Dikembalikan');
    loadSellerAdminList();
  } catch(err){ toast('Gagal memperbarui'); }
}

async function _deleteSubmission(id){
  if(role !== 'admin') return;
  if(!confirm('Hapus pengajuan #' + id + '? Tindakan ini tidak bisa dibatalkan.')) return;
  try {
    const r = await fetch('/api/role-submissions/' + id, {
      method: 'DELETE',
      headers: { 'x-admin-token': adminToken },
    });
    if(!r.ok){ toast('Gagal menghapus'); return; }
    toast('Dihapus');
    loadSellerAdminList();
  } catch(err){ toast('Gagal menghapus'); }
}

// Event wiring — guarded so it's safe to load before the DOM nodes exist
// (script tags sit at end of body, so they should always be present).
(function wireSellerSubmit(){
  const form = $('seller-submit-form');
  if(form) form.addEventListener('submit', submitSellerForm);

  const lookupBtn = $('seller-lookup-btn');
  if(lookupBtn) lookupBtn.addEventListener('click', lookupSellerStatus);
  const lookupInput = $('seller-lookup-url');
  if(lookupInput) lookupInput.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); lookupSellerStatus(); }});

  const refresh = $('seller-admin-refresh');
  if(refresh) refresh.addEventListener('click', loadSellerAdminList);

  const tabs = $('seller-filter-tabs');
  if(tabs){
    tabs.addEventListener('click', e => {
      const t = e.target.closest('.seller-filter-tab');
      if(!t) return;
      _sellerAdminFilter = t.dataset.filter || 'pending';
      tabs.querySelectorAll('.seller-filter-tab').forEach(b => b.classList.toggle('active', b === t));
      loadSellerAdminList();
    });
  }

  const list = $('seller-admin-list');
  if(list){
    list.addEventListener('click', e => {
      const approve = e.target.closest('[data-approve]');
      if(approve){
        const id = approve.dataset.approve;
        const note = list.querySelector(`.seller-admin-note-input[data-note-for="${id}"]`);
        _patchSubmission(id, 'approved', note);
        return;
      }
      const reject = e.target.closest('[data-reject]');
      if(reject){
        const id = reject.dataset.reject;
        const note = list.querySelector(`.seller-admin-note-input[data-note-for="${id}"]`);
        _patchSubmission(id, 'rejected', note);
        return;
      }
      const reopen = e.target.closest('[data-reopen]');
      if(reopen){
        _patchSubmission(reopen.dataset.reopen, 'pending', null);
        return;
      }
      const del = e.target.closest('[data-delete]');
      if(del){
        _deleteSubmission(del.dataset.delete);
        return;
      }
    });
  }
})();

// Live updates: refresh the admin queue and the public showcase whenever
// any submission changes — so everyone on the tab sees a new Star Seller
// pop in the moment admin approves them.
if(typeof socket !== 'undefined' && socket){
  const onRoleEvent = () => {
    const onTab = document.body.getAttribute('data-tab') === 'submit-role';
    if(onTab) loadApprovedSellers();
    if(role === 'admin' && onTab) loadSellerAdminList();
  };
  socket.on('role-submission-added', onRoleEvent);
  socket.on('role-submission-updated', onRoleEvent);
  socket.on('role-submission-deleted', onRoleEvent);
}
