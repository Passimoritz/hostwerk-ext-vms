'use strict';
/*
 * Package 2 of the roadmap, wired into the manager: virtio-win drivers with a checksum held fixed per version (#3),
 * Windows installed without clicking (#2: answer file on its own CD, "press any key" at boot, switch to disk when the
 * guest agent answers). No QEMU, no downloads.   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('../server/spec');
const { buildArgs } = require('../server/qemu-args');
const { readIso } = require('../server/iso');
const { VmManager } = require('../server/manager');
const { Runtime } = require('../server/runtime');

const HOST = { cpus: 8, memoryMb: 16384 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hw-vms-p2-'));

test('spec/args: driver CD as third SATA drive, SATA budget shrinks to 3 disks', () => {
  const sata = (n) => Array.from({ length: n }, (_, i) => ({ id: `disk${i}`, file: `d${i}.qcow2`, bus: 'sata' }));
  assert.equal(S.cleanVm({ name: 'w', osType: 'windows', disks: sata(4) }, { host: HOST }).disks.length, 4);
  assert.throws(() => S.cleanVm({ name: 'w', osType: 'windows', disks: sata(4), drivers: 'C:\\virtio.iso' }, { host: HOST }), /At most 3 SATA disks/);
  const vm = { ...S.cleanVm({ name: 'w', id: 'w', osType: 'windows', disks: sata(1), cdrom: 'C:\\win.iso', boot: 'cdrom', drivers: 'C:\\v,1.iso' }, { host: HOST }), id: 'w', seed: 'unattend.iso' };
  const a = buildArgs(vm, { dir: '/v', ports: { qmp: 1 }, firmware: { code: '/c.fd' } });
  assert.ok(a.includes('ide-hd,drive=disk0,bus=ide.0,bootindex=1'));
  assert.ok(a.includes('ide-cd,id=cdrom0,drive=cd0,bus=ide.1,bootindex=0'));
  assert.ok(a.includes('ide-cd,id=seedcd,drive=seed,bus=ide.2'));
  assert.ok(a.includes('ide-cd,id=driverscd,drive=drivers,bus=ide.3'));
  assert.ok(a.some((x) => x.includes('file=C:\\v,,1.iso')));
  // Windows: WHPX without kernel-irqchip=off (otherwise the Windows kernel hangs at the firmware logo); Linux keeps it
  const win = buildArgs(vm, { dir: '/v', ports: { qmp: 1 }, firmware: { code: '/c.fd' }, accel: ['whpx,kernel-irqchip=off', 'tcg'] });
  assert.deepEqual(win.filter((_, i) => win[i - 1] === '-accel'), ['whpx', 'tcg']);
  const lin = buildArgs({ ...vm, osType: 'linux', drivers: null }, { dir: '/v', ports: { qmp: 1 }, firmware: { code: '/c.fd' }, accel: ['whpx,kernel-irqchip=off', 'tcg'] });
  assert.deepEqual(lin.filter((_, i) => lin[i - 1] === '-accel'), ['whpx,kernel-irqchip=off', 'tcg']);
});

test('Windows under WHPX: named CPU model of the host vendor (max → bluescreen 0x50) and -no-reboot (a reset pauses QEMU)', () => {
  const vm = { ...S.cleanVm({ name: 'w', id: 'w', osType: 'windows', disks: [{ id: 'disk0', file: 'd.qcow2', bus: 'sata' }] }, { host: HOST }), id: 'w' };
  const o = (accel, hostVendor) => ({ dir: '/v', ports: { qmp: 1 }, firmware: { code: '/c.fd' }, accel, hostVendor });
  const cpu = (a) => a[a.indexOf('-cpu') + 1];
  const amd = buildArgs(vm, o(['whpx,kernel-irqchip=off', 'tcg'], 'amd'));
  assert.equal(cpu(amd), 'EPYC-Rome');
  assert.ok(amd.includes('-no-reboot'));
  assert.equal(cpu(buildArgs(vm, o(['whpx'], 'intel'))), 'Skylake-Client');
  // Linux under WHPX: CPU "max", but -no-reboot as well – a guest reset hangs there too (UEFI Linux guest, 0 % CPU,
  // "Display output is not active"); KVM and TCG reset fine
  const lin = buildArgs({ ...vm, osType: 'linux' }, o(['whpx,kernel-irqchip=off', 'tcg'], 'amd'));
  assert.equal(cpu(lin), 'max'); assert.ok(lin.includes('-no-reboot'));
  assert.ok(buildArgs({ ...vm, osType: 'other' }, o(['whpx,kernel-irqchip=off', 'tcg'], 'amd')).includes('-no-reboot'));
  const kvm = buildArgs(vm, o(['kvm'], 'amd'));
  assert.equal(cpu(kvm), 'host'); assert.ok(!kvm.includes('-no-reboot'));
  const tcg = buildArgs({ ...vm, osType: 'linux' }, o(['tcg'], 'amd'));
  assert.equal(cpu(tcg), 'max'); assert.ok(!tcg.includes('-no-reboot'));
  const { rebootByRestart } = require('../server/qemu-args');
  assert.equal(rebootByRestart({ osType: 'linux' }, ['whpx,kernel-irqchip=off', 'tcg']), true);
  assert.equal(rebootByRestart({ osType: 'linux', arch: 'aarch64' }, ['whpx']), false, 'ARM always runs emulated');
  assert.equal(rebootByRestart({ osType: 'linux' }, ['kvm', 'tcg']), false);
});

test('Linux under WHPX: a stop while QEMU comes back after a guest restart waits for it and then stops', async () => {
  const stored = { id: 'l', name: 'l', osType: 'linux', boot: 'disk', disks: [] };
  const r = new Runtime(stored, { qhost: {}, Proc: class {}, dir: tmp(), currentVm: () => stored });
  let running = false; const stops = [];
  r.proc = { info: () => ({ state: running ? 'running' : 'stopped' }), isRunning: () => running, log() {}, stop: async () => { stops.push('stop'); running = false; } };
  let go;
  r.start = () => new Promise((res) => { go = () => { running = true; res(); }; });
  r.rebootByRestart = true;
  r.onEvent({ event: 'SHUTDOWN', data: { guest: true, reason: 'guest-reset' } });
  r.onQemuExit();
  assert.equal(r.status().state, 'starting');
  const stopping = r.shutdown();
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(stops, [], 'the stop waits for the new start');
  go();
  await stopping;
  assert.deepEqual(stops, ['stop']);
  assert.equal(r.status().state, 'stopped');
  // after a guest restart that went through the VM shows "running" again, not "starting" or "stopping"
  r.onEvent({ event: 'SHUTDOWN', data: { guest: true, reason: 'guest-reset' } });
  r.onQemuExit();
  go();
  await r.restartTask;
  assert.equal(r.status().state, 'running');
});

test('-no-reboot VM: guest restart ends QEMU → the runtime starts it again with the stored description, no key presses', async () => {
  const stored = { id: 'w', name: 'w', osType: 'windows', install: { state: 'done' }, boot: 'disk', disks: [] };
  const r = new Runtime({ ...stored, boot: 'cdrom', install: { state: 'running' } }, { qhost: {}, Proc: class {}, dir: tmp(), currentVm: () => stored });
  const starts = []; const changes = [];
  r.onChange = (w) => changes.push(w);
  r.proc = { info: () => ({ state: 'stopped' }), isRunning: () => false, log() {} };
  r.start = async (o) => { starts.push([o, r.vm.boot]); };
  r.rebootByRestart = true;
  r.onEvent({ event: 'SHUTDOWN', data: { guest: true, reason: 'guest-reset' } });
  assert.equal(r.status().state, 'starting', 'between the two QEMU processes the VM is not "stopped"');
  r.onQemuExit();
  await r.restartTask;
  assert.deepEqual(starts, [[{ afterReset: true }, 'disk']]);
  assert.ok(!r.restarting && changes.includes('restarted'));
  // a normal shutdown of the guest: no new start
  r.onEvent({ event: 'SHUTDOWN', data: { guest: true, reason: 'guest-shutdown' } });
  r.onQemuExit();
  assert.equal(starts.length, 1);
  assert.equal(r.status().state, 'stopped');
  // the reset button: end QEMU (system_reset would pause it) and start again
  const sent = [];
  r.isRunning = () => true; r.qmp = { exec: async (c) => { sent.push(c); } };
  await r.reset();
  assert.deepEqual(sent, ['quit']);
  assert.ok(r.restartPending);
});

test('package 3 args: sound on this PC (#19), 3D only in an own window (#18), VNC on 127.0.0.1 (#1)', () => {
  const base = { ...S.cleanVm({ name: 's', id: 's', disks: [{ id: 'disk0', file: 'd.qcow2' }], sound: true, vga: 'virtio-gl', display: 'window' }, { host: HOST }), id: 's' };
  const a = buildArgs(base, { dir: '/v', ports: { qmp: 1, vnc: 5911 }, platform: 'win32' });
  const val = (flag) => a.filter((_, i) => a[i - 1] === flag);
  assert.deepEqual(val('-audiodev'), ['dsound,id=snd0']);
  assert.ok(a.includes('hda-output,audiodev=snd0'));
  assert.ok(a.includes('virtio-vga-gl') && val('-display')[0] === 'sdl,gl=on' && !val('-vga').length);
  assert.deepEqual(val('-vnc'), [], 'QEMU refuses VNC next to an OpenGL context');
  // 3D chosen but the screen is in Hostwerk: plain virtio, no OpenGL window – and the VNC screen on 127.0.0.1
  const web = buildArgs({ ...base, display: 'web' }, { dir: '/v', ports: { qmp: 1, vnc: 5911 }, platform: 'linux' });
  assert.ok(!web.includes('virtio-vga-gl') && web[web.indexOf('-vga') + 1] === 'virtio' && web[web.indexOf('-display') + 1] === 'none');
  assert.equal(web[web.indexOf('-vnc') + 1], '127.0.0.1:11,password=off');
  assert.equal(web[web.indexOf('-audiodev') + 1], 'pa,id=snd0');
});

test('3D (#18): only in an own window; the PNG screen of such a VM says where the picture is (live: QEMU "no surface")', async () => {
  const { glMode } = require('../server/qemu-args');
  assert.equal(glMode({ vga: 'virtio-gl', display: 'window' }), 'window');
  assert.equal(glMode({ vga: 'virtio-gl', display: 'web' }), null, 'egl-headless shows no picture on Windows (SET_SCANOUT fails)');
  assert.equal(glMode({ vga: 'virtio-gl', display: 'window', arch: 'aarch64' }), null);
  assert.equal(glMode({ vga: 'virtio', display: 'window' }), null);
  const r = new Runtime({ id: 'g3', name: 'g3', vga: 'virtio-gl', display: 'window', disks: [] }, { qhost: {}, Proc: class {}, dir: tmp() });
  let dumped = false;
  r.needQmp = () => ({ exec: async () => { dumped = true; } });
  await assert.rejects(() => r.screen(), (e) => e.status === 409 && /own window/.test(e.message));
  assert.ok(!dumped, 'no screendump attempted');
});

/* ---------------- manager ---------------- */
const LISTING = '<a href="virtio-win-0.1.999-1/">virtio-win-0.1.999-1/</a>';
function make({ iso = Buffer.from('VIRTIO') } = {}) {
  const root = tmp();
  const downloads = [];
  const qhost = {
    info: async () => ({ installed: true, accel: 'whpx', accelArgs: ['tcg'], firmware: { code: '/c.fd', vars: '/v.fd' } }),
    create: async (f, bytes) => fs.writeFileSync(f, JSON.stringify({ size: bytes })),
    convert: async () => {}, resize: async () => {}, diskInfo: async () => ({ virtualSize: 1 }), snapshot: async () => {},
  };
  const runJob = (title, fn) => { const job = { id: crypto.randomUUID(), lines: [], progress() {}, status(t) { this.lines.push(t); }, log(l) { this.lines.push(l); } }; job.promise = Promise.resolve().then(() => fn(job)); return job; };
  const fetchText = async (url) => { if (/stable-virtio\/$/.test(url)) return LISTING; if (/CHECKSUM$/.test(url)) return 'abc123  virtio-win-0.1.999-1.noarch.rpm\n'; throw new Error(`offline ${url}`); };
  const downloadFile = async (url, dest, o) => { downloads.push([url, o.sha256 || null]); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, iso); if (o.sha256 && crypto.createHash('sha256').update(iso).digest('hex') !== o.sha256) throw new Error('sha256 mismatch'); };
  const m = new VmManager({ root, qhost, Proc: class {}, runJob, downloadFile, fetchText, broadcast: () => {}, host: HOST });
  const notes = []; m.onNotify = (k, t) => notes.push([k, t]);
  return { m, root, downloads, notes };
}
const winIso = () => { const f = path.join(tmp(), 'Win11_de.iso'); fs.writeFileSync(f, 'win'); return f; };

test('#2/#3 Windows without clicking: answer file CD, drivers CD with a checksum held fixed, UEFI/SATA defaults', async () => {
  const { m, root, downloads } = make();
  const j = m.create({ source: 'iso', iso: winIso(), osType: 'windows', name: 'Win 11', unattended: true, winUser: 'demo', winPassword: 'Geheim<&>"1', edition: 1, language: 'de-DE' });
  await j.promise;
  const vm = m.get('win-11');
  assert.deepEqual([vm.firmware, vm.disks[0].bus, vm.net.model, vm.boot, vm.seed, vm.install.state], ['uefi', 'sata', 'e1000e', 'cdrom', 'unattend.iso', 'running']);
  assert.match(vm.drivers, /virtio-win-0.1.999.iso$/);
  const xml = readIso(fs.readFileSync(path.join(root, 'win-11', 'unattend.iso'))).files['autounattend.xml'].toString();
  assert.match(xml, /demo/);
  assert.match(xml, /Geheim&lt;&amp;&gt;&quot;1/);
  assert.match(xml, /\/IMAGE\/INDEX/);
  assert.match(xml, /BypassTPMCheck/);
  assert.ok(!JSON.stringify(vm).includes('Geheim'), 'the password must not land in vm.json');
  // first download: no checksum published → held fixed on this PC
  assert.deepEqual(downloads, [['https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-0.1.999-1/virtio-win-0.1.999.iso', null]]);
  const pins = JSON.parse(fs.readFileSync(path.join(root, '.pins.json'), 'utf8'));
  assert.equal(pins['virtio-win-0.1.999.iso'], crypto.createHash('sha256').update('VIRTIO').digest('hex'));
  // second VM: from the cache, no download
  await m.create({ source: 'empty', osType: 'windows', name: 'Win 2', diskGb: 30 }).promise;
  assert.equal(downloads.length, 1);
  assert.equal(m.get('win-2').drivers, vm.drivers);
  // another PC with the same pin, the server delivers other bytes for that version → refused
  const bad = make({ iso: Buffer.from('TAMPERED') });
  fs.copyFileSync(path.join(root, '.pins.json'), path.join(bad.root, '.pins.json'));
  await assert.rejects(bad.m.create({ source: 'empty', osType: 'windows', name: 'Win 3', diskGb: 30 }).promise, /sha256 mismatch|checksum/);
  assert.ok(!bad.m.vms.has('win-3'));
});

test('#2 checks before anything is created; drivers can be left out', async () => {
  const { m, downloads } = make();
  assert.throws(() => m.create({ source: 'iso', iso: winIso(), osType: 'windows', name: 'W', unattended: true, winUser: 'Administrator', winPassword: 'x1234567' }), /built-in|Administrator/i);
  assert.throws(() => m.create({ source: 'iso', iso: winIso(), osType: 'windows', name: 'W', unattended: true, winUser: 'demo', winPassword: '' }), /password/i);
  assert.equal(m.vms.size, 0);
  await m.create({ source: 'iso', iso: winIso(), osType: 'windows', name: 'No Drivers', drivers: false }).promise;
  assert.equal(m.get('no-drivers').drivers, null);
  assert.equal(m.get('no-drivers').install, null);
  assert.equal(downloads.length, 0);
});

test('#2 when the guest agent answers, the VM boots from disk and the answer file goes', async () => {
  const { m, root, notes } = make();
  await m.create({ source: 'iso', iso: winIso(), osType: 'windows', name: 'Done', unattended: true, winUser: 'demo', winPassword: 'pw123456', drivers: false }).promise;
  const ejected = [];
  const execs = [];
  m.runtimes.set('done', { vm: m.get('done'), isRunning: () => true, status: () => ({ state: 'running' }), qmp: { exec: async (c, a) => ejected.push([c, a]) }, guestExec: async (c) => { execs.push(c); return { code: 0, out: '' }; } });
  assert.equal(await m.finishInstall('done'), true);
  const vm = m.get('done');
  assert.deepEqual([vm.install.state, vm.boot, vm.seed, vm.install.answerFileRemoved], ['done', 'disk', null, true]);
  assert.deepEqual(ejected, [['eject', { id: 'seedcd', force: true }]]);
  assert.match(execs[0], /Panther\\unattend\.xml/); // Hostwerk deletes the password-holding copies itself
  assert.match(notes[0][1], /installed – sign in as demo/);
  assert.equal(await m.finishInstall('done'), false); // only once
  assert.ok(fs.existsSync(path.join(root, 'done', 'unattend.iso')));
  m.runtimes.delete('done');
  await m.start('done').catch(() => {}); // the fake process cannot start – the clean-up runs before that
  assert.ok(!fs.existsSync(path.join(root, 'done', 'unattend.iso')));
});

test('#2 a copy of the answer file that cannot be deleted is reported', async () => {
  const { m, notes } = make();
  await m.create({ source: 'iso', iso: winIso(), osType: 'windows', name: 'Left', unattended: true, winUser: 'demo', winPassword: 'pw123456', drivers: false }).promise;
  m.runtimes.set('left', { vm: m.get('left'), isRunning: () => true, status: () => ({ state: 'running' }), qmp: { exec: async () => {} }, guestExec: async () => ({ code: 0, out: 'C:\\Windows\\Panther\\unattend.xml\r\n' }) });
  await m.finishInstall('left');
  assert.equal(m.get('left').install.answerFileRemoved, false);
  assert.ok(notes.some(([k, t]) => k === 'warn' && /Panther/.test(t)), JSON.stringify(notes));
});

test('guest exec in Windows: PowerShell answers in UTF-8 (the OEM code page turned "ß" into "�"), Linux unchanged', async () => {
  const calls = [];
  const mk = (osType) => { const r = new Runtime({ id: 'g', name: 'g', osType, disks: [] }, { qhost: {}, Proc: class {}, dir: tmp() }); r.agentCall = async (cmd, args) => { calls.push([cmd, args]); return cmd === 'guest-exec' ? { pid: 7 } : { exited: true, exitcode: 0, 'out-data': Buffer.from('Straße').toString('base64') }; }; return r; };
  assert.equal((await mk('windows').guestExec('Get-Date')).out, 'Straße');
  const win = calls[0][1];
  assert.equal(win.path, 'powershell.exe');
  assert.match(win.arg[win.arg.length - 1], /^\[Console\]::OutputEncoding = New-Object System\.Text\.UTF8Encoding \$false; Get-Date$/);
  calls.length = 0;
  await mk('linux').guestExec('uname -a');
  assert.deepEqual(calls[0][1].arg, ['-c', 'uname -a']);
});

test('#2 runtime presses Enter for "Press any key to boot from CD" while Windows installs', async () => {
  const keys = [];
  const r = new Runtime({ id: 'w', name: 'w', install: { state: 'running' }, boot: 'cdrom', disks: [] }, { qhost: {}, Proc: class {}, dir: tmp() });
  r.qmp = { exec: async (c, a) => { keys.push(a.keys[0].data); } };
  r.isRunning = () => true;
  r.pressToBoot(1600);
  await new Promise((res) => setTimeout(res, 1900));
  assert.ok(keys.length >= 2 && keys.length <= 4 && keys.every((k) => k === 'ret'), JSON.stringify(keys));
});

test('drivers switch from the create dialog is never taken as a file name', () => {
  const lin = S.cleanVm({ name: 'k', osType: 'linux', drivers: true }, { host: HOST });
  assert.strictEqual(lin.drivers, null);
  const old = S.cleanVm({ name: 'k', osType: 'linux' }, { host: HOST, prev: { drivers: 'true' } });
  assert.strictEqual(old.drivers, null);
  const kept = S.cleanVm({ name: 'w', osType: 'windows', drivers: true }, { host: HOST, prev: { drivers: 'C:\virtio.iso' } });
  assert.strictEqual(kept.drivers, 'C:\virtio.iso');
});
