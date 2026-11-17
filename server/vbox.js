'use strict';
/*
 * VirtualBox next to QEMU: existing VirtualBox VMs show up in the same list and can be started (headless or with a
 * window), shut down, paused, saved, snapshotted and looked at (screenshot, typing text) – and taken over into QEMU
 * (manager.importVbox). Everything goes through VBoxManage; nothing of VirtualBox is changed unless the person asks.
 *
 *   parseMachineReadable(text) → { key: value }   (VBoxManage showvminfo --machinereadable)
 *   vmFromInfo(map)            → { uuid, name, state, osType, cpus, memoryMb, firmware, disks, dvds, forwards, snapshots … }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('./util');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** VBoxManage's machine-readable output: key=value, key="value", "key"="value" with \\ and \" escapes. */
function parseMachineReadable(text) {
  const out = {};
  const unq = (s) => (s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1).replace(/\\(["\\])/g, '$1') : s);
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^("(?:[^"\\]|\\.)*"|[^=]+)=(.*)$/);
    if (!m) continue;
    out[unq(m[1].trim())] = unq(m[2].trim());
  }
  return out;
}

/** "name" {uuid} lines of `VBoxManage list vms` */
function parseList(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^"(.*)" \{([0-9a-f-]{36})\}\s*$/i);
    if (m) out.push({ name: m[1], uuid: m[2].toLowerCase() });
  }
  return out;
}

const STATE = { running: 'running', paused: 'paused', saved: 'saved', poweroff: 'stopped', aborted: 'stopped', starting: 'starting', stopping: 'stopping', saving: 'stopping', restoring: 'starting', stuck: 'error', teleported: 'stopped', gurumeditation: 'error' };

function vmFromInfo(m) {
  const disks = [];
  const dvds = [];
  for (const [k, v] of Object.entries(m)) {
    const s = k.match(/^(.+)-(\d+)-(\d+)$/);
    if (!s || /-(ImageUUID|hot-pluggable|nonrotational|discard|tempeject|IsEjected)$/.test(s[1]) || !v || v === 'none' || v === 'emptydrive') continue;
    const item = { controller: s[1], port: Number(s[2]), device: Number(s[3]), path: v };
    if (/\.iso$/i.test(v)) dvds.push(item); else if (/\.(vdi|vmdk|vhdx?|qcow2?|img|raw|parallels|hdd)$/i.test(v)) disks.push(item);
  }
  const forwards = Object.entries(m).filter(([k]) => /^Forwarding\(\d+\)$/.test(k)).map(([, v]) => {
    const [name, proto, hostIp, hostPort, guestIp, guestPort] = String(v).split(',');
    return { name, proto, hostIp: hostIp || '', host: Number(hostPort), guestIp: guestIp || '', guest: Number(guestPort) };
  });
  const snapshots = [];
  for (const [k, v] of Object.entries(m)) {
    const s = k.match(/^SnapshotName((?:-\d+)*)$/);
    if (!s) continue;
    const pathKey = s[1];
    const parentKey = pathKey.replace(/-\d+$/, '');
    snapshots.push({ name: v, uuid: m[`SnapshotUUID${pathKey}`] || null, description: m[`SnapshotDescription${pathKey}`] || '', depth: pathKey ? pathKey.split('-').length - 1 : 0, parent: pathKey ? m[`SnapshotName${parentKey}`] || null : null });
  }
  return {
    uuid: String(m.UUID || '').toLowerCase(), name: m.name || '', osType: m.ostype || '', state: STATE[String(m.VMState || '').toLowerCase()] || 'stopped', rawState: m.VMState || null,
    stateSince: m.VMStateChangeTime ? Date.parse(`${m.VMStateChangeTime.slice(0, 23)}Z`) || null : null,
    cpus: Number(m.cpus) || null, memoryMb: Number(m.memory) || null, firmware: /efi/i.test(m.firmware || '') ? 'uefi' : 'bios',
    disks, dvds, forwards, snapshots, currentSnapshot: m.CurrentSnapshotName || null, config: m.CfgFile || null, description: m.description || '',
    nic: m.nic1 || null,
  };
}

/** Guest OS family of a VirtualBox ostype ("Windows11_64", "Ubuntu (64-bit)" …). */
function osTypeOf(vboxOs) { const s = String(vboxOs || ''); return /windows/i.test(s) ? 'windows' : /linux|ubuntu|debian|fedora|arch|red ?hat|opensuse|oracle|gentoo|mandriva|turbolinux|xandros|alma|rocky/i.test(s) ? 'linux' : 'other'; }

class VBox {
  constructor({ run = U.run, platform = process.platform, env = process.env, exists = fs.existsSync, tmp = os.tmpdir() } = {}) {
    this.runFn = run; this.platform = platform; this.env = env; this.exists = exists; this.tmp = tmp;
    this.exe = undefined; this.cache = new Map();
  }

  locate() {
    if (this.exe !== undefined) return this.exe;
    const list = [];
    if (this.platform === 'win32') {
      if (this.env.VBOX_MSI_INSTALL_PATH) list.push(path.join(this.env.VBOX_MSI_INSTALL_PATH, 'VBoxManage.exe'));
      if (this.env.VBOX_INSTALL_PATH) list.push(path.join(this.env.VBOX_INSTALL_PATH, 'VBoxManage.exe'));
      list.push(path.join(this.env.ProgramFiles || 'C:\\Program Files', 'Oracle', 'VirtualBox', 'VBoxManage.exe'));
    } else list.push('/usr/bin/VBoxManage', '/usr/local/bin/VBoxManage', '/Applications/VirtualBox.app/Contents/MacOS/VBoxManage');
    this.exe = list.find((p) => this.exists(p)) || null;
    return this.exe;
  }

  async call(args, opts = {}) {
    const exe = this.locate();
    if (!exe) throw U.fail(404, 'VirtualBox is not installed.');
    const r = await this.runFn(exe, args, { timeout: 120000, ...opts });
    if (r.code !== 0) {
      const msg = `${r.stderr || ''}\n${r.stdout || ''}`.split(/\r?\n/).map((l) => l.replace(/^VBoxManage(\.exe)?: error: /, '').trim()).filter(Boolean).slice(0, 2).join(' ');
      throw Object.assign(new Error(msg || `VBoxManage: exit code ${r.code}`), { status: 500 });
    }
    return r;
  }
  uuid(id) { if (!UUID_RE.test(String(id))) throw U.fail(400, 'Invalid VirtualBox id.'); return String(id).toLowerCase(); }

  async version() { if (!this.locate()) return null; const r = await this.runFn(this.exe, ['--version'], { timeout: 20000 }).catch(() => null); return r && r.code === 0 ? r.stdout.trim() : null; }

  /** All VirtualBox VMs with details (state, CPU, RAM, disks …) – one VBoxManage call per VM, run in parallel. */
  async list() {
    if (!this.locate()) return [];
    const r = await this.call(['list', 'vms'], { timeout: 30000 });
    const items = parseList(r.stdout);
    return (await Promise.all(items.map((i) => this.vm(i.uuid).catch(() => ({ uuid: i.uuid, name: i.name, state: 'error', error: true }))))).filter(Boolean);
  }
  async vm(id) {
    const r = await this.call(['showvminfo', this.uuid(id), '--machinereadable'], { timeout: 30000 });
    const vm = vmFromInfo(parseMachineReadable(r.stdout));
    const managed = await this.runFn(this.exe, ['getextradata', vm.uuid, 'hostwerk/managed'], { timeout: 15000 }).catch(() => null);
    vm.managed = !!(managed && /Value:\s*1/.test(managed.stdout));
    vm.osFamily = osTypeOf(vm.osType);
    return vm;
  }

  async start(id, { window = false } = {}) { await this.call(['startvm', this.uuid(id), '--type', window ? 'gui' : 'headless'], { timeout: 180000 }); }
  /** acpi (shut down cleanly) · poweroff · savestate · pause · resume · reset */
  async control(id, action) {
    const map = { acpi: 'acpipowerbutton', poweroff: 'poweroff', savestate: 'savestate', pause: 'pause', resume: 'resume', reset: 'reset' };
    if (!map[action]) throw U.fail(400, 'Unknown action.');
    await this.call(['controlvm', this.uuid(id), map[action]], { timeout: 180000 });
  }
  /**
   * Snapshots. Not "--live" by default: VirtualBox then pauses the VM for the moment of the snapshot – live snapshots hang
   * when VirtualBox runs on top of Hyper-V (WSL2, Windows Hypervisor Platform), seen on Windows 11 with VirtualBox 7.2.
   */
  async snapshot(id, action, name, { description = '', live = false } = {}) {
    const u = this.uuid(id);
    const n = String(name || '').slice(0, 64);
    if (!n || /[\r\n"]/.test(n)) throw U.fail(400, 'Invalid snapshot name.');
    const timeout = 10 * 60000;
    if (action === 'take') await this.call(['snapshot', u, 'take', n, ...(description ? ['--description', String(description).slice(0, 400)] : []), ...(live ? ['--live'] : [])], { timeout });
    else if (action === 'restore') await this.call(['snapshot', u, 'restore', n], { timeout });
    else if (action === 'delete') await this.call(['snapshot', u, 'delete', n], { timeout });
    else throw U.fail(400, 'Unknown action.');
  }
  /** Is this disk a difference image (a disk with snapshots)? qemu-img cannot read those – they are merged first. */
  async isDifferencing(file) {
    const r = await this.runFn(this.locate(), ['showmediuminfo', 'disk', file], { timeout: 30000 }).catch(() => null);
    if (!r || r.code !== 0) return /[\\/]Snapshots[\\/]\{[0-9a-f-]{36}\}\.vdi$/i.test(file);
    const m = r.stdout.match(/^Parent UUID:\s*(\S+)/m);
    return !!(m && m[1] !== 'base');
  }
  /** Merges a disk with its whole snapshot chain into one standalone VDI (VirtualBox's own clonemedium). */
  async flatten(file, dest) { await this.call(['clonemedium', 'disk', file, dest, '--format', 'VDI'], { timeout: 6 * 3600e3 }); }
  /** Waits until VirtualBox no longer holds a session on the VM (after power off). → true when free */
  async waitUnlocked(id, ms = 30000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const r = await this.runFn(this.locate(), ['showvminfo', this.uuid(id), '--machinereadable'], { timeout: 15000 }).catch(() => null);
      const m = r && r.code === 0 ? parseMachineReadable(r.stdout) : null;
      if (m && !m.SessionName && STATE[String(m.VMState || '').toLowerCase()] === 'stopped') return true;
      await U.sleep(1000);
    }
    return false;
  }
  /** PNG of the running VM's screen. */
  async screenshot(id) {
    const f = path.join(this.tmp, `hw-vbox-${this.uuid(id)}-${process.pid}.png`);
    try { await this.call(['controlvm', this.uuid(id), 'screenshotpng', f], { timeout: 30000 }); return fs.readFileSync(f); } finally { try { fs.unlinkSync(f); } catch { /* egal */ } }
  }
  async typeText(id, text) {
    const t = String(text || '');
    if (!t || t.length > 2000) throw U.fail(400, 'Text: 1 to 2000 characters.');
    await this.call(['controlvm', this.uuid(id), 'keyboardputstring', t], { timeout: 60000 });
  }
  async ctrlAltDel(id) { await this.call(['controlvm', this.uuid(id), 'keyboardputscancode', '1d', '38', '53', 'd3', 'b8', '9d'], { timeout: 30000 }); }
  async mark(id) { await this.call(['setextradata', this.uuid(id), 'hostwerk/managed', '1'], { timeout: 30000 }); }
  /** Removes a VM Hostwerk created itself (with its files). VMs of the person are never deleted here. */
  async removeManaged(id) {
    const vm = await this.vm(id);
    if (!vm.managed) throw U.fail(403, 'Only VMs Hostwerk created itself can be deleted here – remove other VMs in VirtualBox.');
    if (vm.state !== 'stopped') await this.control(id, 'poweroff').catch(() => {});
    if (!(await this.waitUnlocked(vm.uuid))) throw U.fail(409, 'VirtualBox still holds the VM (it may hang) – close it in VirtualBox or end its VBoxHeadless process, then delete again.');
    await this.call(['unregistervm', vm.uuid, '--delete'], { timeout: 300000 });
  }
}

module.exports = { VBox, parseMachineReadable, parseList, vmFromInfo, osTypeOf, UUID_RE };
