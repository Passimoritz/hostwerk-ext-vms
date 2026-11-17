'use strict';
/*
 * VNC in the browser: a WebSocket <-> TCP bridge from noVNC to QEMU's built-in VNC server.
 *
 *   QEMU listens on 127.0.0.1:<port> (see vncArgs), the browser connects to  /ws/vms/<id>/vnc  (subprotocol "binary"),
 *   this module checks the id, asks resolvePort(id) for the VM's VNC port and pipes raw bytes both ways.
 *
 * Two ways to attach:
 *   attachVncProxy({ host, resolvePort })            – inside Hostwerk: host.on('upgrade', …). Hostwerk's core only hands
 *                                                      /ws/* upgrades to extensions, AFTER its own login check (cookie
 *                                                      hw_token, x-hostwerk-token, x-hostwerk-key, remote-access session)
 *                                                      and origin check. authCheck/originCheck are optional extras here.
 *   attachVncProxy({ server, authCheck, resolvePort }) – any http(s).Server: server.on('upgrade', …). authCheck is required.
 *
 * Paths accepted: /ws/vms/<id>/vnc (the one that works in Hostwerk) and /api/vms/<id>/vnc (only reachable with a plain
 * server – Hostwerk's core destroys non-/ws upgrades before extensions see them).
 *
 * The bridge never connects anywhere but 127.0.0.1, whatever resolvePort returns.
 */
const net = require('net');
const path = require('path');

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const PATH_RE = /^\/(?:ws|api)\/vms\/([^/?#]*)\/vnc\/?(?:[?#].*)?$/;
const LOOPBACK = '127.0.0.1';
const VNC_BASE = 5900; // QEMU's -vnc takes a display number: port = 5900 + display
const HIGH_WATER = 4 * 1024 * 1024; // pause the VNC socket while this much is queued for the browser
const LOW_WATER = 512 * 1024;
const STATUS = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

/** The 'ws' library: Hostwerk's copy via host.lib('ws'), else normal resolution, else Hostwerk's node_modules (tests). */
function loadWs(host) {
  if (host && typeof host.lib === 'function') { try { return host.lib('ws'); } catch { /* fall through */ } }
  try { return require('ws'); } catch { /* fall through */ }
  const roots = [path.join(__dirname, '..', '..', '..', 'hostwerk'), path.join(__dirname, '..', '..', 'hostwerk'), process.cwd()];
  for (const r of roots) { try { return require(require.resolve('ws', { paths: [r] })); } catch { /* next */ } }
  throw new Error('vnc: the "ws" library is not available');
}

/** QEMU arguments for a VNC server on 127.0.0.1:<port> without password (only reachable through the bridge). */
function vncArgs(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < VNC_BASE || p > 65535) throw new Error(`vnc: port must be ${VNC_BASE}…65535 (got ${port})`);
  return ['-vnc', `${LOOPBACK}:${p - VNC_BASE},password=off`];
}

/**
 * A free VNC port (≥ 5900, so it maps to a display number). freePort = util.freePort(start, avoid) of this extension.
 *   const vnc = await pickVncPort(U.freePort, avoid);   // inside Runtime.allocPorts()
 */
async function pickVncPort(freePort, avoid = new Set(), start = VNC_BASE + 10) {
  const p = await freePort(Math.max(VNC_BASE, start), avoid);
  if (p < VNC_BASE) throw new Error('vnc: no port at or above 5900');
  return p;
}

function matchPath(url) {
  const m = PATH_RE.exec(String(url || ''));
  if (!m) return null;
  let id;
  try { id = decodeURIComponent(m[1]); } catch { id = ''; }
  return { id };
}

function reject(socket, status, msg) {
  try {
    if (socket.writable && !socket.destroyed) {
      const body = String(msg || STATUS[status] || 'Error');
      socket.write(`HTTP/1.1 ${status} ${STATUS[status] || 'Error'}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
  } catch { /* ignore */ }
  try { socket.destroy(); } catch { /* ignore */ }
}

/**
 * Attach the bridge.
 *   host | server     – where upgrades come from (one of them)
 *   resolvePort(id)   – VNC port of a running VM, or null (may return a Promise)
 *   authCheck(req)    – true when the request is logged in (required with `server`; optional with `host`)
 *   originCheck(req)  – optional, true when the Origin is acceptable
 *   maxPerVm          – concurrent browser connections per VM (default 4)
 *   connectTimeout    – ms to reach QEMU's VNC port (default 5000)
 *   pingInterval      – ms between WebSocket pings, 0 = off (default 30000)
 *   log(...)          – optional logger
 * → { handle(req, socket, head) → bool, count(id), close() }
 */
function attachVncProxy(opts = {}) {
  const { host, server, resolvePort, authCheck = null, originCheck = null, maxPerVm = 4, connectTimeout = 5000, pingInterval = 30000, log = () => {} } = opts;
  if (typeof resolvePort !== 'function') throw new Error('vnc: resolvePort(id) is required');
  if (!host && !server) throw new Error('vnc: pass host (Hostwerk) or server (http.Server)');
  if (server && !host && typeof authCheck !== 'function') throw new Error('vnc: authCheck(req) is required with a plain server');
  const WS = loadWs(host);
  const WebSocketServer = WS.WebSocketServer || WS.Server;
  const wss = new WebSocketServer({
    noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024, clientTracking: false,
    // noVNC asks for "binary" (older versions by default, ours explicitly); a client without subprotocols is fine too
    handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
  });
  const counts = new Map(); // vm id → open (or opening) connections
  const live = new Set(); // { ws, tcp }
  let closed = false;

  const take = (id) => { counts.set(id, (counts.get(id) || 0) + 1); let done = false; return () => { if (done) return; done = true; const n = (counts.get(id) || 1) - 1; if (n > 0) counts.set(id, n); else counts.delete(id); }; };

  function bridge(id, ws, tcp, release) {
    const pair = { ws, tcp };
    live.add(pair);
    let ended = false;
    let paused = false;
    let alive = true;
    const timer = pingInterval > 0 ? setInterval(() => {
      if (!alive) { end(1011); return; }
      alive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }, pingInterval) : null;
    if (timer && timer.unref) timer.unref();
    ws.on('pong', () => { alive = true; });
    function end(code = 1000, reason = '') {
      if (ended) return;
      ended = true;
      if (timer) clearInterval(timer);
      live.delete(pair);
      release();
      try { tcp.destroy(); } catch { /* ignore */ }
      try {
        if (ws.readyState === 1) {
          ws.close(code, reason);
          const t = setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } }, 2000);
          if (t.unref) t.unref();
        } else if (ws.readyState !== 3) ws.terminate();
      } catch { /* ignore */ }
    }
    pair.end = end;
    tcp.setNoDelay(true);
    tcp.on('data', (d) => {
      if (ws.readyState !== 1) return;
      ws.send(d, { binary: true }, () => {
        if (paused && ws.bufferedAmount < LOW_WATER) { paused = false; tcp.resume(); }
      });
      if (!paused && ws.bufferedAmount > HIGH_WATER) { paused = true; tcp.pause(); }
    });
    tcp.on('end', () => end(1000, 'VNC server closed the connection'));
    tcp.on('close', () => end(1000, 'VNC server closed the connection'));
    tcp.on('error', (e) => { log(`vnc ${id}: ${e.message}`); end(1011, 'VNC connection failed'); });
    tcp.on('drain', () => { if (typeof ws.resume === 'function') ws.resume(); });
    ws.on('message', (d) => {
      const buf = Array.isArray(d) ? Buffer.concat(d) : Buffer.isBuffer(d) ? d : Buffer.from(d);
      if (!tcp.write(buf) && typeof ws.pause === 'function') ws.pause();
    });
    ws.on('close', () => end());
    ws.on('error', () => end(1011));
  }

  function handle(req, socket, head) {
    if (closed) return false;
    const m = matchPath(req && req.url);
    if (!m) return false;
    socket.on('error', () => { /* the client went away – nothing to do */ });
    try {
      if (authCheck && !authCheck(req)) { reject(socket, 401, 'Not logged in.'); return true; }
      if (originCheck && !originCheck(req)) { reject(socket, 403, 'Foreign origin rejected.'); return true; }
    } catch { reject(socket, 401, 'Not logged in.'); return true; }
    const { id } = m;
    if (!ID_RE.test(id)) { reject(socket, 400, 'Invalid VM id.'); return true; }
    if ((counts.get(id) || 0) >= maxPerVm) { reject(socket, 429, 'Too many screen connections to this VM.'); return true; }
    const release = take(id);
    Promise.resolve().then(() => resolvePort(id)).then((port) => {
      const p = Number(port);
      if (port == null || !Number.isInteger(p) || p < 1 || p > 65535) { release(); reject(socket, 404, 'The VM is not running or has no screen.'); return; }
      if (socket.destroyed) { release(); return; }
      const tcp = net.connect({ host: LOOPBACK, port: p });
      let settled = false;
      const t = setTimeout(() => { if (settled) return; settled = true; tcp.destroy(); release(); reject(socket, 504, 'The VM screen did not answer.'); }, connectTimeout);
      tcp.once('error', (e) => { if (settled) return; settled = true; clearTimeout(t); release(); log(`vnc ${id}: ${e.message}`); reject(socket, 502, 'The VM screen is not reachable.'); });
      tcp.once('connect', () => {
        if (settled) { tcp.destroy(); return; }
        settled = true; clearTimeout(t);
        if (closed || socket.destroyed) { tcp.destroy(); release(); return; }
        tcp.pause(); // hold the RFB greeting until the browser side is open
        wss.handleUpgrade(req, socket, head, (ws) => {
          if (closed) { tcp.destroy(); release(); ws.terminate(); return; }
          bridge(id, ws, tcp, release);
          tcp.resume();
        });
      });
    }).catch((e) => { release(); log(`vnc ${id}: ${e && e.message}`); reject(socket, 503, 'The VM screen is not available.'); });
    return true;
  }

  let off = null;
  if (host) {
    const r = host.on('upgrade', handle);
    off = typeof r === 'function' ? r : null;
  } else {
    server.on('upgrade', handle);
    off = () => server.off('upgrade', handle);
  }

  return {
    handle,
    count: (id) => counts.get(id) || 0,
    /** Detach and end all open connections (deactivate / tests). */
    close() {
      closed = true;
      if (off) { try { off(); } catch { /* ignore */ } off = null; }
      for (const p of [...live]) p.end(1001, 'Shutting down');
      try { wss.close(); } catch { /* ignore */ }
    },
  };
}

module.exports = { attachVncProxy, vncArgs, pickVncPort, matchPath, ID_RE, VNC_BASE, loadWs };
