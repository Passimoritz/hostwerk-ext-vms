'use strict';
/*
 * One running QEMU VM: process (Hostwerk's ManagedProcess – logs, CPU/RAM, crash restart, clean stop when Hostwerk
 * quits), QMP control, screen (screendump as PNG), keyboard and mouse, live snapshots, live port forwarding, CD changes,
 * serial console and guest agent.
 *
 *   const rt = new Runtime(vm, { qhost, Proc, dir, lanAllowed, onChange, log })
 *   await rt.start() · rt.status() · await rt.shutdown() · await rt.powerOff() · rt.pause() · rt.screen() · rt.input([…]) …
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { Qmp, agent, addressesFrom } = require('./qmp');
const { buildArgs, rebootByRestart, hostfwdRule, hostfwdKey } = require('./qemu-args');
const K = require('./keys');
const U = require('./util');

const SERIAL_MAX = 256 * 1024;
const usedPorts = new Set(); // ports handed out in this process (QEMU binds them a moment later)

class Runtime {
  constructor(vm, { qhost, Proc, registry = null, dir, lanAllowed = () => false, onChange = () => {}, portBase = 47100, runFn = null, switches = null, prepareKey = null, checkTap = null, currentVm = null }) {
    this.vm = vm; this.qhost = qhost; this.Proc = Proc; this.registry = registry; this.dir = dir; this.runFn = runFn; this.lanAllowed = lanAllowed; this.onChange = onChange; this.portBase = portBase;
    this.switches = switches; this.prepareKey = prepareKey; this.checkTap = checkTap; this.nets = [];
    this.currentVm = currentVm; // the stored description, read again before a restart the runtime does by itself
    this.proc = null; this.qmp = null; this.ports = null; this.paused = false; this.serial = { text: '', seq: 0, sock: null };
    this.lastShot = null; this.shooting = null; this.agentInfo = null; this.accel = null; this.guestEvents = [];
  }

  get procId() { return `vm-${this.vm.id}`; }
  isRunning() { return !!(this.proc && this.proc.isRunning()); }

  status() {
    const p = this.proc ? this.proc.info() : { state: 'stopped' };
    // between the end of QEMU and its new start after a guest restart (-no-reboot): "starting", not "stopped"
    const state = p.state === 'running' && this.paused ? 'paused' : this.restarting && p.state !== 'running' ? 'starting' : p.state;
    return { state, pid: p.pid || null, startedAt: p.startedAt || null, error: p.error || null, hint: p.hint || null, stats: p.stats || null, accel: this.isRunning() ? this.accel : null, ports: this.isRunning() ? this.ports : null, agent: this.agentInfo };
  }

  async allocPorts() {
    const avoid = new Set(usedPorts);
    const qmp = await U.freePort(this.portBase, avoid); avoid.add(qmp);
    const qga = await U.freePort(qmp + 1, avoid); avoid.add(qga);
    const serial = await U.freePort(qga + 1, avoid); avoid.add(serial);
    // VNC for the fluid screen in Hostwerk (#1): QEMU needs a port ≥ 5900 (display number), bridged by server/vnc.js
    // not with 3D: QEMU refuses VNC next to an OpenGL context ("Display vnc is incompatible with the GL context")
    const gl = require('./qemu-args').glMode(this.vm);
    const vnc = gl ? null : await require('./vnc').pickVncPort(U.freePort, avoid).catch(() => null);
    for (const p of [qmp, qga, serial, vnc]) if (p) usedPorts.add(p);
    return { qmp, qga, serial, vnc };
  }
  releasePorts() { if (this.ports) for (const k of ['qmp', 'qga', 'serial', 'vnc']) if (this.ports[k]) usedPorts.delete(this.ports[k]); }

  /** Forwarded host ports must be free – QEMU only warns and starts without them otherwise. */
  async checkForwards() {
    if (this.vm.net && ['bridge', 'none'].includes(this.vm.net.mode)) return;
    for (const f of (this.vm.net && this.vm.net.forwards) || []) {
      if (f.proto !== 'tcp') continue;
      const host = f.bind === 'lan' && this.lanAllowed() ? '0.0.0.0' : '127.0.0.1';
      if (!(await U.portFree(f.host, host))) throw U.fail(409, 'Port {port} on this PC is already in use – change the forwarding “{label}”.', { port: f.host, label: f.label || `${f.guest}` });
    }
  }

  async start({ loadvm = null, afterReset = false } = {}) {
    if (this.isRunning()) return this.status();
    const info = await this.qhost.info();
    if (!info.installed) throw U.fail(428, 'QEMU is not installed yet.', null, 'NO_QEMU');
    // ARM (#22): its own QEMU program and firmware, always emulated (TCG)
    const arm = this.vm.arch === 'aarch64';
    if (arm && !(info.aarch64 && info.aarch64.system)) throw U.fail(428, 'QEMU for ARM (qemu-system-aarch64) was not found next to QEMU.');
    if (arm && !info.aarch64.firmware) throw U.fail(500, 'UEFI firmware for ARM (edk2-aarch64) was not found next to QEMU.');
    const fw = arm ? info.aarch64.firmware : info.firmware;
    if (this.vm.firmware === 'uefi' || arm) {
      if (!fw) throw U.fail(500, 'UEFI firmware (edk2/OVMF) was not found next to QEMU.');
      const vars = path.join(this.dir, 'vars.fd');
      if (!fs.existsSync(vars)) fs.copyFileSync(fw.vars, vars);
    }
    for (const k of this.vm.disks || []) if (!fs.existsSync(path.join(this.dir, k.file))) throw U.fail(404, 'Disk {file} is missing in the VM folder.', { file: k.file });
    if (this.vm.cdrom && !fs.existsSync(this.vm.cdrom)) throw U.fail(404, 'The ISO file was not found: {path}', { path: this.vm.cdrom });
    if (this.vm.net && this.vm.net.mode === 'bridge' && this.checkTap) await this.checkTap(this.vm.net.tap);
    await this.checkForwards();
    this.releasePorts();
    this.ports = await this.allocPorts();
    // Internal networks (#7): a UDP port per NIC, joined to Hostwerk's switch of that network
    this.detachNets();
    const nets = [];
    if ((this.vm.nets || []).length) {
      if (!this.switches) throw U.fail(500, 'Internal networks are not available.');
      const { freeUdpPort } = require('./netswitch');
      for (const n of this.vm.nets) {
        const local = await freeUdpPort(new Set(nets.map((x) => x.local)));
        const remote = await this.switches.attach(n.net, local);
        nets.push({ net: n.net, local, remote, mac: n.mac });
      }
    }
    this.nets = nets;
    // Encrypted disks (#15): key file for this start only – deleted as soon as QEMU has read it (or the start failed)
    let keyFile = null;
    try {
      if ((this.vm.disks || []).some((k) => k.encrypted)) {
        if (!this.prepareKey) throw U.fail(409, 'The key of the encrypted disk is missing.');
        keyFile = await this.prepareKey();
      }
      const args = buildArgs(this.vm, { dir: this.dir, accel: arm ? ['tcg'] : info.accelArgs, firmware: fw, ports: this.ports, lanAllowed: this.lanAllowed(), loadvm, nets, keyFile });
      this.accel = arm ? 'tcg' : info.accel;
      this.rebootByRestart = !arm && rebootByRestart(this.vm, info.accelArgs);
      this.restartPending = false;
      this.proc = (this.registry && this.registry.get(this.procId)) || this.proc || new this.Proc(this.procId, this.vm.name);
      this.proc.name = this.vm.name;
      this.proc.restartFn = this.vm.autoRestart ? () => this.start() : null;
      this.proc.stopFn = () => this.shutdown({ timeout: 45000 }); // Hostwerk quits: shut the guest down cleanly
      this.proc.onExit = () => this.onQemuExit();
      this.paused = false;
      try { fs.rmSync(path.join(this.dir, 'qemu.pid'), { force: true }); } catch { /* egal */ }
      await this.proc.start({
        cmd: arm ? info.aarch64.system : info.system, args, cwd: this.dir,
        // "Own window": Hostwerk starts programs with windowsHide, which on Windows hides QEMU's SDL window too (seen
        // live: no visible window). Hostwerk before this option ignores it – the window stays hidden there.
        hide: this.vm.display !== 'window',
        ready: async () => {
          const q = new Qmp({ port: this.ports.qmp });
          await q.connect(30000);
          this.qmp = q;
          q.on('event', (e) => this.onEvent(e));
          q.on('close', () => { if (this.qmp === q) this.qmp = null; });
        },
      });
    } catch (e) {
      if (!this.isRunning()) this.detachNets();
      throw e;
    } finally {
      if (keyFile) U.removeSecretFile(keyFile); // QMP answers only after QEMU opened the disks
    }
    this.connectSerial();
    // Windows installer from CD: "Press any key to boot from CD or DVD …" – press Enter for a few seconds. Not after a
    // restart of the guest: Setup goes on from the disk there, a key press would start the installer from the CD again.
    if (!afterReset && this.vm.install && this.vm.install.state === 'running' && this.vm.boot === 'cdrom') this.pressToBoot();
    await this.applyLimits({ disks: false }).catch((e) => this.proc.log(`Limits: ${e.message}`, 'sys')); // disk limits are already in the command line
    this.onChange('started');
    this.pollAgent(true);
    return this.status();
  }

  onEvent(e) {
    const ev = e.event;
    if (ev === 'STOP') this.paused = true;
    if (ev === 'RESUME') this.paused = false;
    // -no-reboot: the guest restarts → QEMU ends (SHUTDOWN guest-reset) → onQemuExit starts it again
    if (ev === 'SHUTDOWN' && this.rebootByRestart && e.data && e.data.reason === 'guest-reset') { this.restartPending = true; this.restarting = true; }
    if (['STOP', 'RESUME', 'SHUTDOWN', 'RESET', 'POWERDOWN', 'GUEST_PANICKED'].includes(ev)) {
      this.guestEvents.push({ t: Date.now(), event: ev });
      if (this.guestEvents.length > 30) this.guestEvents.shift();
      if (this.proc) this.proc.log(`Guest: ${ev}${e.data && e.data.reason ? ` (${e.data.reason})` : ''}`, 'sys');
      this.onChange(ev.toLowerCase());
    }
  }

  /** Leaves the switches of the internal networks (VM stopped or start failed). */
  detachNets() {
    for (const n of this.nets || []) if (this.switches) this.switches.detach(n.net, n.local);
    this.nets = [];
  }

  /** QEMU ended: clean up – and after a guest restart (or the reset button) of a -no-reboot VM start it again. */
  onQemuExit() {
    const again = this.restartPending;
    this.restartPending = false;
    this.cleanup();
    if (!again) { this.restarting = false; return; }
    if (this.proc) this.proc.log('Guest restarts – Hostwerk starts QEMU again', 'sys');
    if (this.currentVm) { const v = this.currentVm(); if (v) this.vm = v; }
    this.restartTask = this.start({ afterReset: true })
      .catch((e) => { if (this.proc) this.proc.log(`Restart failed: ${e.message}`, 'sys'); })
      .finally(() => { this.restarting = false; this.restartTask = null; this.onChange('restarted'); });
  }

  cleanup() {
    this.detachNets();
    if (this.qmp) { this.qmp.close(); this.qmp = null; }
    if (this.serial.sock) { try { this.serial.sock.destroy(); } catch { /* egal */ } this.serial.sock = null; }
    this.releasePorts();
    this.paused = false; this.agentInfo = null; this.lastShot = null;
    clearTimeout(this.agentTimer);
    this.onChange('stopped');
  }

  needQmp() { if (!this.qmp || !this.isRunning()) throw U.fail(409, 'The VM is not running.'); return this.qmp; }

  /** Clean shutdown: ACPI power button (and the guest agent, if it runs), hard stop after `timeout`. */
  async shutdown({ timeout = 90000 } = {}) {
    if (!this.isRunning()) return;
    await this.proc.stop({
      timeout,
      graceful: async () => {
        if (this.paused && this.qmp) await this.qmp.exec('cont').catch(() => {});
        if (this.qmp) await this.qmp.exec('system_powerdown').catch(() => {});
        if (this.agentInfo && this.agentInfo.ok) await agent({ port: this.ports.qga }, 'guest-shutdown', { mode: 'powerdown' }, 3000).catch(() => {});
      },
    });
  }
  /** Like pulling the plug – data the guest has not written yet is lost. */
  async powerOff() {
    if (!this.isRunning()) return;
    await this.proc.stop({ timeout: 5000, graceful: async () => { if (this.qmp) await this.qmp.exec('quit').catch(() => {}); } });
  }
  async pause() { await this.needQmp().exec('stop'); this.paused = true; this.onChange('paused'); }
  async resume() { await this.needQmp().exec('cont'); this.paused = false; this.onChange('resumed'); }
  async reset() {
    const q = this.needQmp();
    // WHPX with Windows: system_reset would leave QEMU paused – end QEMU and start it again instead
    if (this.rebootByRestart) { this.restartPending = true; this.restarting = true; await q.exec('quit').catch(() => {}); return; }
    await q.exec('system_reset');
  }

  /** Screen as PNG. Requests that arrive while one is being taken share it; `etag` lets the page skip unchanged frames. */
  async screen() {
    const q = this.needQmp();
    // 3D in QEMU's own window: the picture lives only in that OpenGL window, QEMU's screendump says "no surface"
    if (require('./qemu-args').glMode(this.vm)) throw U.fail(409, 'This VM shows 3D in its own window on this PC – the picture is only there.');
    if (this.shooting) return this.shooting;
    const file = path.join(this.dir, '.screen.png');
    this.shooting = (async () => {
      try {
        await q.exec('screendump', { filename: file, format: 'png' }, 10000);
        const png = fs.readFileSync(file);
        const etag = crypto.createHash('sha1').update(png).digest('hex').slice(0, 16);
        this.lastShot = { png, etag, t: Date.now() };
        return this.lastShot;
      } finally { this.shooting = null; }
    })();
    return this.shooting;
  }

  async input(events) {
    const ev = K.toQmpEvents(events);
    if (!ev.length) return 0;
    // No device id: QEMU sends absolute positions to the USB tablet by itself (checked in GNOME on Ubuntu 24.04 with
    // WHPX). Naming the tablet fails with "not bound to a QemuConsole" when the screen runs without a window.
    await this.needQmp().exec('input-send-event', { events: ev });
    return ev.length;
  }
  async combo(name) {
    const keys = K.COMBOS[name];
    if (!keys) throw U.fail(400, 'Unknown key combination.');
    await this.needQmp().exec('send-key', { keys: keys.map((k) => ({ type: 'qcode', data: k })), 'hold-time': 80 });
  }
  async typeText(text) {
    const t = String(text || '');
    if (!t || t.length > 4000) throw U.fail(400, 'Text: 1 to 4000 characters.');
    const q = this.needQmp();
    for (const keys of K.textToKeys(t, this.vm.keyboard || 'us')) {
      await q.exec('send-key', { keys: keys.map((k) => ({ type: 'qcode', data: k })), 'hold-time': 15 });
      await U.sleep(12);
    }
  }

  /** Presses Enter every 0.7 s for `ms` – catches the short "press any key to boot from CD" window of Windows ISOs. */
  pressToBoot(ms = 20000) {
    const until = Date.now() + ms;
    const tick = async () => {
      if (!this.qmp || !this.isRunning() || Date.now() > until) return;
      await this.qmp.exec('send-key', { keys: [{ type: 'qcode', data: 'ret' }], 'hold-time': 50 }).catch(() => {});
      const t = setTimeout(tick, 700); if (t.unref) t.unref();
    };
    tick();
  }

  /** Inserts an ISO (or ejects with null) while the VM runs. */
  async changeCd(iso) {
    const q = this.needQmp();
    if (!iso) { await q.exec('eject', { id: 'cdrom0', force: true }); return; }
    await q.exec('blockdev-change-medium', { id: 'cdrom0', filename: iso, format: 'raw', 'read-only-mode': 'read-only' });
  }

  // Port forwarding exists only in the user network (NAT) – a bridged VM is reachable directly
  async forwardAdd(f) { if (this.vm.net && ['bridge', 'none'].includes(this.vm.net.mode)) return; await this.needQmp().hmp(`hostfwd_add n0 ${hostfwdRule(f, this.lanAllowed())}`); }
  async forwardRemove(f) { if (this.vm.net && ['bridge', 'none'].includes(this.vm.net.mode)) return; await this.needQmp().hmp(`hostfwd_remove n0 ${hostfwdKey(f, this.lanAllowed())}`); }

  /**
   * Snapshot while running. With `ram` (only where the accelerator supports it): savevm – memory included, the VM
   * continues exactly there after restoring. Otherwise disk snapshots of all qcow2 disks at the same moment; if the guest
   * agent runs, the file systems are frozen for that moment (consistent like a clean shutdown).
   */
  async liveSnapshot(name, { ram = false } = {}) {
    const q = this.needQmp();
    if (ram) { await q.hmp(`savevm ${name}`, 600000); return { ram: true, frozen: false }; }
    let frozen = false;
    if (this.agentInfo && this.agentInfo.ok) frozen = await agent({ port: this.ports.qga }, 'guest-fsfreeze-freeze', null, 20000).then(() => true).catch(() => false);
    try {
      for (const k of this.vm.disks.filter((d) => d.format === 'qcow2')) await q.exec('blockdev-snapshot-internal-sync', { device: k.id, name }, 120000);
    } finally { if (frozen) await agent({ port: this.ports.qga }, 'guest-fsfreeze-thaw', null, 20000).catch(() => {}); }
    return { ram: false, frozen };
  }
  async liveSnapshotDelete(name) {
    const q = this.needQmp();
    for (const k of this.vm.disks.filter((d) => d.format === 'qcow2')) await q.exec('blockdev-snapshot-delete-internal-sync', { device: k.id, name }, 120000).catch((e) => { if (!/not found|does not exist/i.test(e.message)) throw e; });
  }

  /** Guest agent: is it there, which OS, which IP addresses. Polled after the start and then every 30 s. */
  async pollAgent(first = false) {
    clearTimeout(this.agentTimer);
    if (!this.isRunning() || !this.ports) return;
    try {
      const port = this.ports.qga;
      await agent({ port }, 'guest-ping', null, 3000);
      const [os0, ifs, host] = await Promise.all([
        agent({ port }, 'guest-get-osinfo', null, 5000).catch(() => null),
        agent({ port }, 'guest-network-get-interfaces', null, 5000).catch(() => null),
        agent({ port }, 'guest-get-host-name', null, 5000).catch(() => null),
      ]);
      const was = this.agentInfo && this.agentInfo.ok;
      this.agentInfo = { ok: true, at: Date.now(), os: os0 ? (os0['pretty-name'] || os0.name || null) : null, osId: os0 ? os0.id || null : null, kernel: os0 ? os0['kernel-release'] || null : null, hostname: host ? host['host-name'] : null, addresses: addressesFrom(ifs), fs: [] };
      this.agentInfo.fs = await this.guestFs().catch(() => []);
      // A disk in the guest at 90 % or more: report once (again only after it went below 85 %)
      const full = this.agentInfo.fs.filter((f) => f.pct != null && f.pct >= 90);
      if (full.length && !this.fullWarned) { this.fullWarned = true; this.onChange('disk-full', full); }
      if (!full.length && this.agentInfo.fs.every((f) => f.pct == null || f.pct < 85)) this.fullWarned = false;
      if (!was) this.onChange('agent');
    } catch {
      if (this.agentInfo && this.agentInfo.ok) this.onChange('agent');
      this.agentInfo = { ok: false, at: Date.now() };
    }
    const delay = this.agentInfo.ok ? 30000 : first || Date.now() - (this.proc.startedAt || 0) < 600000 ? 5000 : 60000;
    this.agentTimer = setTimeout(() => this.pollAgent(), delay);
    if (this.agentTimer.unref) this.agentTimer.unref();
  }
  async agentCall(cmd, args, timeout) { if (!this.ports) throw U.fail(409, 'The VM is not running.'); return agent({ port: this.ports.qga }, cmd, args, timeout); }

  /**
   * Limits while running: disk throttling through QMP, CPU share (which host cores) and priority on the QEMU process.
   * Lowering needs no administrator rights; "high" is "above normal", never real-time.
   */
  async applyLimits({ disks = true } = {}) {
    const l = this.vm.limits || { iops: 0, mbps: 0, cpuShare: 100, priority: 'normal' };
    if (disks && this.qmp) {
      const bps = (l.mbps || 0) * 1048576;
      for (const k of this.vm.disks) {
        await this.qmp.exec('block_set_io_throttle', { device: k.id, bps, bps_rd: 0, bps_wr: 0, iops: l.iops || 0, iops_rd: 0, iops_wr: 0 });
      }
    }
    const pid = this.proc && this.proc.pid;
    if (!pid) return;
    const cores = require('os').cpus().length;
    const mask = require('./spec').affinityMask(l.cpuShare || 100, cores);
    const run = this.runFn || U.run;
    if (process.platform === 'win32') {
      const prio = { low: 'BelowNormal', normal: 'Normal', high: 'AboveNormal' }[l.priority] || 'Normal';
      const full = (2n ** BigInt(cores) - 1n).toString();
      const ps = `$p = Get-Process -Id ${Number(pid)}; $p.PriorityClass = '${prio}'; $p.ProcessorAffinity = [IntPtr]${mask ? mask.toString() : full}`;
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20000 });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split(/\r?\n/)[0] || 'PowerShell failed');
    } else {
      await run('renice', ['-n', { low: '10', normal: '0', high: '-5' }[l.priority] || '0', '-p', String(pid)], { timeout: 10000 });
      if (mask) await run('taskset', ['-p', mask.toString(16), String(pid)], { timeout: 10000 });
    }
  }

  /* ---------- Files in and out of the guest (#5) – through the guest agent, no network share needed ---------- */
  /** Where dropped files go: the desktop/home of the VM's user. */
  async guestTarget(name) {
    const safe = String(name || 'file').split(/[\\/]/).pop().replace(/[^\w.\-()äöüÄÖÜß ]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
    if (this.vm.osType === 'windows') {
      const u = this.vm.install && this.vm.install.user;
      return { path: u ? `C:\\Users\\${u}\\Desktop\\${safe}` : `C:\\Users\\Public\\Desktop\\${safe}`, owner: null };
    }
    let user = this.vm.ssh && this.vm.ssh.user;
    if (!user) { const r = await this.guestExec('getent passwd 1000 | cut -d: -f1', { timeout: 10000 }).catch(() => null); user = r && r.code === 0 ? r.out.trim() : null; }
    return user && /^[a-z_][a-z0-9_-]{0,31}$/.test(user) ? { path: `/home/${user}/${safe}`, owner: user } : { path: `/root/${safe}`, owner: null };
  }
  /** Writes a stream into a file in the guest (chunks of 1 MB). → bytes written */
  async guestWriteFile(dest, stream, { maxBytes = 2 * 2 ** 30 } = {}) {
    const h = await this.agentCall('guest-file-open', { path: dest, mode: 'wb' }, 15000);
    let total = 0; let pending = [];
    let size = 0;
    const flush = async () => { if (!size) return; const buf = Buffer.concat(pending, size); pending = []; size = 0; await this.agentCall('guest-file-write', { handle: h, 'buf-b64': buf.toString('base64') }, 60000); };
    try {
      for await (const chunk of stream) {
        total += chunk.length;
        if (total > maxBytes) throw U.fail(413, 'The file is too big (at most {gb} GB).', { gb: Math.round(maxBytes / 2 ** 30) });
        pending.push(chunk); size += chunk.length;
        if (size >= 1048576) await flush();
      }
      await flush();
    } finally { await this.agentCall('guest-file-close', { handle: h }, 15000).catch(() => {}); }
    return total;
  }
  /** Reads a file from the guest chunk by chunk (onChunk(Buffer)). → bytes read */
  async guestReadFile(src, onChunk) {
    const h = await this.agentCall('guest-file-open', { path: String(src), mode: 'rb' }, 15000);
    let total = 0;
    try {
      for (;;) {
        const r = await this.agentCall('guest-file-read', { handle: h, count: 1048576 }, 60000);
        if (r.count) { const b = Buffer.from(r['buf-b64'] || '', 'base64'); total += b.length; await onChunk(b); }
        if (r.eof || !r.count) break;
      }
    } finally { await this.agentCall('guest-file-close', { handle: h }, 15000).catch(() => {}); }
    return total;
  }

  /** File systems in the guest with used/total bytes (without pseudo file systems). */
  async guestFs() {
    const list = await this.agentCall('guest-get-fsinfo', null, 10000);
    const seen = new Set();
    const out = [];
    for (const f of Array.isArray(list) ? list : []) {
      if (!f['total-bytes'] || /^(squashfs|tmpfs|devtmpfs|overlay|iso9660|vfat)$/i.test(f.type || '') && f.mountpoint !== '/boot/efi') continue;
      if (/^\/(snap|run|sys|proc|dev)\b/.test(f.mountpoint || '')) continue;
      const key = `${f.name}|${f['total-bytes']}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ mount: f.mountpoint, type: f.type, used: f['used-bytes'] ?? null, total: f['total-bytes'], pct: f['used-bytes'] != null ? Math.round((f['used-bytes'] / f['total-bytes']) * 100) : null });
    }
    return out;
  }

  /**
   * Runs a command in the guest through the agent and waits for it (Linux: /bin/sh -c, Windows: PowerShell).
   * → { code, out, err, timedOut }
   */
  async guestExec(command, { timeout = 60000, windows = this.vm.osType === 'windows' } = {}) {
    const cmd = String(command || '');
    if (!cmd || cmd.length > 4000) throw U.fail(400, 'Command: 1 to 4000 characters.');
    // Windows PowerShell writes its output in the console's OEM code page (850/437) – "ß" came back as "�". UTF-8 instead.
    const ps = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ${cmd}`;
    const spec = windows ? { path: 'powershell.exe', arg: ['-NoProfile', '-NonInteractive', '-Command', ps] } : { path: '/bin/sh', arg: ['-c', cmd] };
    const { pid } = await this.agentCall('guest-exec', { ...spec, 'capture-output': true }, 10000);
    const until = Date.now() + timeout;
    const dec = (b) => (b ? Buffer.from(b, 'base64').toString('utf8') : '');
    while (Date.now() < until) {
      const s = await this.agentCall('guest-exec-status', { pid }, 10000);
      if (s.exited) return { code: s.exitcode ?? (s.signal ? 128 + s.signal : -1), out: dec(s['out-data']).slice(-200000), err: dec(s['err-data']).slice(-50000), timedOut: false };
      await U.sleep(400);
    }
    return { code: null, out: '', err: '', timedOut: true };
  }

  /* ---------- Serial console ---------- */
  connectSerial(tries = 0) {
    if (!this.isRunning() || !this.ports || this.serial.sock) return;
    const s = net.connect({ port: this.ports.serial, host: '127.0.0.1' });
    s.on('connect', () => { this.serial.sock = s; });
    s.on('data', (d) => this.appendSerial(d.toString('utf8')));
    s.on('error', () => {});
    s.on('close', () => {
      if (this.serial.sock === s) this.serial.sock = null;
      if (this.isRunning() && tries < 40) { const t = setTimeout(() => this.connectSerial(tries + 1), 1000); if (t.unref) t.unref(); }
    });
  }
  appendSerial(text) {
    const s = this.serial;
    s.text += text;
    s.seq += text.length;
    if (s.text.length > SERIAL_MAX) s.text = s.text.slice(-SERIAL_MAX);
  }
  /** New serial output since `since` (a position from an earlier answer). */
  serialSince(since) {
    const s = this.serial;
    const start = s.seq - s.text.length;
    const from = Number.isFinite(Number(since)) ? Math.max(start, Number(since)) : start;
    return { seq: s.seq, text: s.text.slice(from - start), reset: Number(since) < start };
  }
  serialWrite(data) {
    if (!this.serial.sock) throw U.fail(409, 'The serial console is not connected.');
    const t = String(data || '');
    if (t.length > 4096) throw U.fail(400, 'Too much input at once.');
    this.serial.sock.write(t);
  }
}

module.exports = { Runtime, usedPorts };
