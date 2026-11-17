'use strict';
/*
 * Small helpers shared by the VM modules: errors with an HTTP status, IDs, QEMU option escaping, free ports, running
 * programs without a shell. Texts are English – Hostwerk translates them through locales/de.json (setT below).
 */
const net = require('net');
const crypto = require('crypto');
const { execFile } = require('child_process');

let translate = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? String(v[k]) : m)) : String(s));
/** Hostwerk's translator (host.t) – set once in server/index.js. */
function setT(fn) { if (typeof fn === 'function') translate = fn; }
const T = (s, v) => translate(s, v);

/** Error with an HTTP status (Hostwerk shows the message; 4xx = the user can fix it). */
function fail(status, text, vars, code) {
  const e = new Error(T(text, vars));
  e.status = status;
  if (code) e.code = code;
  return e;
}

/** a–z, 0–9 and "-", 2–24 characters, unique among `taken`. */
function slug(name, taken = new Set()) {
  let base = String(name || '').toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/, '');
  if (base.length < 2) base = `vm-${base || crypto.randomBytes(2).toString('hex')}`;
  if (!/^[a-z]/.test(base)) base = `vm-${base}`.slice(0, 20);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
function checkId(id) { if (!ID_RE.test(String(id || ''))) throw fail(400, 'Invalid VM id.'); return String(id); }

/** QEMU option values: a comma is written twice (",," – otherwise it starts the next option). */
function qesc(v) { return String(v).replace(/,/g, ',,'); }

/** Stable MAC address from the VM id (QEMU's local range 52:54:00). */
function macFor(id) {
  const h = crypto.createHash('sha1').update(String(id)).digest();
  return ['52', '54', '00', ...[h[0], h[1], h[2]].map((b) => b.toString(16).padStart(2, '0'))].join(':');
}

/** Is the TCP port free on `host`? */
function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.unref();
    s.once('error', () => resolve(false));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
}
/** First free port from `start` that is not in `avoid`. */
async function freePort(start, avoid = new Set(), max = 400) {
  for (let p = start; p < start + max && p < 65535; p++) {
    if (avoid.has(p)) continue;
    if (await portFree(p)) return p;
  }
  throw fail(503, 'No free port found from {port}.', { port: start });
}

/** Runs a program (no shell) → { code, stdout, stderr }. Never throws for a non-zero exit code. */
function run(cmd, args = [], { timeout = 120000, cwd, maxBuffer = 64 * 1024 * 1024, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, cwd, windowsHide: true, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || (err && code === -1 ? err.message : '') || ''), killed: !!(err && err.killed) });
    });
    if (input != null && child.stdin) child.stdin.end(input);
  });
}
/** Like run(), but throws with the program's own message on failure. */
async function runOk(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ') || `exit code ${r.code}`;
    const e = new Error(msg.slice(0, 600));
    e.status = 500;
    e.result = r;
    throw e;
  }
  return r;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * A short-lived file with a secret (the key of an encrypted disk, #15): created empty and exclusive, rights limited to
 * the current user (Windows: icacls without inherited rights; elsewhere 0600), only then the secret is written.
 * → path. Remove it with removeSecretFile() as soon as the program has read it.
 */
async function writeSecretFile(dir, secret, { runFn = run, platform = process.platform } = {}) {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(dir, `.hwkey-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  try {
    if (platform === 'win32') {
      const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : require('os').userInfo().username;
      await runFn('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { timeout: 15000 }); // best effort – the VM folder is private anyway
    }
    fs.writeFileSync(file, String(secret), { mode: 0o600 });
    return file;
  } catch (e) { removeSecretFile(file); throw e; }
}
function removeSecretFile(file) {
  const fs = require('fs');
  try { if (fs.existsSync(file)) { fs.writeFileSync(file, '0'.repeat(80)); fs.rmSync(file, { force: true }); } } catch { /* egal */ }
}

module.exports = { setT, T, fail, slug, checkId, ID_RE, qesc, macFor, portFree, freePort, run, runOk, sleep, clamp, writeSecretFile, removeSecretFile };
