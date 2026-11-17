'use strict';
/*
 * Package 1 of the roadmap: German keyboard, automatic snapshots with retention, guest view (disks, commands, update),
 * disk care (compact, attach a copy), limits (disk throttling, CPU share, priority). No QEMU needed.   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const K = require('../server/keys');
const S = require('../server/spec');
const { buildArgs, throttle } = require('../server/qemu-args');
const { seedFiles } = require('../server/cloudinit');
const { VmManager } = require('../server/manager');
const { Runtime } = require('../server/runtime');

const HOST = { cpus: 8, memoryMb: 16384 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hw-vms-p1-'));

test('#4 German keyboard: QWERTZ positions, Shift and AltGr; dead keys refused', () => {
  assert.deepEqual(K.textToKeys('zyZY', 'de'), [['y'], ['z'], ['shift', 'y'], ['shift', 'z']]);
  assert.deepEqual(K.textToKeys('@€{}[]\\|~', 'de'), [['alt_r', 'q'], ['alt_r', 'e'], ['alt_r', '7'], ['alt_r', '0'], ['alt_r', '8'], ['alt_r', '9'], ['alt_r', 'minus'], ['alt_r', 'less'], ['alt_r', 'bracket_right']]);
  assert.deepEqual(K.textToKeys('äöüßÄ"/-_:#', 'de'), [['apostrophe'], ['semicolon'], ['bracket_left'], ['minus'], ['shift', 'apostrophe'], ['shift', '2'], ['shift', '7'], ['slash'], ['shift', 'slash'], ['shift', 'dot'], ['backslash']]);
  assert.throws(() => K.textToKeys('^', 'de'), /German keyboard/);
  assert.deepEqual(K.textToKeys('z@', 'us'), [['z'], ['shift', '2']]); // US unchanged
  assert.deepEqual(K.textToKeys('z', 'xx'), [['z']]); // unknown layout → US
  // every character of the German map lands on a real qcode
  const qcodes = new Set(Object.values(K.CODE));
  for (const [ch, [q]] of Object.entries(K.LAYOUTS.de)) assert.ok(qcodes.has(q), `${ch} → ${q}`);
  const vm = S.cleanVm({ name: 'x', keyboard: 'de' }, { host: HOST });
  assert.equal(vm.keyboard, 'de');
  assert.equal(S.cleanVm({ name: 'x', keyboard: 'fr' }, { host: HOST }).keyboard, 'us');
  // not cloud-init's "keyboard" module (fails on Debian's cloud image): settings file + console-setup/localectl, each may fail
  const de = seedFiles({ hostname: 'x', user: 'u1', password: 'secret1', keyboard: 'de' })['user-data'];
  assert.doesNotMatch(de, /^keyboard:/m);
  assert.match(de, /path: "\/etc\/default\/keyboard"/);
  assert.match(de, /XKBLAYOUT=\\"de\\"/);
  assert.match(de, /setupcon --force/); assert.match(de, /localectl set-keymap de/);
  assert.ok(de.split('\n').filter((l) => l.includes('"sh", "-c"')).every((l) => /; true"\]$/.test(l)));
  assert.doesNotMatch(seedFiles({ hostname: 'x', user: 'u1', password: 'secret1' })['user-data'], /keyboard/);
  // the user-data stays valid YAML for cloud-init: the content line is one JSON string
  const content = de.match(/content: (".*")/)[1];
  assert.equal(JSON.parse(content), 'XKBMODEL="pc105"\nXKBLAYOUT="de"\nXKBVARIANT=""\nXKBOPTIONS=""\nBACKSPACE="guess"\n');
});

test('#8/#17 spec: automatic snapshots and limits are checked', () => {
  assert.deepEqual(S.cleanAutoSnap({ every: 'hourly', keep: 24 }), { every: 'hourly', keep: 24, beforeUpdate: true, last: null });
  assert.equal(S.cleanAutoSnap({ every: 'yearly' }).every, 'off');
  assert.throws(() => S.cleanAutoSnap({ every: 'daily', keep: 0 }), /Keep between/);
  assert.equal(S.cleanAutoSnap({ every: 'daily', keep: 5 }, { last: 123 }).last, 123); // the time of the last one stays
  assert.deepEqual(S.cleanLimits({}), { iops: 0, mbps: 0, cpuShare: 100, priority: 'normal' });
  assert.deepEqual(S.cleanLimits({ iops: 500, mbps: 50, cpuShare: 50, priority: 'low' }), { iops: 500, mbps: 50, cpuShare: 50, priority: 'low' });
  for (const bad of [{ iops: 10 }, { mbps: -1 }, { cpuShare: 5 }, { cpuShare: 120 }]) assert.throws(() => S.cleanLimits(bad));
  assert.equal(S.cleanLimits({ priority: 'realtime' }).priority, 'normal');
  assert.equal(S.affinityMask(50, 16), 0xffn); // 8 of 16 cores
  assert.equal(S.affinityMask(10, 4), 1n); // at least one core
  assert.equal(S.affinityMask(100, 16), null); // no limit
  const vm = { ...S.cleanVm({ name: 'L', id: 'l', disks: [{ id: 'disk0', file: 'disk0.qcow2' }], limits: { iops: 300, mbps: 20 } }, { host: HOST }), id: 'l' };
  const drive = buildArgs(vm, { dir: '/v', ports: { qmp: 1 } }).find((a) => a.startsWith('if=none,id=disk0'));
  assert.ok(drive.endsWith(',throttling.iops-total=300,throttling.bps-total=20971520'), drive);
  assert.equal(throttle({ iops: 0, mbps: 0 }), '');
});

/* ---------------- manager with fakes (like tests/manager.test.js) ---------------- */
function fakeQhost() {
  const rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const wr = (f, d) => fs.writeFileSync(f, JSON.stringify(d));
  const calls = [];
  return {
    calls,
    info: async () => ({ installed: true, accel: 'whpx', accelArgs: ['tcg'], ramSnapshots: false, firmware: null }),
    create: async (f, bytes) => { wr(f, { size: bytes, snaps: [], pad: 'x'.repeat(4000) }); },
    convert: async (src, dest) => { calls.push(['convert', path.basename(src), path.basename(dest)]); let d; try { d = rd(src); } catch { d = { size: 1 }; } wr(dest, { ...d, snaps: [], pad: '' }); },
    resize: async () => {},
    diskInfo: async (f) => ({ format: 'qcow2', virtualSize: rd(f).size, actualSize: 1, backing: null, snapshots: [] }),
    snapshot: async (f, action, name) => { calls.push(['snapshot', action, name]); const d = rd(f); if (action === 'create') d.snaps.push(name); if (action === 'delete') d.snaps = d.snaps.filter((s) => s !== name); wr(f, d); },
  };
}
function make() {
  const root = tmp();
  const qhost = fakeQhost();
  const runJob = (title, fn) => { const job = { id: crypto.randomUUID(), lines: [], progress() {}, status(t) { this.lines.push(t); }, log(l) { this.lines.push(l); } }; job.promise = Promise.resolve().then(() => fn(job)); return job; };
  const notes = [];
  const m = new VmManager({ root, qhost, Proc: class {}, runJob, downloadFile: async () => {}, fetchText: async () => '', broadcast: () => {}, host: HOST });
  m.onNotify = (kind, text) => notes.push([kind, text]);
  return { m, root, qhost, notes };
}
const running = (m, id, extra = {}) => {
  const calls = [];
  const rt = { vm: m.get(id), calls, agentInfo: { ok: true, osId: 'debian', os: 'Debian GNU/Linux 12' }, isRunning: () => true, status: () => ({ state: 'running' }),
    liveSnapshot: async (n) => { calls.push(['live', n]); return { ram: false, frozen: true }; }, liveSnapshotDelete: async (n) => calls.push(['liveDel', n]),
    guestExec: async (c, o) => { calls.push(['exec', c, o && o.timeout]); return { code: 0, out: 'Reading package lists...\n0 upgraded', err: '', timedOut: false }; },
    guestFs: async () => [{ mount: '/', type: 'ext4', used: 9, total: 10, pct: 90 }], applyLimits: async () => calls.push(['limits']), forwardAdd: async () => {}, forwardRemove: async () => {}, ...extra };
  m.runtimes.set(id, rt);
  return rt;
};

test('#8 automatic snapshots: due ones are taken, the newest N kept, hand-made ones never touched', async () => {
  const { m } = make();
  await m.create({ source: 'empty', name: 'auto', diskGb: 1 }).promise;
  await m.takeSnapshot('auto', { name: 'manual' });
  await m.update('auto', { autoSnap: { every: 'hourly', keep: 2 } });
  running(m, 'auto');
  let t = Date.UTC(2026, 10, 16, 10, 0, 0);
  assert.deepEqual(await m.autoSnapTick(t), ['auto']);
  assert.deepEqual(await m.autoSnapTick(t + 30 * 60000), []); // not due yet
  for (let i = 1; i <= 3; i++) { t += 3600e3; await m.autoSnapTick(t); }
  const snaps = Object.entries(m.get('auto').snapshots);
  assert.equal(snaps.filter(([, s]) => s.auto).length, 2);
  assert.ok(m.get('auto').snapshots.manual && !m.get('auto').snapshots.manual.auto);
  assert.deepEqual(Object.keys(m.get('auto').snapshots).filter((n) => n.startsWith('auto-')).sort(), ['auto-20261116-120000', 'auto-20261116-130000']);
  // stopped and not started again since the last one → nothing new
  m.runtimes.delete('auto');
  assert.deepEqual(await m.autoSnapTick(t + 2 * 3600e3), []);
  // off → nothing
  await m.update('auto', { autoSnap: { every: 'off' } });
  running(m, 'auto');
  assert.deepEqual(await m.autoSnapTick(t + 9 * 3600e3), []);
});

test('#11 guest view: update with a snapshot first, the right command per system, refusals', async () => {
  const { m } = make();
  await m.create({ source: 'empty', name: 'guest', diskGb: 1 }).promise;
  assert.throws(() => m.guestUpdate('guest'), /not running/);
  const rt = running(m, 'guest');
  const r = await m.guestUpdate('guest').promise;
  assert.equal(r.code, 0);
  assert.equal(rt.calls[0][0], 'live'); assert.match(rt.calls[0][1], /^pre-update-/);
  assert.match(rt.calls[1][1], /^export DEBIAN_FRONTEND=noninteractive; apt-get update/);
  assert.equal(m.get('guest').snapshots[rt.calls[0][1]].auto, true);
  assert.equal(m.updateCommand('fedora'), 'dnf -y upgrade --refresh'); assert.equal(m.updateCommand('alpine'), 'apk update && apk upgrade'); assert.equal(m.updateCommand('mswindows'), null);
  rt.agentInfo = { ok: true, osId: 'mswindows', os: 'Windows 11' };
  assert.throws(() => m.guestUpdate('guest'), /does not know how to update/);
  rt.agentInfo = { ok: false };
  assert.throws(() => m.guestUpdate('guest'), /guest agent/);
  rt.agentInfo = { ok: true, osId: 'ubuntu' };
  rt.guestExec = async () => ({ code: 100, out: 'E: broken', err: '', timedOut: false });
  await assert.rejects(m.guestUpdate('guest').promise, /code 100/);
  assert.deepEqual(await m.guestFs('guest'), [{ mount: '/', type: 'ext4', used: 9, total: 10, pct: 90 }]);
  assert.equal((await m.guestExec('guest', 'uname -a')).code, 100);
});

test('#10 disk care: compact rewrites the disk, attach copies an image; unsafe cases refused', async () => {
  const { m, root, qhost } = make();
  await m.create({ source: 'empty', name: 'care', diskGb: 1 }).promise;
  const r = await m.compactDisk('care', 'disk0').promise;
  assert.ok(r.before > r.after && r.saved === r.before - r.after, JSON.stringify(r));
  assert.ok(!fs.existsSync(path.join(root, 'care', 'disk0.qcow2.compact')));
  await m.takeSnapshot('care', { name: 's1' });
  assert.throws(() => m.compactDisk('care', 'disk0'), /Delete the snapshots/);
  await m.deleteSnapshot('care', 's1');
  const img = path.join(tmp(), 'data.vmdk'); fs.writeFileSync(img, 'vmdk');
  await m.attachDisk('care', { file: img, bus: 'sata' }).promise;
  assert.deepEqual(m.get('care').disks.map((k) => [k.id, k.bus]), [['disk0', 'virtio'], ['disk1', 'sata']]);
  assert.ok(qhost.calls.some((c) => c[0] === 'convert' && c[1] === 'data.vmdk' && c[2] === 'disk1.qcow2'));
  assert.ok(fs.existsSync(img)); // original untouched
  assert.throws(() => m.attachDisk('care', { file: path.join(root, 'care', 'disk0.qcow2') }), /belongs to a Hostwerk VM/);
  assert.throws(() => m.attachDisk('care', { file: 'C:\\nope.vdi' }), /not found/);
  running(m, 'care');
  assert.throws(() => m.compactDisk('care', 'disk0'), /Shut the VM down first/);
});

test('#17 limits: changed while running are applied live; runtime throttles every disk and sets CPU share/priority', async () => {
  const { m } = make();
  await m.create({ source: 'empty', name: 'lim', diskGb: 1 }).promise;
  const rt = running(m, 'lim');
  await m.update('lim', { limits: { iops: 200, mbps: 10, cpuShare: 50, priority: 'low' } });
  assert.deepEqual(rt.calls, [['limits']]);
  assert.equal(m.get('lim').limits.cpuShare, 50);
  // the real runtime: QMP block_set_io_throttle per disk, PowerShell/renice on the process
  const qmpCalls = [];
  const runs = [];
  const vm = { ...m.get('lim'), disks: [{ id: 'disk0', file: 'a', format: 'qcow2', bus: 'virtio' }, { id: 'disk1', file: 'b', format: 'qcow2', bus: 'virtio' }] };
  const r = new Runtime(vm, { qhost: {}, Proc: class {}, dir: tmp(), runFn: async (cmd, args) => { runs.push([cmd, args]); return { code: 0, stdout: '', stderr: '' }; } });
  r.qmp = { exec: async (c, a) => { qmpCalls.push([c, a]); return {}; } };
  r.proc = { pid: 4242 };
  await r.applyLimits();
  assert.deepEqual(qmpCalls.map(([c, a]) => [c, a.device, a.iops, a.bps]), [['block_set_io_throttle', 'disk0', 200, 10485760], ['block_set_io_throttle', 'disk1', 200, 10485760]]);
  if (process.platform === 'win32') {
    assert.equal(runs[0][0], 'powershell.exe');
    const ps = runs[0][1].join(' ');
    assert.match(ps, /Get-Process -Id 4242/); assert.match(ps, /PriorityClass = 'BelowNormal'/);
    const mask = S.affinityMask(50, os.cpus().length);
    if (mask) assert.match(ps, new RegExp(`ProcessorAffinity = \\[IntPtr\\]${mask}`));
  } else assert.deepEqual(runs[0], ['renice', ['-n', '10', '-p', '4242']]);
});

test('#11 runtime: guest commands through the agent (exec + status), file systems without pseudo ones', async () => {
  // a guest agent that understands sync, guest-exec, guest-exec-status and guest-get-fsinfo
  let polls = 0;
  const server = net.createServer((s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString('latin1').replace(/\xff/g, '');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        const send = (r) => s.write(`${JSON.stringify({ return: r })}\n`);
        if (m.execute === 'guest-sync-delimited') { s.write(Buffer.from([0xff])); send(m.arguments.id); } else if (m.execute === 'guest-exec') { assert.deepEqual(m.arguments, { path: '/bin/sh', arg: ['-c', 'echo hi'], 'capture-output': true }); send({ pid: 77 }); } else if (m.execute === 'guest-exec-status') { polls++; send(polls < 2 ? { exited: false } : { exited: true, exitcode: 0, 'out-data': Buffer.from('hi\n').toString('base64') }); } else if (m.execute === 'guest-get-fsinfo') send([{ name: 'vda1', mountpoint: '/', type: 'ext4', 'used-bytes': 900, 'total-bytes': 1000 }, { name: 'tmpfs', mountpoint: '/run', type: 'tmpfs', 'used-bytes': 1, 'total-bytes': 10 }, { name: 'vda15', mountpoint: '/boot/efi', type: 'vfat', 'used-bytes': 5, 'total-bytes': 100 }]);
      }
    });
    s.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const r = new Runtime({ id: 'g', name: 'g', osType: 'linux', disks: [] }, { qhost: {}, Proc: class {}, dir: tmp() });
  r.ports = { qga: server.address().port };
  assert.deepEqual(await r.guestExec('echo hi'), { code: 0, out: 'hi\n', err: '', timedOut: false });
  assert.deepEqual(await r.guestFs(), [{ mount: '/', type: 'ext4', used: 900, total: 1000, pct: 90 }, { mount: '/boot/efi', type: 'vfat', used: 5, total: 100, pct: 5 }]);
  await assert.rejects(r.guestExec(''), /Command/);
  server.close();
});
