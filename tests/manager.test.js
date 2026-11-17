'use strict';
/*
 * The VM manager end to end with fakes: qemu-img keeps each "disk" as a small JSON file (size, backing file, snapshots),
 * downloads write known bytes whose checksums are published by the fake server, jobs run at once. Running VMs are fake
 * runtimes. Plus the HTTP routes (status codes, ETag, jobs).   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { VmManager } = require('../server/manager');
const { readIso } = require('../server/iso');
const { routes } = require('../server/routes');
const { vmKind } = require('../server/kind');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hw-vms-m-'));
const GB = 2 ** 30;

function fakeQhost({ ramSnapshots = false } = {}) {
  const rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const wr = (f, d) => fs.writeFileSync(f, JSON.stringify(d));
  const calls = [];
  return {
    calls,
    info: async () => ({ installed: true, accel: ramSnapshots ? 'kvm' : 'whpx', accelArgs: ['whpx', 'tcg'], ramSnapshots, version: '11.1.0', firmware: null }),
    create: async (f, bytes, o = {}) => { calls.push(['create', path.basename(f), bytes, o.backing ? path.basename(path.dirname(o.backing)) : null]); wr(f, { size: bytes || (o.backing ? rd(o.backing).size : 0), backing: o.backing || null, snaps: [], data: 'empty' }); },
    convert: async (src, dest, o = {}) => {
      calls.push(['convert', path.basename(src), path.basename(dest), o.to || 'qcow2', !!o.compress]);
      let d; try { d = rd(src); } catch { d = { size: 2 * GB, data: fs.readFileSync(src, 'utf8').slice(0, 40) }; }
      if (o.onProgress) o.onProgress(50);
      wr(dest, { ...d, backing: null, snaps: [] });
    },
    resize: async (f, bytes) => { calls.push(['resize', path.basename(f), bytes]); wr(f, { ...rd(f), size: bytes }); },
    diskInfo: async (f) => { const d = rd(f); return { format: 'qcow2', virtualSize: d.size, actualSize: 1000, backing: d.backing, snapshots: d.snaps.map((name) => ({ name })) }; },
    snapshot: async (f, action, name) => {
      calls.push(['snapshot', path.basename(f), action, name]);
      const d = rd(f);
      if (action === 'create') { d.snaps.push(name); d.saved = { ...(d.saved || {}), [name]: d.data }; }
      if (action === 'apply') { if (!d.snaps.includes(name)) throw new Error("Can't find snapshot"); d.data = d.saved[name]; }
      if (action === 'delete') d.snaps = d.snaps.filter((s) => s !== name);
      wr(f, d);
    },
  };
}
function fakeRunJob() {
  const jobs = [];
  const runJob = (title, fn) => {
    const job = { id: crypto.randomUUID(), title, texts: [], progress(p, t) { if (t) this.texts.push(t); }, status(t) { this.texts.push(t); }, log(l) { this.texts.push(l); } };
    job.promise = Promise.resolve().then(() => fn(job));
    jobs.push(job);
    return job;
  };
  return { runJob, jobs };
}
const IMAGE = Buffer.from('QFI\xfb fake debian cloud image');
function fakeNet({ corrupt = false } = {}) {
  const downloads = [];
  const sha512 = crypto.createHash('sha512').update(IMAGE).digest('hex');
  return {
    downloads,
    fetchText: async (url) => {
      if (url.endsWith('bookworm/latest/SHA512SUMS')) return `${corrupt ? '0'.repeat(128) : sha512}  debian-12-genericcloud-amd64.qcow2\n`;
      if (url.endsWith('latest-releases.yaml')) return `-\n  flavor: "alpine-virt"\n  file: "alpine-virt-3.22.2-x86_64.iso"\n  sha256: "${crypto.createHash('sha256').update('ISO').digest('hex')}"\n`;
      throw new Error(`offline: ${url}`);
    },
    downloadFile: async (url, dest, o) => {
      downloads.push(url);
      const body = /\.iso$/.test(dest) ? Buffer.from('ISO') : IMAGE;
      if (o.sha256 && crypto.createHash('sha256').update(body).digest('hex') !== o.sha256) throw new Error('sha256 mismatch');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      if (o.onProgress) o.onProgress(body.length, body.length); // like Hostwerk: bytes received, bytes total
      return dest;
    },
  };
}
function make(opts = {}) {
  const root = tmp();
  const qhost = fakeQhost(opts);
  const { runJob, jobs } = fakeRunJob();
  const n = fakeNet(opts);
  const events = [];
  const vbox = opts.vbox || null;
  const m = new VmManager({ root, qhost, vbox, Proc: class {}, runJob, downloadFile: n.downloadFile, fetchText: n.fetchText, broadcast: (e) => events.push(e), host: { cpus: 8, memoryMb: 16384 } });
  return { m, root, qhost, jobs, net: n, events };
}
/** A VM that "runs" – what the manager asks of a runtime. */
function fakeRt(vm, calls = []) {
  return {
    vm, calls, agentInfo: { ok: true }, qmp: { hmp: async (c) => { calls.push(['hmp', c]); return ''; } },
    isRunning: () => true, status: () => ({ state: 'running' }),
    liveSnapshot: async (name, o) => { calls.push(['live', name, !!(o && o.ram)]); return { ram: !!(o && o.ram), frozen: true }; },
    liveSnapshotDelete: async (name) => calls.push(['liveDel', name]),
    forwardAdd: async (f) => calls.push(['fwd+', f.host]), forwardRemove: async (f) => calls.push(['fwd-', f.host]), changeCd: async (iso) => calls.push(['cd', iso]),
    shutdown: async () => calls.push(['shutdown']), powerOff: async () => calls.push(['poweroff']),
  };
}

test('manager: ready-made Linux from the catalog – download once with checksum, disk, size, seed, SSH forward', async () => {
  const { m, root, qhost, jobs, net } = make();
  const job = m.create({ source: 'cloud', image: 'debian-12', name: 'Web Test', user: 'demo', password: 'geheim123', diskGb: 30 });
  assert.equal(job.vmId, 'web-test');
  assert.equal(m.get('web-test').creating, true); // visible at once
  assert.deepEqual(await job.promise, { id: 'web-test' });
  const vm = m.get('web-test');
  assert.equal(vm.creating, undefined); assert.equal(vm.osLabel, 'Debian 12 (Bookworm)'); assert.equal(vm.seed, 'seed.iso');
  assert.deepEqual(vm.ssh, { user: 'demo' });
  assert.deepEqual(vm.net.forwards, [{ id: 'ssh', proto: 'tcp', host: 2222, guest: 22, bind: 'local', label: 'SSH' }]);
  assert.ok(qhost.calls.some((c) => c[0] === 'resize' && c[2] === 30 * GB));
  const seed = readIso(fs.readFileSync(path.join(root, 'web-test', 'seed.iso')));
  assert.equal(seed.volume, 'cidata');
  assert.match(seed.files['user-data'].toString(), /name: "demo"[\s\S]*password: "geheim123"/);
  assert.match(seed.files['meta-data'].toString(), /local-hostname: "web-test"/);
  assert.ok(fs.existsSync(path.join(root, '.images', 'debian-12-genericcloud-amd64.qcow2')));
  // second VM: image from the cache, next free SSH port
  const j2 = m.create({ source: 'cloud', image: 'debian-12', name: 'Web Test', user: 'demo', sshKeys: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq0Qw9b0vW9v1g2fakeKeyFORtestsOnly0000 me' });
  await j2.promise;
  assert.equal(j2.vmId, 'web-test-2');
  assert.equal(net.downloads.length, 1);
  assert.equal(m.get('web-test-2').net.forwards[0].host, 2223);
  assert.ok(jobs[1].texts.some((t) => /cache/.test(t)));
  assert.deepEqual(m.listImages().map((i) => i.id), ['debian-12']);
});

test('manager: a damaged download is refused and nothing is left behind', async () => {
  const { m, root } = make({ corrupt: true });
  const job = m.create({ source: 'cloud', image: 'debian-12', name: 'bad', user: 'u1', password: 'secret1' });
  await assert.rejects(job.promise, /checksum/);
  assert.equal(m.vms.size, 0);
  assert.ok(!fs.existsSync(path.join(root, 'bad')));
  assert.ok(!fs.existsSync(path.join(root, '.images', 'debian-12-genericcloud-amd64.qcow2')));
});

test('manager: input is checked before any job starts', () => {
  const { m, jobs } = make();
  assert.throws(() => m.create({ source: 'teleport', name: 'x' }), /Unknown source/);
  assert.throws(() => m.create({ source: 'cloud', image: 'alpine-virt', name: 'x', user: 'u', password: 'secret1' }), /Unknown image/);
  assert.throws(() => m.create({ source: 'cloud', image: 'debian-12', name: 'x', user: 'root', password: 'secret1' }), /User name/);
  assert.throws(() => m.create({ source: 'iso', iso: 'C:\\nope.iso', name: 'x' }), (e) => e.status === 404);
  assert.throws(() => m.create({ source: 'iso', iso: 'C:\\x.exe', name: 'x' }), /ISO/);
  assert.throws(() => m.create({ source: 'disk', file: 'C:\\nope.vdi', name: 'x' }), (e) => e.status === 404);
  assert.throws(() => m.create({ source: 'empty', name: 'x', diskGb: 0 }), /Disk size/);
  assert.throws(() => m.create({ source: 'empty', name: 'x', memoryMb: 999999 }), /Memory/);
  assert.equal(jobs.length, 0); assert.equal(m.vms.size, 0);
});

test('manager: ISO (own file and catalog), empty VM, disk import, settings while off', async () => {
  const { m, root, qhost } = make();
  const iso = path.join(root, 'my.iso'); fs.writeFileSync(iso, 'x');
  const a = m.create({ source: 'iso', iso, name: 'Win', osType: 'windows', diskGb: 64, drivers: false }); // drivers: tests/package2.test.js
  await a.promise;
  const w = m.get('win');
  assert.deepEqual([w.cdrom, w.boot, w.firmware, w.disks[0].bus, w.net.model], [path.resolve(iso), 'cdrom', 'uefi', 'sata', 'e1000e']);
  assert.ok(qhost.calls.some((c) => c[0] === 'create' && c[2] === 64 * GB));
  await m.create({ source: 'iso', image: 'alpine-virt', name: 'alp' }).promise;
  assert.match(m.get('alp').cdrom, /alpine-virt-3\.22\.2-x86_64\.iso$/);
  await m.create({ source: 'empty', name: 'blank', diskGb: 5 }).promise;
  const vdi = path.join(root, 'old.vdi'); fs.writeFileSync(vdi, 'vdi-bytes');
  await m.create({ source: 'disk', file: vdi, name: 'imported' }).promise;
  assert.ok(qhost.calls.some((c) => c[0] === 'convert' && c[1] === 'old.vdi' && c[2] === 'disk0.qcow2'));
  // settings while off
  const d = await m.update('blank', { cpus: 4, memoryMb: 4096, firmware: 'uefi', notes: 'n' });
  assert.deepEqual([d.cpus, d.memoryMb, d.firmware, d.notes], [4, 4096, 'uefi', 'n']);
  await assert.rejects(m.update('blank', { cdrom: 'C:\\none.iso' }), (e) => e.status === 404);
  // disks: add, grow, remove
  await m.addDisk('blank', { sizeGb: 10 });
  assert.deepEqual(m.get('blank').disks.map((k) => k.id), ['disk0', 'disk1']);
  await assert.rejects(m.resizeDisk('blank', 'disk1', { sizeGb: 5 }), /only grow/);
  await m.resizeDisk('blank', 'disk1', { sizeGb: 20 });
  await m.removeDisk('blank', 'disk1');
  await assert.rejects(m.removeDisk('blank', 'disk0'), /last disk/);
  // list, detail, kind
  const list = m.list();
  assert.deepEqual(list.map((v) => v.id), ['alp', 'blank', 'imported', 'win']);
  const det = await m.detail('blank');
  assert.equal(det.diskInfo[0].virtualSize, 5 * GB);
  assert.equal(det.status.state, 'stopped');
  const kind = vmKind(m);
  assert.equal(kind.list().length, 4); assert.equal(kind.proc('blank').state, 'stopped');
  assert.match(kind.detail(m.view(m.get('blank'))), /4 CPU · 4 GB RAM/);
  assert.equal(kind.headline().value, '0/4');
});

test('manager: snapshots off and on – tree, restore, delete; RAM only where the accelerator allows', async () => {
  const { m, root, qhost } = make();
  await m.create({ source: 'empty', name: 'snap', diskGb: 5 }).promise;
  const disk = path.join(root, 'snap', 'disk0.qcow2');
  const setData = (v) => { const d = JSON.parse(fs.readFileSync(disk)); d.data = v; fs.writeFileSync(disk, JSON.stringify(d)); };
  setData('v1');
  await m.takeSnapshot('snap', { name: 'one', note: 'first' });
  setData('v2');
  await m.takeSnapshot('snap', { name: 'two' });
  await assert.rejects(m.takeSnapshot('snap', { name: 'two' }), (e) => e.status === 409);
  await assert.rejects(m.takeSnapshot('snap', { name: 'bad name' }), /Snapshot name/);
  setData('v3');
  await m.restoreSnapshot('snap', 'one');
  assert.equal(JSON.parse(fs.readFileSync(disk)).data, 'v1');
  assert.equal(m.get('snap').currentSnapshot, 'one');
  assert.equal(m.get('snap').snapshots.two.parent, 'one');
  await m.deleteSnapshot('snap', 'one');
  assert.equal(m.get('snap').snapshots.two.parent, null); // child moves up
  assert.ok(qhost.calls.some((c) => c[0] === 'snapshot' && c[2] === 'delete' && c[3] === 'one'));
  // running: live disk snapshot, no RAM with WHPX, restore needs a stop
  const calls = [];
  m.runtimes.set('snap', fakeRt(m.get('snap'), calls));
  const s = await m.takeSnapshot('snap', { name: 'live1' });
  assert.equal(s.find((x) => x.name === 'live1').live, true);
  assert.equal(s.find((x) => x.name === 'live1').frozen, true);
  await assert.rejects(m.takeSnapshot('snap', { name: 'r', ram: true }), /cannot save the memory/);
  await assert.rejects(m.restoreSnapshot('snap', 'live1'), /Shut the VM down/);
  await m.deleteSnapshot('snap', 'live1');
  assert.deepEqual(calls, [['live', 'live1', false], ['liveDel', 'live1']]);
  // KVM: with memory, restore while running through loadvm
  const k = make({ ramSnapshots: true });
  await k.m.create({ source: 'empty', name: 'kvm', diskGb: 5 }).promise;
  const kc = [];
  k.m.runtimes.set('kvm', fakeRt(k.m.get('kvm'), kc));
  await k.m.takeSnapshot('kvm', { name: 'ram1', ram: true });
  await k.qhost.snapshot(path.join(k.root, 'kvm', 'disk0.qcow2'), 'create', 'ram1'); // what savevm writes into the disk
  await k.m.restoreSnapshot('kvm', 'ram1');
  assert.deepEqual(kc, [['live', 'ram1', true], ['hmp', 'loadvm ram1']]);
  // stopped again: restoring a RAM snapshot resumes it on the next start
  k.m.runtimes.delete('kvm');
  await k.m.restoreSnapshot('kvm', 'ram1');
  assert.equal(k.m.get('kvm').resumeFrom, 'ram1');
});

test('manager: changes while running – live forwards and ISO, hardware refused', async () => {
  const { m } = make();
  await m.create({ source: 'empty', name: 'live', diskGb: 5 }).promise;
  const calls = [];
  m.runtimes.set('live', fakeRt(m.get('live'), calls));
  await assert.rejects(m.update('live', { cpus: 4 }), /Shut the VM down first to change: cpus/);
  await assert.rejects(m.update('live', { net: { model: 'e1000e' } }), /network card/);
  await m.update('live', { name: 'Live 2', net: { forwards: [{ proto: 'tcp', host: 46555, guest: 80, label: 'Web' }] } });
  await m.update('live', { net: { forwards: [] } });
  // the list replaces the old one: the automatic SSH forward goes, the web forward comes and goes – all live
  assert.deepEqual(calls.filter((c) => c[0].startsWith('fwd')), [['fwd-', 2222], ['fwd+', 46555], ['fwd-', 46555]]);
  assert.equal(m.get('live').name, 'Live 2');
  await assert.rejects(m.addDisk('live', { sizeGb: 1 }), /Shut the VM down first/);
  await assert.rejects(m.update('live', { net: { forwards: [{ proto: 'tcp', host: 46556, guest: 22, bind: 'lan' }] } }), (e) => e.status === 403);
  m.setConfig({ lanForwards: true });
  await m.update('live', { net: { forwards: [{ proto: 'tcp', host: 46556, guest: 22, bind: 'lan' }] } });
  assert.equal(m.get('live').net.forwards[0].bind, 'lan');
});

test('manager: templates and linked clones, full copies, removal rules', async () => {
  const { m, root, qhost } = make();
  await m.create({ source: 'cloud', image: 'debian-12', name: 'base', user: 'demo', password: 'secret12' }).promise;
  await m.takeSnapshot('base', { name: 's' });
  assert.throws(() => m.setTemplate('base', true), /Delete the snapshots/);
  await m.deleteSnapshot('base', 's');
  m.setTemplate('base', true);
  await assert.rejects(m.start('base'), /Templates do not start/);
  await assert.rejects(m.takeSnapshot('base', { name: 'x' }), /Templates have no snapshots/);
  const c = m.create({ source: 'template', template: 'base', name: 'clone a' });
  await c.promise;
  const cl = m.get('clone-a');
  assert.equal(cl.linkedTo, 'base'); assert.equal(cl.template, false);
  assert.ok(qhost.calls.some((x) => x[0] === 'create' && x[1] === 'disk0.qcow2' && x[3] === 'base'));
  assert.match(readIso(fs.readFileSync(path.join(root, 'clone-a', 'seed.iso'))).files['meta-data'].toString(), /local-hostname: "clone-a"/);
  assert.notEqual(cl.net.mac, m.get('base').net.mac);
  assert.throws(() => m.setTemplate('base', false), /Linked clones still use/);
  await assert.rejects(m.remove('base'), /Linked clones still use this VM: clone a/);
  assert.throws(() => m.setTemplate('clone-a', true), /linked clone cannot become a template/);
  const full = m.create({ source: 'clone', from: 'clone-a', name: 'full' });
  await full.promise;
  assert.equal(m.get('full').linkedTo, undefined);
  await m.remove('clone-a');
  assert.ok(!fs.existsSync(path.join(root, 'clone-a')));
  m.setTemplate('base', false);
  await m.remove('base');
  assert.deepEqual([...m.vms.keys()], ['full']);
});

test('manager: backups offline and live, restore replaces disks and clears snapshots', async () => {
  const { m, root, qhost } = make();
  await m.create({ source: 'empty', name: 'bk', diskGb: 5 }).promise;
  await m.takeSnapshot('bk', { name: 'old' });
  const j = m.backup('bk', 'Vor Update!');
  const r = await j.promise;
  assert.match(r.file, /^\d{8}-\d{6}-vor-update$/);
  assert.ok(qhost.calls.some((c) => c[0] === 'convert' && c[4] === true)); // compressed
  const list = m.listBackups('bk');
  assert.equal(list.length, 1); assert.equal(list[0].live, false);
  assert.ok(fs.existsSync(path.join(root, '.backups', 'bk', r.file, 'vm.json')));
  // restore: VM must be off; snapshots are gone afterwards
  m.runtimes.set('bk', fakeRt(m.get('bk')));
  assert.throws(() => m.restoreBackup('bk', r.file), /Shut the VM down first/);
  m.runtimes.delete('bk');
  await m.restoreBackup('bk', r.file).promise;
  assert.deepEqual(m.get('bk').snapshots, {});
  assert.throws(() => m.restoreBackup('bk', '../../etc'), (e) => e.status === 404);
  m.removeBackup('bk', r.file);
  assert.equal(m.listBackups('bk').length, 0);
  assert.throws(() => m.removeBackup('bk', 'evil'), /Invalid backup/);
  // the backup centre sees the same through the kind
  const kind = vmKind(m);
  const k = await kind.backups.create('bk', 'x').promise;
  assert.equal(kind.backups.list('bk')[0].file, k.file);
  // busy VMs do not run two things at once
  m.busy.set('bk', 'Exporting');
  assert.throws(() => m.backup('bk'), /busy/);
  await assert.rejects(m.start('bk'), /busy/);
});

test('manager: memory guard, broken creations after a crash, export', async () => {
  const { m, root } = make();
  await m.create({ source: 'empty', name: 'big', memoryMb: 12000, diskGb: 5 }).promise;
  await m.create({ source: 'empty', name: 'big2', memoryMb: 6000, diskGb: 5 }).promise;
  m.runtimes.set('big', fakeRt(m.get('big')));
  await assert.rejects(m.start('big2'), /Not enough memory/);
  m.runtimes.delete('big');
  // a VM folder left over from an interrupted creation is marked and can be removed
  fs.mkdirSync(path.join(root, 'half'));
  fs.writeFileSync(path.join(root, 'half', 'vm.json'), JSON.stringify({ id: 'half', name: 'Half', creating: true, disks: [] }));
  m.load();
  assert.equal(m.get('half').broken, true);
  await assert.rejects(m.start('half'), /still being created/);
  await m.remove('half');
  // export to VirtualBox format
  const dest = path.join(root, 'out.vdi');
  const ex = await m.exportDisk('big2', { format: 'vdi', dest }).promise;
  assert.equal(ex.path, dest);
  assert.throws(() => m.exportDisk('big2', { format: 'exe', dest: path.join(root, 'x') }), /Formats/);
  assert.throws(() => m.exportDisk('big2', { format: 'vdi', dest }), /exists already/);
});

test('manager: taking over a VirtualBox VM converts its disks and keeps CPU, memory and firmware', async () => {
  const src = path.join(tmp(), 'Old.vdi'); fs.writeFileSync(src, 'vdi');
  const vbox = { vm: async () => ({ uuid: '11111111-1111-1111-1111-111111111111', name: 'Old', state: 'stopped', osType: 'Ubuntu (64-bit)', cpus: 3, memoryMb: 3072, firmware: 'uefi', disks: [{ path: src }], snapshots: [{ name: 's' }] }), version: async () => '7.2.14r174565', list: async () => [] };
  const { m, qhost } = make({ vbox });
  const j = m.create({ source: 'vbox', uuid: '11111111-1111-1111-1111-111111111111', name: 'Old' });
  await j.promise;
  const vm = m.get('old');
  assert.deepEqual([vm.cpus, vm.memoryMb, vm.firmware, vm.osType, vm.disks[0].bus, vm.importedFrom.name], [3, 3072, 'uefi', 'linux', 'sata', 'Old']);
  assert.ok(qhost.calls.some((c) => c[0] === 'convert' && c[1] === 'Old.vdi'));
  // with snapshots the current disk is a difference image: VirtualBox merges it first, the temp file is removed
  const merged = [];
  const snapVbox = { ...vbox, isDifferencing: async () => true, flatten: async (src0, dest) => { merged.push(path.basename(src0)); fs.writeFileSync(dest, 'flat'); } };
  const s2 = make({ vbox: snapVbox });
  await s2.m.create({ source: 'vbox', uuid: '11111111-1111-1111-1111-111111111111', name: 'Snappy' }).promise;
  assert.deepEqual(merged, ['Old.vdi']);
  assert.ok(s2.qhost.calls.some((c) => c[0] === 'convert' && c[1] === '.merge-0.vdi'));
  assert.ok(!fs.existsSync(path.join(s2.root, 'snappy', '.merge-0.vdi')));
  const running = { ...(await vbox.vm()), state: 'running' };
  const busy = make({ vbox: { ...vbox, vm: async () => running } });
  await assert.rejects(busy.m.create({ source: 'vbox', uuid: running.uuid, name: 'x' }).promise, /Shut the VirtualBox VM down/);
  assert.equal((await m.engines()).vbox.version, '7.2.14r174565');
});

/* ---------------- HTTP routes ---------------- */
function fakeRouter() {
  const r = { routes: [] };
  for (const method of ['get', 'post', 'put', 'delete']) r[method] = (p, fn) => r.routes.push({ method: method.toUpperCase(), p, fn });
  r.call = async (method, url, { body, headers = {} } = {}) => {
    const [pathname, qs] = url.split('?');
    for (const rt of r.routes) {
      if (rt.method !== method) continue;
      const names = [];
      const re = new RegExp(`^${rt.p.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
      const mm = pathname.match(re);
      if (!mm) continue;
      const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false,
        status(c) { this.statusCode = c; return this; }, set(k, v) { this.headers[k.toLowerCase()] = v; return this; }, type(t) { this.headers['content-type'] = t; return this; },
        json(b) { this.body = b; this.headersSent = true; return this; }, send(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
      const req = { params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(mm[i + 1])])), query: Object.fromEntries(new URLSearchParams(qs || '')), body, headers };
      await rt.fn(req, res);
      return res;
    }
    throw new Error(`no route ${method} ${url}`);
  };
  return r;
}

test('routes: list, create as a job, errors with status codes, screen with ETag', async () => {
  const { m } = make();
  const r = fakeRouter();
  routes(r, m);
  const c = await r.call('POST', '/vms', { body: { source: 'empty', name: 'R1', diskGb: 2 } });
  assert.equal(c.statusCode, 200); assert.ok(c.body.job); assert.equal(c.body.id, 'r1');
  await new Promise((res) => setTimeout(res, 20));
  assert.equal((await r.call('GET', '/vms')).body.vms[0].id, 'r1');
  assert.equal((await r.call('GET', '/vms/r1')).body.name, 'R1');
  assert.equal((await r.call('GET', '/vms/nope')).statusCode, 404);
  assert.equal((await r.call('GET', '/vms/..%2F..')).statusCode, 400);
  assert.equal((await r.call('POST', '/vms', { body: { source: 'x' } })).statusCode, 400);
  assert.equal((await r.call('POST', '/vms/r1/pause')).statusCode, 409); // not running
  assert.equal((await r.call('GET', '/vms/catalog')).body.items.length > 5, true);
  const plan = await r.call('POST', '/vms/plan', { body: { name: 'Neu', memoryMb: 8192 } });
  assert.equal(plan.body.vm.id, 'neu'); assert.equal(plan.body.memory.level, 'ok');
  // screen: PNG and 304 for an unchanged frame
  const shot = { png: Buffer.from('png'), etag: 'abc' };
  m.runtimes.set('r1', { ...fakeRt(m.get('r1')), screen: async () => shot });
  const s1 = await r.call('GET', '/vms/r1/screen');
  assert.equal(s1.headers.etag, '"abc"'); assert.equal(s1.headers['content-type'], 'png'); assert.equal(s1.body.toString(), 'png');
  const s2 = await r.call('GET', '/vms/r1/screen', { headers: { 'if-none-match': '"abc"' } });
  assert.equal(s2.statusCode, 304); assert.equal(s2.body, undefined);
  m.runtimes.delete('r1');
  assert.equal((await r.call('PUT', '/vms/config', { body: { lanForwards: true } })).body.lanForwards, true);
  assert.equal((await r.call('DELETE', '/vms/r1')).body.ok, true);
});
