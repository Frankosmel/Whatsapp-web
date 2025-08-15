// server.js
// --------------------------------------------------------------------------------------
// Servidor Express con API para: estado/QR, listados de grupos, subida de imágenes,
// envío inmediato y programación one-shot con persistencia en JSON.
// Usa whatsapp-web.js + puppeteer y LocalAuth para mantener la sesión en .wa-session.
// --------------------------------------------------------------------------------------

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const QRCode = require('qrcode');
const dayjs = require('dayjs');

const { nanoid } = require('nanoid');

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------------- Seguridad (API Key) ------------------------------------
const API_KEY = process.env.ADMIN_API_KEY || '';
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // si no se configuró, no bloqueamos (modo dev)
  const key = req.header('x-api-key') || '';
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ----------------------------- Static & body ------------------------------------------
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use('/', express.static(path.join(__dirname, 'public')));

// Carpeta de subidas (sirve archivos estáticos)
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
app.use('/uploads', express.static(UPLOAD_DIR));

// ----------------------------- Multer (subida de imágenes) ----------------------------
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
  limits: { fileSize: 16 * 1024 * 1024 }, // 16MB por imagen
  fileFilter: (_, file, cb) => {
    if ((file.mimetype || '').startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes.'));
  }
});

// ----------------------------- WhatsApp Client ----------------------------------------
let lastQR = null;
let waReady = false;

const client = new Client({
  // La sesión se guarda en .wa-session dentro del Repl
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
  // Cache remoto de la versión web para mayor estabilidad ante cambios de WA Web
  webVersionCache: { type: 'remote' }
});

client.on('qr', qr => {
  lastQR = qr;
  waReady = false;
  console.log('🔑 Escanea el QR (primera vez o sesión expirada).');
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

// ----------------------------- Helpers de envío ---------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Envía a un único grupo: mensaje + n imágenes (caption solo en la primera).
 */
async function sendToOneGroup(id, text, mediaPaths = [], mediaDelayMs = 2000) {
  // Enviar solo texto (si no hay imágenes)
  if (!mediaPaths?.length) {
    if (text) await client.sendMessage(id, text);
    return;
  }
  let first = true;
  for (const p of mediaPaths) {
    // Permitir rutas absolutas o relativas a /uploads
    const abs = path.isAbsolute(p) ? p : path.join(__dirname, p.replace(/^\//, ''));
    const mm = MessageMedia.fromFilePath(abs);
    await client.sendMessage(id, mm, { caption: first ? (text || '') : undefined });
    first = false;
    await sleep(Math.max(0, Number(mediaDelayMs) || 0));
  }
}

/**
 * Envía a múltiples grupos con delay entre grupos.
 */
async function sendToMany(ids, text, mediaPaths, mediaDelayMs, groupDelayMs) {
  const results = [];
  for (const gid of ids) {
    try {
      await sendToOneGroup(gid, text, mediaPaths, mediaDelayMs);
      results.push({ id: gid, ok: true });
    } catch (e) {
      results.push({ id: gid, ok: false, error: e?.message || String(e) });
    }
    await sleep(Math.max(1500, Number(groupDelayMs) || 0)); // mínimo 1.5s entre grupos
  }
  return results;
}

// ----------------------------- Endpoints API ------------------------------------------

// Estado general
app.get('/api/status', requireApiKey, (req, res) => {
  let me = null;
  try { me = client.info || null; } catch {}
  res.json({
    ready: waReady,
    me
  });
});

// QR como PNG
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

// Listar grupos
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

// Subida de imágenes (hasta 10)
app.post('/api/upload', requireApiKey, upload.array('images', 10), (req, res) => {
  try {
    const files = (req.files || []).map(f => `/uploads/${path.basename(f.path)}`);
    res.json({ ok: true, files });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Envío inmediato a múltiples grupos
app.post('/api/send', requireApiKey, async (req, res) => {
  try {
    if (!waReady) return res.status(409).json({ error: 'WhatsApp no está listo todavía.' });

    const { ids, text, media = [], mediaDelayMs = 2000, groupDelayMs = 2000 } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'El campo ids[] es obligatorio.' });
    }
    // Validaciones simples de formato de grupo
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

// ----------------------------- Programaciones one-shot --------------------------------
// Persistimos en JSON sencillo (suficiente para un starter)
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

// Crear/actualizar programación
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

// Borrar programación definitivamente (opcional)
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

// ----------------------------- Arranque ------------------------------------------------
app.listen(PORT, () => {
  console.log(`HTTP server en :${PORT}`);
  console.log(`Abra el panel: Replit URL → pestaña "Estado / QR"`);
});
