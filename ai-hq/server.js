'use strict';
/**
 * AI HQ - dashboard untuk mengelola "karyawan AI".
 * Tanpa dependensi eksternal (hanya modul bawaan Node 18+).
 * Kunci API dibaca dari environment variable, tidak pernah dikirim ke browser.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1_000_000;
const MAX_TASKS = 500;
const MAX_LOGS = 300;
const PROVIDERS = ['openai', 'anthropic'];

/* ---------- Penyimpanan ---------- */
// Mode utama: Supabase lewat REST API (tanpa library), data permanen.
// Mode cadangan: file JSON lokal (hilang saat redeploy di plan gratis Render).
const SB_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const USE_SB = !!(SB_URL && SB_KEY);
let storageError = '';
let state = { agents: [], tasks: [], logs: [] };

function loadFile() {
  try {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { agents: s.agents || [], tasks: s.tasks || [], logs: s.logs || [] };
  } catch {
    return { agents: [], tasks: [], logs: [] };
  }
}

function saveFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, DATA_FILE);
    storageError = '';
  } catch (e) {
    storageError = String(e.message || e).slice(0, 300);
    console.error('Penyimpanan file gagal:', storageError);
  }
}

async function sb(method, query, body, extra = {}) {
  const headers = { apikey: SB_KEY, 'Content-Type': 'application/json', ...extra };
  if (SB_KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + SB_KEY; // kunci format lama (JWT)
  const res = await fetch(`${SB_URL}/rest/v1/${query}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// Semua penulisan ke Supabase diantre agar urutannya tetap benar.
let chain = Promise.resolve();
function enqueue(job) {
  chain = chain.then(job).then(
    () => { storageError = ''; },
    (e) => { storageError = String(e.message || e).slice(0, 300); console.error('Penyimpanan Supabase gagal:', storageError); }
  );
  return chain;
}

function put(table, obj) {
  if (!USE_SB) return saveFile();
  const row = { id: obj.id, data: obj, created_at: obj.createdAt || obj.at || new Date().toISOString() };
  return enqueue(() => sb('POST', `${table}?on_conflict=id`, row, { Prefer: 'resolution=merge-duplicates,return=minimal' }));
}

function remove(table, id) {
  if (!USE_SB) return saveFile();
  return enqueue(() => sb('DELETE', `${table}?id=eq.${encodeURIComponent(id)}`, undefined, { Prefer: 'return=minimal' }));
}

async function loadState() {
  if (!USE_SB) return loadFile();
  const [agents, tasks, logs] = await Promise.all([
    sb('GET', 'agents?select=data&order=created_at.asc&limit=1000'),
    sb('GET', `tasks?select=data&order=created_at.desc&limit=${MAX_TASKS}`),
    sb('GET', `logs?select=data&order=created_at.desc&limit=${MAX_LOGS}`),
  ]);
  return {
    agents: agents.map((r) => r.data),
    tasks: tasks.map((r) => r.data),
    logs: logs.map((r) => r.data),
  };
}

function log(message, level = 'info') {
  const entry = { id: uid(), at: new Date().toISOString(), level, message };
  state.logs.unshift(entry);
  put('logs', entry);
  if (state.logs.length > MAX_LOGS) {
    const old = state.logs.pop();
    remove('logs', old.id);
  }
}

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

// Tugas yang masih "running" saat server mati tidak akan pernah selesai.
function recoverStuckTasks() {
  for (const t of state.tasks) {
    if (t.status === 'running') {
      t.status = 'error';
      t.error = 'Server restart saat tugas berjalan.';
      t.finishedAt = new Date().toISOString();
      put('tasks', t);
    }
  }
}

/* ---------- Auth ---------- */
function sessionToken() {
  return crypto.createHmac('sha256', ADMIN_PASSWORD).update('ai-hq-session').digest('hex');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}
function isAuthed(req) {
  return ADMIN_PASSWORD && safeEqual(getCookie(req, 'session'), sessionToken());
}

const attempts = new Map(); // ip -> {count, resetAt}
function tooManyAttempts(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) return false;
  return a.count >= 10;
}
function recordFailure(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) attempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
  else a.count++;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

/* ---------- Validasi ---------- */
function str(v, max) {
  return String(v ?? '').trim().slice(0, max);
}
function num(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function cleanAgent(b) {
  const provider = PROVIDERS.includes(b.provider) ? b.provider : null;
  const name = str(b.name, 60);
  const model = str(b.model, 100);
  if (!name) throw httpError(400, 'Nama karyawan wajib diisi.');
  if (!provider) throw httpError(400, 'Provider harus openai atau anthropic.');
  if (!model) throw httpError(400, 'Model wajib diisi.');
  return {
    name,
    role: str(b.role, 100),
    provider,
    model,
    systemPrompt: str(b.systemPrompt, 8000),
    maxTokens: Math.round(num(b.maxTokens, 1, 32000, 2000)),
    priceIn: num(b.priceIn, 0, 100000, 0),
    priceOut: num(b.priceOut, 0, 100000, 0),
    active: b.active !== false,
  };
}
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* ---------- Adapter provider ---------- */
async function readJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && (data.error.message || data.error)) || `HTTP ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

async function callProvider(agent, input) {
  if (agent.provider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY belum diset di environment.');
    const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const messages = [];
    if (agent.systemPrompt) messages.push({ role: 'system', content: agent.systemPrompt });
    messages.push({ role: 'user', content: input });
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: agent.model, max_completion_tokens: agent.maxTokens, messages }),
      signal: AbortSignal.timeout(120000),
    });
    const d = await readJson(res);
    return {
      text: d.choices?.[0]?.message?.content || '',
      tokensIn: d.usage?.prompt_tokens || 0,
      tokensOut: d.usage?.completion_tokens || 0,
    };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY belum diset di environment.');
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  const body = {
    model: agent.model,
    max_tokens: agent.maxTokens,
    messages: [{ role: 'user', content: input }],
  };
  if (agent.systemPrompt) body.system = agent.systemPrompt;
  const res = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const d = await readJson(res);
  return {
    text: (d.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
    tokensIn: d.usage?.input_tokens || 0,
    tokensOut: d.usage?.output_tokens || 0,
  };
}

async function runTask(task, agent) {
  try {
    const r = await callProvider(agent, task.input);
    task.status = 'done';
    task.output = r.text;
    task.tokensIn = r.tokensIn;
    task.tokensOut = r.tokensOut;
    task.cost = (r.tokensIn * agent.priceIn + r.tokensOut * agent.priceOut) / 1e6;
    log(`${agent.name} menyelesaikan tugas "${task.title}"`, 'ok');
  } catch (e) {
    task.status = 'error';
    task.error = String(e.message || e).slice(0, 1000);
    log(`${agent.name} gagal mengerjakan "${task.title}": ${task.error}`, 'error');
  }
  task.finishedAt = new Date().toISOString();
  put('tasks', task);
}

/* ---------- API ---------- */
function stats() {
  const t = state.tasks;
  return {
    agents: state.agents.length,
    activeAgents: state.agents.filter((a) => a.active).length,
    tasks: t.length,
    done: t.filter((x) => x.status === 'done').length,
    running: t.filter((x) => x.status === 'running').length,
    failed: t.filter((x) => x.status === 'error').length,
    tokens: t.reduce((s, x) => s + (x.tokensIn || 0) + (x.tokensOut || 0), 0),
    cost: t.reduce((s, x) => s + (x.cost || 0), 0),
  };
}

async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  if (p === '/api/health') return send(res, 200, { ok: true });

  if (!ADMIN_PASSWORD) {
    return send(res, 503, {
      error: 'ADMIN_PASSWORD belum diset. Tambahkan di Environment Render lalu deploy ulang.',
      setup: true,
    });
  }

  if (p === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    if (tooManyAttempts(ip)) return send(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
    const body = await readBody(req);
    if (!safeEqual(body.password || '', ADMIN_PASSWORD)) {
      recordFailure(ip);
      return send(res, 401, { error: 'Password salah.' });
    }
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `session=${sessionToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  if (!isAuthed(req)) return send(res, 401, { error: 'Belum login.' });

  if (p === '/api/state' && method === 'GET') {
    return send(res, 200, {
      agents: state.agents,
      tasks: state.tasks.slice(0, 100),
      logs: state.logs.slice(0, 100),
      stats: stats(),
      storage: { mode: USE_SB ? 'supabase' : 'file', error: storageError },
      providers: {
        openai: !!process.env.OPENAI_API_KEY,
        anthropic: !!process.env.ANTHROPIC_API_KEY,
      },
    });
  }

  if (p === '/api/agents' && method === 'POST') {
    const agent = { id: uid(), createdAt: new Date().toISOString(), ...cleanAgent(await readBody(req)) };
    state.agents.push(agent);
    log(`Karyawan baru ditambahkan: ${agent.name}`);
    put('agents', agent);
    return send(res, 201, agent);
  }

  let m = p.match(/^\/api\/agents\/([\w-]+)$/);
  if (m) {
    const idx = state.agents.findIndex((a) => a.id === m[1]);
    if (idx < 0) return send(res, 404, { error: 'Karyawan tidak ditemukan.' });
    if (method === 'PUT') {
      const old = state.agents[idx];
      state.agents[idx] = { ...old, ...cleanAgent(await readBody(req)) };
      log(`Karyawan diperbarui: ${state.agents[idx].name}`);
      put('agents', state.agents[idx]);
      return send(res, 200, state.agents[idx]);
    }
    if (method === 'DELETE') {
      const [gone] = state.agents.splice(idx, 1);
      log(`Karyawan dihapus: ${gone.name}`, 'warn');
      remove('agents', gone.id);
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/tasks' && method === 'POST') {
    const b = await readBody(req);
    const agent = state.agents.find((a) => a.id === b.agentId);
    if (!agent) throw httpError(400, 'Pilih karyawan terlebih dahulu.');
    if (!agent.active) throw httpError(400, 'Karyawan ini sedang dinonaktifkan.');
    const input = str(b.input, 50000);
    if (!input) throw httpError(400, 'Instruksi tugas wajib diisi.');
    const task = {
      id: uid(),
      agentId: agent.id,
      agentName: agent.name,
      title: str(b.title, 120) || input.slice(0, 60),
      input,
      status: 'running',
      createdAt: new Date().toISOString(),
    };
    state.tasks.unshift(task);
    put('tasks', task);
    if (state.tasks.length > MAX_TASKS) {
      const old = state.tasks.pop();
      remove('tasks', old.id);
    }
    log(`Tugas baru untuk ${agent.name}: "${task.title}"`);
    runTask(task, agent); // berjalan di latar belakang; frontend polling
    return send(res, 202, task);
  }

  m = p.match(/^\/api\/tasks\/([\w-]+)$/);
  if (m && method === 'DELETE') {
    const idx = state.tasks.findIndex((t) => t.id === m[1]);
    if (idx < 0) return send(res, 404, { error: 'Tugas tidak ditemukan.' });
    state.tasks.splice(idx, 1);
    remove('tasks', m[1]);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Endpoint tidak ditemukan.' });
}

/* ---------- HTTP helpers ---------- */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(httpError(413, 'Data terlalu besar.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'JSON tidak valid.'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Tidak ditemukan');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Kesalahan server.' : e.message });
  }
});

(async () => {
  try {
    state = await loadState();
  } catch (e) {
    console.error('Gagal memuat data dari Supabase. Cek SUPABASE_URL, SUPABASE_SERVICE_KEY, dan apakah supabase/schema.sql sudah dijalankan.\n' + e.message);
    process.exit(1);
  }
  recoverStuckTasks();
  server.listen(PORT, () => {
    console.log(`AI HQ berjalan di port ${PORT} (penyimpanan: ${USE_SB ? 'Supabase' : 'file lokal'})`);
    if (!ADMIN_PASSWORD) console.warn('PERINGATAN: ADMIN_PASSWORD belum diset, API dikunci.');
  });
})();
