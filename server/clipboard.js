'use strict';
/*
 * Shared clipboard without noVNC: a small VNC client of its own that speaks only the clipboard part of RFB with QEMU's
 * VNC server on 127.0.0.1 – the same way noVNC in the fluid screen does it (extended clipboard, pseudo-encoding
 * 0xC0A1E5CE; verified with Windows 11 in tests/live/clipboard.js). It never asks for pictures.
 *
 *   QEMU's qemu-vdagent chardev ⇄ spice-vdagent in the guest ⇄ the guest's clipboard
 *   QEMU's VNC server            ⇄ this client                 ⇄ GET/POST /api/vms/<id>/clipboard ⇄ the simple screen
 *
 *   const c = new GuestClipboard({ port: 5910 });
 *   await c.connect();
 *   c.state()          → { ready, extended, text, seq, at }  (text: last text copied in the guest, seq counts copies)
 *   c.offer('hello')   → the guest's next paste (Ctrl+V) gets "hello"
 *   c.close()
 *
 * Without the extended clipboard (old QEMU) it falls back to the classic cut text (Latin-1 only).
 */
const net = require('net');
const zlib = require('zlib');
const { EventEmitter } = require('events');

const EXT_CLIP = 0xC0A1E5CE | 0;
const F = { TEXT: 1, CAPS: 0x01000000, REQUEST: 0x02000000, PEEK: 0x04000000, NOTIFY: 0x08000000, PROVIDE: 0x10000000 };
const MAX_TEXT = 1024 * 1024; // what we accept from the guest and hand to it
const LOOPBACK = '127.0.0.1'; // never anywhere else

/** Client cut text with the extended clipboard: type 6, negative length, flags, payload. */
function extCut(flags, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(12);
  h[0] = 6;
  h.writeInt32BE(-(4 + payload.length), 4);
  h.writeUInt32BE(flags >>> 0, 8);
  return Buffer.concat([h, payload]);
}
/** Classic client cut text (Latin-1). */
function legacyCut(text) {
  const t = Buffer.from(String(text).replace(/[^\x00-\xff]/g, '?'), 'latin1');
  const h = Buffer.alloc(8);
  h[0] = 6;
  h.writeUInt32BE(t.length, 4);
  return Buffer.concat([h, t]);
}
/** Text for a PROVIDE message: zlib(length + UTF-8 + NUL). */
function providePayload(text) {
  const t = Buffer.from(`${text}\0`, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(t.length);
  return zlib.deflateSync(Buffer.concat([len, t]));
}
/** Text from a PROVIDE message (the first format in it – we only ever ask for text). */
function readProvide(body) {
  const raw = zlib.inflateSync(body, { maxOutputLength: MAX_TEXT + 16 });
  const n = Math.min(raw.readUInt32BE(0), raw.length - 4);
  return raw.subarray(4, 4 + n).toString('utf8').replace(/\0+$/, '');
}

class GuestClipboard extends EventEmitter {
  constructor({ port, timeout = 5000 } = {}) {
    super();
    this.port = Number(port);
    this.timeout = timeout;
    this.sock = null; this.connecting = null; this.closed = false;
    this.ready = false; this.extended = false;
    this.text = ''; this.seq = 0; this.at = null; // last text from the guest
    this.offered = null; // text the guest gets when it pastes
    this.onCaps = null;
  }

  state() { return { ready: this.ready, extended: this.extended, text: this.text, seq: this.seq, at: this.at }; }

  /** Connects once (again after a drop). Resolves when the VNC handshake is done. */
  connect() {
    if (this.closed) return Promise.reject(new Error('clipboard: closed'));
    if (this.connecting) return this.connecting;
    if (this.ready && this.sock && !this.sock.destroyed) return Promise.resolve(this);
    this.connecting = new Promise((resolve, reject) => {
      const s = net.connect(this.port, LOOPBACK);
      this.sock = s;
      let buf = Buffer.alloc(0);
      let stage = 'version';
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.connecting = null;
        if (err) { try { s.destroy(); } catch { /* egal */ } reject(err); } else resolve(this);
      };
      const timer = setTimeout(() => done(new Error('clipboard: no answer from the VNC server')), this.timeout);
      const need = (n) => buf.length >= n;
      const take = (n) => { const b = buf.subarray(0, n); buf = buf.subarray(n); return b; };
      s.setNoDelay(true);
      if (typeof s.unref === 'function') s.unref(); // never keeps Hostwerk alive
      s.on('error', (e) => done(e));
      s.on('close', () => {
        if (this.sock === s) { this.sock = null; this.ready = false; }
        done(new Error('clipboard: the VNC server closed the connection'));
        this.emit('close');
      });
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        try {
          for (;;) {
            if (stage === 'version') { if (!need(12)) return; take(12); s.write('RFB 003.008\n'); stage = 'sec'; continue; }
            if (stage === 'sec') {
              if (!need(1)) return;
              const n = buf[0];
              if (n === 0) throw new Error('clipboard: VNC refused the connection');
              if (!need(1 + n)) return;
              const types = [...take(1 + n).subarray(1)];
              if (!types.includes(1)) throw new Error('clipboard: VNC wants a password');
              s.write(Buffer.from([1])); stage = 'secres'; continue;
            }
            if (stage === 'secres') { if (!need(4)) return; if (take(4).readUInt32BE(0) !== 0) throw new Error('clipboard: VNC security failed'); s.write(Buffer.from([1])); stage = 'init'; continue; } // shared
            if (stage === 'init') {
              if (!need(24)) return;
              const nl = buf.readUInt32BE(20);
              if (!need(24 + nl)) return;
              take(24 + nl);
              const enc = Buffer.alloc(8); enc[0] = 2; enc.writeUInt16BE(1, 2); enc.writeInt32BE(EXT_CLIP, 4); s.write(enc);
              const caps = Buffer.alloc(4); caps.writeUInt32BE(MAX_TEXT);
              s.write(extCut(F.CAPS | F.REQUEST | F.PEEK | F.NOTIFY | F.PROVIDE | F.TEXT, caps));
              // QEMU answers with its capabilities right away; old servers without the extended clipboard never do
              stage = 'msg'; this.ready = true;
              this.onCaps = () => { this.onCaps = null; done(null); };
              setTimeout(() => { if (this.onCaps) this.onCaps(); }, 600).unref();
              continue;
            }
            // Messages: only bell (2) and cut text (3) come – this client never asks for screen updates
            if (!need(1)) return;
            if (buf[0] === 2) { take(1); continue; }
            if (buf[0] !== 3) throw new Error(`clipboard: unexpected VNC message ${buf[0]}`);
            if (!need(8)) return;
            const len = buf.readInt32BE(4);
            const abs = Math.abs(len);
            if (abs > MAX_TEXT + 1024) throw new Error('clipboard: too much text from the guest');
            if (!need(8 + abs)) return;
            const m = take(8 + abs).subarray(8);
            if (len >= 0) { this.fromGuest(m.toString('latin1')); continue; }
            this.onExt(m.readUInt32BE(0) >>> 0, m.subarray(4));
          }
        } catch (e) {
          this.emit('warn', e);
          done(e);
          try { s.destroy(); } catch { /* egal */ }
        }
      });
    });
    return this.connecting;
  }

  onExt(flags, body) {
    if (flags & F.CAPS) { this.extended = !!(flags & F.TEXT); if (this.onCaps) this.onCaps(); return; }
    if (flags & F.PROVIDE) { if ((flags & F.TEXT) && body.length) this.fromGuest(readProvide(body)); return; }
    if (flags & F.REQUEST) { if (flags & F.TEXT) this.write(extCut(F.PROVIDE | F.TEXT, providePayload(this.offered == null ? '' : this.offered))); return; }
    if (flags & F.PEEK) { this.write(extCut(F.NOTIFY | (this.offered == null ? 0 : F.TEXT))); return; }
    if ((flags & F.NOTIFY) && (flags & F.TEXT)) this.write(extCut(F.REQUEST | F.TEXT)); // the guest copied text: fetch it
  }

  fromGuest(text) {
    this.text = String(text).slice(0, MAX_TEXT);
    this.seq += 1;
    this.at = Date.now();
    this.emit('text', this.text);
  }

  write(b) { if (this.sock && !this.sock.destroyed) this.sock.write(b); }

  /** Text from this PC for the guest: it is announced now and handed over when the guest pastes. */
  offer(text) {
    const t = String(text == null ? '' : text);
    if (Buffer.byteLength(t) > MAX_TEXT) throw Object.assign(new Error('Too much text for the clipboard (1 MB at most).'), { status: 400 });
    if (!this.ready) throw Object.assign(new Error('The clipboard of the VM is not connected.'), { status: 409 });
    this.offered = t;
    if (this.extended) this.write(extCut(F.NOTIFY | F.TEXT));
    else this.write(legacyCut(t));
  }

  close() {
    this.closed = true; this.ready = false;
    if (this.sock) { try { this.sock.destroy(); } catch { /* egal */ } this.sock = null; }
  }
}

module.exports = { GuestClipboard, extCut, legacyCut, providePayload, readProvide, FLAGS: F, EXT_CLIP, MAX_TEXT };
