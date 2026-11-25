'use strict';
/*
 * Shortcuts and the shared clipboard of the screen: combos by name or as key lists, releasing stuck modifiers, and the
 * clipboard client against a fake QEMU VNC server (handshake, extended clipboard both ways, classic cut text). No QEMU.
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');
const K = require('../server/keys');
const C = require('../server/clipboard');
const { Runtime } = require('../server/runtime');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hw-vms-kc-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(10); } throw new Error('timeout'); }

/* ---------------- keys ---------------- */
test('keys: combos by name or as a list of known keys, nothing else', () => {
  assert.deepEqual(K.comboKeys('ctrl-alt-del'), ['ctrl', 'alt', 'delete']);
  assert.deepEqual(K.comboKeys('meta-l'), ['meta_l', 'l']);
  assert.deepEqual(K.comboKeys('ctrl-alt-f3'), ['ctrl', 'alt', 'f3']);
  assert.deepEqual(K.comboKeys(['ctrl', 'shift', 'esc']), ['ctrl', 'shift', 'esc']);
  for (const bad of ['nope', 'constructor', '__proto__', '', ['ctrl', 'ctrl'], ['ctrl', 'evil'], [], new Array(7).fill('a')]) {
    assert.throws(() => K.comboKeys(bad), /Unknown key combination/, JSON.stringify(bad));
  }
  // every named combo only uses qcodes the screen knows
  for (const [name, keys] of Object.entries(K.COMBOS)) assert.ok(keys.every((k) => K.QCODES.has(k)), name);
});

test('keys: Windows key under its old name, media keys; release lets go of every modifier', () => {
  assert.equal(K.qcodeOf('OSLeft'), 'meta_l');
  assert.equal(K.qcodeOf('MetaRight'), 'meta_r');
  assert.equal(K.qcodeOf('AudioVolumeUp'), 'volumeup');
  const ev = K.toQmpEvents([{ t: 'r' }]);
  assert.equal(ev.length, K.MODIFIERS.length);
  assert.ok(ev.every((e) => e.type === 'key' && e.data.down === false));
  assert.deepEqual(ev.map((e) => e.data.key.data).sort(), [...K.MODIFIERS].sort());
});

test('runtime: combo by name and by key list goes to QMP send-key, unknown ones are refused', async () => {
  const calls = [];
  const r = new Runtime({ id: 'v', name: 'v', disks: [] }, { qhost: {}, Proc: class {}, dir: tmp() });
  r.qmp = { exec: async (c, a) => { calls.push([c, a]); } };
  r.isRunning = () => true;
  await r.combo('alt-tab');
  await r.combo(['ctrl', 'alt', 't']);
  assert.deepEqual(calls.map(([c, a]) => [c, a.keys.map((k) => k.data)]), [['send-key', ['alt', 'tab']], ['send-key', ['ctrl', 'alt', 't']]]);
  await assert.rejects(() => r.combo('rm-rf'), (e) => e.status === 400);
});

test('runtime: clipboard helper from query-chardev (spice-vdagent opened its port or not)', async () => {
  const r = new Runtime({ id: 'v', name: 'v', disks: [] }, { qhost: {}, Proc: class {}, dir: tmp() });
  r.isRunning = () => true;
  r.ports = { qmp: 1, qga: 2, vnc: null };
  let open = false;
  r.qmp = { exec: async (c) => { assert.equal(c, 'query-chardev'); return [{ label: 'qga0', 'frontend-open': true }, { label: 'vdagent', 'frontend-open': open }]; } };
  assert.equal(await r.clipboardHelper(), false);
  open = true;
  assert.equal(await r.clipboardHelper(), true);
  r.ports = { qmp: 1, qga: null };
  assert.equal(await r.clipboardHelper(), null); // no agent port → no vdagent chardev
  // 3D in QEMU's own window: no VNC, so no clipboard bridge
  r.ports = { qmp: 1, qga: 2, vnc: null };
  await assert.rejects(() => r.clipboardGet({ watch: true }), (e) => e.status === 409 && /own window/.test(e.message));
  r.isRunning = () => false;
  await assert.rejects(() => r.clipboardSet('x'), (e) => e.status === 409);
});

/* ---------------- clipboard client against a fake QEMU ---------------- */
/** A VNC server like QEMU's: no password, ServerInit, then only cut text. `ext` = speaks the extended clipboard. */
function fakeQemu({ ext = true } = {}) {
  const srv = { got: [], sock: null, encodings: null };
  const server = net.createServer((s) => {
    srv.sock = s;
    let buf = Buffer.alloc(0); let stage = 'version';
    s.on('error', () => {});
    s.write('RFB 003.008\n');
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 'version') { if (buf.length < 12) return; buf = buf.subarray(12); s.write(Buffer.from([1, 1])); stage = 'sec'; continue; }
        if (stage === 'sec') { if (buf.length < 1) return; buf = buf.subarray(1); s.write(Buffer.alloc(4)); stage = 'shared'; continue; }
        if (stage === 'shared') {
          if (buf.length < 1) return; buf = buf.subarray(1);
          const name = Buffer.from('QEMU (fake)'); const init = Buffer.alloc(24); init.writeUInt16BE(640, 0); init.writeUInt16BE(480, 2); init.writeUInt32BE(name.length, 20);
          s.write(Buffer.concat([init, name])); stage = 'msg'; continue;
        }
        if (buf.length < 1) return;
        if (buf[0] === 2) { // SetEncodings
          if (buf.length < 4) return; const n = buf.readUInt16BE(2); if (buf.length < 4 + 4 * n) return;
          srv.encodings = Array.from({ length: n }, (_, i) => buf.readInt32BE(4 + 4 * i)); buf = buf.subarray(4 + 4 * n);
          if (ext && srv.encodings.includes(C.EXT_CLIP)) srv.send(C.FLAGS.CAPS | C.FLAGS.TEXT | C.FLAGS.REQUEST | C.FLAGS.NOTIFY | C.FLAGS.PROVIDE, Buffer.from([0, 0, 0x10, 0]));
          continue;
        }
        if (buf[0] === 6) { // ClientCutText
          if (buf.length < 8) return; const len = buf.readInt32BE(4); const abs = Math.abs(len); if (buf.length < 8 + abs) return;
          const m = buf.subarray(8, 8 + abs); buf = buf.subarray(8 + abs);
          srv.got.push(len >= 0 ? { legacy: m.toString('latin1') } : { flags: m.readUInt32BE(0) >>> 0, body: m.subarray(4) });
          continue;
        }
        throw new Error(`fake: unexpected ${buf[0]}`);
      }
    });
  });
  srv.send = (flags, body = Buffer.alloc(0)) => { const h = Buffer.alloc(12); h[0] = 3; h.writeInt32BE(-(4 + body.length), 4); h.writeUInt32BE(flags >>> 0, 8); srv.sock.write(Buffer.concat([h, body])); };
  srv.sendLegacy = (text) => { const t = Buffer.from(text, 'latin1'); const h = Buffer.alloc(8); h[0] = 3; h.writeUInt32BE(t.length, 4); srv.sock.write(Buffer.concat([h, t])); };
  srv.listen = () => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
  srv.close = () => new Promise((res) => { if (srv.sock) srv.sock.destroy(); server.close(() => res()); });
  return srv;
}

test('clipboard: handshake, guest → PC (notify → request → provide) with umlauts', async () => {
  const q = fakeQemu();
  const c = new C.GuestClipboard({ port: await q.listen() });
  try {
    await c.connect();
    assert.equal(c.ready, true); assert.equal(c.extended, true);
    assert.ok(q.encodings.includes(C.EXT_CLIP));
    // our capabilities came right after SetEncodings
    await until(() => q.got.find((m) => m.flags & C.FLAGS.CAPS));
    // the guest copies: QEMU notifies, we ask, QEMU provides
    q.send(C.FLAGS.NOTIFY | C.FLAGS.TEXT);
    await until(() => q.got.find((m) => m.flags === ((C.FLAGS.REQUEST | C.FLAGS.TEXT) >>> 0)));
    q.send(C.FLAGS.PROVIDE | C.FLAGS.TEXT, C.providePayload('Grüße aus der VM – ÄÖÜ ß €'));
    await until(() => c.seq === 1);
    assert.equal(c.state().text, 'Grüße aus der VM – ÄÖÜ ß €');
    assert.ok(c.state().at > 0);
  } finally { c.close(); await q.close(); }
});

test('clipboard: PC → guest – announced at once, handed over when the guest pastes', async () => {
  const q = fakeQemu();
  const c = new C.GuestClipboard({ port: await q.listen() });
  try {
    await c.connect();
    c.offer('Vom PC: Straße €');
    await until(() => q.got.find((m) => m.flags === ((C.FLAGS.NOTIFY | C.FLAGS.TEXT) >>> 0)));
    q.send(C.FLAGS.REQUEST | C.FLAGS.TEXT); // the guest pastes
    const p = await until(() => q.got.find((m) => m.flags === ((C.FLAGS.PROVIDE | C.FLAGS.TEXT) >>> 0)));
    assert.equal(C.readProvide(p.body), 'Vom PC: Straße €');
    // the raw payload is length + UTF-8 + NUL, as QEMU expects
    const raw = zlib.inflateSync(p.body);
    assert.equal(raw.readUInt32BE(0), raw.length - 4);
    assert.equal(raw[raw.length - 1], 0);
    assert.throws(() => c.offer('x'.repeat(C.MAX_TEXT + 1)), /1 MB/);
  } finally { c.close(); await q.close(); }
});

test('clipboard: old VNC server without the extended clipboard → classic cut text both ways', async () => {
  const q = fakeQemu({ ext: false });
  const c = new C.GuestClipboard({ port: await q.listen() });
  try {
    await c.connect();
    assert.equal(c.extended, false);
    c.offer('café ✓');
    const m = await until(() => q.got.find((x) => x.legacy != null));
    assert.equal(m.legacy, 'café ?'); // Latin-1 only
    q.sendLegacy('from guest');
    await until(() => c.seq === 1);
    assert.equal(c.text, 'from guest');
  } finally { c.close(); await q.close(); }
});

test('clipboard: reconnects after the server dropped, refuses when nobody listens', async () => {
  const q = fakeQemu();
  const port = await q.listen();
  const c = new C.GuestClipboard({ port, timeout: 1500 });
  try {
    await c.connect();
    q.sock.destroy();
    await until(() => !c.ready);
    assert.throws(() => c.offer('x'), /not connected/);
    await c.connect(); // the same QEMU still listens
    assert.equal(c.ready, true);
  } finally { c.close(); await q.close(); }
  const dead = new C.GuestClipboard({ port, timeout: 1500 });
  await assert.rejects(() => dead.connect());
  dead.close();
  await assert.rejects(() => dead.connect(), /closed/);
});
