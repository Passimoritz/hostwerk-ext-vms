'use strict';
/*
 * VNC bridge (server/vnc.js) against a fake VNC server on a real TCP socket and a plain http server.
 * No QEMU needed.   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { attachVncProxy, vncArgs, pickVncPort, matchPath, loadWs } = require('../server/vnc');

const WebSocket = loadWs();
const RFB = 'RFB 003.008\n';
const TOKEN = 'secret-token';

/** Fake VNC server: greets like QEMU, echoes everything back, remembers its sockets. */
async function fakeVnc() {
  const socks = new Set();
  const got = [];
  const srv = net.createServer((s) => {
    socks.add(s);
    s.on('close', () => socks.delete(s));
    s.on('error', () => {});
    s.write(RFB);
    s.on('data', (d) => { got.push(d); s.write(d); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, socks, got, close: () => new Promise((r) => { for (const s of socks) s.destroy(); srv.close(r); }) };
}

async function setup({ ports = {}, maxPerVm } = {}) {
  const vnc = await fakeVnc();
  const server = http.createServer((req, res) => res.end('ok'));
  const asked = [];
  const proxy = attachVncProxy({
    server,
    authCheck: (req) => req.headers['x-hostwerk-token'] === TOKEN,
    resolvePort: async (id) => { asked.push(id); return id in ports ? ports[id] : (id === 'alpha' ? vnc.port : null); },
    maxPerVm,
    pingInterval: 0,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `ws://127.0.0.1:${server.address().port}`;
  const open = (p, headers = { 'x-hostwerk-token': TOKEN }) => new WebSocket(`${base}${p}`, ['binary'], { headers });
  const done = async () => { proxy.close(); await vnc.close(); await new Promise((r) => server.close(r)); };
  return { vnc, server, proxy, open, asked, done };
}

/** Resolves with the HTTP status of a rejected upgrade (or 'open' if it was accepted). */
const outcome = (ws) => new Promise((resolve) => {
  ws.on('unexpected-response', (req, res) => { resolve(res.statusCode); req.destroy(); });
  ws.on('open', () => { resolve('open'); ws.close(); });
  ws.on('error', (e) => resolve(`error:${e.message}`));
});
const nextMessage = (ws) => new Promise((resolve) => ws.once('message', (d, bin) => resolve({ d: Buffer.from(d), bin })));
const waitClose = (ws) => new Promise((resolve) => (ws.readyState === 3 ? resolve() : ws.once('close', (code) => resolve(code))));

test('bytes flow both ways with subprotocol "binary"', async () => {
  const t = await setup();
  try {
    const ws = t.open('/ws/vms/alpha/vnc');
    const first = nextMessage(ws);
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    assert.strictEqual(ws.protocol, 'binary');
    const greet = await first;
    assert.strictEqual(greet.d.toString(), RFB);
    assert.strictEqual(greet.bin, true);
    const payload = Buffer.from([0x52, 0x46, 0x42, 0x00, 0xff, 0x10, 0x01]);
    const echo = nextMessage(ws);
    ws.send(payload);
    assert.deepStrictEqual((await echo).d, payload);
    assert.deepStrictEqual(Buffer.concat(t.vnc.got), payload);
    assert.strictEqual(t.proxy.count('alpha'), 1);
    ws.close();
    await waitClose(ws);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(t.vnc.socks.size, 0, 'TCP side closed after the browser left');
    assert.strictEqual(t.proxy.count('alpha'), 0);
  } finally { await t.done(); }
});

test('/api/vms/<id>/vnc works on a plain server too', async () => {
  const t = await setup();
  try { assert.strictEqual(await outcome(t.open('/api/vms/alpha/vnc')), 'open'); } finally { await t.done(); }
});

test('unauthenticated upgrade is rejected with 401 and never reaches the VM', async () => {
  const t = await setup();
  try {
    assert.strictEqual(await outcome(t.open('/ws/vms/alpha/vnc', {})), 401);
    assert.strictEqual(await outcome(t.open('/ws/vms/alpha/vnc', { 'x-hostwerk-token': 'wrong' })), 401);
    assert.deepStrictEqual(t.asked, []);
    assert.strictEqual(t.vnc.socks.size, 0);
  } finally { await t.done(); }
});

test('invalid ids are rejected with 400', async () => {
  const t = await setup();
  try {
    for (const id of ['A', 'Alpha', '1abc', 'a', 'a_b', 'a%2Fb', 'a%00b', 'a.b', 'x'.repeat(40)]) {
      assert.strictEqual(await outcome(t.open(`/ws/vms/${id}/vnc`)), 400, id);
    }
    assert.deepStrictEqual(t.asked, []);
  } finally { await t.done(); }
});

test('unknown or stopped VM (resolvePort → null) is rejected with 404', async () => {
  const t = await setup({ ports: { beta: null, gamma: 'nope' } });
  try {
    assert.strictEqual(await outcome(t.open('/ws/vms/zeta/vnc')), 404);
    assert.strictEqual(await outcome(t.open('/ws/vms/beta/vnc')), 404);
    assert.strictEqual(await outcome(t.open('/ws/vms/gamma/vnc')), 404);
    assert.strictEqual(t.proxy.count('zeta'), 0);
  } finally { await t.done(); }
});

test('nothing listening on the VNC port → 502', async () => {
  const spare = net.createServer();
  await new Promise((r) => spare.listen(0, '127.0.0.1', r));
  const dead = spare.address().port;
  await new Promise((r) => spare.close(r));
  const t = await setup({ ports: { delta: dead } });
  try { assert.strictEqual(await outcome(t.open('/ws/vms/delta/vnc')), 502); assert.strictEqual(t.proxy.count('delta'), 0); } finally { await t.done(); }
});

test('other upgrade paths are left alone', async () => {
  const t = await setup();
  try {
    const handled = t.proxy.handle({ url: '/ws/term' }, { on() {} }, Buffer.alloc(0));
    assert.strictEqual(handled, false);
    assert.strictEqual(matchPath('/ws/vms/alpha/vnc?x=1').id, 'alpha');
    assert.strictEqual(matchPath('/ws/vms/alpha/vnc/extra'), null);
    assert.strictEqual(matchPath('/ws/vms/alpha/screen'), null);
  } finally { await t.done(); }
});

test('connection closes when the VNC (TCP) side closes', async () => {
  const t = await setup();
  try {
    const ws = t.open('/ws/vms/alpha/vnc');
    const first = nextMessage(ws);
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    await first;
    const closed = waitClose(ws);
    for (const s of t.vnc.socks) s.destroy();
    const code = await closed;
    assert.ok(code === 1000 || code === 1011, `close code ${code}`);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(t.proxy.count('alpha'), 0);
  } finally { await t.done(); }
});

test('concurrent connections per VM are limited', async () => {
  const t = await setup({ maxPerVm: 2 });
  try {
    const a = t.open('/ws/vms/alpha/vnc');
    const b = t.open('/ws/vms/alpha/vnc');
    await Promise.all([a, b].map((w) => new Promise((r, j) => { w.once('open', r); w.once('error', j); })));
    assert.strictEqual(await outcome(t.open('/ws/vms/alpha/vnc')), 429);
    a.close(); await waitClose(a);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(await outcome(t.open('/ws/vms/alpha/vnc')), 'open');
    b.close(); await waitClose(b);
  } finally { await t.done(); }
});

test('close() ends open connections', async () => {
  const t = await setup();
  try {
    const ws = t.open('/ws/vms/alpha/vnc');
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    const closed = waitClose(ws);
    t.proxy.close();
    assert.strictEqual(await closed, 1001);
  } finally { await t.done(); }
});

test('host mode: registers on host.on("upgrade") and needs no authCheck (core checks login)', () => {
  const hooks = [];
  const host = { on: (ev, fn) => { assert.strictEqual(ev, 'upgrade'); hooks.push(fn); return () => hooks.splice(hooks.indexOf(fn), 1); }, lib: () => WebSocket };
  const p = attachVncProxy({ host, resolvePort: () => null });
  assert.strictEqual(hooks.length, 1);
  assert.strictEqual(hooks[0]({ url: '/ws/m/abc' }, { on() {} }, Buffer.alloc(0)), false);
  p.close();
  assert.strictEqual(hooks.length, 0);
  assert.throws(() => attachVncProxy({ server: http.createServer(), resolvePort: () => null }), /authCheck/);
});

test('vncArgs and pickVncPort', async () => {
  assert.deepStrictEqual(vncArgs(5900), ['-vnc', '127.0.0.1:0,password=off']);
  assert.deepStrictEqual(vncArgs(5913), ['-vnc', '127.0.0.1:13,password=off']);
  assert.throws(() => vncArgs(5899));
  assert.throws(() => vncArgs('x'));
  const p = await pickVncPort(async (start, avoid) => { let q = start; while (avoid.has(q)) q++; return q; }, new Set([5910]));
  assert.strictEqual(p, 5911);
});
