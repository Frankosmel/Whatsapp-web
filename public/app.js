// public/app.js
// --------------------------------------------------------------------------------------
// Lado cliente: tabs, estado/QR, grupos, envío ahora, one-shot y campañas CRON.
// Incluye pegado de IDs, subida de imágenes, validaciones y acciones de campañas.
// --------------------------------------------------------------------------------------

const API_KEY = ''; // Si configuraste ADMIN_API_KEY en el server, colócala aquí (o usa fetch con cabecera en proxy/backend).

const $  = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function headers() {
  return API_KEY ? { 'x-api-key': API_KEY } : {};
}

// -------------------------------- Tabs -------------------------------------------------
$$('nav.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('nav.tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const id = btn.getAttribute('data-tab');
    $$('.tab').forEach(s => s.classList.remove('active'));
    $('#' + id).classList.add('active');
  });
});

// ------------------------------- Estado + QR -------------------------------------------
async function refreshStatus() {
  try {
    const r = await fetch('/api/status', { headers: headers() });
    const j = await r.json();
    const pill = $('#pill');
    if (j.ready) { pill.textContent = 'listo'; pill.className = 'pill ok'; }
    else { pill.textContent = 'no listo'; pill.className = 'pill warn'; }
  } catch (e) { console.error(e); }
}
async function refreshQR() {
  try {
    const img = $('#qr');
    const r = await fetch('/api/qr.png', { headers: headers() });
    if (r.status === 204) {
      img.src = '';
      img.alt = 'No hay QR disponible';
    } else {
      const blob = await r.blob();
      img.src = URL.createObjectURL(blob);
      img.alt = 'QR';
    }
  } catch (e) { console.error(e); }
}
$('#btn-refresh-qr').addEventListener('click', refreshQR);
$('#btn-refresh-status').addEventListener('click', refreshStatus);

// ------------------------------- Grupos ------------------------------------------------
let ALL_GROUPS = [];
function renderGroups(list) {
  const root = $('#groups');
  root.innerHTML = '';
  if (!list.length) {
    root.innerHTML = '<div class="muted">No hay grupos o WhatsApp no está listo.</div>';
    return;
  }
  list.forEach(g => {
    const div = document.createElement('div');
    div.className = 'group-item';
    div.textContent = `${g.name} [${g.id}]`;
    root.appendChild(div);
  });
}
async function loadGroups() {
  try {
    const r = await fetch('/api/groups', { headers: headers() });
    const j = await r.json();
    ALL_GROUPS = j.groups || [];
    renderGroups(ALL_GROUPS);
    renderSelectors(false);
    renderSelectors(true);
    renderSelectors('c');
  } catch (e) { console.error(e); }
}
$('#btn-reload-groups').addEventListener('click', loadGroups);
$('#search').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  renderGroups(ALL_GROUPS.filter(g =>
    g.name.toLowerCase().includes(q) || g.id.toLowerCase().includes(q)
  ));
});

// --------------------------- Checklists de grupos --------------------------------------
const SELECTED_SEND = new Set();
const SELECTED_SCHD = new Set();
const SELECTED_CAMP = new Set();

function makeChecklist(containerId, selectedSet) {
  const root = $(containerId);
  root.innerHTML = '';
  if (!ALL_GROUPS.length) {
    root.innerHTML = '<div class="muted">— sin datos —</div>';
    return;
  }
  ALL_GROUPS.forEach(g => {
    const label = document.createElement('label');
    label.className = 'chk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = g.id;
    cb.checked = selectedSet.has(g.id);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedSet.add(cb.value); else selectedSet.delete(cb.value);
    });
    const span = document.createElement('span');
    span.textContent = `${g.name} [${g.id}]`;
    label.appendChild(cb);
    label.appendChild(span);
    root.appendChild(label);
  });
}
function renderSelectors(mode) {
  if (mode === true) return makeChecklist('#select-groups-s', SELECTED_SCHD);
  if (mode === 'c') return makeChecklist('#select-groups-c', SELECTED_CAMP);
  return makeChecklist('#select-groups', SELECTED_SEND);
}

// ------------------------------ Pegar IDs util -----------------------------------------
function extractIds(raw) {
  if (!raw) return [];
  return raw
    .split(/[\s,;\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const m = s.match(/\[([0-9\-]+@g\.us)\]/); // permite "Nombre [id@g.us]"
      if (m) return m[1];
      return s;
    })
    .filter(s => /@g\.us$/.test(s));
}
$('#btn-apply-ids').addEventListener('click', () => {
  extractIds($('#ids-paste').value).forEach(id => SELECTED_SEND.add(id));
  renderSelectors(false);
});
$('#btn-apply-ids-s').addEventListener('click', () => {
  extractIds($('#ids-paste-s').value).forEach(id => SELECTED_SCHD.add(id));
  renderSelectors(true);
});
$('#btn-apply-ids-c').addEventListener('click', () => {
  extractIds($('#ids-paste-c').value).forEach(id => SELECTED_CAMP.add(id));
  renderSelectors('c');
});

// ------------------------------- Upload de imágenes ------------------------------------
async function uploadFiles(inputEl) {
  const fd = new FormData();
  for (const f of inputEl.files) fd.append('images', f);
  const r = await fetch('/api/upload', { method: 'POST', body: fd, headers: headers() });
  const j = await r.json();
  if (!j.ok) throw new Error('Error subiendo imágenes');
  return j.files; // rutas /uploads/...
}

// ------------------------------- Enviar ahora ------------------------------------------
$('#btn-send').addEventListener('click', async () => {
  try {
    const ids = Array.from(SELECTED_SEND);
    if (!ids.length) return alert('Seleccione al menos un grupo.');

    let media = [];
    if ($('#images').files.length) media = await uploadFiles($('#images'));

    const body = {
      ids,
      text: $('#msg').value,
      media,
      mediaDelayMs: Number($('#mediaDelayMs').value || 2000),
      groupDelayMs: Math.max(1500, Number($('#groupDelayMs').value || 2000))
    };

    const r = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers() },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    $('#send-result').textContent = JSON.stringify(j, null, 2);
  } catch (e) {
    $('#send-result').textContent = e?.message || String(e);
  }
});

// ------------------------------- One-shot ----------------------------------------------
async function reloadSchedules() {
  try {
    const r = await fetch('/api/schedules', { headers: headers() });
    const j = await r.json();
    $('#schedules').textContent = JSON.stringify(j, null, 2);
  } catch (e) {
    $('#schedules').textContent = e?.message || String(e);
  }
}
$('#btn-reload-schedules').addEventListener('click', reloadSchedules);

$('#btn-schedule').addEventListener('click', async () => {
  try {
    const ids = Array.from(SELECTED_SCHD);
    if (!ids.length) return alert('Seleccione al menos un grupo.');

    let media = [];
    if ($('#images-s').files.length) media = await uploadFiles($('#images-s'));

    const when = $('#when').value; // datetime-local
    if (!when) return alert('Seleccione fecha/hora.');

    const body = {
      ids,
      message: $('#msg-s').value,
      media,
      mediaDelayMs: Number($('#mediaDelayMs-s').value || 2000),
      groupDelayMs: Math.max(1500, Number($('#groupDelayMs-s').value || 2000)),
      when
    };

    const r = await fetch('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers() },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    $('#schedules').textContent = JSON.stringify(j, null, 2);
  } catch (e) {
    $('#schedules').textContent = e?.message || String(e);
  }
});

// ------------------------------- Campañas CRON -----------------------------------------
async function reloadCampaigns() {
  try {
    const r = await fetch('/api/campaigns', { headers: headers() });
    const j = await r.json();
    $('#campaigns').textContent = JSON.stringify(j, null, 2);
  } catch (e) {
    $('#campaigns').textContent = e?.message || String(e);
  }
}
$('#btn-c-reload').addEventListener('click', reloadCampaigns);

$('#btn-c-save').addEventListener('click', async () => {
  try {
    const ids = Array.from(SELECTED_CAMP);
    if (!ids.length) return alert('Seleccione al menos un grupo.');

    let media = [];
    if ($('#c-images').files.length) media = await uploadFiles($('#c-images'));

    const name = $('#c-name').value.trim() || undefined;
    const message = $('#c-message').value;
    const cronExpr = $('#c-cron').value.trim();
    const tz = $('#c-tz').value;

    if (!cronExpr) return alert('Introduzca una expresión CRON.');
    // Validación básica cliente (no bloquea al servidor)
    const cronLike = /^(@(yearly|monthly|weekly|daily|hourly)|(@reboot)|(\S+\s+\S+\s+\S+\s+\S+\s+\S+(\s+\S+)?))$/i;
    if (!cronLike.test(cronExpr)) {
      if (!confirm('La expresión no parece estándar. ¿Enviar de todos modos y que el servidor valide?')) return;
    }

    const body = {
      name,
      ids,
      message,
      media,
      mediaDelayMs: Number($('#c-mediaDelayMs').value || 2000),
      groupDelayMs: Math.max(1500, Number($('#c-groupDelayMs').value || 2000)),
      cron: cronExpr,
      tz,
      enabled: true
    };

    const r = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers() },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    $('#c-save-result').textContent = JSON.stringify(j, null, 2);
    reloadCampaigns();
  } catch (e) {
    $('#c-save-result').textContent = e?.message || String(e);
  }
});

$('#btn-c-reset').addEventListener('click', () => {
  $('#c-name').value = '';
  $('#c-message').value = '';
  $('#c-cron').value = '';
  $('#c-tz').selectedIndex = 0;
  $('#c-images').value = null;
  SELECTED_CAMP.clear();
  renderSelectors('c');
});

// -------------------------------- Inicial ----------------------------------------------
refreshStatus();
refreshQR();
loadGroups();
reloadSchedules();
reloadCampaigns();
