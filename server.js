// server.js
// --------------------------------------------------------------------------------------
// Servidor Express con API para: estado/QR, grupos, subida de imágenes, envío inmediato,
// programaciones one-shot y campañas CRON (recurrentes). Usa whatsapp-web.js + puppeteer
// con LocalAuth para mantener la sesión en .wa-session.
// --------------------------------------------------------------------------------------

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const QRCode = require('qrcode');
const cron = require('node-cron');
const { nanoid } = require('nanoid');

const dayjs = require('dayjs');

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------------------- Seguridad (API Key) ---------------------------------
const API_KEY = process.env.ADMIN_API_KEY || '';
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // si no hay key, libre (dev)
  const key = req.header('x-api-key') || '';
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// -------------------------------- Middlewares base ------------------------------------
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use('/', express.static(path.join(__dirname, 'public')));

// Carpeta de subidas (sirve archivos estáticos)
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
app.use('/uploads', express.static(UPLOAD_DIR));

// -------------------------------- Multer (subidas) ------------------------------------
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_');
    cb(null, `${ts}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 }, // 16MB
  fileFilter: (_, file, cb) => {
    if ((file.mimetype || '').startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes.'));
  }
});

// ------------------------------- WhatsApp Client --------------------------------------
let lastQR = null;
let waReady = false;

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: process.env.WA_SESSION_PATH || path.join(__dirname, '.wa-session')
  }),
  puppeteer: {
    executablePath: puppeteer.executablePath(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  },
  webVersionCache: { type: 'remote' }
});

client.on('qr', qr => {
  lastQR = qr;
  waReady = false;
  console.log('🔑 Escanea el QR (primera vez o sesión expirada)');
});

client.on('ready', () => {
  waReady = true;
  lastQR = null;
  console.log('✅ WhatsApp listo');
});

client.on('auth_failure', msg => {
  waReady = false;
  console.error('❌ Fallo de autenticación:', msg);
});

client.on('disconnected', reason => {
  waReady = false;
  console.error('⚠️ Cliente desconectado:', reason);
});

(async () => {
  try {
    await client.initialize();
  } catch (e) {
    console.error('Error inicializando WhatsApp:', e?.message || e);
  }
})();

// --------------------------------- Helpers envío --------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Enviar a 1 grupo: texto + múltiples imágenes (caption solo en la primera). */
async function sendToOneGroup(id, text, mediaPaths = [], mediaDelayMs = 2000) {
  if (!mediaPaths?.length) {
    if (text) await client.sendMessage(id, text);
    return;
  }
  let first = true;
  for (const p of mediaPaths) {
    const abs = path.isAbsolute(p) ? p : path.join(__dirname, p.replace(/^\//, ''));
    const mm = MessageMedia.fromFilePath(abs);
    await client.sendMessage(id, mm, { caption: first ? (text || '') : undefined });
    first = false;
    await sleep(Math.max(0, Number(mediaDelayMs) || 0));
  }
}

/** Enviar a N grupos: respeta delay mínimo entre grupos. */
async function sendToMany(ids, text, mediaPaths, mediaDelayMs, groupDelayMs) {
  const results = [];
  for (const gid of ids) {
    try {
      await sendToOneGroup(gid, text, mediaPaths, mediaDelayMs);
      results.push({ id: gid, ok: true });
    } catch (e) {
      results.push({ id: gid, ok: false, error: e?.message || String(e) });
    }
    await sleep(Math.max(1500, Number(groupDelayMs) || 0)); // anti-abuso
  }
  return results;
}

// ------------------------------- Endpoints: Estado/QR ---------------------------------
app.get('/api/status', requireApiKey, (req, res) => {
  let me = null;
  try { me = client.info || null; } catch {}
  res.json({ ready: waReady, me });
});

app.get('/api/qr.png', requireApiKey, async (req, res) => {
  if (!lastQR) return res.status(204).end();
  try {
    const buf = await QRCode.toBuffer(lastQR, { width: 360, margin: 1 });
    res.setHeader('Content-Type', 'image/png');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// -------------------------------- Endpoints: Grupos -----------------------------------
app.get('/api/groups', requireApiKey, async (req, res) => {
  try {
    if (!waReady) return res.json({ groups: [] });
    const chats = await client.getChats();
    const groups = chats
      .filter(c => c.isGroup)
      .map(c => ({ id: c.id._serialized, name: c.name || c.id._serialized }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ------------------------------- Endpoints: Upload ------------------------------------
app.post('/api/upload', requireApiKey, upload.array('images', 10), (req, res) => {
  try {
    const files = (req.files || []).map(f => `/uploads/${path.basename(f.path)}`);
    res.json({ ok: true, files });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ------------------------------- Endpoints: Envío Now ---------------------------------
app.post('/api/send', requireApiKey, async (req, res) => {
  try {
    if (!waReady) return res.status(409).json({ error: 'WhatsApp no está listo.' });

    const { ids, text, media = [], mediaDelayMs = 2000, groupDelayMs = 2000 } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'El campo ids[] es obligatorio.' });
    }
    const bad = ids.filter(x => !/@g\.us$/.test(String(x)));
    if (bad.length) return res.status(400).json({ error: `IDs inválidos: ${bad.join(', ')}` });

    const filesExist = (media || []).every(p => {
      const abs = path.isAbsolute(p) ? p : path.join(__dirname, p.replace(/^\//, ''));
      return fs.existsSync(abs);
    });
    if (!filesExist) return res.status(400).json({ error: 'Una o más imágenes no existen en el servidor.' });

    const results = await sendToMany(
      ids, text, media, Number(mediaDelayMs), Number(groupDelayMs)
    );
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ------------------------------- Programaciones one-shot -------------------------------
// Persistimos en JSON para simplicidad operativa
const SCHEDULES = new Map(); // id -> timeout
const SCHEDULE_STORE = path.join(__dirname, 'schedules.json');

function loadSchedules() {
  try { return JSON.parse(fs.readFileSync(SCHEDULE_STORE, 'utf8')); }
  catch { return []; }
}
function saveSchedules(arr) {
  fs.writeFileSync(SCHEDULE_STORE, JSON.stringify(arr, null, 2));
}
function rearmSchedules() {
  for (const [, t] of SCHEDULES) clearTimeout(t);
  SCHEDULES.clear();

  const arr = loadSchedules();
  const now = Date.now();

  arr.forEach(s => {
    if (s.status !== 'pending') return;
    const whenMs = new Date(s.when).getTime();
    const delay = Math.max(0, whenMs - now);

    const t = setTimeout(async () => {
      try {
        if (!waReady) throw new Error('WhatsApp no está listo en el momento de envío.');
        await sendToMany(s.ids, s.message, s.media, s.mediaDelayMs, s.groupDelayMs);
        s.status = 'sent';
        s.sentAt = new Date().toISOString();
        saveSchedules(arr);
      } catch (e) {
        s.status = 'failed';
        s.error = e?.message || String(e);
        saveSchedules(arr);
      }
    }, delay);

    SCHEDULES.set(s.id, t);
  });
}
rearmSchedules();

// Listar programaciones
app.get('/api/schedules', requireApiKey, (req, res) => {
  res.json({ items: loadSchedules() });
});

// Crear/actualizar programación one-shot
app.post('/api/schedules', requireApiKey, (req, res) => {
  try {
    if (!waReady) return res.status(409).json({ error: 'WhatsApp no está listo.' });

    const payload = req.body || {};
    if (!Array.isArray(payload.ids) || !payload.ids.length) {
      return res.status(400).json({ error: 'ids[] es obligatorio.' });
    }
    const bad = payload.ids.filter(x => !/@g\.us$/.test(String(x)));
    if (bad.length) return res.status(400).json({ error: `IDs inválidos: ${bad.join(', ')}` });

    if (!payload.when) return res.status(400).json({ error: 'El campo when (ISO) es obligatorio.' });
    const whenTs = Date.parse(payload.when);
    if (Number.isNaN(whenTs)) return res.status(400).json({ error: 'Fecha/hora inválida.' });

    const arr = loadSchedules();
    const id = payload.id || nanoid(10);
    const item = {
      id,
      name: payload.name || `pub-${id}`,
      ids: payload.ids,
      message: payload.message || '',
      media: Array.isArray(payload.media) ? payload.media : [],
      when: new Date(whenTs).toISOString(),
      mediaDelayMs: Math.max(0, Number(payload.mediaDelayMs || 2000)),
      groupDelayMs: Math.max(1500, Number(payload.groupDelayMs || 2000)),
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    const idx = arr.findIndex(x => x.id === id);
    if (idx >= 0) arr[idx] = item; else arr.push(item);
    saveSchedules(arr);
    rearmSchedules();

    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Cancelar programación
app.post('/api/schedules/:id/cancel', requireApiKey, (req, res) => {
  const id = req.params.id;
  const arr = loadSchedules();
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Programación no encontrada.' });
  arr[idx].status = 'canceled';
  saveSchedules(arr);
  const t = SCHEDULES.get(id);
  if (t) clearTimeout(t);
  SCHEDULES.delete(id);
  res.json({ ok: true });
});

// Borrar programación
app.delete('/api/schedules/:id', requireApiKey, (req, res) => {
  const id = req.params.id;
  const arr = loadSchedules();
  const nx = arr.filter(x => x.id !== id);
  if (nx.length === arr.length) return res.status(404).json({ error: 'No existe.' });
  saveSchedules(nx);
  const t = SCHEDULES.get(id);
  if (t) clearTimeout(t);
  SCHEDULES.delete(id);
  res.json({ ok: true });
});

// --------------------------------- Campañas CRON --------------------------------------
// Persistencia de campañas y motor de cron
const CAMPAIGNS = new Map(); // id -> { job, running }
const CAMPAIGN_STORE = path.join(__dirname, 'campaigns.json');

function loadCampaigns() {
  try { return JSON.parse(fs.readFileSync(CAMPAIGN_STORE, 'utf8')); }
  catch { return []; }
}
function saveCampaigns(arr) {
  fs.writeFileSync(CAMPAIGN_STORE, JSON.stringify(arr, null, 2));
}
function validateTimeZone(tz) {
  try {
    // Validación ligera: Intl lanzará si el tz es inválido
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
function scheduleCampaignEngine() {
  // Limpia jobs actuales
  for (const [id, j] of CAMPAIGNS) { try { j.job?.stop?.(); } catch {} }
  CAMPAIGNS.clear();

  const items = loadCampaigns();
  for (const c of items) {
    if (!c.enabled) continue;
    if (!cron.validate(c.cron)) {
      console.warn(`⚠️ Campaña ${c.id} tiene CRON inválido; queda deshabilitada.`);
      c.enabled = false;
      continue;
    }
    const tz = c.tz && validateTimeZone(c.tz) ? c.tz : undefined;
    const state = { running: false };
    const job = cron.schedule(c.cron, async () => {
      if (state.running) {
        console.log(`⏭️  Campaña ${c.id} omitida: ya hay una ejecución en curso.`);
        return;
      }
      state.running = true;
      try {
        if (!waReady) throw new Error('WhatsApp no está listo.');
        const filesExist = (c.media || []).every(p => {
          const abs = path.isAbsolute(p) ? p : path.join(__dirname, p.replace(/^\//, ''));
          return fs.existsSync(abs);
        });
        if (!filesExist) throw new Error('Una o más imágenes no existen en el servidor.');
        const idsBad = (c.ids || []).filter(x => !/@g\.us$/.test(String(x)));
        if (idsBad.length) throw new Error(`IDs inválidos: ${idsBad.join(', ')}`);

        console.log(`🚀 Ejecutando campaña ${c.id} @ ${new Date().toISOString()}`);
        await sendToMany(
          c.ids,
          c.message || '',
          Array.isArray(c.media) ? c.media : [],
          Math.max(0, Number(c.mediaDelayMs || 2000)),
          Math.max(1500, Number(c.groupDelayMs || 2000))
        );
        // actualizar metadata
        const arr = loadCampaigns();
        const idx = arr.findIndex(x => x.id === c.id);
        if (idx >= 0) {
          arr[idx].lastRunAt = new Date().toISOString();
          saveCampaigns(arr);
        }
      } catch (e) {
        console.error(`❌ Campaña ${c.id} falló:`, e?.message || e);
        const arr = loadCampaigns();
        const idx = arr.findIndex(x => x.id === c.id);
        if (idx >= 0) {
          arr[idx].lastError = e?.message || String(e);
          arr[idx].lastRunAt = new Date().toISOString();
          saveCampaigns(arr);
        }
      } finally {
        state.running = false;
      }
    }, { timezone: tz });
    CAMPAIGNS.set(c.id, { job, running: state });
  }

  // Guardar posibles deshabilitadas por cron inválido
  saveCampaigns(items);
}
scheduleCampaignEngine();

// Listar campañas
app.get('/api/campaigns', requireApiKey, (req, res) => {
  res.json({ items: loadCampaigns() });
});

// Crear/actualizar campaña
app.post('/api/campaigns', requireApiKey, (req, res) => {
  try {
    const payload = req.body || {};
    const id = payload.id || nanoid(10);
    const name = payload.name || `camp-${id}`;
    const ids = Array.isArray(payload.ids) ? payload.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'ids[] es obligatorio.' });

    // Validación cron
    if (!payload.cron || !cron.validate(payload.cron)) {
      return res.status(400).json({ error: 'CRON inválido. Ej.: */20 * * * * (cada 20 min)' });
    }
    // Validación zona horaria (opcional pero recomendado)
    const tz = payload.tz || 'America/New_York';
    if (!validateTimeZone(tz)) {
      return res.status(400).json({ error: 'Zona horaria inválida.' });
    }

    // Validación IDs de grupo
    const bad = ids.filter(x => !/@g\.us$/.test(String(x)));
    if (bad.length) return res.status(400).json({ error: `IDs inválidos: ${bad.join(', ')}` });

    // Validación imágenes
    const media = Array.isArray(payload.media) ? payload.media : [];
    const filesExist = media.every(p => {
      const abs = path.isAbsolute(p) ? p : path.join(__dirname, p.replace(/^\//, ''));
      return fs.existsSync(abs);
    });
    if (!filesExist) return res.status(400).json({ error: 'Una o más imágenes no existen en el servidor.' });

    const item = {
      id,
      name,
      ids,
      message: payload.message || '',
      media,
      mediaDelayMs: Math.max(0, Number(payload.mediaDelayMs || 2000)),
      groupDelayMs: Math.max(1500, Number(payload.groupDelayMs || 2000)),
      cron: String(payload.cron),
      tz,
      enabled: Boolean(payload.enabled ?? true),
      lastRunAt: null,
      lastError: null,
      createdAt: new Date().toISOString()
    };

    const arr = loadCampaigns();
    const idx = arr.findIndex(x => x.id === id);
    if (idx >= 0) {
      // conserva lastRunAt/lastError si existen
      item.lastRunAt = arr[idx].lastRunAt || null;
      item.lastError = arr[idx].lastError || null;
      arr[idx] = item;
    } else {
      arr.push(item);
    }
    saveCampaigns(arr);
    scheduleCampaignEngine();

    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Habilitar / Deshabilitar campaña
app.post('/api/campaigns/:id/enable', requireApiKey, (req, res) => {
  const id = req.params.id;
  const arr = loadCampaigns();
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'No existe' });
  arr[idx].enabled = true;
  saveCampaigns(arr);
  scheduleCampaignEngine();
  res.json({ ok: true, item: arr[idx] });
});

app.post('/api/campaigns/:id/disable', requireApiKey, (req, res) => {
  const id = req.params.id;
  const arr = loadCampaigns();
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'No existe' });
  arr[idx].enabled = false;
  saveCampaigns(arr);
  scheduleCampaignEngine();
  res.json({ ok: true, item: arr[idx] });
});

// Ejecutar ahora (manual)
app.post('/api/campaigns/:id/run-now', requireApiKey, async (req, res) => {
  try {
    const id = req.params.id;
    const arr = loadCampaigns();
    const idx = arr.findIndex(x => x.id === id);
    if (idx < 0) return res.status(404).json({ error: 'No existe' });
    const c = arr[idx];

    if (!waReady) return res.status(409).json({ error: 'WhatsApp no está listo.' });

    const idsBad = (c.ids || []).filter(x => !/@g\.us$/.test(String(x)));
    if (idsBad.length) return res.status(400).json({ error: `IDs inválidos: ${idsBad.join(', ')}` });

    const filesExist = (c.media || []).every(p => {
      const abs = path.isAbsolute(p) ? p : path.join(__dirname, p.replace(/^\//, ''));
      return fs.existsSync(abs);
    });
    if (!filesExist) return res.status(400).json({ error: 'Una o más imágenes no existen en el servidor.' });

    const results = await sendToMany(
      c.ids,
      c.message || '',
      Array.isArray(c.media) ? c.media : [],
      Math.max(0, Number(c.mediaDelayMs || 2000)),
      Math.max(1500, Number(c.groupDelayMs || 2000))
    );

    // actualizar metadata
    arr[idx].lastRunAt = new Date().toISOString();
    arr[idx].lastError = null;
    saveCampaigns(arr);

    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Eliminar campaña
app.delete('/api/campaigns/:id', requireApiKey, (req, res) => {
  const id = req.params.id;
  const arr = loadCampaigns();
  const nx = arr.filter(x => x.id !== id);
  if (nx.length === arr.length) return res.status(404).json({ error: 'No existe' });
  saveCampaigns(nx);
  scheduleCampaignEngine();
  res.json({ ok: true });
});

// --------------------------------- Arranque servidor ----------------------------------
app.listen(PORT, () => {
  console.log(`HTTP server en :${PORT}`);
  console.log(`Abra el panel: Replit URL → pestaña "Estado / QR"`);
});
