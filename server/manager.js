'use strict';
/*
 * Virtual machines: one folder per VM under <root>/<id>/ (vm.json, disks, vars.fd, seed.iso, serial.log), images cache
 * in <root>/.images, backups in <root>/.backups/<id>/<stamp>/. Every long step runs as a Hostwerk job (progress,
 * cancel, journal). QEMU VMs run through runtime.js; VirtualBox VMs through vbox.js.
 *
 * Dependencies are injected (tests/manager.test.js uses fakes for QEMU, jobs and downloads):
 *   new VmManager({ root, qhost, vbox, Proc, registry, runJob, downloadFile, fetchText, broadcast, host: { cpus, memoryMb } })
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const S = require('./spec');
const U = require('./util');
const catalog = require('./catalog');
const { seedFiles, hostnameFrom } = require('./cloudinit');
const { buildIso } = require('./iso');
const { Runtime } = require('./runtime');
const { formatOf, installPlan } = require('./qemu-host');
const { extractTar, parseOvf, listTar } = require('./importer');
const { osTypeOf } = require('./vbox');
const W = require('./windows');
const { Switches } = require('./netswitch');
const { createShareServer, linuxMountScript, windowsMapCommand } = require('./webdav');
const { listTaps } = require('./tap');
const A = require('./apps');

const ISO_RE = /\.(iso|img)$/i;
const DISK_IMPORT_RE = /\.(qcow2?|vdi|vmdk|vhdx?|img|raw)$/i;

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
function readJson(file, d = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return d; } }
/** Linux guest: the NIC with this MAC gets the address (if it does not have it yet) → prints the NIC name. */
function linuxIpScript(m) {
  const mac = String(m.mac).toLowerCase();
  const ip = S.checkCidr(m.ip);
  return `i=''; for d in /sys/class/net/*; do [ "$(cat "$d/address" 2>/dev/null)" = "${mac}" ] && i=$(basename "$d"); done; [ -n "$i" ] || { echo "no NIC with ${mac}" >&2; exit 3; }; ip link set "$i" up; ip -4 addr show dev "$i" | grep -q " ${ip} " || ip addr add ${ip} dev "$i"; echo "$i"`;
}
/** Windows guest (PowerShell): same by MAC – not verified on a real Windows guest yet. */
function windowsIpScript(m) {
  const mac = String(m.mac).toUpperCase().replace(/:/g, '-');
  const [ip, prefix] = S.checkCidr(m.ip).split('/');
  return `$a = Get-NetAdapter | Where-Object { $_.MacAddress -eq '${mac}' } | Select-Object -First 1; if (-not $a) { throw 'no NIC with ${mac}' }; if (-not (Get-NetIPAddress -InterfaceIndex $a.ifIndex -IPAddress '${ip}' -ErrorAction SilentlyContinue)) { New-NetIPAddress -InterfaceIndex $a.ifIndex -IPAddress '${ip}' -PrefixLength ${prefix} | Out-Null }; $a.Name`;
}

/** qemu-img options for one disk: the key file only for encrypted disks (calls for plain disks stay as they were). */
const kx = (k, key) => (k && k.encrypted && key ? [{ key }] : []);

function stamp(t = new Date()) { return t.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-'); }

/** sha256/sha512 of a file, streamed. */
function hashFile(file, algo) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

class VmManager {
  constructor(o) {
    this.root = o.root;
    this.qhost = o.qhost; this.vbox = o.vbox; this.Proc = o.Proc; this.registry = o.registry || null;
    this.runJob = o.runJob; this.downloadFile = o.downloadFile; this.fetchText = o.fetchText;
    this.broadcast = o.broadcast || (() => {});
    this.hostRes = o.host || { cpus: os.cpus().length, memoryMb: Math.round(os.totalmem() / 1048576) };
    this.platform = o.platform || process.platform;
    this.runtimes = new Map();
    this.busy = new Map(); // id → what is happening (creating, snapshot, backup …)
    this.vms = new Map();
    this.vboxCache = { at: 0, list: [] };
    // Package 4: internal networks (switch per network), shared folders (WebDAV on 127.0.0.1), TAP adapters, disk keys
    this.secrets = o.secrets || null; // Hostwerk's secret store: seal(text) → 'enc:…', open('enc:…') → text
    this.switches = o.switches || new Switches();
    this.listTapsFn = o.listTaps || (() => listTaps());
    this.runFn = o.run || U.run;
    this.hostname = o.hostname || os.hostname();
    this.dav = null; this.davStarting = null;
    this.guestSetup = new Map(); // id → what was set up in the guest after the agent answered (IPs, mounted shares)
    // Package 5: Hyper-V listing (#21), Hostwerk's AI short answers (#20: { ready(), run(task, opts) } – host.ai.quick)
    this.hyperv = o.hyperv || null;
    this.ai = o.ai || null;
    this.appStates = new Map(); // id → last state of the app setup / start script in the guest
    fs.mkdirSync(this.root, { recursive: true });
    this.load();
  }

  /* ---------------- Store ---------------- */
  get configFile() { return path.join(this.root, '.config.json'); }
  config() { return { lanForwards: false, networks: [], ...readJson(this.configFile, {}) }; }
  setConfig(patch) {
    const c = { ...this.config(), ...(patch && typeof patch.lanForwards === 'boolean' ? { lanForwards: patch.lanForwards } : {}) };
    writeJson(this.configFile, c);
    this.changed(null, 'config');
    return c;
  }
  lanAllowed() { return this.config().lanForwards === true; }

  /* ---------------- Internal networks (#7) ---------------- */
  /** Networks of this PC with their members: [{ id, name, n, subnet, members: [{ id, name, ip, running }], active }] */
  networks() {
    return (this.config().networks || []).map((n) => {
      const members = [...this.vms.values()].filter((v) => (v.nets || []).some((x) => x.net === n.id)).map((v) => ({ id: v.id, name: v.name, ip: v.nets.find((x) => x.net === n.id).ip, running: this.isRunning(v.id) })).sort((a, b) => a.name.localeCompare(b.name));
      const sw = this.switches.info(n.id);
      return { ...n, subnet: `10.10.${n.n}.0/24`, members, active: sw ? sw.members : 0 };
    });
  }
  addNetwork({ name } = {}) {
    const nm = String(name || '').trim();
    if (!/^[^\u0000-\u001f<>"]{1,40}$/.test(nm)) throw U.fail(400, 'Network name: 1–40 characters.');
    const c = this.config();
    const list = c.networks || [];
    if (list.length >= 20) throw U.fail(400, 'At most 20 internal networks.');
    if (list.some((x) => x.name.toLowerCase() === nm.toLowerCase())) throw U.fail(409, 'A network named “{name}” exists already.', { name: nm });
    let id = U.slug(nm, new Set(list.map((x) => x.id))).slice(0, 24);
    if (!S.NET_ID_RE.test(id)) id = `net-${crypto.randomBytes(2).toString('hex')}`;
    const n = [...Array(250).keys()].map((i) => i + 1).find((i) => !list.some((x) => x.n === i));
    const net = { id, name: nm, n, createdAt: Date.now() };
    writeJson(this.configFile, { ...c, networks: [...list, net] });
    this.changed(null, 'networks');
    return net;
  }
  renameNetwork(id, { name } = {}) {
    const c = this.config();
    const net = (c.networks || []).find((x) => x.id === id);
    if (!net) throw U.fail(404, 'Unknown internal network.');
    const nm = String(name || '').trim();
    if (!/^[^\u0000-\u001f<>"]{1,40}$/.test(nm)) throw U.fail(400, 'Network name: 1–40 characters.');
    net.name = nm;
    writeJson(this.configFile, c);
    this.changed(null, 'networks');
    return net;
  }
  removeNetwork(id) {
    const c = this.config();
    if (!(c.networks || []).some((x) => x.id === id)) throw U.fail(404, 'Unknown internal network.');
    const users = [...this.vms.values()].filter((v) => (v.nets || []).some((x) => x.net === id));
    if (users.length) throw U.fail(409, 'VMs are still in this network: {list}.', { list: users.map((v) => v.name).join(', ') });
    writeJson(this.configFile, { ...c, networks: c.networks.filter((x) => x.id !== id) });
    this.changed(null, 'networks');
    return { ok: true };
  }
  /** A free address for a VM in a network: 10.10.<n>.10, .11 … */
  suggestIp(netId) {
    const net = (this.config().networks || []).find((x) => x.id === netId);
    if (!net) throw U.fail(404, 'Unknown internal network.');
    const used = new Set([...this.vms.values()].flatMap((v) => (v.nets || []).filter((x) => x.net === netId && x.ip).map((x) => x.ip.split('/')[0])));
    for (let i = 10; i < 255; i++) if (!used.has(`10.10.${net.n}.${i}`)) return `10.10.${net.n}.${i}/24`;
    return null;
  }
  /** Memberships of a VM: the networks exist, no address twice in one network. */
  checkNets(vm) {
    const known = new Set((this.config().networks || []).map((x) => x.id));
    for (const m of vm.nets || []) {
      if (!known.has(m.net)) throw U.fail(400, 'Unknown internal network.');
      if (!m.ip) continue;
      const ip = m.ip.split('/')[0];
      const other = [...this.vms.values()].find((v) => v.id !== vm.id && (v.nets || []).some((x) => x.net === m.net && x.ip && x.ip.split('/')[0] === ip));
      if (other) throw U.fail(409, 'IP address {ip} is already used by “{name}” in this network.', { ip, name: other.name });
    }
  }

  /* ---------------- Shared folders (#13) ---------------- */
  /** The folder for a share token – only while its VM runs (otherwise nobody may read it). */
  shareFor(token) {
    for (const vm of this.vms.values()) {
      const s = (vm.shares || []).find((x) => x.token === token);
      if (s) return this.isRunning(vm.id) && fs.existsSync(s.path) ? { root: s.path, readOnly: s.readOnly, name: s.name } : null;
    }
    return null;
  }
  /** Starts the WebDAV server once (127.0.0.1, port kept in .config.json so addresses in the guests stay valid). */
  async ensureShareServer() {
    if (this.dav) return this.dav.port;
    if (this.davStarting) return this.davStarting;
    this.davStarting = (async () => {
      const dav = createShareServer({ resolve: (t) => this.shareFor(t), log: (l) => this.broadcast({ type: 'vms-log', text: l }) });
      const want = Number(this.config().sharePort) || 0;
      let port = null;
      if (want) port = await dav.listen(want).catch(() => null);
      if (!port) port = await dav.listen(await U.freePort(47950));
      if (port !== want) writeJson(this.configFile, { ...this.config(), sharePort: port });
      this.dav = dav;
      return port;
    })().finally(() => { this.davStarting = null; });
    return this.davStarting;
  }
  async stopShareServer() { if (this.dav) { await this.dav.close(); this.dav = null; } }
  checkShares(vm) {
    for (const s of vm.shares || []) {
      if (!fs.existsSync(s.path) || !fs.statSync(s.path).isDirectory()) throw U.fail(404, 'The folder was not found: {path}', { path: s.path });
      const rel = path.relative(path.resolve(this.root), path.resolve(s.path));
      if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw U.fail(400, 'The VM folder of Hostwerk cannot be shared.');
    }
  }
  /** How the guest reaches a share: address, mount point in Linux, command for Windows. */
  shareInfo(s) {
    const port = Number(this.config().sharePort) || (this.dav && this.dav.port) || null;
    const url = port ? `http://10.0.2.2:${port}/${s.token}/` : null;
    const dirName = s.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || s.id;
    return { url, mount: `/mnt/hostwerk/${dirName}`, windows: url ? windowsMapCommand({ url }) : null };
  }
  /** Mounts a share in a running Linux guest through the guest agent (installs davfs2 there if missing). */
  async mountShare(id, shareId) {
    const vm = this.get(id);
    const s = (vm.shares || []).find((x) => x.id === shareId);
    if (!s) throw U.fail(404, 'Shared folder not found.');
    if (vm.net && vm.net.mode !== 'user') throw U.fail(409, 'Shared folders need the normal network (NAT) of the VM.');
    await this.ensureShareServer();
    const info = this.shareInfo(s);
    if (vm.osType === 'windows') return { windows: true, command: info.windows, url: info.url };
    const user = vm.ssh && vm.ssh.user && /^[a-z_][a-z0-9_-]{0,31}$/.test(vm.ssh.user) ? vm.ssh.user : null;
    const r = await this.guestExec(id, linuxMountScript({ url: info.url, mount: info.mount, readOnly: s.readOnly, user }), { timeout: 6 * 60000 });
    if (r.timedOut || r.code !== 0) throw U.fail(500, 'Mounting in the VM failed: {error}', { error: (r.err || r.out || (r.timedOut ? 'timeout' : `code ${r.code}`)).trim().split(/\r?\n/).slice(-2).join(' ') });
    return { mount: info.mount, url: info.url, already: /already/.test(r.out) };
  }

  /* ---------------- After the guest agent answers ---------------- */
  /**
   * Linux guests: addresses in internal networks (found by MAC, added if missing – again after every start, so they
   * stay without any configuration in the guest) and shared folders marked "mount automatically". Windows: addresses
   * through PowerShell (not verified on a real Windows guest yet).
   */
  async afterAgent(id) {
    const vm = this.get(id);
    const out = { nets: [], shares: [], at: Date.now() };
    const r = this.runtimes.get(id);
    const log = (l) => { if (r && r.proc && r.proc.log) r.proc.log(l, 'sys'); };
    for (const m of (vm.nets || []).filter((x) => x.ip)) {
      try {
        const res = await this.guestExec(id, vm.osType === 'windows' ? windowsIpScript(m) : linuxIpScript(m), { timeout: 30000 });
        const ok = res.code === 0;
        out.nets.push({ net: m.net, ip: m.ip, ok, iface: ok ? res.out.trim().split(/\s+/).pop() : null, error: ok ? null : (res.err || res.out).trim().slice(-300) });
        log(`Internal network ${m.net}: ${ok ? `${m.ip} on ${res.out.trim()}` : `could not set ${m.ip} (${(res.err || res.out).trim().slice(-200)})`}`);
      } catch (e) { out.nets.push({ net: m.net, ip: m.ip, ok: false, error: e.message }); }
    }
    if (vm.osType !== 'windows') {
      for (const s of (vm.shares || []).filter((x) => x.auto)) {
        try { const res = await this.mountShare(id, s.id); out.shares.push({ id: s.id, ok: true, mount: res.mount }); log(`Shared folder ${s.name} → ${res.mount}`); } catch (e) { out.shares.push({ id: s.id, ok: false, error: e.message }); log(`Shared folder ${s.name}: ${e.message}`); }
      }
    }
    this.guestSetup.set(id, out);
    this.changed(id, 'guest-setup');
    return out;
  }

  /* ---------------- Encrypted disks (#15) ---------------- */
  /** The disk key in plain text – only in memory and in short-lived key files. */
  keyOf(vm) {
    if (!vm.encryption) return null;
    if (!this.secrets) throw U.fail(501, 'Encrypted disks need Hostwerk’s secret store.');
    const k = vm.encryption.key ? this.secrets.open(vm.encryption.key) : '';
    if (!k) throw U.fail(409, 'The disk key of “{name}” is not available on this PC – enter it under Hardware → Encryption.', { name: vm.name }, 'KEY_LOCKED');
    return k;
  }
  /** A new random key, sealed with Hostwerk's secret store. */
  newEncryption() {
    if (!this.secrets) throw U.fail(501, 'Encrypted disks need Hostwerk’s secret store.');
    const plain = crypto.randomBytes(32).toString('hex');
    return { plain, enc: { format: 'luks', key: this.secrets.seal(plain) } };
  }
  writeKeyFile(id, plain) { return U.writeSecretFile(this.dirOf(id), plain, { runFn: this.runFn }); }
  /** Runs fn(keyFile) with a key file of the VM (null for VMs without encryption) and deletes the file afterwards. */
  async withKey(vm, fn, plain = null) {
    if (!vm.encryption && !plain) return fn(null);
    const file = await this.writeKeyFile(vm.id, plain || this.keyOf(vm));
    try { return await fn(file); } finally { U.removeSecretFile(file); }
  }
  /** The key in plain text – to note it down or to unlock the VM after moving it to another PC. */
  diskKey(id) {
    const vm = this.get(id);
    if (!vm.encryption) throw U.fail(400, 'The disks of this VM are not encrypted.');
    return { key: this.keyOf(vm) };
  }
  /** After moving to another PC (or a new Hostwerk): the key is checked against the disk and sealed here. */
  async unlock(id, { key } = {}) {
    const vm = this.get(id);
    if (!vm.encryption) throw U.fail(400, 'The disks of this VM are not encrypted.');
    const k = String(key || '').trim();
    if (!/^[\x21-\x7e]{8,200}$/.test(k)) throw U.fail(400, 'Disk key: the 64 characters noted down for this VM.');
    const disk = vm.disks.find((d) => d.encrypted);
    if (!disk) throw U.fail(400, 'The disks of this VM are not encrypted.');
    await this.withKey(vm, (file) => this.qhost.checkKey(path.join(this.dirOf(id), disk.file), file), k).catch((e) => { throw U.fail(400, /password|keyslot/i.test(e.message) ? 'Wrong disk key.' : e.message); });
    if (!this.secrets) throw U.fail(501, 'Encrypted disks need Hostwerk’s secret store.');
    vm.encryption = { format: vm.encryption.format || 'luks', key: this.secrets.seal(k) };
    this.save(vm);
    this.changed(id, 'updated');
    return this.view(vm);
  }
  /** Encrypts the disks of an existing VM (a copy with encryption replaces each disk). */
  encryptDisks(id) {
    const vm = this.get(id);
    this.requireStopped(id, 'encrypt its disks');
    if (vm.template || vm.linkedTo || [...this.vms.values()].some((x) => x.linkedTo === id)) throw U.fail(409, 'Templates and linked clones cannot be encrypted.');
    if (Object.keys(vm.snapshots || {}).length) throw U.fail(409, 'Delete the snapshots first – encrypting rewrites the disks.');
    const todo = vm.disks.filter((k) => k.format === 'qcow2' && !k.encrypted);
    if (!todo.length) throw U.fail(400, 'All disks are encrypted already.');
    if (vm.disks.some((k) => k.format !== 'qcow2')) throw U.fail(400, 'Only qcow2 disks can be encrypted.');
    const fresh = vm.encryption ? null : this.newEncryption();
    return this.runJob(U.T('Encrypt disks of “{name}”', { name: vm.name }), (job) => this.withBusy(id, 'Encrypting', async () => {
      const plain = fresh ? fresh.plain : this.keyOf(vm);
      await this.withKey(vm, async (key) => {
        for (const [i, k] of todo.entries()) {
          job.status(U.T('Encrypting disk {n} of {total} …', { n: i + 1, total: todo.length }));
          const f = path.join(this.dirOf(id), k.file);
          const tmp = `${f}.encrypt`;
          fs.rmSync(tmp, { force: true });
          try { await this.qhost.convert(f, tmp, { destKey: key, onProgress: (p) => job.progress(((i + p / 100) / todo.length) * 98) }); fs.renameSync(tmp, f); } finally { fs.rmSync(tmp, { force: true }); }
          k.encrypted = true;
          if (fresh) vm.encryption = fresh.enc;
          this.save(vm); // after every disk – a crash in between leaves a consistent description
        }
      }, plain);
      this.changed(id, 'updated');
      return { disks: todo.map((k) => k.id) };
    }));
  }

  load() {
    this.vms.clear();
    for (const d of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.') || !U.ID_RE.test(d.name)) continue;
      const vm = readJson(path.join(this.root, d.name, 'vm.json'));
      if (vm && vm.id === d.name) {
        if (vm.creating) { vm.broken = true; } // creation interrupted (Hostwerk quit) – offered for removal
        this.vms.set(vm.id, vm);
      }
      // Key files of encrypted disks live only for seconds – one left over (crash) is removed
      try { for (const f of fs.readdirSync(path.join(this.root, d.name))) if (/^\.hwkey-[a-f0-9]{12}$/.test(f)) U.removeSecretFile(path.join(this.root, d.name, f)); } catch { /* egal */ }
    }
  }
  dirOf(id) { return path.join(this.root, U.checkId(id)); }
  get(id) { const vm = this.vms.get(U.checkId(id)); if (!vm) throw U.fail(404, 'VM not found.'); return vm; }
  save(vm) { fs.mkdirSync(this.dirOf(vm.id), { recursive: true }); writeJson(path.join(this.dirOf(vm.id), 'vm.json'), vm); this.vms.set(vm.id, vm); }
  changed(id, what) { this.broadcast({ type: 'vms', id, what }); }
  /** A message for the person (Hostwerk's toast; index.js may route it to Hostwerk's notification channels). */
  notify(kind, text) { if (this.onNotify) this.onNotify(kind, text); else this.broadcast({ type: 'toast', kind, text }); }

  rt(id) {
    let r = this.runtimes.get(id);
    if (!r) {
      r = new Runtime(this.get(id), {
        qhost: this.qhost, Proc: this.Proc, registry: this.registry, dir: this.dirOf(id), lanAllowed: () => this.lanAllowed(),
        switches: this.switches,
        currentVm: () => (this.vms.has(id) ? this.get(id) : null),
        prepareKey: () => this.writeKeyFile(id, this.keyOf(this.get(id))),
        checkTap: async (name) => { const list = await this.listTapsFn().catch(() => []); if (!list.some((x) => x.name === name)) throw U.fail(409, 'The TAP adapter “{name}” was not found on this PC – install TAP-Windows (OpenVPN) or choose another network.', { name }); },
        onChange: (what, data) => {
          this.changed(id, what);
          if (what === 'agent' && this.vms.get(id) && this.vms.get(id).install && this.vms.get(id).install.state === 'running' && r.agentInfo && r.agentInfo.ok) this.finishInstall(id).catch(() => {});
          if (what === 'agent' && r.agentInfo && r.agentInfo.ok) this.afterAgent(id).catch(() => {});
          if (what === 'stopped') this.guestSetup.delete(id);
          if (what === 'disk-full') this.notify('warn', U.T('VM “{name}”: disk {mount} is {pct} % full.', { name: this.vms.get(id) ? this.vms.get(id).name : id, mount: data[0].mount, pct: data[0].pct }));
        },
      });
      this.runtimes.set(id, r);
    }
    r.vm = this.get(id); // always the stored description
    return r;
  }
  stateOf(id) { const r = this.runtimes.get(id); return r ? r.status() : { state: 'stopped' }; }
  isRunning(id) { const r = this.runtimes.get(id); return !!(r && r.isRunning()); }
  requireStopped(id, what) { if (this.isRunning(id)) throw U.fail(409, 'Shut the VM down first to {what}.', { what: U.T(what) }); }
  async withBusy(id, what, fn) {
    if (this.busy.has(id)) throw U.fail(409, 'The VM is busy: {what}.', { what: U.T(this.busy.get(id)) });
    this.busy.set(id, what); this.changed(id, 'busy');
    try { return await fn(); } finally { this.busy.delete(id); this.changed(id, 'busy'); }
  }

  view(vm) {
    const st = this.stateOf(vm.id);
    const clones = [...this.vms.values()].filter((x) => x.linkedTo === vm.id).map((x) => x.id);
    const v = { ...S.publicVm(vm), status: st, busy: this.busy.get(vm.id) || null, clones, dir: this.dirOf(vm.id) };
    if (vm.encryption) v.encryption = { format: vm.encryption.format, key: vm.encryption.key || null, locked: !this.keyAvailable(vm) }; // the key stays sealed
    if ((vm.shares || []).length) v.shares = vm.shares.map((s) => ({ ...s, ...this.shareInfo(s) }));
    if (this.guestSetup.has(vm.id)) v.guestSetup = this.guestSetup.get(vm.id);
    if (vm.app) { const app = A.get(vm.app.id); v.appInfo = { id: vm.app.id, label: app ? app.label : vm.app.id, open: A.appUrl(vm), state: this.appStates.get(vm.id) || null }; }
    return v;
  }
  keyAvailable(vm) { try { return !!this.keyOf(vm); } catch { return false; } }
  list() { return [...this.vms.values()].sort((a, b) => a.name.localeCompare(b.name)).map((vm) => this.view(vm)); }
  async detail(id) {
    const vm = this.get(id);
    const v = this.view(vm);
    v.diskInfo = [];
    for (const k of vm.disks) {
      const f = path.join(this.dirOf(id), k.file);
      let info = null;
      try { info = await this.qhost.diskInfo(f); } catch { info = null; }
      v.diskInfo.push({ id: k.id, file: k.file, bus: k.bus, format: k.format, virtualSize: info ? info.virtualSize : null, actualSize: info ? info.actualSize : (fs.existsSync(f) ? fs.statSync(f).size : null), backing: info ? info.backing : null });
    }
    v.ssh = this.sshInfo(vm);
    v.memory = S.memoryCheck(this.runningMemoryMb(id), vm.memoryMb, this.hostRes.memoryMb);
    return v;
  }
  runningMemoryMb(except) { let mb = 0; for (const [id, vm] of this.vms) if (id !== except && this.isRunning(id)) mb += vm.memoryMb; return mb; }
  sshInfo(vm) {
    const f = (vm.net && vm.net.forwards || []).find((x) => x.guest === 22 && x.proto === 'tcp');
    if (!f) return null;
    const user = vm.ssh && vm.ssh.user;
    return { port: f.host, user: user || null, command: `ssh -p ${f.host} ${user ? `${user}@` : ''}127.0.0.1` };
  }

  /* ---------------- Engines ---------------- */
  async engines({ fresh = false } = {}) {
    const [qemu, vboxVersion] = await Promise.all([this.qhost.info({ fresh }), this.vbox ? this.vbox.version().catch(() => null) : null]);
    let freeGb = null;
    try { const s = fs.statfsSync(this.root); freeGb = Math.round((s.bavail * s.bsize) / 2 ** 30); } catch { /* egal */ }
    return { qemu, vbox: { installed: !!vboxVersion, version: vboxVersion }, host: { ...this.hostRes, freeGb, platform: this.platform }, install: installPlan(this.platform), root: this.root, config: this.config() };
  }

  /** Installs QEMU (Windows: winget – Windows asks for administrator rights once). */
  installQemu() {
    const plan = installPlan(this.platform);
    if (plan.method !== 'winget') throw U.fail(400, 'Install QEMU with your package manager: {cmd}', { cmd: plan.command });
    return this.runJob(U.T('Install QEMU'), async (job) => {
      job.progress(5, U.T('Windows asks for administrator rights …'));
      const r = await U.run('winget', ['install', '--id', plan.id, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'], { timeout: 30 * 60000 });
      job.log(`${r.stdout}\n${r.stderr}`.trim().slice(-3000));
      const info = await this.qhost.info({ fresh: true });
      if (!info.installed) throw new Error(r.code === 0 ? U.T('QEMU was installed but not found – start Hostwerk again.') : U.T('winget could not install QEMU (code {code}).', { code: r.code }));
      this.changed(null, 'engines');
      return { version: info.version, accel: info.accel };
    }, { key: 'vms-install-qemu' });
  }

  /* ---------------- Images ---------------- */
  get imageDir() { return path.join(this.root, '.images'); }
  listImages() {
    if (!fs.existsSync(this.imageDir)) return [];
    return fs.readdirSync(this.imageDir).filter((f) => !f.endsWith('.part') && !f.endsWith('.json')).map((f) => {
      const st = fs.statSync(path.join(this.imageDir, f));
      const meta = readJson(path.join(this.imageDir, `${f}.json`), {});
      return { file: f, size: st.size, t: st.mtimeMs, label: meta.label || f, id: meta.id || null, path: path.join(this.imageDir, f) };
    }).sort((a, b) => b.t - a.t);
  }
  removeImage(file) {
    const f = path.basename(String(file || ''));
    if (!f || f.startsWith('.')) throw U.fail(400, 'Invalid file.');
    fs.rmSync(path.join(this.imageDir, f), { force: true });
    fs.rmSync(path.join(this.imageDir, `${f}.json`), { force: true });
  }
  /** Downloads a catalog image once (checksum checked) and keeps it for later VMs. */
  async ensureImage(entry, job, from = 0, to = 60) {
    const r = await catalog.resolve(entry, { fetchText: this.fetchText });
    const dest = path.join(this.imageDir, r.file);
    const meta = path.join(this.imageDir, `${r.file}.json`);
    const known = readJson(meta);
    if (fs.existsSync(dest) && known && known.hash === r.hash) { job.log(U.T('Using the image from the cache: {file}', { file: r.file })); return dest; }
    fs.mkdirSync(this.imageDir, { recursive: true });
    job.status(U.T('Downloading {name} …', { name: entry.label }));
    fs.rmSync(dest, { force: true });
    await this.downloadFile(r.url, dest, { sha256: r.algo === 'sha256' ? r.hash : undefined, onProgress: (received, total) => { const pct = total ? Math.min(100, (received / total) * 100) : 0; job.progress(from + ((to - from) * pct) / 100); } }); // Hostwerk: onProgress(received, total) in bytes
    if (r.algo !== 'sha256') {
      job.status(U.T('Checking the checksum …'));
      const got = await hashFile(dest, r.algo);
      if (got !== r.hash) { fs.rmSync(dest, { force: true }); throw new Error(U.T('The download is damaged (checksum does not match) – please try again.')); }
    }
    writeJson(meta, { id: entry.id, label: entry.label, url: r.url, hash: r.hash, algo: r.algo, t: Date.now() });
    return dest;
  }

  /**
   * virtio-win drivers for Windows (#3): one ISO in the image cache. The project publishes no checksum, so the SHA-256
   * is held fixed: from the list in windows.js, or – for a version not listed yet – from the first download on this PC
   * (<root>/.pins.json). A later download of the same version must match exactly.
   */
  async ensureDrivers(job, from = 0, to = 100) {
    const r = await W.resolveVirtioWin({ fetchText: this.fetchText });
    const dest = path.join(this.imageDir, r.file);
    const meta = `${dest}.json`;
    const pinsFile = path.join(this.root, '.pins.json');
    const pins = readJson(pinsFile, {});
    const expect = r.hash || pins[r.file] || null;
    const known = readJson(meta);
    if (fs.existsSync(dest) && known && (!expect || known.hash === expect)) { job.log(U.T('Using the image from the cache: {file}', { file: r.file })); return dest; }
    fs.mkdirSync(this.imageDir, { recursive: true });
    fs.rmSync(dest, { force: true });
    job.status(U.T('Downloading {name} …', { name: W.VIRTIO_WIN.label }));
    await this.downloadFile(r.url, dest, { sha256: expect || undefined, onProgress: (received, total) => { if (total) job.progress(from + ((to - from) * received) / total); } });
    const got = await hashFile(dest, 'sha256');
    if (expect && got !== expect) { fs.rmSync(dest, { force: true }); throw new Error(U.T('The download is damaged (checksum does not match) – please try again.')); }
    if (!expect) { pins[r.file] = got; writeJson(pinsFile, pins); job.log(U.T('Checksum of {file} held fixed: {hash}', { file: r.file, hash: got })); }
    writeJson(meta, { id: 'virtio-win', label: W.VIRTIO_WIN.label, url: r.url, hash: got, algo: 'sha256', version: r.version, pinned: !!r.pinned || !expect, t: Date.now() });
    return dest;
  }

  /** Windows installed itself and its guest agent answers: switch to booting from disk, drop the answer file. */
  async finishInstall(id) {
    const vm = this.get(id);
    if (!vm.install || vm.install.state !== 'running') return false;
    vm.install = { ...vm.install, state: 'done', doneAt: Date.now() };
    vm.boot = 'disk';
    vm.seed = null; // unattend.iso is deleted on the next start (QEMU still holds it now)
    this.save(vm);
    const r = this.runtimes.get(id);
    if (r && r.qmp) await r.qmp.exec('eject', { id: 'seedcd', force: true }).catch(() => {});
    // SECURITY: Setup's copies of the answer file hold the password in plain text. The first-logon command deletes them
    // too, but the guest agent can answer before that ran – so Hostwerk deletes them itself and checks.
    if (r && typeof r.guestExec === 'function') {
      const res = await r.guestExec(W.PANTHER_CLEANUP, { timeout: 30000 }).catch((e) => ({ code: -1, out: e.message }));
      const left = String((res && res.out) || '').trim();
      vm.install = { ...vm.install, answerFileRemoved: !!res && res.code === 0 && !left };
      this.save(vm);
      if (!vm.install.answerFileRemoved) this.notify('warn', U.T('Windows in “{name}”: the copy of the answer file in {path} could not be deleted – it contains the password.', { name: vm.name, path: 'C:\\Windows\\Panther' }));
    }
    this.changed(id, 'installed');
    this.notify('success', U.T('Windows in “{name}” is installed – sign in as {user}.', { name: vm.name, user: vm.install.user || '' }));
    return true;
  }

  /* ---------------- Create ---------------- */
  newId(name) { return U.slug(name, new Set([...this.vms.keys(), ...fs.readdirSync(this.root)])); }
  /** Validated description of a new VM (throws 4xx before any job starts). */
  plan(body) {
    const b = body || {};
    const id = this.newId(b.name);
    const d = S.defaultsFor(b.osType || 'linux', b.arch);
    const bus = S.BUSES.includes(b.bus) ? b.bus : d.bus;
    const vm = S.cleanVm({ ...b, id, disks: [{ id: 'disk0', file: 'disk0.qcow2', bus, format: 'qcow2' }] }, { host: this.hostRes, lanAllowed: this.lanAllowed() });
    vm.id = id;
    vm.net.mac = U.macFor(id);
    vm.nets = S.cleanNets((vm.nets || []).map((x) => ({ net: x.net, ip: x.ip })), id); // MACs from the final id
    this.checkNets(vm);
    this.checkShares(vm);
    return vm;
  }

  /**
   * New VM. body.source:
   *   'cloud'    { image, user, password, sshKeys, timezone, diskGb } – ready-made Linux with cloud-init
   *   'iso'      { iso | image, diskGb }                                – installer
   *   'empty'    { diskGb }                                             – blank disk (e.g. network boot, later ISO)
   *   'disk'     { file }                                               – existing disk image (qcow2, vdi, vmdk, vhdx, raw)
   *   'ova'      { file }                                               – appliance (OVA/OVF)
   *   'template' { template }                                           – linked clone of a template (seconds)
   *   'clone'    { from, linked }                                       – copy of a VM
   *   'vbox'     { uuid }                                               – take over a VirtualBox VM
   * Returns the job; the VM shows up at once (state "creating").
   */
  create(body) {
    const b = body || {};
    const source = String(b.source || 'empty');
    if (!['cloud', 'iso', 'empty', 'disk', 'ova', 'template', 'clone', 'vbox'].includes(source)) throw U.fail(400, 'Unknown source.');
    let entry = null;
    if (source === 'cloud' || (source === 'iso' && b.image)) {
      entry = catalog.get(b.image);
      if (!entry || entry.kind !== (source === 'cloud' ? 'cloud' : 'iso')) throw U.fail(400, 'Unknown image.');
    }
    if (source === 'iso' && !b.image) this.checkIso(b.iso);
    // ARM (#22): from the image, or chosen for an own ISO, an empty VM or a disk image; copies keep their architecture
    const archOf = (entry && entry.arch) || (['iso', 'empty', 'disk'].includes(source) && !(entry && entry.kind === 'iso') ? b.arch : null) || null;
    if (archOf && !S.ARCHES.includes(archOf)) throw U.fail(400, 'Unknown architecture.');
    // App templates and own start scripts (#9) – only for ready-made Linux (cloud-init does the work)
    const app = source === 'cloud' ? A.checkApp(b.app, entry) : null;
    if (b.app && source !== 'cloud') throw U.fail(400, 'App templates need a ready-made Linux.');
    const hasStart = String(b.startCommands || '').trim() || String(b.startScript || '').trim();
    if (hasStart && source !== 'cloud') throw U.fail(400, 'Start commands and scripts need a ready-made Linux (cloud-init runs them).');
    // Windows: drivers CD (#3) and the installation without clicking (#2) – checked before anything is created
    const isWin = (b.osType || (entry && entry.osType)) === 'windows';
    const wantDrivers = isWin && ['iso', 'empty'].includes(source) && b.drivers !== false;
    const unattend = isWin && source === 'iso' && b.unattended ? {
      user: b.winUser, password: b.winPassword, computerName: b.computerName || String(b.name || 'windows').replace(/[^A-Za-z0-9-]/g, '').slice(0, 15) || 'windows',
      language: b.language || 'de-DE', timezone: b.winTimezone || undefined, edition: b.edition || 'Windows 11 Pro', productKey: b.productKey || undefined,
      bypassChecks: b.bypassChecks !== false, drivers: wantDrivers, autoLogon: true,
    } : null;
    if (unattend) W.cleanUnattend({ ...unattend, firmware: b.firmware || 'uefi', diskBus: 'sata' });
    if ((source === 'disk' || source === 'ova') && !(b.file && fs.existsSync(String(b.file)) && fs.statSync(String(b.file)).isFile())) throw U.fail(404, 'File not found.');
    if (source === 'disk' && !DISK_IMPORT_RE.test(b.file)) throw U.fail(400, 'Supported: qcow2, VDI, VMDK, VHD, VHDX, IMG, RAW.');
    if (source === 'ova' && !/\.(ova|ovf)$/i.test(b.file)) throw U.fail(400, 'Choose an .ova or .ovf file.');
    const base = source === 'template' ? this.get(b.template) : source === 'clone' ? this.get(b.from) : null;
    if (source === 'template' && !base.template) throw U.fail(400, 'This VM is not a template.');
    if (source === 'clone') this.requireStopped(base.id, 'copy it');
    const diskGb = b.diskGb != null && b.diskGb !== '' ? Number(b.diskGb) : app ? app.diskGb : S.defaultsFor(b.osType, archOf || 'x86_64').diskGb;
    if (['cloud', 'iso', 'empty'].includes(source)) S.diskBytes(diskGb);
    // Encrypted disk (#15): new disks only (cloud image, installer, empty); copies of an encrypted VM stay encrypted
    if (b.encrypt && !['cloud', 'iso', 'empty'].includes(source)) throw U.fail(400, 'Encryption is offered for new disks (ready-made Linux, ISO, empty) – encrypt other VMs afterwards under Hardware.');
    if (base && base.encryption && (source === 'template' || b.linked)) throw U.fail(409, 'Encrypted VMs cannot have linked clones – make a full copy.');
    const crypt = b.encrypt ? this.newEncryption() : null;
    const baseKey = source === 'clone' && base.encryption ? this.keyOf(base) : null;
    const vm = this.plan({ ...(base ? { cpus: base.cpus, memoryMb: base.memoryMb, osType: base.osType, firmware: base.firmware, vga: base.vga, osLabel: base.osLabel, arch: base.arch, net: { model: base.net.model, forwards: [] } } : {}), ...(app && !b.memoryMb ? { memoryMb: Math.min(app.memoryMb, Math.max(512, this.hostRes.memoryMb - 1024)) } : {}), ...b, ...(archOf ? { arch: archOf } : base ? { arch: base.arch } : { arch: undefined }), osType: b.osType || (base && base.osType) || (entry && entry.osType) || 'linux', osLabel: b.osLabel || (entry && entry.label) || (base && base.osLabel) || '' });
    const seedOpts = source === 'cloud' ? { hostname: b.hostname || hostnameFrom(b.name), user: b.user || entry.user, password: b.password, sshKeys: b.sshKeys, timezone: b.timezone, keyboard: b.keyboard, network: vm.nets.some((x) => x.ip) ? { mac: vm.net.mac, internal: vm.nets.filter((x) => x.ip) } : null, app: app ? app.id : null, startCommands: b.startCommands, startScript: b.startScript } : null;
    if (seedOpts) seedFiles(seedOpts); // validate before the job
    if (base) vm.disks = base.disks.map((k) => ({ ...k }));
    if (crypt) { vm.encryption = crypt.enc; vm.disks = vm.disks.map((k) => ({ ...k, encrypted: true })); }
    if (baseKey) vm.encryption = { ...base.encryption };
    if (source === 'cloud' || b.ssh !== false) this.addSshForward(vm, source === 'cloud' || vm.osType === 'linux');
    if (seedOpts) vm.ssh = { user: seedOpts.user };
    if (source === 'cloud') vm.cloud = { image: entry.id, user: seedOpts.user, ...(hasStart ? { start: true } : {}) };
    if (app) { this.addAppForwards(vm, app); vm.app = { id: app.id }; }
    if (source === 'iso') { vm.boot = 'cdrom'; }
    vm.creating = true;
    this.save(vm);
    this.changed(vm.id, 'created');
    const dir = this.dirOf(vm.id);
    const job = this.runJob(U.T('Create VM “{name}”', { name: vm.name }), async (job) => this.withKey(vm, (key) => this.createSteps({ job, vm, b, source, entry, base, dir, diskGb, seedOpts, wantDrivers, unattend, key }), crypt ? crypt.plain : baseKey));
    job.vmId = vm.id;
    return job;
  }

  /** The steps of create() inside the job; `key` = key file when the new disks are encrypted. */
  async createSteps({ job, vm, b, source, entry, base, dir, diskGb, seedOpts, wantDrivers, unattend, key }) {
    try {
      if (vm.app) await this.freeAppPorts(vm);
      if (source === 'cloud') {
        const img = await this.ensureImage(entry, job, 0, 70);
        job.status(U.T('Preparing the disk …'));
        await this.qhost.convert(img, path.join(dir, 'disk0.qcow2'), { destKey: key, onProgress: (p) => job.progress(70 + p * 0.2) });
        await this.growTo(path.join(dir, 'disk0.qcow2'), S.diskBytes(diskGb), key);
        this.writeSeed(vm, { ...seedOpts, instanceId: `hw-${vm.id}-${Date.now().toString(36)}` });
      } else if (source === 'iso') {
        vm.cdrom = b.image ? await this.ensureImage(entry, job, 0, wantDrivers ? 45 : 90) : path.resolve(String(b.iso));
        await this.qhost.create(path.join(dir, 'disk0.qcow2'), S.diskBytes(diskGb), { key });
        if (wantDrivers) vm.drivers = await this.ensureDrivers(job, 50, 95);
        if (unattend) {
          // The answer file holds the password: it lives only in the VM folder and is deleted after the installation
          fs.writeFileSync(path.join(dir, 'unattend.iso'), W.unattendIso({ ...unattend, firmware: vm.firmware, diskBus: vm.disks[0].bus }));
          vm.seed = 'unattend.iso';
          vm.install = { state: 'running', startedAt: Date.now(), user: unattend.user };
        }
      } else if (source === 'empty' && wantDrivers) {
        await this.qhost.create(path.join(dir, 'disk0.qcow2'), S.diskBytes(diskGb), { key });
        vm.drivers = await this.ensureDrivers(job, 0, 95);
      } else if (source === 'empty') {
        await this.qhost.create(path.join(dir, 'disk0.qcow2'), S.diskBytes(diskGb), { key });
      } else if (source === 'disk') {
        job.status(U.T('Converting the disk …'));
        await this.qhost.convert(path.resolve(String(b.file)), path.join(dir, 'disk0.qcow2'), { srcFormat: formatOf(b.file), onProgress: (p) => job.progress(p * 0.95) });
      } else if (source === 'ova') {
        await this.importOva(vm, path.resolve(String(b.file)), job, b);
      } else if (source === 'template') {
        for (const k of base.disks) await this.qhost.create(path.join(dir, k.file), null, { backing: path.join(this.dirOf(base.id), k.file) });
        vm.linkedTo = base.id;
        vm.template = false;
        if (base.cloud) { vm.cloud = base.cloud; vm.ssh = base.ssh; this.writeSeed(vm, { hostname: hostnameFrom(vm.name), user: base.ssh.user, password: b.password || crypto.randomBytes(9).toString('base64url'), sshKeys: b.sshKeys, instanceId: `hw-${vm.id}-${Date.now().toString(36)}` }); }
      } else if (source === 'clone') {
        vm.template = false;
        if (b.linked) { for (const k of base.disks) await this.qhost.create(path.join(dir, k.file), null, { backing: path.join(this.dirOf(base.id), k.file) }); vm.linkedTo = base.id; }
        else for (const [i, k] of base.disks.entries()) await this.qhost.convert(path.join(this.dirOf(base.id), k.file), path.join(dir, k.file), { ...(k.encrypted ? { srcKey: key, destKey: key } : {}), onProgress: (p) => job.progress(((i + p / 100) / base.disks.length) * 95) });
        if (base.firmware === 'uefi' && fs.existsSync(path.join(this.dirOf(base.id), 'vars.fd'))) fs.copyFileSync(path.join(this.dirOf(base.id), 'vars.fd'), path.join(dir, 'vars.fd'));
        vm.ssh = base.ssh || null; vm.cloud = base.cloud || null;
      } else if (source === 'vbox') {
        await this.importVboxInto(vm, b.uuid, job);
      }
      delete vm.creating;
      vm.snapshots = {};
      this.save(vm);
      this.changed(vm.id, 'ready');
      if (b.start) { job.status(U.T('Starting …')); await this.start(vm.id); }
      return { id: vm.id };
    } catch (e) {
      this.vms.delete(vm.id);
      fs.rmSync(dir, { recursive: true, force: true });
      this.changed(vm.id, 'removed');
      throw e;
    }
  }

  checkIso(iso) {
    const f = String(iso || '');
    if (!f || !ISO_RE.test(f)) throw U.fail(400, 'Choose an ISO file.');
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) throw U.fail(404, 'The ISO file was not found: {path}', { path: f });
    return path.resolve(f);
  }
  addSshForward(vm, wanted) {
    if (!wanted || vm.net.forwards.some((f) => f.guest === 22)) return;
    const taken = new Set();
    for (const x of this.vms.values()) for (const f of (x.net && x.net.forwards) || []) taken.add(f.host);
    let port = 2222;
    while (taken.has(port)) port++;
    vm.net.forwards.push({ id: 'ssh', proto: 'tcp', host: port, guest: 22, bind: 'local', label: 'SSH' });
  }
  /** Port forwards of an app template (#9): its usual port on this PC, the next one when another VM has it already. */
  addAppForwards(vm, app) {
    const taken = new Set(vm.net.forwards.map((f) => `${f.proto}:${f.host}`));
    for (const x of this.vms.values()) if (x.id !== vm.id) for (const f of (x.net && x.net.forwards) || []) taken.add(`${f.proto}:${f.host}`);
    for (const f of app.forwards) {
      if (vm.net.forwards.some((x) => x.id === `app-${f.id}`)) continue;
      let port = f.host;
      while (taken.has(`tcp:${port}`) && port < 65535) port++;
      taken.add(`tcp:${port}`);
      vm.net.forwards.push({ id: `app-${f.id}`, proto: 'tcp', host: port, guest: f.guest, bind: 'local', label: f.label });
    }
    vm.net.forwards = S.checkForwards(vm.net.forwards, { lanAllowed: this.lanAllowed() });
  }
  /** Before the first start: a port another program on this PC already uses moves on to the next free one. */
  async freeAppPorts(vm) {
    const other = new Set();
    for (const x of this.vms.values()) if (x.id !== vm.id) for (const f of (x.net && x.net.forwards) || []) other.add(f.host);
    for (const f of vm.net.forwards.filter((x) => /^app-/.test(x.id))) {
      const mine = new Set(vm.net.forwards.filter((x) => x !== f).map((x) => x.host));
      let port = f.host;
      while (port < 65535 && (other.has(port) || mine.has(port) || !(await U.portFree(port)))) port++;
      f.host = port;
    }
  }
  /** State of the app setup and the own start script in the guest (through the agent): ok | running | failed | none */
  async appStatus(id) {
    const vm = this.get(id);
    if (!vm.app && !(vm.cloud && vm.cloud.start)) return { app: 'none', script: 'none', log: '' };
    if (!this.isRunning(id)) return { ...(this.appStates.get(id) || { app: 'unknown', script: 'unknown' }), running: false, log: '' };
    const r = await this.guestExec(id, A.STATE_CMD, { timeout: 20000 });
    const lines = String(r.out || '').split(/\r?\n/);
    let st = { app: 'unknown', script: 'unknown' };
    try { st = JSON.parse(lines[0]); } catch { /* keep unknown */ }
    const out = { app: st.app, script: st.script, at: Date.now() };
    this.appStates.set(id, out);
    return { ...out, running: true, log: lines.slice(1).join('\n').trim().slice(-3000) };
  }
  async growTo(file, bytes, key = null) {
    const info = await this.qhost.diskInfo(file).catch(() => null);
    if (!info || info.virtualSize < bytes) await this.qhost.resize(file, bytes, key ? { key } : undefined);
  }
  writeSeed(vm, opts) {
    const iso = buildIso({ volume: 'cidata', files: seedFiles(opts) });
    fs.writeFileSync(path.join(this.dirOf(vm.id), 'seed.iso'), iso);
    vm.seed = 'seed.iso';
  }

  async importOva(vm, file, job, b) {
    const dir = this.dirOf(vm.id);
    let ovfText; let srcDir;
    if (/\.ova$/i.test(file)) {
      job.status(U.T('Unpacking the appliance …'));
      const tmp = path.join(dir, '.ova');
      fs.mkdirSync(tmp, { recursive: true });
      await extractTar(file, tmp, (n) => /\.(ovf|vmdk|vhd|vdi|img)$/i.test(n));
      const ovf = fs.readdirSync(tmp).find((f) => /\.ovf$/i.test(f));
      if (!ovf) throw new Error(U.T('No OVF description in the OVA file.'));
      ovfText = fs.readFileSync(path.join(tmp, ovf), 'utf8');
      srcDir = tmp;
    } else { ovfText = fs.readFileSync(file, 'utf8'); srcDir = path.dirname(file); }
    const o = parseOvf(ovfText);
    if (!o.disks.length) throw new Error(U.T('The appliance has no disk.'));
    vm.disks = [];
    for (const [i, d] of o.disks.entries()) {
      const src = path.join(srcDir, path.basename(d.file));
      if (!fs.existsSync(src)) throw new Error(U.T('Disk {file} is missing.', { file: d.file }));
      job.status(U.T('Converting disk {n} …', { n: i + 1 }));
      await this.qhost.convert(src, path.join(dir, `disk${i}.qcow2`), { onProgress: (p) => job.progress(((i + p / 100) / o.disks.length) * 95) });
      vm.disks.push({ id: `disk${i}`, file: `disk${i}.qcow2`, bus: 'sata', format: 'qcow2' }); // appliances come from VirtualBox/VMware with AHCI or IDE – SATA boots everywhere
    }
    fs.rmSync(path.join(dir, '.ova'), { recursive: true, force: true });
    if (!b.cpus && o.cpus) vm.cpus = U.clamp(o.cpus, 1, this.hostRes.cpus);
    if (!b.memoryMb && o.memoryMb) vm.memoryMb = U.clamp(o.memoryMb, 256, Math.max(256, this.hostRes.memoryMb - 512));
    if (!b.firmware) vm.firmware = o.firmware;
    if (!b.osType) vm.osType = o.osType;
  }

  /* ---------------- VirtualBox ---------------- */
  async vboxList({ fresh = false } = {}) {
    if (!this.vbox) return [];
    if (!fresh && Date.now() - this.vboxCache.at < 4000) return this.vboxCache.list;
    const list = await this.vbox.list().catch(() => []);
    this.vboxCache = { at: Date.now(), list };
    return list;
  }
  async importVboxInto(vm, uuid, job) {
    const src = await this.vbox.vm(uuid);
    if (src.state === 'running' || src.state === 'paused') throw new Error(U.T('Shut the VirtualBox VM down first.'));
    if (!src.disks.length) throw new Error(U.T('The VirtualBox VM has no disk.'));
    if (src.snapshots.length) job.log(U.T('Note: the current state is taken over; VirtualBox snapshots stay in VirtualBox.'));
    const dir = this.dirOf(vm.id);
    vm.disks = [];
    for (const [i, d] of src.disks.slice(0, 4).entries()) {
      let from = d.path;
      let tmp = null;
      // A VM with snapshots runs on a difference image – VirtualBox merges the chain into one disk first (qemu-img
      // reads only standalone VDIs). The VM in VirtualBox stays untouched.
      if (this.vbox.isDifferencing && await this.vbox.isDifferencing(d.path)) {
        job.status(U.T('Merging the snapshots of disk {n} …', { n: i + 1 }));
        tmp = path.join(dir, `.merge-${i}.vdi`);
        await this.vbox.flatten(d.path, tmp);
        from = tmp;
      }
      job.status(U.T('Converting disk {n} …', { n: i + 1 }));
      try {
        await this.qhost.convert(from, path.join(dir, `disk${i}.qcow2`), { srcFormat: formatOf(from), onProgress: (p) => job.progress(((i + p / 100) / src.disks.length) * 95) });
      } finally { if (tmp) fs.rmSync(tmp, { force: true }); }
      vm.disks.push({ id: `disk${i}`, file: `disk${i}.qcow2`, bus: 'sata', format: 'qcow2' }); // VirtualBox guests usually use AHCI
    }
    vm.cpus = U.clamp(src.cpus || vm.cpus, 1, this.hostRes.cpus);
    vm.memoryMb = U.clamp(src.memoryMb || vm.memoryMb, 256, Math.max(256, this.hostRes.memoryMb - 512));
    vm.firmware = src.firmware;
    vm.osType = osTypeOf(src.osType);
    vm.osLabel = src.osType;
    vm.net.model = vm.osType === 'linux' ? 'virtio' : 'e1000e';
    vm.importedFrom = { vbox: src.uuid, name: src.name };
  }
  async vboxAction(uuid, action, body = {}) {
    const v = this.vbox;
    if (!v) throw U.fail(404, 'VirtualBox is not installed.');
    if (action === 'start') await v.start(uuid, { window: !!body.window });
    else if (['acpi', 'poweroff', 'savestate', 'pause', 'resume', 'reset'].includes(action)) await v.control(uuid, action);
    else if (action === 'snapshot') await v.snapshot(uuid, body.action || 'take', body.name, { description: body.description });
    else if (action === 'type') await v.typeText(uuid, body.text);
    else if (action === 'ctrl-alt-del') await v.ctrlAltDel(uuid);
    else throw U.fail(400, 'Unknown action.');
    this.vboxCache.at = 0;
    this.changed(uuid, 'vbox');
    return v.vm(uuid);
  }

  /* ---------------- Lifecycle ---------------- */
  async start(id, { once = null } = {}) {
    const vm = this.get(id);
    if (vm.creating) throw U.fail(409, 'The VM is still being created.');
    if (vm.template) throw U.fail(409, 'Templates do not start – create a VM from it.');
    if (this.busy.has(id)) throw U.fail(409, 'The VM is busy: {what}.', { what: U.T(this.busy.get(id)) });
    if (vm.linkedTo && !this.vms.has(vm.linkedTo)) throw U.fail(409, 'The template of this linked clone is missing.');
    const mem = S.memoryCheck(this.runningMemoryMb(id), vm.memoryMb, this.hostRes.memoryMb);
    if (mem.level === 'err') throw U.fail(409, 'Not enough memory: the running VMs and this one would need {total} MB of {host} MB.', { total: mem.total, host: this.hostRes.memoryMb });
    if (!vm.seed && fs.existsSync(path.join(this.dirOf(id), 'unattend.iso'))) fs.rmSync(path.join(this.dirOf(id), 'unattend.iso'), { force: true }); // after the installation
    if (vm.encryption) this.keyOf(vm); // locked (moved here, key not entered yet) → clear message before anything starts
    this.checkNets(vm);
    if ((vm.shares || []).length) await this.ensureShareServer();
    const r = this.rt(id);
    let loadvm = null;
    if (vm.resumeFrom && vm.snapshots && vm.snapshots[vm.resumeFrom] && vm.snapshots[vm.resumeFrom].ram) loadvm = vm.resumeFrom;
    if (once === 'cdrom' && vm.cdrom) r.vm = { ...vm, boot: 'cdrom' };
    const st = await r.start({ loadvm });
    if (vm.resumeFrom) { delete vm.resumeFrom; this.save(vm); }
    vm.lastStart = Date.now();
    this.save(vm);
    return st;
  }
  async stop(id, { force = false } = {}) {
    this.get(id);
    const r = this.runtimes.get(id);
    if (!r || (!r.isRunning() && !r.restartTask)) return { state: 'stopped' }; // restartTask: QEMU comes back after a guest restart
    if (force) await r.powerOff(); else await r.shutdown();
    return r.status();
  }
  async restart(id) { await this.stop(id); return this.start(id); }
  async control(id, action, body = {}) {
    const r = this.rt(id);
    if (action === 'pause') await r.pause();
    else if (action === 'resume') await r.resume();
    else if (action === 'reset') await r.reset();
    else if (action === 'combo') await r.combo(Array.isArray(body.keys) ? body.keys : String(body.combo || ''));
    else if (action === 'type') await r.typeText(body.text);
    else throw U.fail(400, 'Unknown action.');
    return r.status();
  }

  /* ---------------- Settings of a VM ---------------- */
  /** Changes while running are limited to what QEMU can change live: name, notes, autostart, forwards, ISO. */
  async update(id, body) {
    const b = body || {};
    const vm = this.get(id);
    const running = this.isRunning(id);
    const LIVE = new Set(['name', 'notes', 'autostart', 'autoRestart', 'onExit', 'net', 'cdrom', 'keyboard', 'autoSnap', 'limits', 'shares']);
    if (running) {
      const blocked = Object.keys(b).filter((k) => !LIVE.has(k) && JSON.stringify(b[k]) !== JSON.stringify(vm[k]));
      if (blocked.length) throw U.fail(409, 'Shut the VM down first to change: {list}.', { list: blocked.join(', ') });
      if (b.net && ((b.net.model && b.net.model !== vm.net.model) || (b.net.mode && b.net.mode !== vm.net.mode) || (b.net.tap !== undefined && b.net.tap !== vm.net.tap))) throw U.fail(409, 'Shut the VM down first to change the network card.');
    }
    if (b.cdrom) b.cdrom = this.checkIso(b.cdrom);
    if (b.disks) delete b.disks; // disks have their own routes
    delete b.encryption; // only through the encryption routes
    const next = S.cleanVm(b, { prev: vm, host: this.hostRes, lanAllowed: this.lanAllowed() });
    if (b.nets !== undefined) this.checkNets(next);
    if (b.shares !== undefined) { this.checkShares(next); if (next.shares.length) await this.ensureShareServer(); }
    if (running) {
      const r = this.rt(id);
      const key = (f) => `${f.proto}:${f.host}:${f.guest}:${f.bind}`;
      const before = new Map(vm.net.forwards.map((f) => [key(f), f]));
      const after = new Map(next.net.forwards.map((f) => [key(f), f]));
      for (const [k, f] of before) if (!after.has(k)) await r.forwardRemove(f);
      for (const [k, f] of after) if (!before.has(k)) {
        if (f.proto === 'tcp' && !(await U.portFree(f.host, f.bind === 'lan' && this.lanAllowed() ? '0.0.0.0' : '127.0.0.1'))) throw U.fail(409, 'Port {port} on this PC is already in use – change the forwarding “{label}”.', { port: f.host, label: f.label || `${f.guest}` });
        await r.forwardAdd(f);
      }
      if ((next.cdrom || null) !== (vm.cdrom || null)) await r.changeCd(next.cdrom);
      if (r.proc) { r.proc.name = next.name; r.proc.restartFn = next.autoRestart ? () => r.start() : null; }
      if (JSON.stringify(next.limits) !== JSON.stringify(vm.limits)) { r.vm = next; await r.applyLimits(); }
    }
    this.save(next);
    this.changed(id, 'updated');
    return this.detail(id);
  }

  async addDisk(id, { sizeGb, bus } = {}) {
    const vm = this.get(id);
    this.requireStopped(id, 'add a disk');
    const n = [0, 1, 2, 3, 4, 5, 6, 7].find((i) => !vm.disks.some((k) => k.id === `disk${i}`));
    if (n === undefined) throw U.fail(400, 'At most 8 disks.');
    const disk = { id: `disk${n}`, file: `disk${n}.qcow2`, bus: S.BUSES.includes(bus) ? bus : vm.disks[0] ? vm.disks[0].bus : 'virtio', format: 'qcow2', ...(vm.encryption ? { encrypted: true } : {}) };
    const next = S.cleanVm({ disks: [...vm.disks, disk] }, { prev: vm, host: this.hostRes, lanAllowed: this.lanAllowed() });
    await this.withKey(vm, (key) => this.qhost.create(path.join(this.dirOf(id), disk.file), S.diskBytes(sizeGb), key ? { key } : undefined));
    this.save(next);
    this.changed(id, 'updated');
    return this.detail(id);
  }
  async resizeDisk(id, diskId, { sizeGb } = {}) {
    const vm = this.get(id);
    this.requireStopped(id, 'resize a disk');
    const k = vm.disks.find((d) => d.id === diskId);
    if (!k) throw U.fail(404, 'Disk not found.');
    if (Object.keys(vm.snapshots || {}).length) throw U.fail(409, 'Delete the snapshots first – a disk with snapshots cannot grow.');
    const f = path.join(this.dirOf(id), k.file);
    const info = await this.qhost.diskInfo(f);
    const bytes = S.diskBytes(sizeGb);
    if (bytes <= info.virtualSize) throw U.fail(400, 'Disks can only grow (now {gb} GB).', { gb: Math.round(info.virtualSize / 2 ** 30) });
    await this.withKey(vm, (key) => this.qhost.resize(f, bytes, ...kx(k, key)));
    this.changed(id, 'updated');
    return this.detail(id);
  }
  async removeDisk(id, diskId) {
    const vm = this.get(id);
    this.requireStopped(id, 'remove a disk');
    const k = vm.disks.find((d) => d.id === diskId);
    if (!k) throw U.fail(404, 'Disk not found.');
    if (vm.disks.length === 1) throw U.fail(400, 'The last disk cannot be removed.');
    vm.disks = vm.disks.filter((d) => d.id !== diskId);
    fs.rmSync(path.join(this.dirOf(id), k.file), { force: true });
    this.save(vm);
    this.changed(id, 'updated');
    return this.detail(id);
  }

  /* ---------------- Snapshots ---------------- */
  async takeSnapshot(id, { name, note = '', ram = false, auto = false } = {}) {
    const vm = this.get(id);
    if (vm.template) throw U.fail(409, 'Templates have no snapshots – their disks are the base of linked clones.');
    const n = S.checkSnapName(name || `snap-${stamp()}`);
    if (vm.snapshots && vm.snapshots[n]) throw U.fail(409, 'A snapshot with this name exists already.');
    return this.withBusy(id, 'Taking a snapshot', async () => {
      const running = this.isRunning(id);
      let res = { ram: false, frozen: false };
      if (running) {
        const info = await this.qhost.info();
        if (ram && !info.ramSnapshots) throw U.fail(409, 'This accelerator ({accel}) cannot save the memory – take a disk snapshot or shut the VM down.', { accel: info.accel });
        res = await this.rt(id).liveSnapshot(n, { ram });
      } else {
        await this.withKey(vm, async (key) => { for (const k of vm.disks.filter((d) => d.format === 'qcow2')) await this.qhost.snapshot(path.join(this.dirOf(id), k.file), 'create', n, ...kx(k, key)); });
      }
      vm.snapshots = { ...(vm.snapshots || {}), [n]: { label: String(note || '').slice(0, 200), createdAt: Date.now(), parent: vm.currentSnapshot || null, ram: res.ram, live: running, frozen: res.frozen, ...(auto ? { auto: true } : {}) } };
      vm.currentSnapshot = n;
      this.save(vm);
      this.changed(id, 'snapshot');
      return S.publicVm(vm).snapshots;
    });
  }
  async restoreSnapshot(id, name) {
    const vm = this.get(id);
    const s = vm.snapshots && vm.snapshots[name];
    if (!s) throw U.fail(404, 'Snapshot not found.');
    return this.withBusy(id, 'Restoring a snapshot', async () => {
      if (this.isRunning(id)) {
        if (!s.ram) throw U.fail(409, 'Shut the VM down first to restore a disk snapshot.');
        await this.rt(id).qmp.hmp(`loadvm ${name}`, 600000);
      } else {
        await this.withKey(vm, async (key) => { for (const k of vm.disks.filter((d) => d.format === 'qcow2')) await this.qhost.snapshot(path.join(this.dirOf(id), k.file), 'apply', name, ...kx(k, key)); });
        if (s.ram) vm.resumeFrom = name; // the next start continues with the saved memory
      }
      vm.currentSnapshot = name;
      this.save(vm);
      this.changed(id, 'snapshot');
      return S.publicVm(vm).snapshots;
    });
  }
  async deleteSnapshot(id, name) {
    const vm = this.get(id);
    if (!vm.snapshots || !vm.snapshots[name]) throw U.fail(404, 'Snapshot not found.');
    return this.withBusy(id, 'Deleting a snapshot', async () => {
      if (this.isRunning(id)) {
        if (vm.snapshots[name].ram) await this.rt(id).qmp.hmp(`delvm ${name}`, 600000); else await this.rt(id).liveSnapshotDelete(name);
      } else await this.withKey(vm, async (key) => { for (const k of vm.disks.filter((d) => d.format === 'qcow2')) await this.qhost.snapshot(path.join(this.dirOf(id), k.file), 'delete', name, ...kx(k, key)).catch((e) => { if (!/not found|Can't find/i.test(e.message)) throw e; }); });
      const parent = vm.snapshots[name].parent;
      delete vm.snapshots[name];
      for (const s of Object.values(vm.snapshots)) if (s.parent === name) s.parent = parent; // children move up
      if (vm.currentSnapshot === name) vm.currentSnapshot = parent;
      if (vm.resumeFrom === name) delete vm.resumeFrom;
      this.save(vm);
      this.changed(id, 'snapshot');
      return S.publicVm(vm).snapshots;
    });
  }

  /* ---------------- Templates ---------------- */
  setTemplate(id, on) {
    const vm = this.get(id);
    if (on) {
      this.requireStopped(id, 'turn it into a template');
      if (vm.linkedTo) throw U.fail(409, 'A linked clone cannot become a template – make a full copy first.');
      if (vm.encryption) throw U.fail(409, 'Encrypted VMs cannot become templates – linked clones would need the key of this VM.');
      if (Object.keys(vm.snapshots || {}).length) throw U.fail(409, 'Delete the snapshots first – a template is a fixed state.');
    } else if ([...this.vms.values()].some((x) => x.linkedTo === id)) throw U.fail(409, 'Linked clones still use this template.');
    vm.template = !!on;
    this.save(vm);
    this.changed(id, 'updated');
    return this.view(vm);
  }

  /* ---------------- Remove ---------------- */
  async remove(id) {
    const vm = this.get(id);
    const clones = [...this.vms.values()].filter((x) => x.linkedTo === id);
    if (clones.length) throw U.fail(409, 'Linked clones still use this VM: {list}.', { list: clones.map((x) => x.name).join(', ') });
    if (this.isRunning(id)) await this.stop(id, { force: true });
    const r = this.runtimes.get(id);
    if (r && r.proc && this.registry) this.registry.delete(r.proc.id);
    this.runtimes.delete(id);
    fs.rmSync(this.dirOf(id), { recursive: true, force: true });
    this.vms.delete(vm.id);
    this.changed(id, 'removed');
    return { ok: true };
  }

  /* ---------------- Backups ---------------- */
  backupDir(id) { return path.join(this.root, '.backups', U.checkId(id)); }
  listBackups(id) {
    const d = this.backupDir(id);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => /^[0-9]{8}-[0-9]{6}(-[a-z0-9-]{1,40})?$/.test(f)).map((f) => {
      const meta = readJson(path.join(d, f, 'backup.json'), {});
      return { file: f, id: f, label: meta.label || f, time: meta.t || null, size: meta.size || null, live: !!meta.live, auto: /-auto$/.test(f) };
    }).sort((a, b) => (b.time || 0) - (a.time || 0));
  }
  /** Copies every disk (compressed qcow2) plus the VM description – while running through QEMU's block backup. */
  backup(id, label) {
    const vm = this.get(id);
    if (vm.creating) throw U.fail(409, 'The VM is still being created.');
    if (this.busy.has(id)) throw U.fail(409, 'The VM is busy: {what}.', { what: U.T(this.busy.get(id)) });
    const tag = String(label || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return this.runBackup(vm, `${stamp()}${tag ? `-${tag}` : ''}`);
  }
  runBackup(vm, name) {
    const id = vm.id;
    return this.runJob(U.T('Back up VM “{name}”', { name: vm.name }), (job) => this.withBusy(id, 'Backing up', async () => {
      const dest = path.join(this.backupDir(id), name);
      fs.mkdirSync(dest, { recursive: true });
      const running = this.isRunning(id);
      try {
        let size = 0;
        // Encrypted disks stay encrypted in the backup (same key; qcow2 cannot compress them)
        await this.withKey(vm, async (key) => {
          for (const [i, k] of vm.disks.entries()) {
            const src = path.join(this.dirOf(id), k.file);
            const out = path.join(dest, `${k.id}.qcow2`);
            job.status(U.T('Backing up disk {n} of {total} …', { n: i + 1, total: vm.disks.length }));
            if (running) await this.liveBackup(id, k, out, (p) => job.progress(((i + p / 100) / vm.disks.length) * 98), key);
            else await this.qhost.convert(src, out, { compress: !k.encrypted, srcFormat: k.format, ...(k.encrypted ? { srcKey: key, destKey: key } : {}), onProgress: (p) => job.progress(((i + p / 100) / vm.disks.length) * 98) });
            size += fs.statSync(out).size;
          }
        });
        for (const extra of ['vars.fd', 'seed.iso']) { const f = path.join(this.dirOf(id), extra); if (fs.existsSync(f)) { fs.copyFileSync(f, path.join(dest, extra)); size += fs.statSync(f).size; } }
        writeJson(path.join(dest, 'vm.json'), vm);
        writeJson(path.join(dest, 'backup.json'), { t: Date.now(), label: name, size, live: running, disks: vm.disks.map((k) => k.id) });
        this.changed(id, 'backup');
        return { file: name, size };
      } catch (e) { fs.rmSync(dest, { recursive: true, force: true }); throw e; }
    }));
  }
  /**
   * Point-in-time copy of a running disk: QEMU's blockdev-backup into a new compressed qcow2 – the VM keeps running.
   * The guest agent (if present) freezes the file systems for the start of the copy.
   */
  async liveBackup(id, disk, out, onProgress, key = null) {
    const r = this.rt(id);
    const q = r.needQmp();
    const info = await this.qhost.diskInfo(path.join(this.dirOf(id), disk.file));
    await this.qhost.create(out, info.virtualSize, ...kx(disk, key));
    const node = `hwbk-${disk.id}-${Date.now().toString(36)}`;
    const jobId = `job-${node}`;
    // An encrypted target uses the key QEMU already holds (secret "hwkey0" from the start)
    await q.exec('blockdev-add', { driver: 'qcow2', 'node-name': node, file: { driver: 'file', filename: out }, ...(disk.encrypted ? { encrypt: { format: 'luks', 'key-secret': 'hwkey0' } } : {}) });
    let frozen = false;
    try {
      const done = new Promise((resolve, reject) => {
        const onEv = (e) => {
          if (!e.data || e.data.device !== jobId) return;
          if (e.event === 'BLOCK_JOB_COMPLETED') { q.off('event', onEv); if (e.data.error) reject(new Error(e.data.error)); else resolve(); }
          if (e.event === 'BLOCK_JOB_CANCELLED') { q.off('event', onEv); reject(new Error('Backup cancelled')); }
        };
        q.on('event', onEv);
      });
      if (r.agentInfo && r.agentInfo.ok) frozen = await r.agentCall('guest-fsfreeze-freeze', null, 20000).then(() => true).catch(() => false);
      await q.exec('blockdev-backup', { 'job-id': jobId, device: disk.id, target: node, sync: 'full', compress: !disk.encrypted });
      if (frozen) { await r.agentCall('guest-fsfreeze-thaw', null, 20000).catch(() => {}); frozen = false; }
      const tick = setInterval(async () => {
        try { const jobs = await q.exec('query-block-jobs'); const j = jobs.find((x) => x.device === jobId); if (j && j.len) onProgress((j.offset / j.len) * 100); } catch { /* egal */ }
      }, 1000);
      try { await done; } finally { clearInterval(tick); }
    } finally {
      if (frozen) await r.agentCall('guest-fsfreeze-thaw', null, 20000).catch(() => {});
      await q.exec('blockdev-del', { 'node-name': node }).catch(() => {});
    }
  }
  restoreBackup(id, file) {
    const vm = this.get(id);
    const f = path.basename(String(file || ''));
    const src = path.join(this.backupDir(id), f);
    if (!fs.existsSync(path.join(src, 'backup.json'))) throw U.fail(404, 'Backup not found.');
    this.requireStopped(id, 'restore a backup');
    if ([...this.vms.values()].some((x) => x.linkedTo === id)) throw U.fail(409, 'Linked clones use this template – restoring would break them.');
    return this.runJob(U.T('Restore VM “{name}”', { name: vm.name }), (job) => this.withBusy(id, 'Restoring a backup', async () => {
      const saved = readJson(path.join(src, 'vm.json'));
      if (!saved || saved.id !== id) throw new Error(U.T('The backup belongs to another VM.'));
      // The backup carries its own (sealed) key – the restored VM uses that one again
      await this.withKey(saved, async (key) => {
        for (const [i, k] of saved.disks.entries()) {
          job.status(U.T('Restoring disk {n} of {total} …', { n: i + 1, total: saved.disks.length }));
          const tmp = path.join(this.dirOf(id), `${k.file}.restore`);
          await this.qhost.convert(path.join(src, `${k.id}.qcow2`), tmp, { ...(k.encrypted ? { srcKey: key, destKey: key } : {}), onProgress: (p) => job.progress(((i + p / 100) / saved.disks.length) * 98) });
          fs.renameSync(tmp, path.join(this.dirOf(id), k.file));
        }
      });
      for (const extra of ['vars.fd', 'seed.iso']) if (fs.existsSync(path.join(src, extra))) fs.copyFileSync(path.join(src, extra), path.join(this.dirOf(id), extra));
      const next = { ...saved, name: vm.name, snapshots: {}, currentSnapshot: null, linkedTo: null };
      delete next.resumeFrom;
      this.save(next);
      this.changed(id, 'restored');
      return { ok: true };
    }));
  }
  removeBackup(id, file) {
    const f = path.basename(String(file || ''));
    if (!/^[0-9]{8}-[0-9]{6}/.test(f)) throw U.fail(400, 'Invalid backup.');
    fs.rmSync(path.join(this.backupDir(id), f), { recursive: true, force: true });
    this.changed(id, 'backup');
  }

  /* ---------------- Export ---------------- */
  exportDisk(id, { disk = 'disk0', format = 'vdi', dest } = {}) {
    const vm = this.get(id);
    this.requireStopped(id, 'export a disk');
    const k = vm.disks.find((d) => d.id === disk);
    if (!k) throw U.fail(404, 'Disk not found.');
    const ext = { qcow2: 'qcow2', vdi: 'vdi', vmdk: 'vmdk', vhdx: 'vhdx', vhd: 'vhd' }[format];
    if (!ext) throw U.fail(400, 'Formats: qcow2, VDI, VMDK, VHDX, VHD.');
    const target = path.resolve(String(dest || path.join(os.homedir(), `${vm.id}-${k.id}.${ext}`)));
    if (fs.existsSync(target)) throw U.fail(409, 'The file exists already: {path}', { path: target });
    return this.runJob(U.T('Export disk of “{name}”', { name: vm.name }), (job) => this.withBusy(id, 'Exporting', async () => {
      // An encrypted disk is exported decrypted – other programs (VirtualBox, VMware …) cannot read QEMU's encryption
      await this.withKey(vm, (key) => this.qhost.convert(path.join(this.dirOf(id), k.file), target, { to: format === 'vhd' ? 'vpc' : format, ...(k.encrypted ? { srcKey: key } : {}), onProgress: (p) => job.progress(p) }));
      return { path: target, decrypted: !!k.encrypted };
    }));
  }

  /** A snapshot name that is not taken yet: base, base-2, base-3 … */
  freeSnapName(id, base) {
    const snaps = this.get(id).snapshots || {};
    let n = base;
    for (let i = 2; snaps[n]; i++) n = `${base}-${i}`;
    return n;
  }

  /* ---------------- Automatic snapshots ---------------- */
  /** Every 5 minutes: VMs whose automatic snapshot is due get one; older automatic ones beyond "keep" are deleted. */
  startScheduler() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.autoSnapTick().catch(() => {}); }, 5 * 60000);
    if (this.timer.unref) this.timer.unref();
  }
  stopScheduler() { clearInterval(this.timer); this.timer = null; }
  async autoSnapTick(now = Date.now()) {
    const done = [];
    for (const vm of [...this.vms.values()]) {
      const a = vm.autoSnap;
      const every = a && S.SNAP_EVERY[a.every];
      if (!every || vm.template || vm.creating || vm.broken || this.busy.has(vm.id)) continue;
      if (a.last && now - a.last < every - 60000) continue;
      // A stopped VM does not change – one snapshot after its last start is enough
      if (!this.isRunning(vm.id) && a.last && (vm.lastStart || 0) < a.last) continue;
      try {
        await this.takeSnapshot(vm.id, { name: this.freeSnapName(vm.id, `auto-${stamp(new Date(now))}`), note: U.T('Automatic snapshot'), auto: true });
        const cur = this.get(vm.id);
        cur.autoSnap = { ...cur.autoSnap, last: now };
        this.save(cur);
        await this.pruneAutoSnaps(vm.id);
        done.push(vm.id);
      } catch (e) { this.notify('warn', U.T('Automatic snapshot of “{name}” failed: {error}', { name: vm.name, error: e.message })); }
    }
    return done;
  }
  /** Keeps the newest `keep` automatic snapshots; snapshots taken by hand are never touched. */
  async pruneAutoSnaps(id) {
    const vm = this.get(id);
    const keep = (vm.autoSnap && vm.autoSnap.keep) || 24;
    const autos = Object.entries(vm.snapshots || {}).filter(([, s]) => s.auto).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0) || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)); // same millisecond: the name (auto-<time>) decides
    for (const [name] of autos.slice(keep)) await this.deleteSnapshot(id, name);
    return autos.slice(keep).map(([n]) => n);
  }

  /* ---------------- Inside the guest (guest agent) ---------------- */
  async guestFs(id) { return this.rt(this.get(id).id).guestFs(); }
  async guestExec(id, command, opts) {
    if (!this.isRunning(id)) throw U.fail(409, 'The VM is not running.');
    return this.rt(id).guestExec(command, opts);
  }
  /** The update command for the guest's distribution (from the agent's OS id). */
  updateCommand(osId) {
    const id = String(osId || '').toLowerCase();
    if (/debian|ubuntu|mint|pop|kali|raspbian/.test(id)) return 'export DEBIAN_FRONTEND=noninteractive; apt-get update -q && apt-get -y -q -o Dpkg::Options::=--force-confold full-upgrade && apt-get -y -q autoremove';
    if (/fedora|rhel|centos|alma|rocky|ol|amzn/.test(id)) return 'dnf -y upgrade --refresh';
    if (/alpine/.test(id)) return 'apk update && apk upgrade';
    if (/opensuse|sles/.test(id)) return 'zypper --non-interactive refresh && zypper --non-interactive update';
    if (/arch|manjaro/.test(id)) return 'pacman -Syu --noconfirm';
    if (/mswindows|windows/.test(id)) return null;
    return null;
  }
  /** Updates the guest system: snapshot first (if switched on), then the distribution's update, output in the job log. */
  guestUpdate(id) {
    const vm = this.get(id);
    if (!this.isRunning(id)) throw U.fail(409, 'The VM is not running.');
    const r = this.rt(id);
    const agentInfo = r.agentInfo;
    if (!agentInfo || !agentInfo.ok) throw U.fail(409, 'The guest agent is not connected – updates run through it.');
    const cmd = this.updateCommand(agentInfo.osId);
    if (!cmd) throw U.fail(400, 'Hostwerk does not know how to update this system ({os}) – update it inside the VM.', { os: agentInfo.os || agentInfo.osId || '?' });
    return this.runJob(U.T('Update the system of “{name}”', { name: vm.name }), async (job) => {
      if (!vm.autoSnap || vm.autoSnap.beforeUpdate !== false) {
        job.status(U.T('Taking a snapshot before the update …'));
        await this.takeSnapshot(id, { name: this.freeSnapName(id, `pre-update-${stamp()}`), note: U.T('Before the system update'), auto: true });
        await this.pruneAutoSnaps(id);
      }
      job.progress(10, U.T('Updating – this can take a few minutes …'));
      const res = await r.guestExec(cmd, { timeout: 45 * 60000 }); // the guest agent runs as root/SYSTEM
      for (const line of `${res.out}\n${res.err}`.split(/\r?\n/).filter(Boolean).slice(-400)) job.log(line);
      if (res.timedOut) throw new Error(U.T('The update took longer than 45 minutes – it may still be running in the VM.'));
      if (res.code !== 0) throw new Error(U.T('The update ended with code {code} – details in the job log.', { code: res.code }));
      return { code: 0, reboot: /reboot|restart required/i.test(res.out) };
    }, { key: `vm-update-${id}` });
  }

  /* ---------------- Disk care ---------------- */
  /**
   * Gives free space of a disk back to this PC: the guest trims first (if running with the agent – then the VM is shut
   * down), the disk is rewritten without unused blocks. Disks with snapshots, templates with clones and linked clones
   * are refused (rewriting would lose snapshots or break the chain).
   */
  compactDisk(id, diskId) {
    const vm = this.get(id);
    this.requireStopped(id, 'compact a disk');
    const k = vm.disks.find((d) => d.id === diskId);
    if (!k) throw U.fail(404, 'Disk not found.');
    if (Object.keys(vm.snapshots || {}).length) throw U.fail(409, 'Delete the snapshots first – compacting rewrites the disk.');
    if (vm.linkedTo || [...this.vms.values()].some((x) => x.linkedTo === id)) throw U.fail(409, 'Linked clones and templates with clones cannot be compacted.');
    return this.runJob(U.T('Compact disk of “{name}”', { name: vm.name }), (job) => this.withBusy(id, 'Compacting', async () => {
      const f = path.join(this.dirOf(id), k.file);
      const before = fs.statSync(f).size;
      const tmp = `${f}.compact`;
      fs.rmSync(tmp, { force: true });
      try {
        await this.withKey(vm, (key) => this.qhost.convert(f, tmp, { ...(k.encrypted ? { srcKey: key, destKey: key } : {}), onProgress: (p) => job.progress(p * 0.98) }));
        fs.renameSync(tmp, f);
      } finally { fs.rmSync(tmp, { force: true }); }
      const after = fs.statSync(f).size;
      this.changed(id, 'updated');
      return { before, after, saved: Math.max(0, before - after) };
    }));
  }
  /** Before compacting a running VM: TRIM inside the guest (Linux fstrim, Windows Optimize-Volume -ReTrim). */
  async guestTrim(id) {
    const vm = this.get(id);
    const res = await this.guestExec(id, vm.osType === 'windows' ? 'Get-Volume | Where-Object DriveLetter | ForEach-Object { Optimize-Volume -DriveLetter $_.DriveLetter -ReTrim }' : 'fstrim -av', { timeout: 10 * 60000 });
    return { code: res.code, out: res.out.trim().slice(-2000) };
  }
  /** Attaches an existing disk image as a new disk – always as a copy, so the original stays untouched and unused elsewhere. */
  attachDisk(id, { file, bus } = {}) {
    const vm = this.get(id);
    this.requireStopped(id, 'add a disk');
    const src = path.resolve(String(file || ''));
    if (!file || !fs.existsSync(src) || !fs.statSync(src).isFile()) throw U.fail(404, 'File not found.');
    if (!DISK_IMPORT_RE.test(src)) throw U.fail(400, 'Supported: qcow2, VDI, VMDK, VHD, VHDX, IMG, RAW.');
    if (src.toLowerCase().startsWith(this.root.toLowerCase())) throw U.fail(400, 'This disk belongs to a Hostwerk VM – copy that VM instead.');
    const n = [0, 1, 2, 3, 4, 5, 6, 7].find((i) => !vm.disks.some((x) => x.id === `disk${i}`));
    if (n === undefined) throw U.fail(400, 'At most 8 disks.');
    const disk = { id: `disk${n}`, file: `disk${n}.qcow2`, bus: S.BUSES.includes(bus) ? bus : vm.disks[0] ? vm.disks[0].bus : 'virtio', format: 'qcow2', ...(vm.encryption ? { encrypted: true } : {}) };
    const next = S.cleanVm({ disks: [...vm.disks, disk] }, { prev: vm, host: this.hostRes, lanAllowed: this.lanAllowed() });
    return this.runJob(U.T('Attach disk to “{name}”', { name: vm.name }), (job) => this.withBusy(id, 'Attaching a disk', async () => {
      // In an encrypted VM the copy is encrypted, too
      await this.withKey(vm, (key) => this.qhost.convert(src, path.join(this.dirOf(id), disk.file), { srcFormat: formatOf(src), ...(key ? { destKey: key } : {}), onProgress: (p) => job.progress(p) }));
      this.save({ ...this.get(id), disks: next.disks });
      this.changed(id, 'updated');
      return { disk: disk.id };
    }));
  }

  /* ---------------- Moving to another PC (#16, Hostwerk's kind.copy) ---------------- */
  /**
   * The folder Hostwerk packs. Only a VM that is off and complete: a running VM would be copied mid-write, a linked
   * clone needs its template (which stays here) – make a full copy first.
   */
  copyDir(id) {
    const vm = this.get(id);
    if (this.isRunning(id)) throw U.fail(409, 'Shut the VM down first to {what}.', { what: U.T('move it') });
    if (this.busy.has(id)) throw U.fail(409, 'The VM is busy: {what}.', { what: U.T(this.busy.get(id)) });
    if (vm.creating || vm.broken) throw U.fail(409, 'The VM is still being created.');
    if (vm.linkedTo) throw U.fail(409, 'A linked clone needs its template – make a full copy (Copy …) and move that one.');
    if ([...this.vms.values()].some((x) => x.linkedTo === id)) throw U.fail(409, 'Linked clones still use this VM: {list}.', { list: [...this.vms.values()].filter((x) => x.linkedTo === id).map((x) => x.name).join(', ') });
    return this.dirOf(id);
  }
  /** The description that travels with the files (vm.json itself is not packed – the target writes its own). */
  copyEntry(id) {
    const vm = this.get(id);
    const { id: _i, autostart: _a, lastStart: _l, broken: _b, creating: _c, resumeFrom: _r, ...entry } = vm; // eslint-disable-line no-unused-vars
    const nets = Object.fromEntries((this.config().networks || []).map((n) => [n.id, n.name]));
    entry.netNames = Object.fromEntries((vm.nets || []).map((m) => [m.net, nets[m.net] || m.net]));
    entry.sealedOn = vm.encryption ? this.hostname : undefined; // the key is sealed for THIS PC – the target asks for it
    return { entry, port: null };
  }
  /**
   * Creates (or, for Hostwerk's mirror, updates) a VM from a moved description: never autostart, networks by name
   * (created here if missing), shared folders only where the folder exists here, host ports that are taken here get
   * the next free one, files that point to this PC (ISO, drivers) only if they exist. An encrypted VM whose key
   * cannot be opened here is "locked" until the key is entered.
   */
  async copyPlace({ id = null, name, entry = {}, tag = {} } = {}) {
    if (id && this.vms.has(id) && this.isRunning(id)) throw U.fail(409, '“{name}” is running – please stop it first.', { name: this.get(id).name });
    const e = { ...entry };
    const nid = id && this.vms.has(id) ? id : this.newId(e.name || name || 'vm');
    const warn = [];
    // Networks by name
    const nets = [];
    for (const m of Array.isArray(e.nets) ? e.nets : []) {
      const nm = (e.netNames && e.netNames[m.net]) || m.net;
      const have = (this.config().networks || []).find((n) => n.name.toLowerCase() === String(nm).toLowerCase()) || this.addNetwork({ name: nm });
      let ip = m.ip || null;
      const user = ip && [...this.vms.values()].find((v) => v.id !== nid && (v.nets || []).some((x) => x.net === have.id && x.ip && x.ip.split('/')[0] === ip.split('/')[0]));
      if (user) { warn.push(U.T('IP address {ip} is already used by “{name}” in this network.', { ip: ip.split('/')[0], name: user.name })); ip = null; }
      nets.push({ net: have.id, ip });
    }
    delete e.netNames;
    const shares = (Array.isArray(e.shares) ? e.shares : []).filter((s) => { const ok = s && s.path && fs.existsSync(s.path); if (!ok && s) warn.push(U.T('Shared folder “{name}” left out – {path} does not exist here.', { name: s.name, path: s.path })); return ok; }).map(({ url: _u, mount: _m, windows: _w, ...s }) => s); // eslint-disable-line no-unused-vars
    // Host ports: keep where free here
    const taken = new Set(); for (const x of this.vms.values()) if (x.id !== nid) for (const f of (x.net && x.net.forwards) || []) taken.add(`${f.proto}:${f.host}`);
    const forwards = ((e.net && e.net.forwards) || []).map((f) => { let host = f.host; while (taken.has(`${f.proto}:${host}`)) host++; taken.add(`${f.proto}:${host}`); if (host !== f.host) warn.push(U.T('Port {from} is used here – the forwarding “{label}” now uses {to}.', { from: f.host, to: host, label: f.label || f.guest })); return { ...f, host, bind: f.bind === 'lan' && !this.lanAllowed() ? 'local' : f.bind }; });
    let encryption = e.encryption ? { format: e.encryption.format || 'luks', key: e.encryption.key || null } : null;
    if (encryption && !(this.secrets && encryption.key && this.secrets.open(encryption.key))) encryption = { format: encryption.format, key: null, from: e.sealedOn || null };
    delete e.sealedOn;
    const raw = {
      ...e, id: nid, name: String(e.name || name || nid).slice(0, 60), autostart: false, linkedTo: null, template: false, ...tag,
      net: { ...(e.net || {}), forwards, mac: U.macFor(nid) }, nets, shares, encryption,
      cdrom: e.cdrom && fs.existsSync(e.cdrom) ? e.cdrom : null, drivers: e.drivers && fs.existsSync(e.drivers) ? e.drivers : null,
      snapshots: e.snapshots && !Array.isArray(e.snapshots) ? e.snapshots : {},
    };
    if (raw.net.mode === 'bridge' && !raw.net.tap) raw.net.mode = 'user';
    const vm = S.cleanVm({}, { prev: raw, host: this.hostRes, lanAllowed: this.lanAllowed() });
    vm.id = nid;
    vm.nets = S.cleanNets(nets, nid); // MACs for the new id
    fs.mkdirSync(this.dirOf(nid), { recursive: true });
    this.save(vm);
    this.changed(nid, 'created');
    return { id: nid, dir: this.dirOf(nid), port: null, created: nid !== id, warn: warn.join(' ') || null };
  }
  /** The files are in place: write our own description again (a vm.json from the package never wins), drop leftovers. */
  copyAfterFiles(id) {
    const vm = this.get(id);
    for (const f of ['qemu.pid', '.screen.png']) fs.rmSync(path.join(this.dirOf(id), f), { force: true });
    try { for (const f of fs.readdirSync(this.dirOf(id))) if (/^\.hwkey-/.test(f)) U.removeSecretFile(path.join(this.dirOf(id), f)); } catch { /* egal */ }
    this.save(vm);
  }
  /** "Keep when removing Hostwerk" → new Hostwerk: the entry (from view(), keys re-sealed by Hostwerk) plus the folder. */
  copyAdd(entry) {
    const e = entry || {};
    const id = U.checkId(e.id);
    if (this.vms.has(id)) throw U.fail(409, 'A VM with this id exists already.');
    const file = readJson(path.join(this.dirOf(id), 'vm.json'), {}) || {};
    const { status: _s, busy: _b, clones: _c, dir: _d, diskInfo: _di, memory: _m, guestSetup: _g, ...rest } = e; // eslint-disable-line no-unused-vars
    const snapshots = Array.isArray(rest.snapshots) ? Object.fromEntries(rest.snapshots.map(({ name, ...s }) => [name, s])) : (rest.snapshots || file.snapshots || {});
    const shares = (rest.shares || []).map(({ url: _u, mount: _mo, windows: _w, ...s }) => s); // eslint-disable-line no-unused-vars
    const encryption = rest.encryption ? { format: rest.encryption.format || 'luks', key: rest.encryption.key || null } : null;
    const vm = { ...file, ...rest, id, snapshots, shares, encryption, autostart: false };
    delete vm.creating; delete vm.broken;
    this.save(vm);
    this.changed(id, 'created');
    return vm;
  }
  /** Hostwerk's "clone": a full copy (with data) or the same hardware with an empty disk (without data). */
  async copyClone(id, { name, withData = true } = {}, job = null) {
    const src = this.get(id);
    const nm = name || U.T('{name} (copy)', { name: src.name });
    const j = withData
      ? this.create({ source: 'clone', from: id, name: nm })
      : this.create({ source: 'empty', name: nm, osType: src.osType, cpus: src.cpus, memoryMb: src.memoryMb, firmware: src.firmware, vga: src.vga, osLabel: src.osLabel, net: { model: src.net.model }, encrypt: !!src.encryption });
    if (job && job.log) job.log(U.T('New VM “{name}”', { name: nm }));
    const r = await j.promise;
    return { id: r.id, href: `#/vms/${r.id}` };
  }
  /** Test run after a move: the VM starts and keeps running for a few seconds (then it is switched off again). */
  async copyProbe(id) {
    const vm = this.get(id);
    if (vm.encryption && !this.keyAvailable(vm)) return true; // locked – cannot start before the key is entered; the files arrived
    await this.start(id);
    for (let i = 0; i < 16; i++) { await U.sleep(500); if (!this.isRunning(id)) return false; }
    await this.stop(id, { force: true }).catch(() => {});
    return true;
  }

  /* ---------------- Ask AI about the screen (#20) ---------------- */
  /**
   * What Hostwerk tells the AI about a VM's screen – text only (Hostwerk's AI services for extensions take text; the
   * picture itself is not sent): name, system, state, guest agent facts, last guest events and the last lines of the
   * serial console (escape sequences removed, password-like values blanked).
   * → { text, image: false, parts: { agent, serialLines, events } }
   */
  screenContext(id) {
    const vm = this.get(id);
    const r = this.runtimes.get(vm.id);
    const st = this.stateOf(vm.id);
    const agent = r && r.agentInfo && r.agentInfo.ok ? r.agentInfo : null;
    const L = [];
    L.push(`Virtual machine “${vm.name}” in Hostwerk (QEMU${vm.arch === 'aarch64' ? ', ARM64, emulated without acceleration' : ''}).`);
    L.push(`System: ${vm.osLabel || vm.osType}${agent && agent.os ? ` – the guest agent reports ${agent.os}${agent.kernel ? `, kernel ${agent.kernel}` : ''}` : ''}.`);
    L.push(`State: ${st.state}${st.accel ? `, accelerator ${st.accel}` : ''}; ${vm.cpus} CPU, ${vm.memoryMb} MB RAM, firmware ${vm.firmware}${vm.arch === 'aarch64' ? '' : ` (${vm.osType === 'windows' ? 'Windows guest' : vm.osType})`}, boots from ${vm.boot === 'cdrom' ? 'the ISO' : 'the disk'}${vm.cdrom ? `, ISO ${path.basename(vm.cdrom)}` : ''}.`);
    if (vm.install && vm.install.state === 'running') L.push('Windows is installing itself (unattended setup).');
    if (vm.app) { const app = A.get(vm.app.id); const s = this.appStates.get(vm.id); L.push(`App template: ${app ? app.label : vm.app.id}${s ? ` (setup: ${s.app})` : ''}.`); }
    if (agent) {
      L.push(`Guest agent: connected${agent.hostname ? `, host name ${agent.hostname}` : ''}${(agent.addresses || []).length ? `, addresses ${agent.addresses.map((a) => `${a.iface} ${a.ip}`).join(', ')}` : ''}.`);
      const fsx = (agent.fs || []).filter((f) => f.pct != null).map((f) => `${f.mount} ${f.pct} %`);
      if (fsx.length) L.push(`File systems: ${fsx.join(', ')}.`);
    } else L.push(st.state === 'running' ? 'Guest agent: not connected (not installed or the system has not started yet).' : 'Guest agent: –');
    const events = r ? (r.guestEvents || []).slice(-6) : [];
    if (events.length) L.push(`Last events: ${events.map((e) => `${new Date(e.t).toISOString().slice(11, 19)} ${e.event}`).join(', ')}.`);
    let serial = [];
    if (r) {
      // eslint-disable-next-line no-control-regex
      const text = String(r.serialSince(null).text || '').replace(/\x1b\[[0-9;?=]*[A-Za-z]/g, '').replace(/\x1b[()][A-Z0-9]/g, '').replace(/\r(?!\n)/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, '');
      serial = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-40).map((l) => l.slice(0, 200));
    }
    if (serial.length) L.push('', 'Last lines of the serial console:', ...serial);
    else L.push('Serial console: no output.');
    const SECRET = /(password|passwort|kennwort|secret|token|api[_-]?key|private key|pwd)(\s*[:=]\s*)\S+/gi;
    return { text: L.join('\n').replace(SECRET, '$1$2•••').slice(0, 6000), image: false, parts: { agent: !!agent, serialLines: serial.length, events: events.length } };
  }
  /** Short answer of Hostwerk's AI (text context only) – refused clearly while the AI is off; nothing is sent then. */
  async aiExplain(id, { question, lang = 'de' } = {}) {
    const vm = this.get(id);
    const ready = this.ai && typeof this.ai.ready === 'function' ? await this.ai.ready().catch(() => false) : false;
    if (!ready) throw U.fail(409, 'The AI assistant is off or not set up – nothing was sent.', null, 'AI_OFF');
    const ctx = this.screenContext(vm.id);
    const q = String(question || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300) || 'What does the screen of this virtual machine show right now, and what does an error there mean?';
    const r = await this.ai.run('explain', { text: `${q}\n\n${ctx.text}`, lang: lang === 'en' ? 'en' : 'de', context: `Screen of the virtual machine “${vm.name}” – text context only, no picture` });
    return { text: r && r.text ? r.text : '', image: false, sent: ctx.text };
  }

  /* ---------------- Hyper-V (#21) ---------------- */
  async hypervState({ fresh = false } = {}) {
    if (!this.hyperv) return { available: false, reason: 'not-windows', vms: [] };
    return this.hyperv.state({ fresh });
  }
  async hypervAction(id, action, body = {}) {
    if (!this.hyperv) throw U.fail(404, 'Hyper-V is not available on this PC.');
    await this.hyperv.action(id, action, { name: body.name });
    this.changed(id, 'hyperv');
    return this.hypervState({ fresh: true });
  }

  /* ---------------- Start with Hostwerk ---------------- */
  async autostart() {
    for (const vm of [...this.vms.values()].filter((x) => x.autostart && !x.template && !x.creating)) {
      try { await this.start(vm.id); } catch (e) { this.broadcast({ type: 'toast', kind: 'warn', text: U.T('VM “{name}” did not start: {error}', { name: vm.name, error: e.message }) }); }
      await U.sleep(1500);
    }
  }
  /** After an update of the extension: take over the VMs whose QEMU kept running (Hostwerk's process registry). → ids */
  async adoptRunning() {
    const out = [];
    await Promise.all([...this.vms.keys()].map(async (id) => {
      try { if (await this.rt(id).adopt()) out.push(id); } catch (e) { console.warn(`[vms] ${id}: running VM not taken over – ${e.message}`); } // eslint-disable-line no-console
    }));
    return out;
  }
  /** The extension is updated or switched off: let go of every VM without stopping it (Hostwerk stops them when it quits). */
  detachAll() { for (const r of this.runtimes.values()) if (r.isRunning()) r.detach(); }
  async stopAll() { await Promise.all([...this.runtimes.values()].filter((r) => r.isRunning() || r.restartTask).map((r) => (r.vm.onExit === 'kill' ? r.powerOff() : r.shutdown({ timeout: 45000 })).catch(() => {}))); }
}

module.exports = { VmManager, hashFile, stamp };
