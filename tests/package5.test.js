'use strict';
/*
 * Package 5 of the roadmap: app templates and own start scripts (#9), Ask AI about the screen and AI tools (#20),
 * Hyper-V listing (#21) and ARM VMs (#22). No QEMU, no PowerShell, no AI needed – fakes only.   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const A = require('../server/apps');
const S = require('../server/spec');
const catalog = require('../server/catalog');
const { seedFiles } = require('../server/cloudinit');
const { buildArgs } = require('../server/qemu-args');
const QH = require('../server/qemu-host');
const HV = require('../server/hyperv');
const { vmsAi } = require('../server/ai');
const { VmManager } = require('../server/manager');
const { readIso } = require('../server/iso');

const HOST = { cpus: 8, memoryMb: 16384 };
const GB = 2 ** 30;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hw-vms-p5-'));

/* ---------------- fakes (like tests/manager.test.js) ---------------- */
const IMAGE = Buffer.from('QFI\xfb fake cloud image');
function make() {
  const root = tmp();
  const rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const wr = (f, d) => fs.writeFileSync(f, JSON.stringify(d));
  const qhost = {
    info: async () => ({ installed: true, accel: 'whpx', accelArgs: ['whpx', 'tcg'], version: '11.1.0', firmware: null }),
    create: async (f, bytes) => wr(f, { size: bytes || 0 }),
    convert: async (src, dest) => wr(dest, { size: 2 * GB }),
    resize: async (f, bytes) => wr(f, { ...rd(f), size: bytes }),
    diskInfo: async (f) => ({ format: 'qcow2', virtualSize: rd(f).size, actualSize: 1000, backing: null, snapshots: [] }),
  };
  const sha512 = crypto.createHash('sha512').update(IMAGE).digest('hex');
  const fetchText = async (url) => {
    if (/SHA512SUMS$/.test(url)) return `${sha512}  debian-12-genericcloud-amd64.qcow2\n${sha512}  debian-12-genericcloud-arm64.qcow2\n`;
    throw new Error(`offline: ${url}`);
  };
  const downloadFile = async (url, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, IMAGE); return dest; };
  const runJob = (title, fn) => { const job = { id: crypto.randomUUID(), title, progress() {}, status() {}, log() {} }; job.promise = Promise.resolve().then(() => fn(job)); return job; };
  const m = new VmManager({ root, qhost, Proc: class {}, runJob, downloadFile, fetchText, broadcast: () => {}, host: HOST });
  return { m, root };
}
const userData = (root, id) => readIso(fs.readFileSync(path.join(root, id, 'seed.iso'))).files['user-data'].toString();
/** runcmd entries of the form ["sh", "-c", "<command>"] read back (JSON plus \U escapes) */
const shCommands = (ud) => ud.split('\n').map((l) => l.match(/^ {2}- \["sh", "-c", (".*")\]$/)).filter(Boolean).map((x) => A.unyq(x[1]));
const b64Files = (ud) => { const out = {}; const re = /- path: "([^"]+)"\n {4}encoding: "b64"\n {4}content: "([A-Za-z0-9+/=]+)"/g; let x; while ((x = re.exec(ud))) out[x[1]] = Buffer.from(x[2], 'base64').toString('utf8'); return out; };

/* ---------------- #9 app templates and start scripts ---------------- */
test('#9 app catalog: 6 apps, each with packages, a script and the right forwards', () => {
  const list = A.list();
  assert.deepEqual(list.map((a) => a.id), ['nginx', 'docker', 'wordpress', 'nextcloud', 'gitea', 'uptime-kuma']);
  for (const a of list) {
    assert.ok(a.label && a.text && a.packages.length && a.memoryMb >= 1024, a.id);
    assert.ok(!('script' in a), 'the script stays on the server');
    for (const p of a.packages) assert.match(p, /^[a-z0-9][a-z0-9.+-]{0,63}$/);
    if (a.url) assert.ok(a.forwards.some((f) => f.id === a.url.forward) && a.open, a.id);
  }
  assert.deepEqual(A.get('wordpress').forwards, [{ id: 'web', guest: 80, host: 8080, label: 'WordPress' }]);
  assert.deepEqual(A.get('nginx').forwards[0].guest, 80);
  assert.equal(A.get('docker').forwards.length, 0);
  assert.throws(() => A.checkApp('mysql', catalog.get('debian-12')), /Unknown app template/);
  assert.throws(() => A.checkApp('nginx', catalog.get('alma-9')), /Debian or Ubuntu/);
  assert.equal(A.checkApp('nginx', catalog.get('ubuntu-24.04')).id, 'nginx');
  assert.equal(A.checkApp('', catalog.get('debian-12')), null);
  const sh = A.appScript(A.get('docker'), 'demo');
  assert.match(sh, /^#!\/bin\/bash\n# Hostwerk app template: docker\nset -e\nHW_USER=demo\n/);
  assert.match(sh, /usermod -aG docker "\$HW_USER"/);
  assert.throws(() => A.appScript(A.get('docker'), 'x; rm -rf /'), /user name/);
});

test('#9 start commands and script: one runcmd entry per line, safely quoted; script base64; limits', () => {
  const tricky = ['echo "hi" > /root/x', 'key: value # not yaml', '- [evil]', '"], ["rm", "-rf", "/"]', 'echo ü€😀\u2028$(id)', 'a\\b', "it's"];
  const ud = seedFiles({ hostname: 'x', user: 'u1', password: 'secret1', app: 'nginx', startCommands: ['# a comment', '', ...tricky].join('\r\n'), startScript: 'echo marker > /root/m' })['user-data'];
  const cmds = shCommands(ud);
  // app setup first, then the own commands exactly as typed (comment and empty line skipped), then the script
  assert.match(cmds[0], /^bash \/var\/lib\/hostwerk\/app\.sh >>\/var\/log\/hostwerk-app\.log 2>&1 && touch \/var\/lib\/hostwerk\/app-ready \|\| touch \/var\/lib\/hostwerk\/app-failed$/);
  assert.deepEqual(cmds.slice(1, 1 + tricky.length), tricky);
  assert.match(cmds[cmds.length - 1], /^\/var\/lib\/hostwerk\/start-script\.sh >>\/var\/log\/hostwerk-start-script\.log 2>&1 && touch .*start-script-done \|\| touch .*start-script-failed$/);
  // every user-data line is ASCII – nothing raw that YAML 1.1 could read as a line break or refuse
  assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(ud));
  assert.ok(!/^- /m.test(ud) && !/^ {2}- \["rm"/m.test(ud), 'no injected list entries');
  const files = b64Files(ud);
  assert.equal(files['/var/lib/hostwerk/start-script.sh'], '#!/bin/bash\necho marker > /root/m\n');
  assert.match(files['/var/lib/hostwerk/app.sh'], /HW_USER=u1\n[\s\S]*systemctl enable --now nginx/);
  assert.match(ud, /permissions: "0700"/);
  assert.match(ud, /packages:\n {2}- "qemu-guest-agent"\n {2}- "nginx"\n {2}- "curl"\n/);
  // without app/commands/script: nothing extra (and the old keyboard-only write_files still works)
  const plain = seedFiles({ hostname: 'x', user: 'u1', password: 'secret1' })['user-data'];
  assert.doesNotMatch(plain, /write_files|hostwerk\/app|start-script/);
  // limits and checks
  assert.throws(() => A.cleanStartScript({ commands: Array(51).fill('true').join('\n') }), /At most 50 commands/);
  assert.throws(() => A.cleanStartScript({ commands: 'x'.repeat(2001) }), /at most 2000 characters/);
  assert.throws(() => A.cleanStartScript({ script: 'x'.repeat(65 * 1024) }), /64 KB/);
  assert.throws(() => A.cleanStartScript({ commands: 'a\u0000b' }), /Invalid character/);
  assert.deepEqual(A.cleanStartScript({ script: '#!/bin/sh\necho 1' }), { commands: [], script: '#!/bin/sh\necho 1\n' });
  assert.deepEqual(A.cleanStartScript({ script: '   \n' }), { commands: [], script: null });
  assert.throws(() => seedFiles({ hostname: 'x', user: 'u1', password: 'secret1', app: 'nope' }), /Unknown app template/);
  // yq: JSON-compatible for BMP characters, \U for the rest – and back again
  assert.equal(A.yq('ü😀\u2028'), '"\\u00fc\\U0001f600\\u2028"');
  assert.equal(A.unyq(A.yq('ü😀\u2028"\\')), 'ü😀\u2028"\\');
});

test('#9 manager: app VM gets its forwards (next free port), memory, marker of the start script; refused where it cannot work', async () => {
  const { m, root } = make();
  const j1 = m.create({ source: 'cloud', image: 'debian-12', name: 'Blog', user: 'demo', password: 'geheim123', app: 'wordpress', startCommands: 'echo hi > /root/hi' });
  await j1.promise;
  const vm = m.get('blog');
  assert.deepEqual(vm.app, { id: 'wordpress' });
  assert.equal(vm.memoryMb, 2048); // the app's size
  assert.equal(vm.cloud.start, true);
  assert.deepEqual(vm.net.forwards.map((f) => [f.id, f.host, f.guest]), [['ssh', 2222, 22], ['app-web', vm.net.forwards[1].host, 80]]);
  assert.ok(vm.net.forwards[1].host >= 8080);
  const v = m.view(vm);
  assert.equal(v.appInfo.label, 'WordPress');
  assert.deepEqual(v.appInfo.open, { url: `http://127.0.0.1:${vm.net.forwards[1].host}/`, port: vm.net.forwards[1].host, label: 'Open WordPress', lan: false });
  const ud = userData(root, 'blog');
  assert.match(ud, /- "wordpress"/);
  assert.deepEqual(shCommands(ud).slice(1), ['echo hi > /root/hi']);
  // a second web app: the port of the first VM is taken → the next one
  await m.create({ source: 'cloud', image: 'debian-12', name: 'Web', user: 'demo', password: 'geheim123', app: 'nginx' }).promise;
  const w = m.get('web');
  assert.ok(w.net.forwards.find((f) => f.id === 'app-web').host > vm.net.forwards[1].host);
  // explicit memory wins over the app's size
  await m.create({ source: 'cloud', image: 'debian-12', name: 'Dock', user: 'demo', password: 'geheim123', app: 'docker', memoryMb: 1536 }).promise;
  assert.equal(m.get('dock').memoryMb, 1536);
  assert.equal(m.view(m.get('dock')).appInfo.open, null); // Docker host: nothing to open
  // refused before anything is created
  assert.throws(() => m.create({ source: 'cloud', image: 'alma-9', name: 'x1', user: 'demo', password: 'geheim123', app: 'nginx' }), /Debian or Ubuntu/);
  assert.throws(() => m.create({ source: 'empty', name: 'x2', app: 'nginx' }), /ready-made Linux/);
  assert.throws(() => m.create({ source: 'empty', name: 'x3', startScript: 'echo' }), /ready-made Linux/);
  assert.throws(() => m.create({ source: 'cloud', image: 'debian-12', name: 'x4', user: 'demo', password: 'geheim123', startCommands: Array(60).fill('true').join('\n') }), /At most 50/);
  assert.equal(m.vms.size, 3);
  // app state through the guest agent (fake runtime)
  const calls = [];
  m.runtimes.set('blog', { vm, isRunning: () => true, status: () => ({ state: 'running' }), guestExec: async (cmd) => { calls.push(cmd); return { code: 0, out: '{"app":"running","script":"ok"}\nSetting up mariadb-server …\n', err: '' }; } });
  const st = await m.appStatus('blog');
  assert.equal(st.app, 'running'); assert.equal(st.script, 'ok'); assert.match(st.log, /mariadb/);
  assert.equal(calls[0], A.STATE_CMD);
  assert.equal(m.view(vm).appInfo.state.app, 'running');
});

/* ---------------- #20 Ask AI about the screen, AI tools ---------------- */
test('#20 screen context: text only, escape sequences removed, secrets blanked; AI off → clear refusal, nothing sent', async () => {
  const { m } = make();
  await m.create({ source: 'cloud', image: 'debian-12', name: 'Kaputt', user: 'demo', password: 'geheim123' }).promise;
  const vm = m.get('kaputt');
  const serial = '\x1b[0;32m[  OK  ]\x1b[0m Started ssh.service\r\nKernel panic - not syncing: VFS: Unable to mount root fs\npassword=supersecret123\r\n';
  m.runtimes.set('kaputt', { vm, isRunning: () => true, status: () => ({ state: 'running', accel: 'whpx', agent: null }), agentInfo: null, guestEvents: [{ t: Date.UTC(2026, 0, 1, 10, 0, 0), event: 'RESET' }], serialSince: () => ({ text: serial, seq: serial.length }) });
  const ctx = m.screenContext('kaputt');
  assert.equal(ctx.image, false);
  assert.match(ctx.text, /Virtual machine “Kaputt”/);
  assert.match(ctx.text, /State: running, accelerator whpx/);
  assert.match(ctx.text, /Guest agent: not connected/);
  assert.match(ctx.text, /Last events: 10:00:00 RESET/);
  assert.match(ctx.text, /Kernel panic - not syncing/);
  assert.match(ctx.text, /\[ {2}OK {2}\] Started ssh\.service/);
  assert.doesNotMatch(ctx.text, /\x1b|supersecret|geheim123/);
  assert.match(ctx.text, /password=•••/);
  assert.equal(ctx.parts.serialLines, 3);
  // AI off (no service, or not ready) → 409, the AI is never called
  await assert.rejects(m.aiExplain('kaputt'), (e) => e.status === 409 && e.code === 'AI_OFF' && /nothing was sent/.test(e.message));
  let called = 0;
  m.ai = { ready: async () => false, run: async () => { called++; return { text: 'x' }; } };
  await assert.rejects(m.aiExplain('kaputt'), /AI assistant is off/);
  assert.equal(called, 0);
  // AI on → explain with the text context, never a picture
  const seen = [];
  m.ai = { ready: async () => true, run: async (task, o) => { seen.push([task, o]); return { text: 'The kernel cannot find its root disk.' }; } };
  const r = await m.aiExplain('kaputt', { question: 'Why does it stop?', lang: 'en' });
  assert.equal(r.text, 'The kernel cannot find its root disk.');
  assert.equal(r.image, false);
  assert.equal(seen[0][0], 'explain');
  assert.match(seen[0][1].text, /^Why does it stop\?\n\nVirtual machine “Kaputt”[\s\S]*Kernel panic/);
  assert.equal(seen[0][1].lang, 'en');
  assert.ok(seen[0][1].context.length <= 300 && /text context only, no picture/.test(seen[0][1].context));
});

test('#20 AI tools through host.aiExtend: read tools never ask, changing ones describe themselves; @ source', async () => {
  const { m } = make();
  await m.create({ source: 'cloud', image: 'debian-12', name: 'Alpha', user: 'demo', password: 'geheim123' }).promise;
  const def = vmsAi(m);
  const tools = {};
  const add = (name, group, description, props, required, run, opts) => { tools[name] = { group, description, props, required, run, opts }; };
  def.tools({ add, S: (d) => ({ type: 'string', description: d }), L: (de, en) => en, clip: (x) => x });
  assert.deepEqual(Object.keys(tools), ['vm_list', 'vm_apps', 'vm_screen', 'vm_start', 'vm_stop', 'vm_create', 'vm_from_template']);
  for (const n of ['vm_list', 'vm_apps', 'vm_screen']) assert.equal(tools[n].opts.risk, 'read', n);
  for (const n of ['vm_start', 'vm_create', 'vm_from_template']) { assert.equal(tools[n].opts.risk, 'change', n); assert.equal(typeof tools[n].opts.describe, 'function'); }
  assert.equal(tools.vm_stop.opts.risk({ force: true }), 'system');
  assert.equal(tools.vm_stop.opts.risk({}), 'change');
  const d = tools.vm_start.opts.describe({ vm: 'alpha' });
  assert.deepEqual(Object.keys(d), ['ask', 'verb', 'effect', 'undo']);
  assert.equal(d.ask, 'Start VM “Alpha”?');
  assert.match(tools.vm_stop.opts.describe({ vm: 'Alpha', force: true }).effect, /pulling the plug/);
  assert.match(tools.vm_create.opts.describe({ name: 'Blog', app: 'wordpress' }).ask, /Create VM “Blog” with WordPress \(Debian 12/);
  const list = await tools.vm_list.run({});
  assert.equal(list.vms[0].name, 'Alpha'); assert.equal(list.vms[0].ssh, 'ssh -p 2222 demo@127.0.0.1');
  assert.equal(list.hyperv, 'nicht verfügbar');
  assert.ok((await tools.vm_apps.run({})).apps.some((a) => a.id === 'wordpress' && a.port === 8080));
  await assert.rejects(tools.vm_start.run({ vm: 'nobody' }), /Keine VM/);
  await assert.rejects(tools.vm_from_template.run({ template: 'alpha', name: 'b' }), /keine Vorlage/);
  // vm_create: a real (fake) job with a random password reported back (the start itself is not part of this test)
  m.start = async () => ({ state: 'running' });
  const out = await tools.vm_create.run({ name: 'Blog', app: 'nginx' });
  assert.match(out, /VM “Blog” is being created and started \(job [0-9a-f-]+\)\. User debian, password \S{12}/);
  assert.equal(m.get('blog').app.id, 'nginx');
  // own @ source "vm"
  assert.equal(def.context.kind, 'vm');
  assert.deepEqual(await def.context.search('alp'), [{ id: 'alpha', label: 'Alpha' }]);
  assert.match(await def.context.resolve('alpha'), /Virtual machine “Alpha”/);
  assert.ok(def.groups.vms && def.about.de);
});

/* ---------------- #21 Hyper-V ---------------- */
test('#21 Hyper-V: ConvertTo-Json output parsed (one VM, list, numbers or names as state); messages of the script', () => {
  const one = JSON.stringify({ Name: 'Win Test', Id: '0E1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9', State: 'Running', ProcessorCount: 2, MemoryAssigned: 4294967296, MemoryStartup: 2147483648, Generation: 2, Uptime: 3725, Status: 'Operating normally', Version: '11.0', Notes: '', Checkpoints: 1 });
  assert.deepEqual(HV.parseVms(one), [{ id: '0e1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9', name: 'Win Test', state: 'running', cpus: 2, memoryMb: 4096, generation: 2, uptimeS: 3725, status: 'Operating normally', version: '11.0', notes: null, checkpoints: 1 }]);
  // a list, raw enum numbers (Off = 3, Saved = 6), Uptime as TimeSpan object, a VM without Id is dropped
  const list = `\uFEFF[{"Name":"b-vm","Id":"11111111-2222-3333-4444-555555555555","State":3,"ProcessorCount":1,"MemoryAssigned":0,"MemoryStartup":1073741824,"Generation":1,"Uptime":{"TotalSeconds":0}},{"Name":"a-vm","VMId":"aaaaaaaa-2222-3333-4444-555555555555","State":6,"Uptime":"01:02:03.5"},{"Name":"broken"}]`;
  const vms = HV.parseVms(list);
  assert.deepEqual(vms.map((v) => [v.name, v.state, v.memoryMb, v.uptimeS]), [['a-vm', 'saved', null, 3723], ['b-vm', 'stopped', 1024, 0]]);
  assert.deepEqual(HV.parseVms(''), []); assert.deepEqual(HV.parseVms('not json'), []); assert.deepEqual(HV.parseVms('[]'), []);
  assert.equal(HV.stateOf('Paused'), 'paused'); assert.equal(HV.stateOf(32773), 'stopping'); assert.equal(HV.stateOf('Weird'), 'other');
  assert.deepEqual(HV.parseListOutput('HWHV:NOMODULE\r\n'), { available: false, reason: 'no-module', vms: [] });
  const ok = HV.parseListOutput(`HWHV:OK\r\n${one}\r\n`);
  assert.equal(ok.available, true); assert.equal(ok.access, true); assert.equal(ok.vms[0].name, 'Win Test');
  const denied = HV.parseListOutput('HWHV:DENIED\r\nYou do not have the required permission to complete this task. Contact the administrator of the authorization policy.\r\n');
  assert.equal(denied.available, true); assert.equal(denied.access, false); assert.equal(denied.admin, true); assert.match(denied.error, /required permission/);
  assert.deepEqual(HV.parseListOutput(''), { available: false, reason: 'no-answer', vms: [] });
  // the listing script only reads
  assert.doesNotMatch(HV.LIST_PS, /Start-VM|Stop-VM|Checkpoint-VM|Set-|Remove-/);
});

test('#21 Hyper-V: quiet "not available" (asked once), actions only by GUID, names checked, admin message', async () => {
  const calls = [];
  const hv = new HV.HyperV({ platform: 'win32', run: async (cmd, args) => { calls.push(args[args.length - 1]); return { code: 0, stdout: 'HWHV:NOMODULE\n', stderr: '' }; } });
  assert.deepEqual(await hv.detect(), { available: false, reason: 'no-module', count: 0 });
  assert.deepEqual(await hv.list(), []);
  assert.equal(calls.length, 1); // remembered – no PowerShell every few seconds on Windows Home
  await hv.state({ fresh: true });
  assert.equal(calls.length, 2);
  await assert.rejects(hv.action('0e1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9', 'start'), (e) => e.status === 404);
  assert.deepEqual(await new HV.HyperV({ platform: 'linux', run: async () => { throw new Error('never'); } }).state(), { available: false, reason: 'not-windows', vms: [] });
  // action scripts: only a GUID, fixed cmdlets, checkpoint names without quotes
  const id = '0e1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
  assert.equal(HV.actionScript(id, 'start'), `Start-VM -VM (Get-VM -Id '${id}' -ErrorAction Stop) -ErrorAction Stop`);
  assert.match(HV.actionScript(id, 'turnoff'), /Stop-VM .* -TurnOff -Force/);
  assert.match(HV.actionScript(id, 'checkpoint', 'vor Update'), /Checkpoint-VM .* -SnapshotName 'vor Update'/);
  assert.throws(() => HV.actionScript("x'; Remove-Item C:\\ -Recurse; '", 'start'), /Invalid Hyper-V VM id/);
  assert.throws(() => HV.actionScript(id, 'checkpoint', "a'; Stop-Computer; '"), /Checkpoint name/);
  assert.throws(() => HV.actionScript(id, 'delete'), /Unknown action/);
  // with the module but without rights: a clear message
  const hv2 = new HV.HyperV({ platform: 'win32', run: async (cmd, args) => (/HWHV/.test(args[args.length - 1]) ? { code: 0, stdout: `HWHV:OK\n[]`, stderr: '' } : { code: 1, stdout: '', stderr: 'Start-VM : You do not have the required permission to complete this task.\nAt line:1 char:1' }) });
  assert.equal((await hv2.detect()).available, true);
  await assert.rejects(hv2.action(id, 'start'), (e) => e.status === 403 && /administrator/.test(e.message));
});

/* ---------------- #22 ARM ---------------- */
test('#22 spec: aarch64 forces UEFI and virtio graphics, refuses Windows and SATA; x86 descriptions stay as they were', () => {
  const arm = S.cleanVm({ name: 'Pi', arch: 'aarch64', firmware: 'bios', vga: 'std', disks: [{ id: 'disk0', file: 'disk0.qcow2', bus: 'virtio' }] }, { host: HOST });
  assert.equal(arm.arch, 'aarch64'); assert.equal(arm.firmware, 'uefi'); assert.equal(arm.vga, 'virtio');
  assert.throws(() => S.cleanVm({ name: 'W', arch: 'aarch64', osType: 'windows' }, { host: HOST }), /Windows on ARM/);
  assert.throws(() => S.cleanVm({ name: 'S', arch: 'aarch64', disks: [{ id: 'disk0', file: 'disk0.qcow2', bus: 'sata' }] }, { host: HOST }), /no SATA/);
  const x86 = S.cleanVm({ name: 'PC', arch: 'sparc' }, { host: HOST });
  assert.equal('arch' in x86, false);
  assert.equal('arch' in S.cleanVm({ name: 'PC' }, { prev: { ...arm }, host: HOST }), true); // kept on updates
  assert.deepEqual(S.defaultsFor('other', 'aarch64'), { cpus: 2, memoryMb: 2048, firmware: 'uefi', bus: 'virtio', model: 'virtio', vga: 'virtio', diskGb: 10 });
  assert.equal(S.defaultsFor('other').bus, 'sata'); // unchanged for x86
});

test('#22 QEMU command line for aarch64: virt, TCG, edk2-aarch64, virtio-scsi CD, USB keyboard + tablet, virtio-gpu', () => {
  const dir = path.join(os.tmpdir(), 'armvm');
  const vm = S.cleanVm({ id: 'armvm', name: 'ARM, Test', arch: 'aarch64', cpus: 2, memoryMb: 2048, cdrom: 'C:\\iso\\debian-arm64.iso', boot: 'cdrom', disks: [{ id: 'disk0', file: 'disk0.qcow2', bus: 'virtio' }], net: { forwards: [{ proto: 'tcp', host: 2222, guest: 22 }] } }, { host: HOST });
  vm.seed = 'seed.iso';
  const fw = { code: 'C:\\Program Files\\qemu\\share\\edk2-aarch64-code.fd', vars: 'x' };
  const a = buildArgs(vm, { dir, accel: ['whpx', 'tcg'], firmware: fw, ports: { qmp: 4001, qga: 4002, serial: 4003, vnc: 5901 }, platform: 'win32' });
  const s = a.join(' ');
  const after = (k) => a[a.indexOf(k) + 1];
  assert.equal(after('-machine'), 'virt,gic-version=max');
  assert.deepEqual(a.filter((x, i) => a[i - 1] === '-accel'), ['tcg']); // never WHPX for ARM
  assert.equal(after('-cpu'), 'max,pauth-impdef=on');
  assert.equal(after('-name'), 'guest=ARM,, Test');
  assert.ok(a.includes(`if=pflash,format=raw,unit=0,readonly=on,file=${fw.code}`));
  assert.ok(a.includes(`if=pflash,format=raw,unit=1,file=${path.join(dir, 'vars.fd')}`));
  assert.ok(a.includes('virtio-blk-pci,drive=disk0,bootindex=1'));
  assert.ok(a.includes('virtio-scsi-pci,id=scsi0'));
  assert.ok(a.includes('scsi-cd,id=cdrom0,drive=cd0,bus=scsi0.0,bootindex=0'));
  assert.ok(a.includes('virtio-blk-pci,drive=seed'));
  assert.ok(a.includes('virtio-gpu-pci'));
  assert.ok(a.includes('usb-kbd,id=kbd0,bus=xhci.0') && a.includes('usb-tablet,id=tablet0,bus=xhci.0'));
  assert.ok(a.includes('user,id=n0,hostfwd=tcp:127.0.0.1:2222-:22'));
  assert.ok(a.includes('chardev:ser0'));
  assert.doesNotMatch(s, /ide-cd|ide-hd|-vga|q35|whpx|hpet/);
  assert.throws(() => buildArgs({ ...vm, disks: [{ id: 'disk0', file: 'disk0.qcow2', bus: 'sata' }] }, { dir, firmware: fw, ports: { qmp: 1 } }), /no SATA/);
  assert.throws(() => buildArgs(vm, { dir, firmware: null, ports: { qmp: 1 } }), /edk2-aarch64/);
  // x86 unchanged: q35 and IDE CD as before
  const x = buildArgs(S.cleanVm({ id: 'pc', name: 'PC', disks: [{ id: 'disk0', file: 'disk0.qcow2', bus: 'virtio' }] }, { host: HOST }), { dir, accel: ['tcg'], ports: { qmp: 1 } });
  assert.equal(x[x.indexOf('-machine') + 1], 'q35');
  assert.ok(x.some((y) => /^ide-cd,id=cdrom0/.test(y)));
});

test('#22 QEMU host: qemu-system-aarch64 and its firmware next to QEMU; catalog has ARM64 cloud images with checksum lists', async () => {
  const q = path.join('C:\\Program Files', 'qemu');
  const have = new Set([path.join(q, 'qemu-system-x86_64.exe'), path.join(q, 'qemu-img.exe'), path.join(q, 'qemu-system-aarch64.exe'), path.join(q, 'share', 'edk2-aarch64-code.fd'), path.join(q, 'share', 'edk2-arm-vars.fd'), path.join(q, 'share', 'edk2-x86_64-code.fd'), path.join(q, 'share', 'edk2-i386-vars.fd')]);
  const exists = (p) => have.has(p);
  assert.deepEqual(QH.locateArm(q, { platform: 'win32', exists }), { system: path.join(q, 'qemu-system-aarch64.exe'), firmware: { code: path.join(q, 'share', 'edk2-aarch64-code.fd'), vars: path.join(q, 'share', 'edk2-arm-vars.fd') } });
  assert.equal(QH.locateArm(q, { platform: 'win32', exists: (p) => !/aarch64\.exe$/.test(p) && exists(p) }), null);
  // info(): aarch64 usable only when it answers and the firmware is there
  const run = async (exe, args) => (args[0] === '--version' ? { code: 0, stdout: 'QEMU emulator version 11.1.0' } : { code: 0, stdout: 'Accelerators supported in QEMU binary:\ntcg\nwhpx\n' });
  const host = new QH.QemuHost({ run, platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists, probe: async () => ({ ok: true }) });
  const info = await host.info();
  assert.deepEqual(info.aarch64, { system: path.join(q, 'qemu-system-aarch64.exe'), firmware: { code: path.join(q, 'share', 'edk2-aarch64-code.fd'), vars: path.join(q, 'share', 'edk2-arm-vars.fd') }, version: '11.1.0', ok: true, accel: 'tcg' });
  assert.equal(info.accel, 'whpx'); // x86 VMs keep WHPX
  const arm = catalog.list().filter((e) => e.arch === 'aarch64');
  assert.deepEqual(arm.map((e) => e.id), ['debian-12-arm64', 'debian-13-arm64', 'ubuntu-24.04-arm64']);
  for (const e of arm) { assert.match(e.url, /^https:\/\/cloud(-images)?\.(debian\.org|ubuntu\.com)\/.*arm64\.(qcow2|img)$/); assert.match(e.sums, /SHA(256|512)SUMS$/); }
  assert.equal(catalog.get('debian-12').arch, undefined); assert.equal(catalog.list().find((e) => e.id === 'debian-12').arch, 'x86_64');
  const sha = 'ab'.repeat(64);
  const r = await catalog.resolve(catalog.get('debian-12-arm64'), { fetchText: async () => `${'cd'.repeat(64)}  debian-12-genericcloud-amd64.qcow2\n${sha}  debian-12-genericcloud-arm64.qcow2\n` });
  assert.deepEqual(r, { url: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-arm64.qcow2', file: 'debian-12-genericcloud-arm64.qcow2', hash: sha, algo: 'sha512' });
});

test('#22 manager: ARM VMs from the ARM image or chosen for an empty VM; virtio disk; catalog ISOs stay x86', async () => {
  const { m } = make();
  await m.create({ source: 'cloud', image: 'debian-12-arm64', name: 'Arm Cloud', user: 'demo', password: 'geheim123', arch: 'x86_64' }).promise;
  const c = m.get('arm-cloud');
  assert.equal(c.arch, 'aarch64'); assert.equal(c.firmware, 'uefi'); assert.equal(c.disks[0].bus, 'virtio'); assert.equal(c.osLabel, 'Debian 12 (Bookworm) · ARM64');
  await m.create({ source: 'empty', name: 'Arm Empty', osType: 'other', arch: 'aarch64', diskGb: 1 }).promise;
  const e = m.get('arm-empty');
  assert.equal(e.arch, 'aarch64'); assert.equal(e.disks[0].bus, 'virtio');
  await m.create({ source: 'empty', name: 'Pc Empty', osType: 'other', diskGb: 1 }).promise;
  assert.equal('arch' in m.get('pc-empty'), false); assert.equal(m.get('pc-empty').disks[0].bus, 'sata');
  assert.throws(() => m.create({ source: 'empty', name: 'Arm Win', osType: 'windows', arch: 'aarch64' }), /Windows on ARM/);
  assert.throws(() => m.create({ source: 'empty', name: 'Bad', arch: 'mips' }), /Unknown architecture/);
  // a linked clone of an ARM template stays ARM
  await m.setTemplate('arm-empty', true);
  await m.create({ source: 'template', template: 'arm-empty', name: 'Arm Clone' }).promise;
  assert.equal(m.get('arm-clone').arch, 'aarch64');
});
