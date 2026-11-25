'use strict';
/*
 * QMP client, guest agent client and the VM runtime against fake QEMU endpoints on real TCP sockets: the fake process
 * reads the generated command line, opens a QMP server on exactly that port and answers like QEMU 11 does.
 * No QEMU needed.   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Qmp, agent, addressesFrom } = require('../server/qmp');
const { Runtime } = require('../server/runtime');
const S = require('../server/spec');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hw-vms-r-'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4510000000049454e44ae426082', 'hex');

/** A QMP server that behaves like QEMU: greeting, capabilities, ids, errors, events. */
function fakeQmp(port, log = []) {
  const state = { running: true, socks: new Set(), fwds: new Set() };
  const server = net.createServer((s) => {
    state.socks.add(s);
    s.write(`${JSON.stringify({ QMP: { version: { qemu: { major: 11, minor: 1, micro: 0 } }, capabilities: [] } })}\r\n`);
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        log.push(m);
        const ok = (r = {}) => s.write(`${JSON.stringify({ return: r, id: m.id })}\r\n`);
        const err = (desc) => s.write(`${JSON.stringify({ error: { class: 'GenericError', desc }, id: m.id })}\r\n`);
        const a = m.arguments || {};
        switch (m.execute) {
          case 'qmp_capabilities': ok(); break;
          case 'query-status': ok({ status: state.running ? 'running' : 'paused', running: state.running }); break;
          case 'stop': state.running = false; ok(); s.write(`${JSON.stringify({ event: 'STOP', timestamp: {} })}\r\n`); break;
          case 'cont': state.running = true; ok(); s.write(`${JSON.stringify({ event: 'RESUME', timestamp: {} })}\r\n`); break;
          case 'screendump': fs.writeFileSync(a.filename, PNG); ok(); break;
          case 'input-send-event': case 'send-key': case 'system_reset': case 'eject': case 'blockdev-change-medium': ok(); break;
          case 'blockdev-snapshot-internal-sync': if (a.device === 'missing') err(`Device '${a.device}' not found`); else ok(); break;
          case 'human-monitor-command': {
            const c = a['command-line'];
            if (/^hostfwd_add n0 (\S+)$/.test(c)) { state.fwds.add(c.split(' ')[2]); ok(''); } else if (/^hostfwd_remove/.test(c)) ok('host forwarding rule for x removed\r\n');
            else if (/^savevm/.test(c)) ok('Error: State blocked due to missing dirty memory tracking support\r\n'); else ok('');
            break;
          }
          case 'system_powerdown': ok(); s.write(`${JSON.stringify({ event: 'POWERDOWN', timestamp: {} })}\r\n`); setTimeout(() => state.onPowerdown && state.onPowerdown(), 30); break;
          case 'quit': ok(); setTimeout(() => state.onPowerdown && state.onPowerdown(), 10); break;
          default: err(`The command ${m.execute} has not been found`);
        }
      }
    });
    s.on('error', () => {});
    s.on('close', () => state.socks.delete(s));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, state, log, close: () => { for (const s of state.socks) s.destroy(); server.close(); } })));
}

/** A guest agent that understands guest-sync-delimited (0xff prefix). */
function fakeAgent(port, { silent = false } = {}) {
  const server = net.createServer((s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString('latin1').replace(/\xff/g, '');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (silent) continue;
        const send = (r) => s.write(`${JSON.stringify({ return: r })}\n`);
        if (m.execute === 'guest-sync-delimited') { s.write(Buffer.from([0xff])); send(m.arguments.id); } else if (m.execute === 'guest-ping') send({});
        else if (m.execute === 'guest-network-get-interfaces') send([{ name: 'lo', 'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4', prefix: 8 }] }, { name: 'eth0', 'ip-addresses': [{ 'ip-address': '10.0.2.15', 'ip-address-type': 'ipv4', prefix: 24 }, { 'ip-address': 'fe80::1', 'ip-address-type': 'ipv6', prefix: 64 }] }]);
        else if (m.execute === 'guest-get-osinfo') send({ 'pretty-name': 'Debian GNU/Linux 12 (bookworm)', 'kernel-release': '6.1.0-30-cloud-amd64' });
        else if (m.execute === 'guest-get-host-name') send({ 'host-name': 'deb' });
        else if (m.execute === 'guest-fsfreeze-freeze') send(2);
        else if (m.execute === 'guest-fsfreeze-thaw') send(2);
        else s.write(`${JSON.stringify({ error: { class: 'CommandNotFound', desc: 'nope' } })}\n`);
      }
    });
    s.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('qmp: connects even if QEMU is still starting, matches answers by id, errors and events', async () => {
  const port = await freePort();
  const q = new Qmp({ port });
  const connecting = q.connect(5000);
  await new Promise((r) => setTimeout(r, 400)); // QEMU opens the socket a moment later
  const srv = await fakeQmp(port);
  await connecting;
  const [a, b] = await Promise.all([q.exec('query-status'), q.exec('query-status')]);
  assert.deepEqual(a, { status: 'running', running: true }); assert.deepEqual(b, a);
  await assert.rejects(q.exec('nope'), (e) => e.qmpClass === 'GenericError' && /not been found/.test(e.message));
  const ev = new Promise((r) => q.once('event', r));
  await q.exec('stop');
  assert.equal((await ev).event, 'STOP');
  await assert.rejects(q.hmp('savevm x'), /dirty memory/);
  assert.equal(await q.hmp('hostfwd_add n0 tcp:127.0.0.1:1-:2'), '');
  q.close(); srv.close();
  await assert.rejects(q.exec('query-status'), /not connected/);
});

test('qmp: QEMU quitting abruptly (connection reset) is no unhandled error', async () => {
  const port = await freePort();
  const srv = await fakeQmp(port);
  const q = new Qmp({ port });
  await q.connect(3000);
  const closed = new Promise((r) => q.once('close', r));
  const pending = q.exec('query-status', null, 2000).catch((e) => e);
  for (const s of srv.state.socks) s.resetAndDestroy(); // TCP RST like a killed process → ECONNRESET on our side
  await closed;
  const e = await pending;
  assert.ok(e instanceof Error || (e && e.status === undefined));
  srv.close();
});

test('guest agent: sync, call, addresses; silence becomes a clear error', async () => {
  const port = await freePort();
  const srv = await fakeAgent(port);
  await agent({ port }, 'guest-ping');
  const ifs = await agent({ port }, 'guest-network-get-interfaces');
  assert.deepEqual(addressesFrom(ifs), [{ iface: 'eth0', ip: '10.0.2.15', type: 'ipv4', prefix: 24 }]);
  await assert.rejects(agent({ port }, 'guest-exec'), /nope/);
  srv.close();
  const p2 = await freePort();
  const quiet = await fakeAgent(p2, { silent: true });
  await assert.rejects(agent({ port: p2 }, 'guest-ping', null, 400), (e) => e.code === 'NO_AGENT' && e.status === 503);
  quiet.close();
});

/** Hostwerk's ManagedProcess, reduced: start → ready → running; QMP quit/powerdown ends it. */
function makeProc() {
  const registry = new Map();
  class FakeProc extends EventEmitter {
    constructor(id, name) { super(); this.id = id; this.name = name; this.state = 'stopped'; this.child = null; this.logs = []; registry.set(id, this); }
    isRunning() { return !!this.child; }
    info() { return { state: this.state, pid: this.child ? 4242 : null, startedAt: this.startedAt || null, error: null, stats: { cpu: 3, memory: 1e9 } }; }
    log(l) { this.logs.push(l); }
    async start({ args, ready }) {
      this.args = args;
      const port = Number(args[args.indexOf('-qmp') + 1].match(/:(\d+),/)[1]);
      this.qmp = await fakeQmp(port);
      this.qmp.state.onPowerdown = () => this.exit();
      const qga = args.find((a) => /^socket,id=qga0/.test(a));
      if (qga && this.withAgent) this.agentSrv = await fakeAgent(Number(qga.match(/port=(\d+)/)[1]));
      this.child = {}; this.state = 'starting'; this.startedAt = Date.now();
      this.exited = new Promise((r) => { this.resolveExit = r; });
      await ready();
      this.state = 'running';
    }
    exit() { if (!this.child) return; this.child = null; this.state = 'stopped'; this.qmp.close(); if (this.agentSrv) this.agentSrv.close(); this.resolveExit(); if (this.onExit) this.onExit({}); }
    async stop({ graceful, timeout = 15000 } = {}) {
      if (!this.child) return;
      this.state = 'stopping';
      if (graceful) await graceful();
      const done = await Promise.race([this.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), timeout))]);
      if (!done) this.exit();
    }
  }
  return { FakeProc, registry };
}

test('runtime: start, screen, input, live forwards, CD, disk snapshots with frozen file system, pause, shutdown', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'disk0.qcow2'), 'x');
  fs.writeFileSync(path.join(dir, 'disk1.qcow2'), 'x');
  const vm = { ...S.cleanVm({ name: 'Deb', id: 'deb', disks: [{ id: 'disk0', file: 'disk0.qcow2' }, { id: 'disk1', file: 'disk1.qcow2' }], net: { forwards: [{ proto: 'tcp', host: 46222, guest: 22 }] } }, { host: { cpus: 8, memoryMb: 16384 } }), id: 'deb' };
  const qhost = { info: async () => ({ installed: true, system: 'qemu-system-x86_64', accel: 'whpx', accelArgs: ['whpx,kernel-irqchip=off', 'tcg'], firmware: null }) };
  const { FakeProc, registry } = makeProc();
  FakeProc.prototype.withAgent = true;
  const changes = [];
  const rt = new Runtime(vm, { qhost, Proc: FakeProc, registry, dir, onChange: (w) => changes.push(w), portBase: 47900 });
  const st = await rt.start();
  assert.equal(st.state, 'running'); assert.equal(st.accel, 'whpx');
  const proc = registry.get('vm-deb');
  assert.ok(proc.args.includes('-qmp'));
  assert.equal(typeof proc.stopFn, 'function'); // Hostwerk quits → clean shutdown
  // screen: PNG with a stable ETag
  const s1 = await rt.screen();
  assert.ok(s1.png.equals(PNG)); assert.match(s1.etag, /^[0-9a-f]{16}$/);
  assert.equal((await rt.screen()).etag, s1.etag);
  assert.equal(await rt.input([{ t: 'm', x: 0.1, y: 0.2 }, { t: 'b', b: 'left', d: true }, { t: 'k', c: 'KeyA', d: true }, { t: 'm', x: 0.3, y: 0.3 }]), 6);
  // one call, no device id (naming the tablet fails without a window: "not bound to a QemuConsole"), order kept
  const inputs = proc.qmp.log.filter((m) => m.execute === 'input-send-event').map((m) => [m.arguments.device || null, m.arguments.events.map((e) => e.type).join(',')]);
  assert.deepEqual(inputs, [[null, 'abs,abs,btn,key,abs,abs']]);
  await rt.combo('ctrl-alt-del');
  await assert.rejects(rt.combo('rm-rf'), /Unknown key combination/);
  await rt.typeText('ls\n');
  const sends = proc.qmp.log.filter((m) => m.execute === 'send-key').map((m) => m.arguments.keys.map((k) => k.data));
  assert.deepEqual(sends, [['ctrl', 'alt', 'delete'], ['l'], ['s'], ['ret']]);
  await rt.forwardAdd({ proto: 'tcp', host: 48080, guest: 80, bind: 'local' });
  assert.ok(proc.qmp.state.fwds.has('tcp:127.0.0.1:48080-:80'));
  await rt.changeCd('C:\\ISO\\alpine.iso');
  await rt.changeCd(null);
  // the agent becomes visible
  await rt.pollAgent();
  assert.equal(rt.agentInfo.ok, true); assert.equal(rt.agentInfo.os, 'Debian GNU/Linux 12 (bookworm)'); assert.deepEqual(rt.agentInfo.addresses.map((a) => a.ip), ['10.0.2.15']);
  // live disk snapshot: every qcow2 disk, frozen by the agent
  const snap = await rt.liveSnapshot('s1');
  assert.deepEqual(snap, { ram: false, frozen: true });
  assert.deepEqual(proc.qmp.log.filter((m) => m.execute === 'blockdev-snapshot-internal-sync').map((m) => m.arguments), [{ device: 'disk0', name: 's1' }, { device: 'disk1', name: 's1' }]);
  await assert.rejects(rt.liveSnapshot('s2', { ram: true }), /dirty memory/);
  await rt.pause();
  assert.equal(rt.status().state, 'paused');
  await rt.resume();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(rt.status().state, 'running');
  // serial console text arrives in order and can be read from a position
  rt.appendSerial('Debian login: '); const pos = rt.serial.seq; rt.appendSerial('again');
  assert.deepEqual(rt.serialSince(pos), { seq: pos + 5, text: 'again', reset: false });
  // clean shutdown: ACPI power button, then the process ends
  await rt.shutdown({ timeout: 3000 });
  assert.ok(proc.qmp.log.some((m) => m.execute === 'system_powerdown'));
  assert.equal(rt.status().state, 'stopped');
  assert.ok(changes.includes('started') && changes.includes('stopped'));
  await assert.rejects(rt.screen(), /not running/);
});

test('runtime: refuses to start with a busy forwarded port or a missing disk', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'disk0.qcow2'), 'x');
  const blocker = net.createServer().listen(46333, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const qhost = { info: async () => ({ installed: true, system: 'q', accel: 'tcg', accelArgs: ['tcg'] }) };
  const { FakeProc, registry } = makeProc();
  const vm = { ...S.cleanVm({ name: 'A', id: 'a', disks: [{ id: 'disk0', file: 'disk0.qcow2' }], net: { forwards: [{ proto: 'tcp', host: 46333, guest: 22, label: 'SSH' }] } }, { host: { cpus: 8, memoryMb: 16384 } }), id: 'a' };
  await assert.rejects(new Runtime(vm, { qhost, Proc: FakeProc, registry, dir }).start(), (e) => e.status === 409 && /46333/.test(e.message) && /SSH/.test(e.message));
  blocker.close();
  const vm2 = { ...vm, disks: [{ id: 'disk0', file: 'gone.qcow2', bus: 'virtio', format: 'qcow2' }], net: { ...vm.net, forwards: [] } };
  await assert.rejects(new Runtime(vm2, { qhost, Proc: FakeProc, registry, dir }).start(), (e) => e.status === 404 && /gone\.qcow2/.test(e.message));
  await assert.rejects(new Runtime(vm2, { qhost: { info: async () => ({ installed: false }) }, Proc: FakeProc, registry, dir }).start(), (e) => e.code === 'NO_QEMU');
});

/* ---------------- 1.0.3: an update of the extension does not stop running VMs ---------------- */
const keepVm = (id, extra = {}) => ({ ...S.cleanVm({ name: id, id, disks: [{ id: 'disk0', file: 'disk0.qcow2' }], net: { forwards: [] }, ...extra }, { host: { cpus: 8, memoryMb: 16384 } }), id });
const keepHost = { info: async () => ({ installed: true, system: 'qemu-system-x86_64', accel: 'whpx', accelArgs: ['whpx', 'tcg'], firmware: null }) };

test('update: the old instance lets go, QEMU keeps running, the new one takes it over; Hostwerk quitting shuts it down cleanly', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'disk0.qcow2'), 'x');
  const vm = keepVm('keep');
  const { FakeProc, registry } = makeProc();
  const old = new Runtime(vm, { qhost: keepHost, Proc: FakeProc, registry, dir, portBase: 47960 });
  await old.start();
  const proc = registry.get('vm-keep');
  assert.ok(fs.existsSync(path.join(dir, 'run.json')), 'run.json for a later takeover');
  // the extension is updated: the shutdown hook only lets go
  old.detach();
  assert.equal(proc.isRunning(), true, 'QEMU keeps running');
  assert.equal(typeof proc.onExit, 'function'); assert.equal(proc.restartFn, null); assert.equal(old.qmp, null); // onExit of the let-go instance only tidies run.json
  // the new instance of the extension
  const changes = [];
  const neu = new Runtime(vm, { qhost: keepHost, Proc: FakeProc, registry, dir, onChange: (w) => changes.push(w) });
  assert.equal(await neu.adopt(), true);
  assert.equal(neu.status().state, 'running');
  assert.deepEqual(neu.ports, old.ports); assert.equal(neu.status().accel, 'whpx');
  assert.ok(changes.includes('adopted'));
  await neu.pause(); assert.equal(neu.status().state, 'paused');
  await neu.resume(); assert.equal(neu.status().state, 'running');
  assert.equal(await neu.adopt(), false, 'already running in this instance');
  // Hostwerk quits: its process registry calls stopFn – a clean guest shutdown through the new instance
  await proc.stopFn();
  assert.equal(proc.isRunning(), false);
  assert.ok(proc.qmp.log.some((m) => m.execute === 'system_powerdown'));
  assert.ok(!fs.existsSync(path.join(dir, 'run.json')), 'run.json removed when QEMU ended');
  // nothing running → nothing to take over
  assert.equal(await new Runtime(vm, { qhost: keepHost, Proc: FakeProc, registry, dir }).adopt(), false);
});

test('update: "power off when Hostwerk quits" holds even after letting go (QMP is connected again for it)', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'disk0.qcow2'), 'x');
  const { FakeProc, registry } = makeProc();
  const rt = new Runtime(keepVm('hard', { onExit: 'kill' }), { qhost: keepHost, Proc: FakeProc, registry, dir, portBase: 47980 });
  await rt.start();
  const proc = registry.get('vm-hard');
  rt.detach(); // extension switched off, Hostwerk quits afterwards
  await proc.stopFn();
  assert.equal(proc.isRunning(), false);
  assert.ok(proc.qmp.log.some((m) => m.execute === 'quit') && !proc.qmp.log.some((m) => m.execute === 'system_powerdown'));
});

test('internal networks: a new switch opens on the port QEMU still sends to – not while the old one holds it', async () => {
  const { Switches } = require('../server/netswitch');
  const a = new Switches();
  const port = await a.attach('lan', 40001);
  const b = new Switches();
  await assert.rejects(b.attach('lan', 40001, port), /EADDRINUSE|address/i);
  assert.equal(b.info('lan'), null, 'no half-open switch left behind');
  a.closeAll();
  assert.equal(await b.attach('lan', 40001, port), port);
  assert.equal(await b.attach('lan', 40002, port), port, 'a second VM in the same network');
  await assert.rejects(b.attach('lan', 40003, port + 1), /already open/);
  b.closeAll();
});

/* ---------------- 1.2.1: the QEMU exit may be handled before QMP's SHUTDOWN (guest-reset) ---------------- */
/** QEMU ends, the process exit is handled first – only then the socket delivers what QEMU wrote last and closes. */
function exitBeforeEvents(proc, events) {
  proc.child = null; proc.state = 'stopped'; proc.resolveExit(); proc.onExit({});
  for (const s of proc.qmp.state.socks) s.end(events.map((e) => `${JSON.stringify({ ...e, timestamp: {} })}\r\n`).join(''));
  proc.qmp.server.close();
}

test('guest restart: SHUTDOWN (guest-reset) read after the process exit still starts QEMU again', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'disk0.qcow2'), 'x');
  const { FakeProc, registry } = makeProc();
  const changes = [];
  const rt = new Runtime(keepVm('race'), { qhost: keepHost, Proc: FakeProc, registry, dir, onChange: (w) => changes.push(w), portBase: 48100 });
  await rt.start();
  assert.equal(rt.rebootByRestart, true);
  const proc = registry.get('vm-race');
  const first = proc.qmp;
  exitBeforeEvents(proc, [{ event: 'SHUTDOWN', data: { guest: true, reason: 'guest-reset' } }]);
  assert.equal(rt.status().state, 'starting', 'no flicker to "stopped" while QMP is read to the end');
  await rt.restartTask;
  assert.equal(rt.status().state, 'running');
  assert.notEqual(proc.qmp, first, 'a new QEMU was started');
  assert.ok(changes.includes('restarted'));
  await rt.powerOff();
  assert.equal(rt.status().state, 'stopped');
});

test('guest restart: a process exit without SHUTDOWN (guest-reset) leaves the VM stopped', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'disk0.qcow2'), 'x');
  const { FakeProc, registry } = makeProc();
  const rt = new Runtime(keepVm('crash'), { qhost: keepHost, Proc: FakeProc, registry, dir, portBase: 48120 });
  await rt.start();
  const proc = registry.get('vm-crash');
  const first = proc.qmp;
  exitBeforeEvents(proc, []);
  await rt.restartTask;
  assert.equal(rt.status().state, 'stopped');
  assert.equal(proc.qmp, first, 'no new start');
  assert.equal(rt.restarting, false);
  // a normal guest shutdown that QMP reported before the exit: decided at once, no wait
  await rt.start();
  const p2 = registry.get('vm-crash');
  for (const s of p2.qmp.state.socks) s.write(`${JSON.stringify({ event: 'SHUTDOWN', data: { guest: true, reason: 'guest-shutdown' }, timestamp: {} })}\r\n`);
  await new Promise((r) => setTimeout(r, 50));
  p2.exit();
  assert.equal(rt.status().state, 'stopped');
  assert.equal(rt.restartTask, null);
});

test('guest restart: QMP that never closes after the exit – decided after the time limit, VM stopped', async () => {
  const r = new Runtime({ id: 't', name: 't', osType: 'linux', disks: [] }, { qhost: {}, Proc: class {}, dir: tmp() });
  const starts = [];
  r.start = async (o) => { starts.push(o); };
  r.proc = { info: () => ({ state: 'stopped' }), isRunning: () => false, log() {} };
  r.rebootByRestart = true;
  const q = Object.assign(new EventEmitter(), { connected: true, close() { this.connected = false; } });
  r.qmp = q;
  r.onQemuExit();
  assert.equal(r.status().state, 'starting');
  await r.restartTask;
  assert.deepEqual(starts, []);
  assert.equal(r.status().state, 'stopped');
  assert.equal(r.qmp, null);
});

test('ensureQmp: a reconnected QMP also delivers events (guest-reset is noticed)', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'disk0.qcow2'), 'x');
  const { FakeProc, registry } = makeProc();
  const rt = new Runtime(keepVm('reco'), { qhost: keepHost, Proc: FakeProc, registry, dir, portBase: 48140 });
  await rt.start();
  const proc = registry.get('vm-reco');
  rt.qmp.close(); rt.qmp = null; // the connection got lost
  await rt.ensureQmp();
  assert.ok(rt.qmp && rt.qmp.connected);
  await new Promise((r) => setTimeout(r, 50));
  for (const s of proc.qmp.state.socks) if (!s.destroyed) s.write(`${JSON.stringify({ event: 'SHUTDOWN', data: { guest: true, reason: 'guest-reset' }, timestamp: {} })}\r\n`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(rt.restartPending, true);
  rt.restartPending = false; rt.restarting = false;
  await rt.powerOff();
  assert.equal(rt.status().state, 'stopped');
});
