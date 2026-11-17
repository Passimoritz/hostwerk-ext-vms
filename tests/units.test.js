'use strict';
/*
 * Pure building blocks: VM description, QEMU command line, ISO writer, cloud-init, catalog, keys, OVA/OVF, VirtualBox
 * output, QEMU detection. No program runs, nothing is downloaded.   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../server/spec');
const { buildArgs, cpuFor, hostfwdRule, hostfwdKey } = require('../server/qemu-args');
const { buildIso, readIso, primaryNames } = require('../server/iso');
const { seedFiles, cleanSeed, hostnameFrom } = require('../server/cloudinit');
const catalog = require('../server/catalog');
const K = require('../server/keys');
const { listTar, extractTar, parseOvf } = require('../server/importer');
const VB = require('../server/vbox');
const QH = require('../server/qemu-host');
const U = require('../server/util');

const HOST = { cpus: 8, memoryMb: 16384 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hw-vms-u-'));

/* ---------------- spec ---------------- */
test('spec: defaults per system, limits and clean names', () => {
  const l = S.cleanVm({ name: 'Web test', id: 'web-test' }, { host: HOST });
  assert.equal(l.osType, 'linux'); assert.equal(l.cpus, 2); assert.equal(l.memoryMb, 2048); assert.equal(l.net.model, 'virtio'); assert.equal(l.firmware, 'bios');
  assert.match(l.net.mac, /^52:54:00(:[0-9a-f]{2}){3}$/);
  const w = S.cleanVm({ name: 'Win', osType: 'windows', id: 'win' }, { host: HOST });
  assert.equal(w.firmware, 'uefi'); assert.equal(w.net.model, 'e1000e'); assert.equal(w.memoryMb, 8192);
  assert.throws(() => S.cleanVm({ name: '', id: 'x' }, { host: HOST }), /Name/);
  assert.throws(() => S.cleanVm({ name: 'a<b', id: 'x' }, { host: HOST }), /Name/);
  assert.throws(() => S.cleanVm({ name: 'x', cpus: 9 }, { host: HOST }), /CPU cores/);
  assert.throws(() => S.cleanVm({ name: 'x', memoryMb: 16000 }, { host: HOST }), /Memory/);
  assert.throws(() => S.cleanVm({ name: 'x', memoryMb: 64 }, { host: HOST }), /Memory/);
  assert.equal(S.cleanVm({ name: 'x', firmware: 'nonsense' }, { host: HOST }).firmware, 'bios');
});

test('spec: updates keep stored fields, MAC stays stable', () => {
  const a = S.cleanVm({ name: 'A', id: 'a', cpus: 3, notes: 'hi' }, { host: HOST });
  const b = S.cleanVm({ memoryMb: 4096 }, { prev: a, host: HOST });
  assert.equal(b.cpus, 3); assert.equal(b.notes, 'hi'); assert.equal(b.memoryMb, 4096); assert.equal(b.net.mac, a.net.mac); assert.equal(b.createdAt, a.createdAt);
  assert.equal(U.macFor('a'), U.macFor('a')); assert.notEqual(U.macFor('a'), U.macFor('b'));
});

test('spec: port forwards – range, duplicates, home network only when allowed', () => {
  assert.deepEqual(S.cleanForward({ proto: 'TCP', host: '2222', guest: 22, label: 'SSH' }), { id: 'tcp-2222', proto: 'tcp', host: 2222, guest: 22, bind: 'local', label: 'SSH' });
  assert.throws(() => S.cleanForward({ proto: 'tcp', host: 80, guest: 80 }), /1024/);
  assert.throws(() => S.cleanForward({ proto: 'icmp', host: 2000, guest: 1 }), /TCP or UDP/);
  assert.throws(() => S.cleanForward({ proto: 'tcp', host: 2000, guest: 70000 }), /65535/);
  assert.throws(() => S.cleanForward({ proto: 'tcp', host: 2000, guest: 22, bind: 'lan' }), (e) => e.status === 403);
  assert.equal(S.cleanForward({ proto: 'tcp', host: 2000, guest: 22, bind: 'lan' }, { lanAllowed: true }).bind, 'lan');
  assert.throws(() => S.checkForwards([{ proto: 'tcp', host: 2000, guest: 1 }, { proto: 'tcp', host: 2000, guest: 2 }]), (e) => e.status === 409);
  assert.equal(S.checkForwards([{ proto: 'tcp', host: 2000, guest: 1 }, { proto: 'udp', host: 2000, guest: 1 }]).length, 2);
});

test('spec: disks stay inside the VM folder, SATA ports are counted', () => {
  assert.throws(() => S.cleanDisk({ file: '../../evil.qcow2' }, 0), /disk file/);
  assert.throws(() => S.cleanDisk({ file: 'C:\\x.qcow2' }, 0), /disk file/);
  assert.deepEqual(S.cleanDisk({ id: 'disk3', file: 'data.qcow2', bus: 'nvme' }, 0), { id: 'disk3', file: 'data.qcow2', bus: 'nvme', format: 'qcow2' });
  const many = [0, 1, 2, 3, 4].map((i) => ({ id: `disk${i}`, file: `d${i}.qcow2`, bus: 'sata' }));
  assert.throws(() => S.cleanVm({ name: 'x', disks: many }, { host: HOST }), /SATA/);
  assert.throws(() => S.cleanVm({ name: 'x', disks: [{ id: 'disk0', file: 'a.qcow2' }, { id: 'disk0', file: 'b.qcow2' }] }, { host: HOST }), /twice/);
  assert.equal(S.diskBytes(20), 20 * 2 ** 30);
  assert.throws(() => S.diskBytes(0)); assert.throws(() => S.diskBytes(20000));
});

test('spec: snapshot names, memory check, public view', () => {
  assert.equal(S.checkSnapName(' before-update_1.2 '), 'before-update_1.2');
  for (const bad of ['', 'a b', '-x', 'x;rm', 'ä', 'x'.repeat(49)]) assert.throws(() => S.checkSnapName(bad));
  assert.equal(S.memoryCheck(4096, 2048, 16384).level, 'ok');
  assert.equal(S.memoryCheck(10000, 3000, 16384).level, 'warn');
  assert.equal(S.memoryCheck(14000, 2048, 16384).level, 'err');
  const v = S.publicVm({ id: 'a', snapshots: { b: { createdAt: 2 }, a: { createdAt: 1 } } });
  assert.deepEqual(v.snapshots.map((s) => s.name), ['a', 'b']);
});

test('util: slug, ids and QEMU escaping', () => {
  assert.equal(U.slug('Mein Größter Server!'), 'mein-groesster-serve');
  assert.equal(U.slug('web', new Set(['web'])), 'web-2');
  assert.match(U.slug('!!'), /^vm-/);
  assert.match(U.slug('123abc'), /^vm-123abc/);
  assert.throws(() => U.checkId('../x')); assert.throws(() => U.checkId('A')); assert.equal(U.checkId('ab'), 'ab');
  assert.equal(U.qesc('C:\\VMs,new\\a.iso'), 'C:\\VMs,,new\\a.iso');
});

/* ---------------- QEMU command line ---------------- */
const base = (o = {}) => ({ ...S.cleanVm({ name: 'Deb, test', id: 'deb', disks: [{ id: 'disk0', file: 'disk0.qcow2' }], ...o }, { host: HOST, lanAllowed: true }), id: 'deb' });
const val = (args, flag) => args.filter((_, i) => args[i - 1] === flag);

test('qemu-args: Linux VM with virtio, accelerators in order, control only on 127.0.0.1', () => {
  const vm = base({ net: { forwards: [{ proto: 'tcp', host: 2222, guest: 22 }] } });
  const a = buildArgs(vm, { dir: 'C:\\VMs\\deb', accel: ['whpx,kernel-irqchip=off', 'tcg'], ports: { qmp: 47100, qga: 47101, serial: 47102 }, platform: 'win32' });
  assert.deepEqual(val(a, '-accel'), ['whpx,kernel-irqchip=off', 'tcg']);
  assert.equal(val(a, '-cpu')[0], 'max');
  assert.equal(val(a, '-name')[0], 'guest=Deb,, test');
  assert.ok(a.includes('virtio-blk-pci,drive=disk0,bootindex=0'));
  assert.ok(val(a, '-drive').some((d) => d.startsWith(`if=none,id=disk0,file=${path.join('C:\\VMs\\deb', 'disk0.qcow2')},format=qcow2`)));
  assert.equal(val(a, '-netdev')[0], 'user,id=n0,hostfwd=tcp:127.0.0.1:2222-:22');
  assert.ok(val(a, '-device').includes(`virtio-net-pci,netdev=n0,mac=${vm.net.mac}`));
  assert.equal(val(a, '-qmp')[0], 'tcp:127.0.0.1:47100,server=on,wait=off');
  assert.ok(val(a, '-chardev').filter((c) => c.startsWith('socket')).every((c) => c.includes('host=127.0.0.1')));
  // clipboard (#6): QEMU's vdagent on the guest's spice channel, the tablet keeps the mouse
  assert.ok(val(a, '-chardev').includes('qemu-vdagent,id=vdagent,clipboard=on,mouse=off'));
  assert.ok(a.includes('virtserialport,bus=vser0.0,chardev=vdagent,name=com.redhat.spice.0'));
  assert.ok(!a.includes('ich9-intel-hda')); // no sound unless switched on
  assert.equal(val(a, '-display')[0], 'none');
  assert.ok(a.includes('usb-tablet,id=tablet0,bus=xhci.0'));
  assert.ok(!a.some((x) => /0\.0\.0\.0/.test(x)));
});

test('qemu-args: Windows on UEFI with SATA, e1000e, local time, ISO first when booting from CD', () => {
  const vm = base({ osType: 'windows', disks: [{ id: 'disk0', file: 'disk0.qcow2', bus: 'sata' }], cdrom: 'D:\\ISO\\Win 11,de.iso', boot: 'cdrom' });
  const a = buildArgs(vm, { dir: '/vms/w', accel: ['tcg'], firmware: { code: '/q/edk2-x86_64-code.fd', vars: '/q/vars.fd' }, ports: { qmp: 1 }, platform: 'linux' });
  assert.equal(val(a, '-machine')[0], 'q35,hpet=off');
  assert.ok(val(a, '-rtc')[0].startsWith('base=localtime'));
  assert.ok(val(a, '-drive').includes('if=pflash,format=raw,unit=0,readonly=on,file=/q/edk2-x86_64-code.fd'));
  assert.ok(val(a, '-drive').some((d) => d.startsWith('if=pflash,format=raw,unit=1,file=') && d.endsWith('vars.fd')));
  assert.ok(a.includes('ide-hd,drive=disk0,bus=ide.0,bootindex=1'));
  assert.ok(a.includes('ide-cd,id=cdrom0,drive=cd0,bus=ide.1,bootindex=0'));
  assert.ok(val(a, '-drive').some((d) => d.includes('file=D:\\ISO\\Win 11,,de.iso')));
  assert.ok(val(a, '-device').some((d) => d.startsWith('e1000e,netdev=n0')));
  assert.throws(() => buildArgs(vm, { dir: '/x', ports: { qmp: 1 } }), /UEFI/);
});

test('qemu-args: empty CD drive, seed disc, NVMe, own window, KVM with host CPU, loadvm, home network', () => {
  const vm = base({ display: 'window', disks: [{ id: 'disk0', file: 'disk0.qcow2', bus: 'nvme' }], net: { forwards: [{ proto: 'udp', host: 27015, guest: 27015, bind: 'lan' }] } });
  vm.seed = 'seed.iso';
  const a = buildArgs(vm, { dir: '/v', accel: ['kvm', 'tcg'], ports: { qmp: 1 }, platform: 'linux', lanAllowed: true, loadvm: 'snap1' });
  assert.ok(val(a, '-drive').includes('if=none,id=cd0,media=cdrom,readonly=on'));
  assert.ok(a.includes('ide-cd,id=cdrom0,drive=cd0,bus=ide.0'));
  // Linux: seed as read-only virtio disk (cloud kernels lack SATA-CD drivers); other systems: SATA CD
  assert.ok(val(a, '-drive').some((d) => d.startsWith('if=none,id=seed,format=raw,readonly=on,file=')));
  assert.ok(a.includes('virtio-blk-pci,drive=seed'));
  assert.ok(buildArgs({ ...vm, osType: 'other' }, { dir: '/v', ports: { qmp: 1 } }).includes('ide-cd,id=seedcd,drive=seed,bus=ide.1'));
  assert.ok(a.includes('nvme,drive=disk0,serial=hw-disk0,bootindex=0'));
  assert.equal(val(a, '-display')[0], 'gtk');
  assert.equal(val(a, '-cpu')[0], 'host');
  assert.equal(val(a, '-loadvm')[0], 'snap1');
  assert.equal(val(a, '-netdev')[0], 'user,id=n0,hostfwd=udp:0.0.0.0:27015-:27015');
  assert.equal(val(buildArgs(vm, { dir: '/v', ports: { qmp: 1 }, lanAllowed: false }), '-netdev')[0], 'user,id=n0,hostfwd=udp:127.0.0.1:27015-:27015');
  assert.equal(val(buildArgs(vm, { dir: '/v', ports: { qmp: 1 }, platform: 'win32' }), '-display')[0], 'sdl');
  assert.equal(val(buildArgs({ ...vm, net: { mode: 'none' } }, { dir: '/v', ports: { qmp: 1 } }), '-netdev').length, 0);
  assert.equal(cpuFor(['hvf']), 'host'); assert.equal(cpuFor(['tcg']), 'max');
  assert.equal(hostfwdRule({ proto: 'tcp', host: 8080, guest: 80, bind: 'lan' }, false), 'tcp:127.0.0.1:8080-:80');
  assert.equal(hostfwdKey({ proto: 'tcp', host: 8080, guest: 80, bind: 'lan' }, true), 'tcp:0.0.0.0:8080');
  assert.throws(() => buildArgs(vm, { ports: { qmp: 1 } }), /dir/);
  assert.throws(() => buildArgs(vm, { dir: '/v', ports: {} }), /qmp/);
});

/* ---------------- ISO ---------------- */
test('iso: cidata seed with Joliet names round-trips; primary names are 8.3', () => {
  const files = { 'user-data': '#cloud-config\nhostname: "x"\n', 'meta-data': 'instance-id: "i-1"\n', 'network-config': 'version: 2\n' };
  const iso = buildIso({ volume: 'cidata', files });
  assert.equal(iso.length % 2048, 0);
  assert.equal(iso.toString('ascii', 16 * 2048 + 1, 16 * 2048 + 6), 'CD001');
  assert.equal(iso.toString('ascii', 17 * 2048 + 88, 17 * 2048 + 91), '%/E');
  assert.equal(iso[18 * 2048], 255);
  const r = readIso(iso);
  assert.equal(r.joliet, true);
  assert.equal(r.volume, 'cidata');
  for (const [k, v] of Object.entries(files)) assert.equal(r.files[k].toString(), v);
  assert.deepEqual(primaryNames(['user-data', 'meta-data', 'network-config']), ['USER_DAT.;1', 'META_DAT.;1', 'NETWORK_.;1']);
  assert.deepEqual(primaryNames(['abcdefghij', 'abcdefghik']), ['ABCDEFGH.;1', 'ABCDEFG1.;1']);
  const big = Buffer.alloc(5000, 7);
  assert.deepEqual(readIso(buildIso({ files: { 'big.bin': big } })).files['big.bin'], big);
  assert.throws(() => buildIso({ files: { '../x': 'a' } }));
  assert.throws(() => readIso(Buffer.alloc(100)));
});

/* ---------------- cloud-init ---------------- */
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq0Qw9b0vW9v1g2fakeKeyFORtestsOnly0000 me@pc';
test('cloud-init: user, password, keys, agent – every value safely quoted', () => {
  const f = seedFiles({ hostname: 'Web Test', user: 'demo', password: 'p"a$s\'w:rd #1', sshKeys: [KEY], timezone: 'Europe/Berlin', instanceId: 'hw-1' });
  assert.equal(f['meta-data'], 'instance-id: "hw-1"\nlocal-hostname: "web-test"\n');
  const u = f['user-data'];
  assert.ok(u.startsWith('#cloud-config\n'));
  assert.ok(u.includes('  - name: "demo"'));
  assert.ok(u.includes(`      password: ${JSON.stringify('p"a$s\'w:rd #1')}`));
  assert.ok(u.includes(`      - ${JSON.stringify(KEY)}`));
  assert.ok(u.includes('lock_passwd: false') && u.includes('ssh_pwauth: true'));
  assert.ok(u.includes('  - "qemu-guest-agent"') && u.includes('timezone: "Europe/Berlin"'));
  const only = seedFiles({ hostname: 'k', user: 'u1', sshKeys: KEY });
  assert.ok(only['user-data'].includes('lock_passwd: true') && only['user-data'].includes('ssh_pwauth: false') && !only['user-data'].includes('chpasswd'));
});

test('cloud-init: refuses what could break the guest or lock everybody out', () => {
  assert.throws(() => cleanSeed({ hostname: 'x', user: 'root', password: 'secret1' }), /User name/);
  assert.throws(() => cleanSeed({ hostname: 'x', user: 'Bad User', password: 'secret1' }), /User name/);
  assert.throws(() => cleanSeed({ hostname: 'x', user: 'u', password: 'abc' }), /Password/);
  assert.throws(() => cleanSeed({ hostname: 'x', user: 'u', password: 'secret\nroot:x' }), /Password/);
  assert.throws(() => cleanSeed({ hostname: 'x', user: 'u' }), /password or an SSH key/);
  assert.throws(() => cleanSeed({ hostname: 'x', user: 'u', sshKeys: 'not a key' }), /SSH key/);
  assert.throws(() => cleanSeed({ hostname: 'x', user: 'u', password: 'secret1', packages: ['vim; rm -rf /'] }), /package/);
  assert.equal(cleanSeed({ hostname: 'x', user: 'u', password: 'secret1', timezone: 'x"; evil' }).timezone, null);
  assert.equal(hostnameFrom('  ÄÖ !! '), 'vm');
  assert.equal(hostnameFrom('My Server 2'), 'my-server-2');
});

/* ---------------- catalog ---------------- */
test('catalog: checksum lists in every common form', () => {
  const m = catalog.parseSums([
    `${'a'.repeat(128)}  debian-12-genericcloud-amd64.qcow2`,
    `${'b'.repeat(64)} *noble-server-cloudimg-amd64.img`,
    `SHA256 (AlmaLinux-9-GenericCloud-latest.x86_64.qcow2) = ${'c'.repeat(64)}`,
    '# comment', '',
  ].join('\n'));
  assert.equal(m.get('debian-12-genericcloud-amd64.qcow2'), 'a'.repeat(128));
  assert.equal(m.get('noble-server-cloudimg-amd64.img'), 'b'.repeat(64));
  assert.equal(m.get('AlmaLinux-9-GenericCloud-latest.x86_64.qcow2'), 'c'.repeat(64));
});

test('catalog: resolve picks the right file and hash for every kind', async () => {
  const fetchText = async (url) => {
    if (url.endsWith('bookworm/latest/SHA512SUMS')) return `${'d'.repeat(128)}  debian-12-genericcloud-amd64.qcow2\n${'e'.repeat(128)}  debian-12-generic-amd64.qcow2\n`;
    if (url.endsWith('latest-releases.yaml')) return `---\n-\n  title: "Standard"\n  flavor: "alpine-standard"\n  file: "alpine-standard-3.22.2-x86_64.iso"\n  sha256: "${'1'.repeat(64)}"\n-\n  title: "Virtual"\n  flavor: "alpine-virt"\n  version: "3.22.2"\n  file: "alpine-virt-3.22.2-x86_64.iso"\n  sha256: "${'2'.repeat(64)}"\n`;
    if (url.endsWith('iso-cd/SHA256SUMS')) return `${'3'.repeat(64)}  debian-13.2.0-amd64-netinst.iso\n${'4'.repeat(64)}  debian-edu-13.2.0-amd64-netinst.iso\n`;
    if (url.endsWith('releases.json')) return JSON.stringify([{ version: '43', arch: 'x86_64', variant: 'Cloud', subvariant: 'Cloud_Base', link: 'https://dl.fedoraproject.org/x/Fedora-Cloud-Base-Generic-43-1.6.x86_64.qcow2', sha256: '5'.repeat(64) }, { version: '42', arch: 'x86_64', variant: 'Cloud', subvariant: 'Cloud_Base', link: 'https://dl/x/F42.qcow2', sha256: '6'.repeat(64) }, { version: '43', arch: 'aarch64', variant: 'Cloud', subvariant: 'Cloud_Base', link: 'https://x/a.qcow2', sha256: '7'.repeat(64) }]);
    throw new Error(`unexpected ${url}`);
  };
  const deb = await catalog.resolve(catalog.get('debian-12'), { fetchText });
  assert.deepEqual([deb.file, deb.hash, deb.algo], ['debian-12-genericcloud-amd64.qcow2', 'd'.repeat(128), 'sha512']);
  const alp = await catalog.resolve(catalog.get('alpine-virt'), { fetchText });
  assert.deepEqual([alp.file, alp.hash], ['alpine-virt-3.22.2-x86_64.iso', '2'.repeat(64)]);
  assert.ok(alp.url.startsWith('https://dl-cdn.alpinelinux.org/'));
  const net = await catalog.resolve(catalog.get('debian-netinst'), { fetchText });
  assert.equal(net.file, 'debian-13.2.0-amd64-netinst.iso');
  const fed = await catalog.resolve(catalog.get('fedora'), { fetchText });
  assert.deepEqual([fed.version, fed.hash], ['43', '5'.repeat(64)]);
  await assert.rejects(catalog.resolve(catalog.get('windows-11'), { fetchText }), /cannot be downloaded/);
  await assert.rejects(catalog.resolve(catalog.get('debian-13'), { fetchText: async () => 'nothing' }), /Checksum/);
  for (const e of catalog.list()) { assert.ok(!e.url || e.url.startsWith('https://'), e.id); assert.ok(e.label && e.kind, e.id); }
});

/* ---------------- keys ---------------- */
test('keys: physical keys, text typing, events for QMP', () => {
  assert.equal(K.qcodeOf('KeyQ'), 'q'); assert.equal(K.qcodeOf('Digit0'), '0'); assert.equal(K.qcodeOf('Enter'), 'ret'); assert.equal(K.qcodeOf('IntlBackslash'), 'less'); assert.equal(K.qcodeOf('Nope'), null);
  assert.deepEqual(K.textToKeys('aB!\n'), [['a'], ['shift', 'b'], ['shift', '1'], ['ret']]);
  assert.throws(() => K.textToKeys('ä'), /US keyboard/);
  const ev = K.toQmpEvents([{ t: 'm', x: 0.5, y: 2 }, { t: 'b', b: 'left', d: true }, { t: 'k', c: 'KeyA', d: false }, { t: 'k', c: 'Bogus', d: true }, { t: 'b', b: 'evil' }, null]);
  assert.deepEqual(ev, [
    { type: 'abs', data: { axis: 'x', value: 16384 } }, { type: 'abs', data: { axis: 'y', value: 32767 } },
    { type: 'btn', data: { down: true, button: 'left' } }, { type: 'key', data: { down: false, key: { type: 'qcode', data: 'a' } } },
  ]);
  assert.equal(K.toQmpEvents(new Array(500).fill({ t: 'b', b: 'left', d: true })).length, 200);
});

/* ---------------- OVA / OVF ---------------- */
function tarEntry(name, data) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136); h.write('        ', 148); h[156] = 48; h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b; h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const OVF = `<?xml version="1.0"?><Envelope xmlns="http://schemas.dmtf.org/ovf/envelope/1" xmlns:ovf="http://schemas.dmtf.org/ovf/envelope/1" xmlns:rasd="x" xmlns:vbox="y">
<References><File ovf:id="file1" ovf:href="Test VM-disk001.vmdk"/></References>
<DiskSection><Disk ovf:capacity="20" ovf:capacityAllocationUnits="byte * 2^30" ovf:diskId="vmdisk1" ovf:fileRef="file1" ovf:format="vmdk"/></DiskSection>
<VirtualSystem ovf:id="Test VM"><Name>Test &amp; VM</Name><OperatingSystemSection ovf:id="96"><Description>Debian_64</Description><vbox:OSType ovf:required="false">Debian_64</vbox:OSType></OperatingSystemSection>
<VirtualHardwareSection><Item><rasd:ResourceType>3</rasd:ResourceType><rasd:VirtualQuantity>4</rasd:VirtualQuantity></Item>
<Item><rasd:AllocationUnits>MegaBytes</rasd:AllocationUnits><rasd:ResourceType>4</rasd:ResourceType><rasd:VirtualQuantity>3072</rasd:VirtualQuantity></Item></VirtualHardwareSection>
<vbox:Machine><Hardware><Platform><Firmware type="EFI"/></Platform></Hardware></vbox:Machine></VirtualSystem></Envelope>`;

test('importer: OVF values and a tar (OVA) without leaving the target folder', async () => {
  const o = parseOvf(OVF);
  assert.deepEqual(o, { name: 'Test & VM', cpus: 4, memoryMb: 3072, osType: 'linux', firmware: 'uefi', disks: [{ file: 'Test VM-disk001.vmdk', capacity: 20 * 2 ** 30 }] });
  const d = tmp();
  const ova = path.join(d, 'a.ova');
  fs.writeFileSync(ova, Buffer.concat([tarEntry('Test VM.ovf', Buffer.from(OVF)), tarEntry('Test VM-disk001.vmdk', Buffer.alloc(1300, 1)), tarEntry('../../evil.vmdk', Buffer.from('x')), Buffer.alloc(1024)]));
  assert.deepEqual(listTar(ova).map((e) => [e.name, e.size]), [['Test VM.ovf', Buffer.byteLength(OVF)], ['Test VM-disk001.vmdk', 1300], ['../../evil.vmdk', 1]]);
  const out = path.join(d, 'out'); fs.mkdirSync(out);
  const got = await extractTar(ova, out, (n) => /\.(ovf|vmdk)$/.test(n));
  assert.deepEqual(got.sort(), ['Test VM-disk001.vmdk', 'Test VM.ovf', 'evil.vmdk'].sort());
  assert.ok(!fs.existsSync(path.join(d, 'evil.vmdk')));
  assert.equal(fs.statSync(path.join(out, 'Test VM-disk001.vmdk')).size, 1300);
});

/* ---------------- VirtualBox ---------------- */
const MR = [
  'name="Test, VM"', 'ostype="Ubuntu (64-bit)"', 'UUID="0C4F5E2A-7B1D-4E3A-9C2F-1A2B3C4D5E6F"', 'CfgFile="C:\\\\VMs\\\\Test\\\\Test.vbox"', 'memory=4096', 'firmware="EFI"', 'cpus=2',
  'VMState="poweroff"', 'VMStateChangeTime="2026-08-13T21:47:24.000000000"',
  '"SATA-0-0"="C:\\\\VMs\\\\Test\\\\Test.vdi"', '"SATA-ImageUUID-0-0"="46264e42-047d-442f-bbb5-4f2e991b2fdb"', '"SATA-nonrotational-0-0"="off"',
  '"SATA-1-0"="C:\\\\Downloads\\\\ubuntu.iso"', '"IDE-0-1"="emptydrive"', '"SATA-2-0"="none"',
  'Forwarding(0)="ssh,tcp,,2222,,22"', 'nic1="nat"',
  'SnapshotName="base"', 'SnapshotUUID="11111111-1111-1111-1111-111111111111"', 'SnapshotName-1="after \\"update\\""', 'SnapshotUUID-1="22222222-2222-2222-2222-222222222222"', 'SnapshotDescription-1="ok"',
  'CurrentSnapshotName="after \\"update\\""', 'description="line"',
].join('\r\n');

test('vbox: machine-readable output, disks, ISOs, forwards and snapshot tree', () => {
  const m = VB.parseMachineReadable(MR);
  assert.equal(m.name, 'Test, VM'); assert.equal(m['SATA-0-0'], 'C:\\VMs\\Test\\Test.vdi');
  const vm = VB.vmFromInfo(m);
  assert.equal(vm.uuid, '0c4f5e2a-7b1d-4e3a-9c2f-1a2b3c4d5e6f'); assert.equal(vm.state, 'stopped'); assert.equal(vm.firmware, 'uefi'); assert.equal(vm.memoryMb, 4096);
  assert.deepEqual(vm.disks, [{ controller: 'SATA', port: 0, device: 0, path: 'C:\\VMs\\Test\\Test.vdi' }]);
  assert.deepEqual(vm.dvds.map((x) => x.path), ['C:\\Downloads\\ubuntu.iso']);
  assert.deepEqual(vm.forwards, [{ name: 'ssh', proto: 'tcp', hostIp: '', host: 2222, guestIp: '', guest: 22 }]);
  assert.deepEqual(vm.snapshots.map((s) => [s.name, s.depth, s.parent]), [['base', 0, null], ['after "update"', 1, 'base']]);
  assert.equal(vm.currentSnapshot, 'after "update"');
  assert.equal(vm.stateSince, Date.parse('2026-08-13T21:47:24.000Z'));
  assert.deepEqual(VB.parseList('"Mac Test" {0c4f5e2a-7b1d-4e3a-9c2f-1a2b3c4d5e6f}\n"a b" {11111111-1111-1111-1111-111111111111}\nnoise'), [{ name: 'Mac Test', uuid: '0c4f5e2a-7b1d-4e3a-9c2f-1a2b3c4d5e6f' }, { name: 'a b', uuid: '11111111-1111-1111-1111-111111111111' }]);
  assert.equal(VB.osTypeOf('Windows11_64'), 'windows'); assert.equal(VB.osTypeOf('Ubuntu (64-bit)'), 'linux'); assert.equal(VB.osTypeOf('Mac OS X (64-bit)'), 'other');
});

test('vbox: commands go to VBoxManage as arguments; foreign VMs are never deleted', async () => {
  const calls = [];
  const managed = new Set();
  const run = async (exe, args) => {
    calls.push(args);
    if (args[0] === 'showvminfo') return { code: 0, stdout: MR, stderr: '' };
    if (args[0] === 'getextradata') return { code: 0, stdout: managed.has(args[1]) ? 'Value: 1' : 'No value set!', stderr: '' };
    if (args[0] === 'list') return { code: 0, stdout: '"Test, VM" {0c4f5e2a-7b1d-4e3a-9c2f-1a2b3c4d5e6f}\n', stderr: '' };
    if (args[0] === 'startvm' && args[1] === '11111111-1111-1111-1111-111111111111') return { code: 1, stdout: '', stderr: 'VBoxManage.exe: error: Could not find a registered machine' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const v = new VB.VBox({ run, platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists: (p) => /VBoxManage/.test(p) });
  assert.equal(v.locate(), path.join('C:\\Program Files', 'Oracle', 'VirtualBox', 'VBoxManage.exe'));
  const id = '0c4f5e2a-7b1d-4e3a-9c2f-1a2b3c4d5e6f';
  await v.start(id);
  await v.control(id, 'acpi');
  await v.snapshot(id, 'take', 'before', { description: 'x' });
  await assert.rejects(v.control(id, 'format-c'), /Unknown action/);
  await assert.rejects(v.start('../../x'), /Invalid VirtualBox id/);
  await assert.rejects(v.snapshot(id, 'take', 'a"b'), /Invalid snapshot name/);
  await assert.rejects(v.start('11111111-1111-1111-1111-111111111111'), /Could not find a registered machine/);
  await assert.rejects(v.removeManaged(id), (e) => e.status === 403);
  assert.ok(!calls.some((c) => c[0] === 'unregistervm'));
  managed.add(id);
  await v.removeManaged(id);
  assert.deepEqual(calls.find((c) => c[0] === 'startvm'), ['startvm', id, '--type', 'headless']);
  assert.deepEqual(calls.find((c) => c[0] === 'controlvm'), ['controlvm', id, 'acpipowerbutton']);
  // no --live: live snapshots hang when VirtualBox runs on Hyper-V
  assert.deepEqual(calls.find((c) => c[0] === 'snapshot'), ['snapshot', id, 'take', 'before', '--description', 'x']);
  assert.equal(await v.isDifferencing('C:\\VMs\\Test\\Snapshots\\{e6d3fac8-bea3-48d3-a92f-cc958bebfad3}.vdi'), false); // showmediuminfo answered without a parent
  assert.equal(await new VB.VBox({ run: async () => ({ code: 0, stdout: 'UUID: x\nParent UUID: 1234\n' }), platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists: () => true }).isDifferencing('a.vdi'), true);
  assert.deepEqual(calls.find((c) => c[0] === 'unregistervm'), ['unregistervm', id, '--delete']);
  assert.equal((await v.list())[0].name, 'Test, VM');
  assert.deepEqual(await new VB.VBox({ run, platform: 'win32', env: {}, exists: () => false }).list(), []);
});

/* ---------------- QEMU on this PC ---------------- */
test('qemu-host: finding QEMU, accelerator order, version and disk info', async () => {
  const pf = 'C:\\Program Files';
  const q = path.join(pf, 'qemu');
  const files = new Set([path.join(q, 'qemu-system-x86_64.exe'), path.join(q, 'qemu-img.exe'), path.join(q, 'share', 'edk2-x86_64-code.fd'), path.join(q, 'share', 'edk2-i386-vars.fd')]);
  const exists = (p) => files.has(p);
  assert.deepEqual(QH.locate({ env: { ProgramFiles: pf }, platform: 'win32', exists }), { dir: q, system: path.join(q, 'qemu-system-x86_64.exe'), img: path.join(q, 'qemu-img.exe') });
  assert.equal(QH.locate({ env: {}, platform: 'win32', exists: () => false }), null);
  assert.deepEqual(QH.findFirmware(q, { exists }), { code: path.join(q, 'share', 'edk2-x86_64-code.fd'), vars: path.join(q, 'share', 'edk2-i386-vars.fd') });
  assert.deepEqual(QH.preferredAccels('win32', ['tcg', 'whpx']), ['whpx,kernel-irqchip=off', 'tcg']);
  assert.deepEqual(QH.preferredAccels('win32', ['tcg']), ['tcg']);
  assert.deepEqual(QH.preferredAccels('linux', ['kvm', 'tcg']), ['kvm', 'tcg']);
  assert.deepEqual(QH.parseAccelHelp('Accelerators supported in QEMU binary:\r\ntcg\r\nwhpx\r\n'), ['tcg', 'whpx']);
  assert.equal(QH.parseVersion('QEMU emulator version 11.1.0 (v11.1.0-12130-ge470268ff4)'), '11.1.0');
  assert.equal(QH.formatOf('a.VDI'), 'vdi'); assert.equal(QH.formatOf('a.vhd'), 'vpc'); assert.equal(QH.formatOf('a.img'), null);
  const info = QH.parseInfo({ format: 'qcow2', 'virtual-size': 10, 'actual-size': 5, 'full-backing-filename': '/t/disk0.qcow2', snapshots: [{ name: 's', 'date-sec': 2, 'vm-state-size': 0 }] });
  assert.deepEqual(info, { format: 'qcow2', virtualSize: 10, actualSize: 5, backing: '/t/disk0.qcow2', snapshots: [{ name: 's', date: 2000, vmStateSize: 0 }] });
  const run = async (exe, args) => (args[0] === '--version' ? { code: 0, stdout: 'QEMU emulator version 11.1.0' } : args[0] === '-accel' ? { code: 0, stdout: 'Accelerators supported in QEMU binary:\ntcg\nwhpx\n' } : { code: 1, stderr: 'qemu-img.exe: Could not open \'x\': No such file' });
  const h1 = new QH.QemuHost({ run, platform: 'win32', env: { ProgramFiles: pf }, exists, probe: async () => ({ ok: true }) });
  const i1 = await h1.info();
  assert.deepEqual([i1.accel, i1.accelArgs, i1.ramSnapshots, i1.version], ['whpx', ['whpx,kernel-irqchip=off', 'tcg'], false, '11.1.0']);
  await assert.rejects(h1.diskInfo('x'), /Could not open 'x'/);
  const h2 = new QH.QemuHost({ run, platform: 'win32', env: { ProgramFiles: pf }, exists, probe: async () => ({ ok: false, text: 'WHPX: No accelerator found' }) });
  const i2 = await h2.info();
  assert.deepEqual([i2.accel, i2.accelArgs, i2.ramSnapshots, i2.accelNote], ['tcg', ['tcg'], true, 'WHPX: No accelerator found']);
  const h3 = new QH.QemuHost({ run, platform: 'win32', env: {}, exists: () => false });
  assert.deepEqual(await h3.info(), { installed: false, platform: 'win32' });
  await assert.rejects(h3.img(), (e) => e.code === 'NO_QEMU' && e.status === 428);
  assert.equal(QH.installPlan('win32').method, 'winget'); assert.match(QH.installPlan('linux').command, /apt/);
});
