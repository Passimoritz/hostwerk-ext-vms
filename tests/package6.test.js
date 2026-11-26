'use strict';
/*
 * 1.4.0: files and users in the guest (file browser, new password), the whole VM as an appliance (OVA) and the
 * graphics options. No QEMU, no guest – commands as text, a fake guest agent and fake disks.   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('../server/spec');
const GF = require('../server/guest-files');
const OVA = require('../server/ova');
const { listTar, extractTar, parseOvf } = require('../server/importer');
const { buildArgs } = require('../server/qemu-args');
const { VmManager } = require('../server/manager');

const HOST = { cpus: 8, memoryMb: 16384 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hw-vms-p6-'));
const T = '\t';

test('guest files: the Linux listing command quotes the folder and its output is read back', () => {
  const cmd = GF.listCommand(false, "/home/me/it's here");
  assert.ok(cmd.startsWith("cd -- '/home/me/it'\\''s here' && pwd -P"), cmd);
  assert.match(cmd, /stat -c '%F\t%s\t%Y\t%n' -- \.\[!\.\]\* \.\.\?\* \*/);
  const out = ['/home/me', `regular file${T}120${T}1700000000${T}notes.txt`, `directory${T}4096${T}1700000100${T}Projects`, `symbolic link${T}9${T}1700000200${T}latest`, `regular empty file${T}0${T}1700000300${T}.hidden`, `regular file${T}5${T}0${T}tab${T}name`].join('\n');
  const l = GF.parseListing(out, false);
  assert.equal(l.path, '/home/me'); assert.equal(l.parent, '/home'); assert.equal(l.sep, '/'); assert.equal(l.truncated, false);
  assert.deepEqual(l.entries.map((e) => [e.name, e.type]), [['Projects', 'dir'], ['.hidden', 'file'], ['latest', 'link'], ['notes.txt', 'file'], [`tab${T}name`, 'file']]);
  const notes = l.entries.find((e) => e.name === 'notes.txt');
  assert.equal(notes.size, 120); assert.equal(notes.mtime, 1700000000000);
  assert.equal(l.entries[0].size, null, 'a folder has no size');
  assert.equal(GF.parseListing('/\n', false).parent, null, 'nothing above /');
});

test('guest files: Windows – drives at the top, folders by Resolve-Path, quotes doubled', () => {
  assert.match(GF.listCommand(true, ''), /Get-PSDrive -PSProvider FileSystem/);
  const cmd = GF.listCommand(true, "C:\\Users\\O'Neil");
  assert.match(cmd, /Resolve-Path -LiteralPath 'C:\\Users\\O''Neil'/);
  const drives = GF.parseListing(`\r\nd${T}0${T}0${T}C:\\\r\nd${T}0${T}0${T}D:\\\r\n`, true);
  assert.equal(drives.path, ''); assert.equal(drives.parent, null);
  assert.deepEqual(drives.entries.map((e) => e.name), ['C:\\', 'D:\\']);
  const l = GF.parseListing(`C:\\Users\\me\r\nd${T}0${T}1700000000${T}Desktop\r\nf${T}42${T}1700000000${T}a.txt\r\n`, true);
  assert.equal(l.parent, 'C:\\Users'); assert.equal(l.sep, '\\');
  assert.equal(GF.parentOf('C:\\Users', true), 'C:\\'); assert.equal(GF.parentOf('C:\\', true), ''); assert.equal(GF.parentOf('', true), null);
  assert.equal(GF.joinPath('C:\\', 'x.txt', true), 'C:\\x.txt'); assert.equal(GF.joinPath('C:\\Users\\me\\', 'x.txt', true), 'C:\\Users\\me\\x.txt');
  assert.equal(GF.joinPath('/', 'x', false), '/x'); assert.equal(GF.joinPath('/home/me/', 'x', false), '/home/me/x');
});

test('guest files: more than 1000 entries are cut and said so', () => {
  const lines = ['/big', ...Array.from({ length: GF.MAX_ENTRIES + 1 }, (_, i) => `regular file${T}1${T}1${T}f${i}`)];
  const l = GF.parseListing(lines.join('\n'), false);
  assert.equal(l.entries.length, GF.MAX_ENTRIES); assert.equal(l.truncated, true);
});

test('guest files: new folder and delete – names cannot leave the folder, system folders stay', () => {
  assert.equal(GF.mkdirCommand(false, '/home/me', 'new one'), `mkdir -- '/home/me/new one' && chown "$(stat -c %u:%g -- '/home/me')" -- '/home/me/new one'`);
  assert.match(GF.mkdirCommand(true, 'C:\\Users\\me', 'Neu'), /New-Item -ItemType Directory -Path 'C:\\Users\\me\\Neu'/);
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'x\ny']) assert.throws(() => GF.mkdirCommand(false, '/home/me', bad), /Name/);
  assert.throws(() => GF.mkdirCommand(true, 'C:\\', 'a:b'), /Name/);
  assert.equal(GF.deleteCommand(false, '/home/me/old dir/'), "rm -rf -- '/home/me/old dir'");
  assert.match(GF.deleteCommand(true, 'C:\\Users\\me\\old'), /Remove-Item -LiteralPath 'C:\\Users\\me\\old' -Recurse -Force/);
  for (const sys of ['/', '/etc', '/home/', '/usr', 'relative/path']) assert.throws(() => GF.deleteCommand(false, sys), /belongs to the system/);
  for (const sys of ['C:\\', 'c:', 'C:\\Windows', 'C:/Users', 'D:\\Program Files']) assert.throws(() => GF.deleteCommand(true, sys), /belongs to the system/);
  assert.throws(() => GF.deleteCommand(false, 'a\nb'), /Path in the VM/);
  assert.equal(GF.safeName('../../etc/passwd'), 'passwd'); assert.equal(GF.safeName('.bashrc'), 'bashrc'); assert.equal(GF.safeName('Bericht (1).pdf'), 'Bericht (1).pdf');
});

test('guest users and password: only sign-in accounts, the password goes base64 to the agent, bad input is refused', () => {
  assert.match(GF.usersCommand(false), /getent passwd/);
  assert.match(GF.usersCommand(true), /Get-LocalUser/);
  assert.deepEqual(GF.parseUsers('root\nme\n\nme\nbad;name\n'), ['root', 'me']);
  const a = GF.passwordArgs(' me ', 'Geheim€1');
  assert.deepEqual(a, { username: 'me', password: Buffer.from('Geheim€1', 'utf8').toString('base64'), crypted: false });
  assert.throws(() => GF.passwordArgs('me; rm -rf /', 'x'), /User/);
  assert.throws(() => GF.passwordArgs('me', ''), /Password/);
  assert.throws(() => GF.passwordArgs('me', 'a\nb'), /Password/);
  assert.throws(() => GF.passwordArgs('me', 'x'.repeat(129)), /Password/);
});

/** A manager whose one VM "runs" with a fake guest agent (commands and agent calls are recorded). */
function managerWithGuest({ osType = 'linux', reply = () => ({ code: 0, out: '', err: '' }), agentCall = async () => ({}) } = {}) {
  const root = tmp();
  const wr = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
  const qhost = {
    info: async () => ({ installed: true, accel: 'tcg', ramSnapshots: true }),
    create: async (f, bytes) => wr(f, { size: bytes || 0 }),
    convert: async (src, dest, o = {}) => { fs.writeFileSync(dest, Buffer.alloc(3000, 7)); if (o.onProgress) o.onProgress(100); },
    diskInfo: async () => ({ format: 'qcow2', virtualSize: 20 * 2 ** 30, actualSize: 1000, backing: null, snapshots: [] }),
  };
  const runJob = (title, fn) => { const job = { id: crypto.randomUUID(), title, progress() {}, status() {}, log() {} }; job.promise = Promise.resolve().then(() => fn(job)); return job; };
  const m = new VmManager({ root, qhost, Proc: class {}, runJob, broadcast: () => {}, host: HOST });
  const vm = { ...S.cleanVm({ name: 'Büro PC', id: 'buero', osType, firmware: 'uefi', cpus: 4, memoryMb: 4096, disks: [{ id: 'disk0', file: 'disk0.qcow2' }, { id: 'disk1', file: 'disk1.qcow2' }] }, { host: HOST }), id: 'buero' };
  fs.mkdirSync(m.dirOf('buero'), { recursive: true });
  for (const k of vm.disks) wr(path.join(m.dirOf('buero'), k.file), { size: 1 });
  m.vms.set('buero', vm); m.save(vm);
  const calls = { exec: [], agent: [] };
  const r = {
    vm, agentInfo: { ok: true }, isRunning: () => true, status: () => ({ state: 'running' }),
    guestTarget: async () => ({ path: osType === 'windows' ? 'C:\\Users\\me\\Desktop\\x' : '/home/me/x', owner: 'me' }),
    guestExec: async (command, o) => { calls.exec.push({ command, windows: o.windows }); return { timedOut: false, ...reply(command) }; },
    agentCall: async (cmd, args) => { calls.agent.push({ cmd, args }); return agentCall(cmd, args); },
  };
  return { m, r, calls, root, start: () => m.runtimes.set('buero', r), stop: () => m.runtimes.delete('buero') };
}

test('manager: a folder of the running VM – home first, errors of the guest in plain words, nothing without the agent', async () => {
  const g = managerWithGuest({ reply: (c) => (/no-such/.test(c) ? { code: 1, out: '', err: 'sh: 1: cd: can\'t cd to /no-such\nmore' } : { code: 0, out: `/home/me\ndirectory${T}4096${T}1700000000${T}Docs\n`, err: '' }) });
  await assert.rejects(() => g.m.guestFiles('buero'), /not running/);
  g.start();
  const home = await g.m.guestFiles('buero');
  assert.equal(home.path, '/home/me'); assert.deepEqual(home.entries.map((e) => e.name), ['Docs']);
  assert.match(g.calls.exec[0].command, /^cd -- '\/home\/me'/);
  await assert.rejects(() => g.m.guestFiles('buero', '/no-such'), /The VM answered: sh: 1: cd: can't cd to \/no-such$/);
  await g.m.guestMkdir('buero', { path: '/home/me', name: 'Neu' });
  assert.ok(g.calls.exec.some((c) => c.command.startsWith("mkdir -- '/home/me/Neu' && chown ")));
  assert.deepEqual(await g.m.guestDelete('buero', '/home/me/Neu'), { ok: true });
  await assert.rejects(() => g.m.guestDelete('buero', '/etc'), /belongs to the system/);
  assert.deepEqual(await g.m.guestUploadTarget('buero', '/srv/www', '../x.html'), { path: '/srv/www/x.html', ownerOf: '/srv/www' });
  assert.equal((await g.m.guestUploadTarget('buero', '', 'x.html')).owner, 'me', 'without a folder: the desktop/home as before');
  g.r.agentInfo = { ok: false };
  await assert.rejects(() => g.m.guestFiles('buero', '/'), /guest agent is not connected/);
});

test('manager: new password through the agent – never part of an error text', async () => {
  const g = managerWithGuest({ reply: () => ({ code: 0, out: 'root\nme\n', err: '' }), agentCall: async (cmd, a) => { if (a.username === 'ghost') throw new Error('child process has failed to set user password'); return {}; } });
  g.start();
  assert.deepEqual(await g.m.guestUsers('buero'), { users: ['root', 'me'] });
  assert.deepEqual(await g.m.guestSetPassword('buero', { user: 'me', password: 'Neu-4711' }), { ok: true, user: 'me' });
  assert.deepEqual(g.calls.agent[0], { cmd: 'guest-set-user-password', args: { username: 'me', password: Buffer.from('Neu-4711').toString('base64'), crypted: false } });
  await assert.rejects(() => g.m.guestSetPassword('buero', { user: 'ghost', password: 'Neu-4711' }), (e) => /refused the new password/.test(e.message) && !/Neu-4711/.test(e.message));
  await assert.rejects(() => g.m.guestSetPassword('buero', { user: 'me', password: '' }), /Password/);
});

test('OVA: description round-trips through the importer (CPU, memory, UEFI, system, disks)', () => {
  const vm = { name: 'Büro & <PC>', cpus: 4, memoryMb: 4096, firmware: 'uefi', osType: 'windows' };
  const xml = OVA.buildOvf(vm, [{ file: 'b-disk1.vmdk', size: 1000, capacity: 20 * 2 ** 30 }, { file: 'b-disk2.vmdk', size: 500, capacity: 5 * 2 ** 30 }]);
  assert.match(xml, /<Name>Büro &amp; &lt;PC&gt;<\/Name>/);
  const o = parseOvf(xml);
  assert.equal(o.name, 'Büro & <PC>'); assert.equal(o.cpus, 4); assert.equal(o.memoryMb, 4096); assert.equal(o.firmware, 'uefi'); assert.equal(o.osType, 'windows');
  assert.deepEqual(o.disks, [{ file: 'b-disk1.vmdk', capacity: 20 * 2 ** 30 }, { file: 'b-disk2.vmdk', capacity: 5 * 2 ** 30 }]);
  const lin = parseOvf(OVA.buildOvf({ name: 'l', cpus: 1, memoryMb: 512, firmware: 'bios', osType: 'linux' }, [{ file: 'l-disk1.vmdk', size: 1, capacity: 2 ** 30 }]));
  assert.equal(lin.firmware, 'bios'); assert.equal(lin.osType, 'linux');
  // the rasd elements of an item are in alphabetical order (OVF 1.0; VMware checks it)
  const first = xml.match(/<Item>([\s\S]*?)<\/Item>/)[1];
  const tags = [...first.matchAll(/<rasd:(\w+)>/g)].map((x) => x[1]);
  assert.deepEqual(tags, [...tags].sort());
  assert.equal(OVA.fileBase('Büro & <PC>'), 'Buro-PC'); assert.equal(OVA.fileBase('…'), 'vm');
  assert.equal(OVA.manifestText([{ name: 'a.ovf', sha256: 'ab' }]), 'SHA256(a.ovf)= ab\n');
});

test('OVA: the tar archive is read back by the importer – also the header of a file of 8 GiB and more', async () => {
  const dir = tmp();
  const big = crypto.randomBytes(70000);
  fs.writeFileSync(path.join(dir, 'd.vmdk'), big);
  const ova = path.join(dir, 'x.ova');
  let seen = 0;
  await OVA.writeTar(ova, [{ name: 'x.ovf', data: '<Envelope/>' }, { name: 'x-disk1.vmdk', path: path.join(dir, 'd.vmdk') }, { name: 'x.mf', data: 'SHA256(x.ovf)= 00\n' }], (n) => { seen = n; });
  assert.equal(fs.statSync(ova).size % 512, 0);
  assert.deepEqual(listTar(ova).map((e) => [e.name, e.size]), [['x.ovf', 11], ['x-disk1.vmdk', 70000], ['x.mf', 18]]);
  assert.equal(seen, 11 + 70000 + 18);
  const out = path.join(dir, 'out'); fs.mkdirSync(out);
  await extractTar(ova, out);
  assert.ok(fs.readFileSync(path.join(out, 'x-disk1.vmdk')).equals(big));
  assert.equal(fs.readFileSync(path.join(out, 'x.ovf'), 'utf8'), '<Envelope/>');
  // 9 GiB: size in base-256, read back by listTar (a file with only this header and no data)
  const h = OVA.tarHeader('huge.vmdk', 9 * 2 ** 30);
  assert.equal(h[124], 0x80);
  const f = path.join(dir, 'huge.tar'); fs.writeFileSync(f, Buffer.concat([h, Buffer.alloc(1024)]));
  assert.deepEqual(listTar(f).map((e) => [e.name, e.size]), [['huge.vmdk', 9 * 2 ** 30]]);
  assert.throws(() => OVA.tarHeader('n'.repeat(101), 1), /name too long/);
});

test('manager: the whole VM as an appliance – every disk, checksums that fit, no leftovers, not while running', async () => {
  const g = managerWithGuest({ osType: 'linux' });
  const dest = path.join(g.root, 'export', 'buero');
  await assert.rejects(async () => g.m.exportOva('buero', { dest }), /folder does not exist/);
  fs.mkdirSync(path.dirname(dest));
  g.start();
  await assert.rejects(async () => g.m.exportOva('buero', { dest }), /Shut the VM down first/);
  g.stop();
  const res = await g.m.exportOva('buero', { dest }).promise;
  assert.equal(res.path, `${dest}.ova`); assert.equal(res.disks, 2); assert.equal(res.decrypted, false);
  const entries = listTar(res.path);
  assert.deepEqual(entries.map((e) => e.name), ['Buro-PC.ovf', 'Buro-PC-disk1.vmdk', 'Buro-PC-disk2.vmdk', 'Buro-PC.mf']);
  const out = path.join(g.root, 'out'); fs.mkdirSync(out);
  await extractTar(res.path, out);
  const o = parseOvf(fs.readFileSync(path.join(out, 'Buro-PC.ovf'), 'utf8'));
  assert.equal(o.name, 'Büro PC'); assert.equal(o.cpus, 4); assert.equal(o.memoryMb, 4096); assert.equal(o.firmware, 'uefi');
  assert.deepEqual(o.disks, [{ file: 'Buro-PC-disk1.vmdk', capacity: 20 * 2 ** 30 }, { file: 'Buro-PC-disk2.vmdk', capacity: 20 * 2 ** 30 }]);
  const mf = fs.readFileSync(path.join(out, 'Buro-PC.mf'), 'utf8').trim().split('\n');
  assert.equal(mf.length, 3);
  for (const line of mf) { const [, name, sum] = /^SHA256\((.+)\)= ([0-9a-f]{64})$/.exec(line); assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex'), sum, name); }
  assert.ok(!fs.existsSync(path.join(g.m.dirOf('buero'), '.ova-export')), 'the working folder is gone');
  await assert.rejects(async () => g.m.exportOva('buero', { dest }), /exists already/);
});

test('graphics: more cards, video memory and start resolution – only where the card has them, old VMs unchanged', () => {
  const mk = (o) => ({ ...S.cleanVm({ name: 'g', id: 'g', disks: [{ id: 'disk0', file: 'd.qcow2' }], ...o }, { host: HOST }), id: 'g' });
  const opts = (vm) => { const a = buildArgs(vm, { dir: '/v', ports: { qmp: 1 } }); return { vga: a[a.indexOf('-vga') + 1], globals: a.filter((_, i) => a[i - 1] === '-global') }; };
  const plain = mk({});
  assert.ok(!('vramMb' in plain) && !('resolution' in plain));
  assert.deepEqual(opts(plain), { vga: 'std', globals: [] }, 'nothing chosen: the same arguments as before');
  assert.deepEqual(opts(mk({ vga: 'std', vramMb: 64, resolution: '1920X1080' })), { vga: 'std', globals: ['VGA.vgamem_mb=64', 'VGA.xres=1920', 'VGA.yres=1080'] });
  assert.deepEqual(opts(mk({ vga: 'qxl', vramMb: 128, resolution: '2560x1440' })), { vga: 'qxl', globals: ['qxl-vga.vgamem_mb=128', 'qxl-vga.xres=2560', 'qxl-vga.yres=1440'] });
  assert.deepEqual(opts(mk({ vga: 'vmware', vramMb: 32, resolution: '1280x720' })), { vga: 'vmware', globals: ['vmware-svga.vgamem_mb=32'] }, 'VMware SVGA has no preferred size');
  const virtio = mk({ vga: 'virtio', vramMb: 64, resolution: '1600x900' });
  assert.ok(!('vramMb' in virtio)); assert.deepEqual(opts(virtio), { vga: 'virtio', globals: ['virtio-vga.xres=1600', 'virtio-vga.yres=900'] });
  assert.deepEqual(opts(mk({ vga: 'cirrus', vramMb: 64, resolution: '1024x768' })), { vga: 'cirrus', globals: [] });
  // 3D in its own window: the gl device gets the size
  const gl = buildArgs(mk({ vga: 'virtio-gl', display: 'window', resolution: '1920x1080' }), { dir: '/v', ports: { qmp: 1 } });
  assert.ok(gl.includes('virtio-vga-gl') && gl.includes('virtio-vga-gl.xres=1920'));
  // switching to a card without the option drops it; "auto"/0 clear it
  const back = S.cleanVm({ vga: 'cirrus' }, { prev: mk({ vga: 'std', vramMb: 64, resolution: '1920x1080' }), host: HOST });
  assert.ok(!('vramMb' in back) && !('resolution' in back));
  const cleared = S.cleanVm({ vramMb: 0, resolution: 'auto' }, { prev: mk({ vga: 'std', vramMb: 64, resolution: '1920x1080' }), host: HOST });
  assert.ok(!('vramMb' in cleared) && !('resolution' in cleared));
  assert.throws(() => mk({ vramMb: 48 }), /Video memory/);
  for (const bad of ['1920', '100x100', '9999x9999', '1920x1080; rm']) assert.throws(() => mk({ resolution: bad }), /Resolution/);
  assert.equal(mk({ arch: 'aarch64', vga: 'qxl', disks: [{ id: 'disk0', file: 'd.qcow2', bus: 'virtio' }] }).vga, 'virtio', 'ARM keeps virtio graphics');
});
