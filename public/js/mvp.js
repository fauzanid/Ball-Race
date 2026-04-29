// ═══════════════════════════════════════════════════════════════════════════
// MVP OF THE MONTH
// ═══════════════════════════════════════════════════════════════════════════
// Depends on: $, escapeHtml, toast, role, adminToken, socket, currentTab.
// Server returns the list pre-sorted by points DESC, name ASC, scoped to
// the requested ?month= (defaults to the current calendar month).

let mvpEntries = [];
let mvpAvailableMonths = [];
let mvpSelectedMonth = currentMonthString();

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
  try {
    const r = await fetch('/api/mvp?month=' + encodeURIComponent(mvpSelectedMonth));
    mvpEntries = r.ok ? await r.json() : [];
  } catch { mvpEntries = []; }
  // Update subtitle so the user always knows which month they're viewing
  const sub = $('mvp-subtitle');
  if(sub){
    const isCurrent = mvpSelectedMonth === currentMonthString();
    sub.textContent = isCurrent
      ? `Klasemen pemain ${formatMonthLabel(mvpSelectedMonth)} (bulan ini).`
      : `Klasemen pemain ${formatMonthLabel(mvpSelectedMonth)}.`;
  }
  renderMvpTable();
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

// Live updates: server now broadcasts which month changed. Refetch only
// when the change touched the month we're viewing OR the dropdown needs
// to gain a brand-new month entry.
if(typeof socket !== 'undefined' && socket){
  socket.on('mvp-updated', (payload) => {
    const changedMonth = payload && payload.month;
    if(currentTab === 'mvp'){
      // Reload the months list (a new month may have appeared) and current entries
      loadMvpMonths().then(() => {
        if(!changedMonth || changedMonth === mvpSelectedMonth) loadMvpEntries();
      });
    }
  });
}
