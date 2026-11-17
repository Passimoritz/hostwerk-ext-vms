'use strict';
/*
 * QEMU Machine Protocol (QMP) and the QEMU guest agent – both speak JSON lines over a socket.
 *
 *   const q = new Qmp({ port }); await q.connect(); await q.exec('query-status'); q.on('event', …); q.close();
 *   await q.hmp('hostfwd_add n0 tcp:127.0.0.1:2222-:22')   → text of the human monitor (errors become exceptions)
 *   await agent({ port }, 'guest-network-get-interfaces')  → one call to the guest agent (connect, sync, call, close)
 */
const net = require('net');
const { EventEmitter } = require('events');

class QmpError extends Error {
  constructor(cls, desc) { super(desc || cls || 'QMP error'); this.qmpClass = cls; this.status = 500; }
}

/** Splits a socket stream into JSON objects (one per line). */
function lineReader(onMsg) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { onMsg(JSON.parse(line)); } catch { /* not JSON – ignore */ }
    }
  };
}

class Qmp extends EventEmitter {
  constructor({ port, host = '127.0.0.1', timeout = 15000 }) {
    super();
    this.port = port; this.host = host; this.timeout = timeout;
    this.sock = null; this.pending = new Map(); this.seq = 0; this.closed = false;
  }

  /** Connects (QEMU may still be starting – retries until `waitMs`) and negotiates capabilities. */
  async connect(waitMs = 15000) {
    const until = Date.now() + waitMs;
    let lastErr = null;
    while (Date.now() < until && !this.closed) {
      try { await this.connectOnce(); await this.exec('qmp_capabilities'); return this; } catch (e) { lastErr = e; this.drop(); await new Promise((r) => setTimeout(r, 250)); }
    }
    throw lastErr || new Error('QMP not reachable');
  }

  connectOnce() {
    return new Promise((resolve, reject) => {
      const s = net.connect({ port: this.port, host: this.host });
      let greeted = false;
      const t = setTimeout(() => { s.destroy(); reject(new Error('QMP greeting timeout')); }, 3000);
      s.on('data', lineReader((m) => {
        if (!greeted && m.QMP) { greeted = true; clearTimeout(t); this.sock = s; resolve(); return; }
        this.onMessage(m);
      }));
      // After the greeting a socket error (QEMU quit: ECONNRESET) only ends the connection – 'close' follows and rejects
      // pending calls. Re-emitting 'error' without a listener would be an unhandled exception in Hostwerk.
      s.on('error', (e) => { clearTimeout(t); if (!greeted) reject(e); else if (this.listenerCount('error')) this.emit('error', e); });
      s.on('close', () => { clearTimeout(t); if (this.sock === s) { this.sock = null; this.rejectAll(new Error('QMP connection closed')); this.emit('close'); } });
    });
  }

  onMessage(m) {
    if (m.event) { this.emit('event', m); return; }
    const p = m.id != null ? this.pending.get(m.id) : null;
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new QmpError(m.error.class, m.error.desc)); else p.resolve(m.return);
  }

  exec(execute, args, timeout = this.timeout) {
    if (!this.sock) return Promise.reject(new Error('QMP not connected'));
    const id = `hw${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`QMP ${execute}: no answer`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(`${JSON.stringify(args ? { execute, arguments: args, id } : { execute, id })}\n`);
    });
  }

  /** Human monitor command through QMP. QEMU reports most HMP errors as text – those become exceptions. */
  async hmp(line, timeout) {
    const out = String(await this.exec('human-monitor-command', { 'command-line': line }, timeout) || '');
    if (/^(Error|Could not|Invalid|Unknown|.*not found)/im.test(out.trim())) throw new QmpError('GenericError', out.trim());
    return out;
  }

  rejectAll(err) { for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); } this.pending.clear(); }
  drop() { if (this.sock) { try { this.sock.destroy(); } catch { /* egal */ } } this.sock = null; }
  get connected() { return !!this.sock; }
  close() { this.closed = true; this.drop(); this.rejectAll(new Error('QMP closed')); }
}

/**
 * One guest agent call. The agent has no greeting; guest-sync-delimited with a random id clears what an earlier,
 * interrupted call may have left in the channel. → result, or throws (agent not running: timeout).
 */
function agent({ port, host = '127.0.0.1' }, execute, args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ port, host });
    const syncId = Math.floor(Math.random() * 2 ** 31);
    let synced = false;
    const done = (err, v) => { clearTimeout(t); s.destroy(); if (err) reject(err); else resolve(v); };
    const t = setTimeout(() => done(Object.assign(new Error('The guest agent does not answer.'), { status: 503, code: 'NO_AGENT' })), timeout);
    s.on('error', (e) => done(e));
    s.on('connect', () => { s.write(Buffer.concat([Buffer.from([0xff]), Buffer.from(`${JSON.stringify({ execute: 'guest-sync-delimited', arguments: { id: syncId } })}\n`)])); });
    // The agent answers guest-sync-delimited with a 0xFF byte in front of the JSON – drop it before reading lines
    const read = lineReader((m) => {
      if (!synced) {
        if (m.return === syncId) {
          synced = true;
          if (execute === 'guest-shutdown') { s.write(`${JSON.stringify({ execute, arguments: args || {} })}\n`); setTimeout(() => done(null, {}), 500); return; } // no answer by design
          s.write(`${JSON.stringify(args ? { execute, arguments: args } : { execute })}\n`);
        }
        return;
      }
      if (m.error) done(new QmpError(m.error.class, m.error.desc)); else done(null, m.return);
    });
    s.on('data', (d) => read(Buffer.from(d.filter((b) => b !== 0xff))));
  });
}

/** IPv4/IPv6 addresses from guest-network-get-interfaces (without loopback and link-local). */
function addressesFrom(ifaces) {
  const out = [];
  for (const i of Array.isArray(ifaces) ? ifaces : []) {
    if (i.name === 'lo' || /loopback/i.test(i.name || '')) continue;
    for (const a of i['ip-addresses'] || []) {
      const ip = a['ip-address'];
      if (!ip || ip.startsWith('127.') || ip === '::1' || /^fe80:/i.test(ip) || /^169\.254\./.test(ip)) continue;
      out.push({ iface: i.name, ip, type: a['ip-address-type'], prefix: a.prefix });
    }
  }
  return out;
}

module.exports = { Qmp, QmpError, agent, addressesFrom, lineReader };
