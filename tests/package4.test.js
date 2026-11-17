'use strict';
/*
 * Package 4 of the roadmap: internal networks between VMs (#7, a switch on 127.0.0.1), shared folders PC → VM (#13,
 * WebDAV on 127.0.0.1), network bridge through a TAP adapter (#14, detection only), encrypted disks (#15, qcow2 LUKS,
 * key sealed by Hostwerk and handed to QEMU in a short-lived file), moving a VM to another PC (#16, Hostwerk's
 * kind.copy). No QEMU, no downloads – UDP and HTTP run for real on 127.0.0.1.   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const S = require('../server/spec');
const U = require('../server/util');
const { buildArgs } = require('../server/qemu-args');
const { Switches } = require('../server/netswitch');
const dav = require('../server/webdav');
const tap = require('../server/tap');
const { networkConfig, seedFiles } = require('../server/cloudinit');
const QH = require('../server/qemu-host');
const { VmManager } = require('../server/manager');
const { Runtime } = require('../server/runtime');
const { vmKind } = require('../server/kind');

const HOST = { cpus: 8, memoryMb: 16384 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hw-vms-p4-'));
const noRun = async () => ({ code: 0, stdout: '', stderr: '' }); // icacls & co. in tests

/* ---------------- spec ---------------- */
test('#7 spec: up to two internal networks, MAC fixed per VM and network, addresses checked', () => {
  const vm = S.cleanVm({ name: 'a', id: 'a', nets: [{ net: 'lab', ip: '10.10.1.5' }, { net: 'dmz' }] }, { host: HOST });
  assert.deepEqual(vm.nets.map((n) => [n.net, n.ip]), [['lab', '10.10.1.5/24'], ['dmz', null]]);
  assert.equal(vm.nets[0].mac, U.macFor('a/lab'));
  assert.notEqual(vm.nets[0].mac, vm.nets[1].mac);
  assert.equal(S.cleanVm({ name: 'a', id: 'a', nets: [{ net: 'lab' }] }, { host: HOST }).nets[0].mac, vm.nets[0].mac); // deterministic
  assert.throws(() => S.cleanVm({ name: 'a', nets: [{ net: 'x1' }, { net: 'x2' }, { net: 'x3' }] }, { host: HOST }), /at most 2 internal networks/);
  assert.throws(() => S.cleanVm({ name: 'a', nets: [{ net: 'lab' }, { net: 'lab' }] }, { host: HOST }), /twice/);
  for (const bad of ['10.10.1.0/24', '10.10.1.255/24', '127.0.0.1', '300.1.1.1', '10.1.1.1/31', 'x']) assert.throws(() => S.checkCidr(bad), /IP address/, bad);
  assert.equal(S.checkCidr('192.168.50.7/16'), '192.168.50.7/16');
});

test('#13/#14/#15 spec: shares checked, bridge needs a TAP adapter, encryption never from the interface', () => {
  const vm = S.cleanVm({ name: 's', shares: [{ name: 'Projekte', path: 'C:\\Daten\\Projekte' }, { name: 'Musik', path: '/home/x/Musik', readOnly: false }] }, { host: HOST });
  assert.deepEqual(vm.shares.map((s) => [s.id, s.readOnly, s.auto, dav.TOKEN_RE.test(s.token)]), [['share0', true, true, true], ['share1', false, true, true]]);
  const again = S.cleanVm({ shares: vm.shares }, { prev: vm, host: HOST });
  assert.deepEqual(again.shares.map((s) => s.token), vm.shares.map((s) => s.token)); // tokens stay
  assert.throws(() => S.cleanVm({ name: 's', shares: [{ name: 'a', path: 'relative/x' }] }, { host: HOST }), /folder on this PC/);
  assert.throws(() => S.cleanVm({ name: 's', shares: [{ name: 'a/b', path: 'C:\\x' }] }, { host: HOST }), /Share name/);
  assert.throws(() => S.cleanVm({ name: 's', shares: [{ name: 'a', path: 'C:\\x' }, { name: 'A', path: 'C:\\y' }] }, { host: HOST }), /exists already/);
  assert.throws(() => S.cleanVm({ name: 's', shares: Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, path: 'C:\\x' })) }, { host: HOST }), /At most 4/);
  assert.throws(() => S.cleanVm({ name: 'b', net: { mode: 'bridge' } }, { host: HOST }), /TAP adapter/);
  const br = S.cleanVm({ name: 'b', net: { mode: 'bridge', tap: 'OpenVPN TAP-Windows6' } }, { host: HOST });
  assert.deepEqual([br.net.mode, br.net.tap], ['bridge', 'OpenVPN TAP-Windows6']);
  assert.equal(S.cleanVm({ net: { mode: 'user' } }, { prev: br, host: HOST }).net.tap, undefined);
  assert.equal(S.cleanVm({ name: 'e', encryption: { format: 'luks', key: 'plain!' } }, { host: HOST }).encryption, null);
  const enc = { ...S.cleanVm({ name: 'e', disks: [{ id: 'disk0', file: 'disk0.qcow2', encrypted: true }] }, { host: HOST }) };
  assert.equal(enc.disks[0].encrypted, true);
  assert.equal(S.cleanDisk({ id: 'disk1', file: 'd.vdi', format: 'vdi', encrypted: true }, 1).encrypted, undefined); // only qcow2
});

/* ---------------- QEMU command line ---------------- */
test('args: internal networks as dgram NICs to the switch, bridge through TAP, encrypted disks with a key file', () => {
  const base = { ...S.cleanVm({ name: 'n', id: 'n', disks: [{ id: 'disk0', file: 'disk0.qcow2', encrypted: true }, { id: 'disk1', file: 'disk1.qcow2' }], nets: [{ net: 'lab' }] }, { host: HOST }), id: 'n' };
  assert.throws(() => buildArgs(base, { dir: '/v', ports: { qmp: 1 } }), /key of the encrypted disk is missing/);
  const a = buildArgs(base, { dir: '/v', ports: { qmp: 1 }, keyFile: 'C:\\v,1\\.hwkey-abc', nets: [{ local: 47001, remote: 47002, mac: base.nets[0].mac }] });
  const val = (flag) => a.filter((_, i) => a[i - 1] === flag);
  assert.deepEqual(val('-object'), ['secret,id=hwkey0,file=C:\\v,,1\\.hwkey-abc']);
  const drives = val('-drive');
  assert.match(drives[0], /id=disk0,.*format=qcow2,encrypt\.format=luks,encrypt\.key-secret=hwkey0,/);
  assert.doesNotMatch(drives[1], /encrypt/);
  assert.ok(val('-netdev').includes('dgram,id=in0,local.type=inet,local.host=127.0.0.1,local.port=47001,remote.type=inet,remote.host=127.0.0.1,remote.port=47002'));
  assert.ok(val('-device').includes(`virtio-net-pci,netdev=in0,mac=${base.nets[0].mac}`));
  assert.ok(!a.join(' ').includes('230.0.0'), 'no multicast (does not work on Windows)');
  const br = buildArgs({ ...base, disks: [], net: { ...base.net, mode: 'bridge', tap: 'TAP, LAN', forwards: [{ id: 'ssh', proto: 'tcp', host: 2222, guest: 22, bind: 'local' }] } }, { dir: '/v', ports: { qmp: 1 } });
  assert.ok(br.includes('tap,id=n0,ifname=TAP,, LAN'));
  assert.ok(!br.join(' ').includes('hostfwd'), 'no forwarding in bridge mode');
});

test('qemu-img with a key: --object secret from a file, --image-opts, never the key itself', async () => {
  const calls = [];
  const h = new QH.QemuHost({ run: async (exe, args) => { calls.push(args); return { code: 0, stdout: '{"virtual-size":1,"format":"qcow2","encrypted":true}' }; }, platform: 'win32', env: { ProgramFiles: 'C:\\PF' }, exists: () => true, probe: async () => ({ ok: true }) });
  h.cache = { installed: true, img: 'qemu-img' };
  await h.create('C:\\v\\disk0.qcow2', 1024, { key: 'C:\\v\\.hwkey-1' });
  await h.resize('C:\\v\\disk0.qcow2', 2048, { key: 'C:\\v\\.hwkey-1' });
  await h.snapshot('C:\\v\\disk0.qcow2', 'create', 's1', { key: 'C:\\v\\.hwkey-1' });
  await h.checkKey('C:\\v\\disk0.qcow2', 'C:\\v\\.hwkey-1');
  assert.deepEqual(calls[0], ['create', '-f', 'qcow2', '--object', 'secret,id=hwkey,file=C:\\v\\.hwkey-1', '-o', 'lazy_refcounts=on,encrypt.format=luks,encrypt.key-secret=hwkey', 'C:\\v\\disk0.qcow2', '1024']);
  const opts = 'driver=qcow2,file.filename=C:\\v\\disk0.qcow2,encrypt.format=luks,encrypt.key-secret=hwkey';
  assert.deepEqual(calls[1], ['resize', '--object', 'secret,id=hwkey,file=C:\\v\\.hwkey-1', '--image-opts', opts, '2048']);
  assert.deepEqual(calls[2], ['snapshot', '--object', 'secret,id=hwkey,file=C:\\v\\.hwkey-1', '--image-opts', '-c', 's1', opts]);
  assert.deepEqual(calls[3].slice(-2), ['-l', opts]);
  assert.equal((await h.diskInfo('x')).encrypted, true);
  await h.create('C:\\v\\plain.qcow2', 1024);
  assert.deepEqual(calls[5], ['create', '-f', 'qcow2', '-o', 'lazy_refcounts=on', 'C:\\v\\plain.qcow2', '1024']); // unchanged without key
});

test('secret file: created empty and exclusive, rights limited (icacls on Windows), then removed', async () => {
  const dir = tmp();
  const runs = [];
  const f = await U.writeSecretFile(dir, 'abc123', { platform: 'win32', runFn: async (cmd, args) => { runs.push([cmd, args.slice(1, 4)]); assert.equal(fs.readFileSync(args[0], 'utf8'), '', 'empty while the rights are set'); return { code: 0 }; } });
  assert.match(path.basename(f), /^\.hwkey-[a-f0-9]{12}$/);
  assert.equal(fs.readFileSync(f, 'utf8'), 'abc123');
  assert.deepEqual(runs[0][0], 'icacls');
  assert.deepEqual(runs[0][1].slice(0, 2), ['/inheritance:r', '/grant:r']);
  U.removeSecretFile(f);
  assert.ok(!fs.existsSync(f));
});

/* ---------------- switch ---------------- */
const udp = () => new Promise((ok) => { const s = dgram.createSocket('udp4'); s.bind(0, '127.0.0.1', () => ok(s)); });
const frame = (dst, src, text) => Buffer.concat([Buffer.from(dst.replace(/:/g, ''), 'hex'), Buffer.from(src.replace(/:/g, ''), 'hex'), Buffer.from([0x08, 0x00]), Buffer.from(text)]);
const recv = (s, ms = 300) => new Promise((ok) => { const got = []; const on = (b) => got.push(b.subarray(14).toString()); s.on('message', on); setTimeout(() => { s.off('message', on); ok(got); }, ms); });

test('#7 switch: floods broadcasts, learns MACs, ignores ports that are not members, closes with the last NIC', async () => {
  const sw = new Switches();
  const [a, b, c, stranger] = await Promise.all([udp(), udp(), udp(), udp()]);
  const port = await sw.attach('lab', a.address().port);
  assert.equal(await sw.attach('lab', b.address().port), port);
  await sw.attach('lab', c.address().port);
  const MA = '52:54:00:00:00:0a'; const MB = '52:54:00:00:00:0b';
  // broadcast from A → B and C
  let rb = recv(b); let rc = recv(c); let ra = recv(a);
  a.send(frame('ff:ff:ff:ff:ff:ff', MA, 'hello all'), port, '127.0.0.1');
  assert.deepEqual([await rb, await rc, await ra], [['hello all'], ['hello all'], []]);
  // B answers A (A's MAC is known now) → only A
  ra = recv(a); rc = recv(c);
  b.send(frame(MA, MB, 'hi A'), port, '127.0.0.1');
  assert.deepEqual([await ra, await rc], [['hi A'], []]);
  // A → B unicast (B learnt) → only B
  rb = recv(b); rc = recv(c);
  a.send(frame(MB, MA, 'hi B'), port, '127.0.0.1');
  assert.deepEqual([await rb, await rc], [['hi B'], []]);
  // a process that is not a member gets nothing through
  ra = recv(a); rb = recv(b);
  stranger.send(frame('ff:ff:ff:ff:ff:ff', '52:54:00:00:00:99', 'intruder'), port, '127.0.0.1');
  assert.deepEqual([await ra, await rb], [[], []]);
  assert.ok(sw.info('lab').dropped >= 1);
  sw.detach('lab', a.address().port); sw.detach('lab', b.address().port);
  assert.equal(sw.info('lab').members, 1);
  sw.detach('lab', c.address().port);
  assert.equal(sw.info('lab'), null);
  for (const s of [a, b, c, stranger]) s.close();
});

/* ---------------- WebDAV ---------------- */
const req = (port, method, p, { body, headers = {} } = {}) => new Promise((ok, bad) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { const ch = []; res.on('data', (d) => ch.push(d)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, text: Buffer.concat(ch).toString() })); });
  r.on('error', bad);
  r.end(body);
});

test('#13 WebDAV: list, read, write, move, delete – read-only shares refuse changes, nothing outside the folder', async () => {
  const root = tmp(); const ro = tmp(); const outside = tmp();
  fs.writeFileSync(path.join(root, 'hallo.txt'), 'Hallo VM');
  fs.mkdirSync(path.join(root, 'Ordner äö'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'no');
  fs.writeFileSync(path.join(ro, 'readme.md'), 'ro');
  const T1 = dav.newToken(); const T2 = dav.newToken();
  const srv = dav.createShareServer({ resolve: (t) => (t === T1 ? { root, readOnly: false, name: 'rw' } : t === T2 ? { root: ro, readOnly: true, name: 'ro' } : null) });
  const port = await srv.listen(0);
  try {
    const pf = await req(port, 'PROPFIND', `/${T1}/`, { headers: { Depth: '1' } });
    assert.equal(pf.status, 207);
    assert.match(pf.text, /hallo\.txt/); assert.match(pf.text, /Ordner%20%C3%A4%C3%B6\//); assert.match(pf.text, /<D:collection\/>/);
    assert.equal((await req(port, 'GET', `/${T1}/hallo.txt`)).text, 'Hallo VM');
    assert.equal((await req(port, 'PUT', `/${T1}/Ordner%20%C3%A4%C3%B6/neu.txt`, { body: 'vom Gast' })).status, 201);
    assert.equal(fs.readFileSync(path.join(root, 'Ordner äö', 'neu.txt'), 'utf8'), 'vom Gast');
    assert.equal((await req(port, 'MKCOL', `/${T1}/sub`)).status, 201);
    assert.equal((await req(port, 'MOVE', `/${T1}/hallo.txt`, { headers: { Destination: `http://10.0.2.2:${port}/${T1}/sub/hallo2.txt` } })).status, 201);
    assert.ok(fs.existsSync(path.join(root, 'sub', 'hallo2.txt')));
    assert.equal((await req(port, 'LOCK', `/${T1}/sub/hallo2.txt`, { body: '<lockinfo/>' })).headers['lock-token'].startsWith('<opaquelocktoken:'), true);
    assert.equal((await req(port, 'DELETE', `/${T1}/sub`)).status, 204);
    assert.equal((await req(port, 'DELETE', `/${T1}/`)).status, 403, 'never the shared folder itself');
    // read-only
    assert.equal((await req(port, 'GET', `/${T2}/readme.md`)).text, 'ro');
    assert.equal((await req(port, 'PUT', `/${T2}/x.txt`, { body: 'x' })).status, 403);
    assert.equal((await req(port, 'DELETE', `/${T2}/readme.md`)).status, 403);
    assert.ok(fs.existsSync(path.join(ro, 'readme.md')));
    // outside the folder, unknown token, cross-share move
    for (const p of [`/${T1}/../${path.basename(outside)}/secret.txt`, `/${T1}/%2e%2e/${path.basename(outside)}/secret.txt`, `/${T1}/..%5C${path.basename(outside)}%5Csecret.txt`, `/${T1}/C:%5CWindows%5Cwin.ini`]) {
      const r = await req(port, 'GET', p);
      assert.ok(r.status === 403 || r.status === 404, `${p} → ${r.status}`);
      assert.notEqual(r.text, 'no');
    }
    // a link (junction) inside the share that points outside is refused, too
    try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction'); } catch { /* no links allowed here */ }
    if (fs.existsSync(path.join(root, 'link'))) assert.equal((await req(port, 'GET', `/${T1}/link/secret.txt`)).status, 403);
    assert.equal((await req(port, 'GET', `/${dav.newToken()}/hallo.txt`)).status, 404);
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    assert.equal((await req(port, 'MOVE', `/${T1}/a.txt`, { headers: { Destination: `/${T2}/a.txt` } })).status, 403);
  } finally { await srv.close(); }
  assert.deepEqual(dav.parseUrl('/abc/x'), null);
  assert.match(dav.linuxMountScript({ url: 'http://10.0.2.2:47950/t/', mount: '/mnt/hostwerk/p', readOnly: true, user: 'demo' }), /mount -t davfs -o ro,uid=demo,gid=demo/);
  assert.equal(dav.windowsMapCommand({ url: 'http://10.0.2.2:1/t/' }), 'net use * "http://10.0.2.2:1/t/" /persistent:yes');
});

/* ---------------- TAP, cloud-init ---------------- */
test('#14 TAP adapters: only TAP-Windows from Get-NetAdapter, nothing on other systems, nothing installed', async () => {
  const json = JSON.stringify([
    { Name: 'Ethernet', InterfaceDescription: 'Realtek Gaming 2.5GbE', Status: 'Up', MacAddress: 'A0-AD-9F-21-EC-1B', ComponentID: 'PCI\\VEN_10EC' },
    { Name: 'OpenVPN TAP', InterfaceDescription: 'TAP-Windows Adapter V9', Status: 'Disconnected', MacAddress: '00-FF-12-34-56-78', ComponentID: 'tap0901' },
  ]);
  assert.deepEqual(tap.parseAdapters(json), [{ name: 'OpenVPN TAP', description: 'TAP-Windows Adapter V9', status: 'Disconnected', mac: '00:ff:12:34:56:78' }]);
  assert.deepEqual(tap.parseAdapters(JSON.stringify({ Name: 'x', InterfaceDescription: 'Wintun', ComponentID: 'wintun' })), []);
  assert.deepEqual(tap.parseAdapters('not json'), []);
  const runs = [];
  assert.deepEqual(await tap.listTaps({ platform: 'linux', run: async (...a) => runs.push(a) }), []);
  await tap.listTaps({ platform: 'win32', run: async (cmd, args) => { runs.push(args.join(' ')); return { code: 0, stdout: json }; } });
  assert.match(runs[0], /Get-NetAdapter -IncludeHidden/);
  assert.doesNotMatch(runs[0], /Install|Add-|New-|Set-|Enable-/);
});

test('#7 cloud-init network config: NAT NIC by MAC with DHCP plus static addresses for internal NICs', () => {
  const nc = networkConfig({ mac: '52:54:00:aa:bb:cc', internal: [{ mac: '52:54:00:11:22:33', ip: '10.10.1.5/24' }] });
  assert.equal(nc, 'version: 2\nethernets:\n  hwnat:\n    match: { macaddress: "52:54:00:aa:bb:cc" }\n    set-name: "hwnat"\n    dhcp4: true\n  hwin0:\n    match: { macaddress: "52:54:00:11:22:33" }\n    set-name: "hwin0"\n    addresses: ["10.10.1.5/24"]\n');
  assert.equal(networkConfig({ mac: 'x', internal: [{ mac: '52:54:00:11:22:33', ip: null }] }), null);
  const files = seedFiles({ user: 'demo', password: 'secret12', network: { mac: '52:54:00:aa:bb:cc', internal: [{ mac: '52:54:00:11:22:33', ip: '10.10.1.5/24' }] } });
  assert.ok(files['network-config']);
  assert.ok(!('network-config' in seedFiles({ user: 'demo', password: 'secret12' })));
});

/* ---------------- manager ---------------- */
function fakeSecrets(tag = 'pc1') {
  return {
    seal: (t) => `enc:${tag}:${Buffer.from(t).toString('base64')}`,
    open: (v) => (String(v).startsWith(`enc:${tag}:`) ? Buffer.from(String(v).slice(tag.length + 5), 'base64').toString() : ''),
  };
}
function fakeQhost(log) {
  const rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const wr = (f, d) => fs.writeFileSync(f, JSON.stringify(d));
  const keyOf = (k) => { assert.ok(fs.existsSync(k), 'key file exists while qemu-img runs'); return fs.readFileSync(k, 'utf8'); };
  return {
    info: async () => ({ installed: true, accel: 'whpx', accelArgs: ['tcg'], ramSnapshots: false, firmware: null, system: 'qemu' }),
    create: async (f, bytes, o = {}) => { log.push(['create', path.basename(f), o.key ? keyOf(o.key) : null]); wr(f, { size: bytes, enc: o.key ? keyOf(o.key) : null, snaps: [] }); },
    convert: async (src, dest, o = {}) => {
      let d; try { d = rd(src); } catch { d = { size: 1, enc: null, snaps: [] }; }
      if (d.enc && (!o.srcKey || keyOf(o.srcKey) !== d.enc)) throw new Error('Invalid password, cannot unlock any keyslot');
      log.push(['convert', path.basename(src), path.basename(dest), o.srcKey ? 'src-key' : null, o.destKey ? 'dest-key' : null, !!o.compress]);
      wr(dest, { ...d, enc: o.destKey ? keyOf(o.destKey) : null, snaps: [] });
    },
    resize: async (f, bytes, o = {}) => { const d = rd(f); if (d.enc && (!o.key || keyOf(o.key) !== d.enc)) throw new Error('key-secret is required'); log.push(['resize', path.basename(f)]); wr(f, { ...d, size: bytes }); },
    diskInfo: async (f) => { const d = rd(f); return { format: 'qcow2', virtualSize: d.size, actualSize: 1, backing: null, snapshots: [], ...(d.enc ? { encrypted: true } : {}) }; },
    snapshot: async (f, action, name, o = {}) => { const d = rd(f); if (d.enc && (!o.key || keyOf(o.key) !== d.enc)) throw new Error("Parameter 'encrypt.key-secret' is required for cipher"); log.push(['snapshot', action, name, !!o.key]); if (action === 'create') d.snaps.push(name); wr(f, d); },
    checkKey: async (f, k) => { if (rd(f).enc !== keyOf(k)) throw new Error('Invalid password, cannot unlock any keyslot'); return true; },
  };
}
function make({ secrets = fakeSecrets(), taps = [] } = {}) {
  const root = tmp();
  const log = [];
  const runJob = (title, fn) => { const job = { id: crypto.randomUUID(), lines: [], progress() {}, status(t) { this.lines.push(t); }, log(l) { this.lines.push(l); } }; job.promise = Promise.resolve().then(() => fn(job)); return job; };
  const m = new VmManager({ root, qhost: fakeQhost(log), Proc: class {}, runJob, downloadFile: async () => {}, fetchText: async () => '', broadcast: () => {}, host: HOST, secrets, run: noRun, listTaps: async () => taps, hostname: 'pc-1' });
  return { m, root, log };
}
const running = (m, id, extra = {}) => {
  const calls = [];
  const rt = { vm: m.get(id), calls, agentInfo: { ok: true }, isRunning: () => true, status: () => ({ state: 'running' }), proc: { log: (l) => calls.push(['log', l]) },
    guestExec: async (c, o) => { calls.push(['exec', c, o && o.timeout]); return { code: 0, out: c.includes('davfs') ? 'mounted' : 'hwin0', err: '', timedOut: false }; }, ...extra };
  m.runtimes.set(id, rt);
  return rt;
};
const noKeyFiles = (root) => { const left = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else if (/^\.hwkey-/.test(e.name)) left.push(e.name); } }; walk(root); return left; };

test('#7 manager: networks with members, suggested addresses, no address twice, delete only when empty', async () => {
  const { m } = make();
  const lab = m.addNetwork({ name: 'Labor' });
  assert.deepEqual([lab.id, lab.n], ['labor', 1]);
  assert.equal(m.addNetwork({ name: 'DMZ' }).n, 2);
  assert.throws(() => m.addNetwork({ name: 'labor' }), /exists already/);
  assert.equal(m.suggestIp('labor'), '10.10.1.10/24');
  await m.create({ source: 'empty', name: 'web', diskGb: 1, nets: [{ net: 'labor', ip: '10.10.1.10' }] }).promise;
  assert.equal(m.get('web').nets[0].mac, U.macFor('web/labor'));
  assert.equal(m.suggestIp('labor'), '10.10.1.11/24');
  assert.throws(() => m.create({ source: 'empty', name: 'db', diskGb: 1, nets: [{ net: 'labor', ip: '10.10.1.10/24' }] }), /already used by “web”/);
  assert.throws(() => m.create({ source: 'empty', name: 'db', diskGb: 1, nets: [{ net: 'nope' }] }), /Unknown internal network/);
  await m.create({ source: 'empty', name: 'db', diskGb: 1 }).promise;
  await m.update('db', { nets: [{ net: 'labor', ip: '10.10.1.11' }] });
  const net = m.networks().find((n) => n.id === 'labor');
  assert.deepEqual(net.members.map((x) => [x.id, x.ip]), [['db', '10.10.1.11/24'], ['web', '10.10.1.10/24']]);
  assert.equal(net.subnet, '10.10.1.0/24');
  assert.throws(() => m.removeNetwork('labor'), /still in this network: db, web|still in this network: web, db/);
  running(m, 'db');
  await assert.rejects(m.update('db', { nets: [] }), /Shut the VM down first/);
  m.runtimes.delete('db');
  await m.update('db', { nets: [] }); await m.update('web', { nets: [] });
  assert.deepEqual(m.removeNetwork('labor'), { ok: true });
  // after the agent answers: the address is set in the guest, found by MAC
  m.addNetwork({ name: 'Labor' });
  await m.update('web', { nets: [{ net: 'labor', ip: '10.10.3.5/24' }] });
  const rt = running(m, 'web');
  const res = await m.afterAgent('web');
  assert.deepEqual(res.nets.map((x) => [x.ip, x.ok, x.iface]), [['10.10.3.5/24', true, 'hwin0']]);
  assert.match(rt.calls.find((c) => c[0] === 'exec')[1], new RegExp(`= "${m.get('web').nets[0].mac}".*ip addr add 10\\.10\\.3\\.5/24`));
});

test('#7 runtime: NICs join the switch on start, leave it when QEMU ends', async () => {
  const sw = new Switches();
  let args = null;
  class Proc { constructor() { this.running = false; } isRunning() { return this.running; } info() { return { state: this.running ? 'running' : 'stopped' }; } async start(o) { args = o.args; this.running = true; } log() {} }
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'disk0.qcow2'), 'x');
  const vm = { ...S.cleanVm({ name: 'r', id: 'r', disks: [{ id: 'disk0', file: 'disk0.qcow2' }], nets: [{ net: 'lab' }] }, { host: HOST }), id: 'r' };
  const r = new Runtime(vm, { qhost: { info: async () => ({ installed: true, accelArgs: ['tcg'], system: 'q' }) }, Proc, dir, switches: sw });
  r.applyLimits = async () => {}; r.pollAgent = () => {}; r.connectSerial = () => {};
  await r.start();
  const nd = args[args.findIndex((x) => x.startsWith('dgram,id=in0'))];
  const remote = Number(nd.match(/remote\.port=(\d+)/)[1]);
  assert.equal(remote, sw.info('lab').port);
  assert.equal(sw.info('lab').members, 1);
  r.proc.running = false;
  r.cleanup();
  assert.equal(sw.info('lab'), null);
  r.releasePorts();
});

test('#15 encrypted VM: key sealed in vm.json, key file only while QEMU/qemu-img read it, snapshots/backups/clone/compact keep it encrypted', async () => {
  const { m, root, log } = make();
  await m.create({ source: 'empty', name: 'safe', diskGb: 2, encrypt: true }).promise;
  const vm = m.get('safe');
  const plain = m.diskKey('safe').key;
  assert.match(plain, /^[a-f0-9]{64}$/);
  const json = fs.readFileSync(path.join(root, 'safe', 'vm.json'), 'utf8');
  assert.ok(!json.includes(plain), 'the key never lands in vm.json in plain text');
  assert.match(vm.encryption.key, /^enc:/);
  assert.deepEqual(vm.disks[0], { id: 'disk0', file: 'disk0.qcow2', bus: 'virtio', format: 'qcow2', encrypted: true });
  assert.deepEqual(log[0], ['create', 'disk0.qcow2', plain]);
  assert.equal(m.view(vm).encryption.locked, false);
  assert.ok(!JSON.stringify(m.view(vm)).includes(plain));
  // offline operations open the disk with the key
  await m.takeSnapshot('safe', { name: 's1' });
  await m.deleteSnapshot('safe', 's1');
  await m.resizeDisk('safe', 'disk0', { sizeGb: 4 });
  await m.addDisk('safe', { sizeGb: 1 });
  assert.equal(m.get('safe').disks[1].encrypted, true);
  const b = await m.backup('safe').promise;
  assert.ok(log.some((c) => c[0] === 'convert' && c[3] === 'src-key' && c[4] === 'dest-key' && c[5] === false), 'backup encrypted, not compressed');
  const bdisk = JSON.parse(fs.readFileSync(path.join(m.backupDir('safe'), b.file, 'disk0.qcow2'), 'utf8'));
  assert.equal(bdisk.enc, plain);
  await m.restoreBackup('safe', b.file).promise;
  await m.compactDisk('safe', 'disk0').promise;
  await m.create({ source: 'clone', from: 'safe', name: 'safe copy' }).promise;
  assert.equal(m.diskKey('safe-copy').key, plain);
  assert.throws(() => m.create({ source: 'clone', from: 'safe', name: 'lc', linked: true }), /linked clones/);
  assert.throws(() => m.setTemplate('safe', true), /templates/);
  const ex = await m.exportDisk('safe', { format: 'vdi', dest: path.join(tmp(), 'out.vdi') }).promise;
  assert.equal(ex.decrypted, true);
  assert.deepEqual(noKeyFiles(root), [], 'no key file left anywhere');
  // start: QEMU gets the key file; it is gone right after the start
  let seenKey = null;
  m.Proc = class { isRunning() { return false; } info() { return { state: 'stopped' }; } async start(o) { const f = o.args[o.args.indexOf('-object') + 1].match(/file=(.*)$/)[1]; seenKey = fs.readFileSync(f, 'utf8'); } log() {} };
  m.qhost.info = async () => ({ installed: true, accelArgs: ['tcg'], system: 'q' });
  const r = m.rt('safe'); r.applyLimits = async () => {}; r.pollAgent = () => {}; r.connectSerial = () => {};
  await r.start();
  assert.equal(seenKey, plain);
  assert.deepEqual(noKeyFiles(root), []);
  r.releasePorts();
});

test('#15 encrypting an existing VM, wrong keys refused, locked without the key', async () => {
  const { m } = make();
  await m.create({ source: 'empty', name: 'later', diskGb: 1 }).promise;
  await m.encryptDisks('later').promise;
  const vm = m.get('later');
  assert.equal(vm.disks[0].encrypted, true);
  const plain = m.diskKey('later').key;
  // another Hostwerk (other secret store) sees the sealed key but cannot open it
  vm.encryption.key = 'enc:pc2:xyz';
  assert.equal(m.view(vm).encryption.locked, true);
  await assert.rejects(m.start('later'), /not available on this PC/);
  await assert.rejects(m.unlock('later', { key: 'f'.repeat(64) }), /Wrong disk key/);
  await m.unlock('later', { key: plain });
  assert.equal(m.view(m.get('later')).encryption.locked, false);
  assert.throws(() => m.encryptDisks('later'), /encrypted already/);
  const noSecrets = make({ secrets: null });
  assert.throws(() => noSecrets.m.create({ source: 'empty', name: 'x', diskGb: 1, encrypt: true }), /secret store/);
  const img = path.join(tmp(), 'old.qcow2'); fs.writeFileSync(img, '{}');
  assert.throws(() => m.create({ source: 'disk', name: 'y', file: img, encrypt: true }), /new disks/);
});

test('#13 manager: shares served only while the VM runs, mounted in Linux through the agent, Windows gets a command', async () => {
  const { m, root } = make();
  const folder = tmp();
  fs.writeFileSync(path.join(folder, 'notiz.txt'), 'vom PC');
  await m.create({ source: 'empty', name: 'share', diskGb: 1 }).promise;
  assert.throws(() => m.checkShares({ shares: [{ path: root }] }), /cannot be shared/);
  await assert.rejects(m.update('share', { shares: [{ name: 'X', path: path.join(folder, 'nope') }] }), /not found/);
  const d = await m.update('share', { shares: [{ name: 'Projekte', path: folder, readOnly: true }] });
  const s = d.shares[0];
  assert.match(s.url, new RegExp(`^http://10\\.0\\.2\\.2:${m.config().sharePort}/[a-f0-9]{32}/$`));
  assert.equal(s.mount, '/mnt/hostwerk/projekte');
  const port = m.config().sharePort;
  assert.equal((await req(port, 'GET', `/${s.token}/notiz.txt`)).status, 404, 'VM off → nothing served');
  const rt = running(m, 'share');
  assert.equal((await req(port, 'GET', `/${s.token}/notiz.txt`)).text, 'vom PC');
  m.get('share').ssh = { user: 'demo' };
  const mounted = await m.mountShare('share', s.id);
  assert.equal(mounted.mount, '/mnt/hostwerk/projekte');
  assert.match(rt.calls.find((c) => c[0] === 'exec')[1], /mount -t davfs -o ro,uid=demo,gid=demo/);
  const res = await m.afterAgent('share');
  assert.deepEqual(res.shares.map((x) => x.ok), [true]);
  m.get('share').osType = 'windows';
  assert.match((await m.mountShare('share', s.id)).command, /^net use \* "http:\/\/10\.0\.2\.2:\d+\/[a-f0-9]{32}\/" \/persistent:yes$/);
  m.runtimes.delete('share');
  await m.stopShareServer();
});

test('#14 manager: bridge start refused when the TAP adapter is missing', async () => {
  const { m } = make({ taps: [{ name: 'TAP LAN' }] });
  await m.create({ source: 'empty', name: 'br', diskGb: 1, net: { mode: 'bridge', tap: 'Gone' } }).promise;
  const r = m.rt('br');
  await assert.rejects(r.checkTap('Gone'), /TAP adapter “Gone” was not found/);
  await r.checkTap('TAP LAN');
});

test('#16 moving to another PC: Hostwerk packs the folder of a switched-off VM, the target places it (networks by name, free ports, encrypted → locked)', async () => {
  const A = make(); const B = make({ secrets: fakeSecrets('pc2') });
  const kindA = vmKind(A.m); const kindB = vmKind(B.m);
  for (const k of ['dir', 'dirFor', 'entry', 'place', 'add', 'isRunning', 'clone', 'probe', 'afterFiles']) assert.equal(typeof kindA.copy[k], 'function', k);
  assert.ok(kindA.copy.skip.includes('vm.json'));
  A.m.addNetwork({ name: 'Labor' });
  await A.m.create({ source: 'empty', name: 'Mover', diskGb: 1, encrypt: true, nets: [{ net: 'labor', ip: '10.10.1.20' }], net: { forwards: [{ proto: 'tcp', host: 8080, guest: 80 }] } }).promise;
  await A.m.takeSnapshot('mover', { name: 'before' });
  // refused while running, and for linked clones
  running(A.m, 'mover');
  assert.throws(() => kindA.copy.dir('mover'), /Shut the VM down first to move it/);
  A.m.runtimes.delete('mover');
  await A.m.create({ source: 'empty', name: 'Tmpl', diskGb: 1 }).promise;
  A.m.setTemplate('tmpl', true);
  await A.m.create({ source: 'template', template: 'tmpl', name: 'Linked' }).promise;
  assert.throws(() => kindA.copy.dir('linked'), /needs its template/);
  // export side
  const dirA = kindA.copy.dir('mover');
  const { entry } = kindA.copy.entry('mover');
  assert.ok(!('id' in entry) && !('autostart' in entry));
  assert.deepEqual(entry.netNames, { labor: 'Labor' });
  assert.equal(entry.sealedOn, 'pc-1');
  // target: port 8080 already used there, no network "Labor" yet
  await B.m.create({ source: 'empty', name: 'Busy', diskGb: 1, net: { forwards: [{ proto: 'tcp', host: 8080, guest: 80 }] } }).promise;
  const placed = await kindB.copy.place({ name: 'Mover', entry: JSON.parse(JSON.stringify(entry)), port: null, tag: { movedFrom: 'pc-1', movedAt: 1 } });
  assert.equal(placed.id, 'mover');
  assert.match(placed.warn, /Port 8080 is used here/);
  // Hostwerk unpacks the zip into placed.dir (vm.json is skipped – a stray one never wins)
  for (const f of fs.readdirSync(dirA)) if (!/^vm\.json$/.test(f)) fs.copyFileSync(path.join(dirA, f), path.join(placed.dir, f));
  fs.writeFileSync(path.join(placed.dir, 'vm.json'), '{"id":"evil"}');
  kindB.copy.afterFiles(placed.id);
  const vmB = B.m.get('mover');
  assert.equal(JSON.parse(fs.readFileSync(path.join(placed.dir, 'vm.json'), 'utf8')).id, 'mover');
  assert.deepEqual([vmB.autostart, vmB.movedFrom, vmB.net.forwards[0].host, Object.keys(vmB.snapshots)], [false, 'pc-1', 8081, ['before']]);
  assert.deepEqual(B.m.networks().map((n) => [n.name, n.members.map((x) => x.ip)]), [['Labor', ['10.10.1.20/24']]]);
  assert.equal(vmB.nets[0].mac, U.macFor('mover/labor'));
  // the key was sealed on PC 1: locked here until entered
  assert.equal(B.m.view(vmB).encryption.locked, true);
  assert.equal(await kindB.copy.probe('mover'), true); // cannot start yet – the files arrived
  await B.m.unlock('mover', { key: A.m.diskKey('mover').key });
  assert.equal(B.m.view(B.m.get('mover')).encryption.locked, false);
  // keep when removing Hostwerk → new Hostwerk: entry from get() (keys re-sealed by Hostwerk), folder copied back first
  const kept = JSON.parse(JSON.stringify(kindA.get('mover')));
  const C = make();
  fs.mkdirSync(kindA.copy.dirFor('mover').replace(A.root, C.root), { recursive: true });
  for (const f of fs.readdirSync(dirA)) fs.copyFileSync(path.join(dirA, f), path.join(C.root, 'mover', f));
  vmKind(C.m).copy.add(kept);
  assert.equal(C.m.diskKey('mover').key, A.m.diskKey('mover').key);
  assert.deepEqual(Object.keys(C.m.get('mover').snapshots), ['before']);
  assert.equal(C.m.get('mover').autostart, false);
  // clone (Hostwerk's "clone" button): with data a full copy, without data the same hardware with an empty disk
  const c1 = await kindA.copy.clone('mover', { name: 'Mover 2', withData: true }, { log() {} });
  assert.deepEqual(c1, { id: 'mover-2', href: '#/vms/mover-2' });
  const c2 = await kindA.copy.clone('mover', { name: 'Mover leer', withData: false }, { log() {} });
  assert.equal(A.m.get(c2.id).encryption.format, 'luks');
  // placed on the same PC again (a copy): the address in the network stays with the original
  const again = await kindA.copy.place({ name: 'Mover', entry: JSON.parse(JSON.stringify(entry)) });
  assert.match(again.warn, /10\.10\.1\.20 is already used by “Mover”/);
  assert.deepEqual(A.m.get(again.id).nets.map((x) => [x.net, x.ip]), [['labor', null]]);
  assert.deepEqual(noKeyFiles(A.root), []);
});
