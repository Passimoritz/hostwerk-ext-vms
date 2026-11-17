'use strict';
/*
 * QEMU on this PC: where it is, which version, which accelerator really works (tried once – a compiled-in accelerator
 * can still be switched off in Windows), UEFI firmware, and qemu-img for disks (create, convert, resize, info, offline
 * snapshots). Program calls go through `run` (injectable for the tests).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const U = require('./util');

const EXE = process.platform === 'win32' ? '.exe' : '';

function candidates(env = process.env, platform = process.platform) {
  const list = [];
  if (env.HW_QEMU_DIR) list.push(env.HW_QEMU_DIR);
  if (platform === 'win32') {
    for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean)) list.push(path.join(pf, 'qemu'));
    if (env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, 'Programs', 'qemu'));
    if (env.USERPROFILE) list.push(path.join(env.USERPROFILE, 'scoop', 'apps', 'qemu', 'current'));
    list.push('C:\\msys64\\ucrt64\\bin', 'C:\\msys64\\mingw64\\bin');
  } else if (platform === 'darwin') list.push('/opt/homebrew/bin', '/usr/local/bin');
  else list.push('/usr/bin', '/usr/local/bin', '/usr/libexec');
  for (const p of String(env.PATH || env.Path || '').split(path.delimiter)) if (p) list.push(p);
  return [...new Set(list)];
}

/** Finds qemu-system-x86_64 and qemu-img (same folder preferred). */
function locate({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  for (const dir of candidates(env, platform)) {
    const sys = path.join(dir, `qemu-system-x86_64${platform === 'win32' ? '.exe' : ''}`);
    if (!exists(sys)) continue;
    const img = path.join(dir, `qemu-img${platform === 'win32' ? '.exe' : ''}`);
    return { dir, system: sys, img: exists(img) ? img : null };
  }
  return null;
}

/** UEFI firmware: edk2 that ships with QEMU (Windows/macOS: <qemu>/share, Linux: ovmf packages). */
function findFirmware(qemuDir, { exists = fs.existsSync } = {}) {
  const roots = [path.join(qemuDir || '', 'share'), path.join(qemuDir || '', '..', 'share', 'qemu'), '/usr/share/qemu', '/usr/share/OVMF', '/usr/share/edk2/ovmf', '/usr/share/edk2/x64', '/opt/homebrew/share/qemu', '/usr/local/share/qemu'];
  const codes = ['edk2-x86_64-code.fd', 'OVMF_CODE_4M.fd', 'OVMF_CODE.fd', 'OVMF_CODE.4m.fd'];
  const vars = ['edk2-i386-vars.fd', 'OVMF_VARS_4M.fd', 'OVMF_VARS.fd', 'OVMF_VARS.4m.fd'];
  for (const r of roots) {
    const code = codes.map((c) => path.join(r, c)).find((p) => exists(p));
    const v = vars.map((c) => path.join(r, c)).find((p) => exists(p));
    if (code && v) return { code, vars: v };
  }
  return null;
}

/**
 * ARM (#22): qemu-system-aarch64 in the same folder and the edk2 firmware for it (Windows/macOS: <qemu>/share
 * edk2-aarch64-code.fd + edk2-arm-vars.fd; Linux: AAVMF from qemu-efi-aarch64). → { system, firmware } or null
 */
function locateArm(qemuDir, { platform = process.platform, exists = fs.existsSync } = {}) {
  if (!qemuDir) return null;
  const system = path.join(qemuDir, `qemu-system-aarch64${platform === 'win32' ? '.exe' : ''}`);
  if (!exists(system)) return null;
  const roots = [path.join(qemuDir, 'share'), path.join(qemuDir, '..', 'share', 'qemu'), '/usr/share/qemu', '/usr/share/AAVMF', '/usr/share/edk2/aarch64', '/opt/homebrew/share/qemu', '/usr/local/share/qemu'];
  const codes = ['edk2-aarch64-code.fd', 'AAVMF_CODE.fd', 'QEMU_EFI-pflash.raw'];
  const vars = ['edk2-arm-vars.fd', 'AAVMF_VARS.fd', 'vars-template-pflash.raw'];
  let firmware = null;
  for (const r of roots) {
    const code = codes.map((c) => path.join(r, c)).find((p) => exists(p));
    const v = vars.map((c) => path.join(r, c)).find((p) => exists(p));
    if (code && v) { firmware = { code, vars: v }; break; }
  }
  return { system, firmware };
}

/** Accelerators to try, best first, for this platform. */
function preferredAccels(platform, compiled) {
  const has = (a) => !compiled || compiled.includes(a);
  if (platform === 'win32') return [has('whpx') ? 'whpx,kernel-irqchip=off' : null, 'tcg'].filter(Boolean);
  if (platform === 'darwin') return [has('hvf') ? 'hvf' : null, 'tcg'].filter(Boolean);
  return [has('kvm') ? 'kvm' : null, 'tcg'].filter(Boolean);
}

/** "Accelerators supported in QEMU binary:\ntcg\nwhpx" → ['tcg', 'whpx'] */
function parseAccelHelp(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[a-z]+$/.test(l));
}
function parseVersion(text) { const m = String(text || '').match(/version\s+(\d+\.\d+(?:\.\d+)?)/i); return m ? m[1] : null; }

/**
 * Starts QEMU for a moment with only the hardware accelerator (no fallback). Still running after 1.5 s → works.
 * Ends with an error ("No accelerator found", WHPX: "Unexpected VP exit"…) → not usable on this PC right now.
 */
function probeAccel(system, accel, { timeout = 6000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const child = spawn(system, ['-machine', 'q35', '-accel', accel, '-cpu', 'max', '-m', '64', '-nodefaults', '-display', 'none', '-S', '-monitor', 'none', '-serial', 'none'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (ok) => { if (settled) return; settled = true; clearTimeout(t1); clearTimeout(t2); try { child.kill(); } catch { /* egal */ } resolve({ ok, text: out.trim().split(/\r?\n/).slice(-2).join(' ') }); };
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { out += e.message; finish(false); });
    child.on('exit', () => finish(false));
    const t1 = setTimeout(() => finish(true), 1500);
    const t2 = setTimeout(() => finish(false), timeout);
  });
}

class QemuHost {
  constructor({ run = U.run, platform = process.platform, env = process.env, exists = fs.existsSync, probe = probeAccel } = {}) {
    this.runFn = run; this.platform = platform; this.env = env; this.exists = exists; this.probe = probe;
    this.cache = null;
  }

  /** Everything about QEMU on this PC (cached; `fresh` looks again, e.g. after installing). */
  async info({ fresh = false } = {}) {
    if (this.cache && !fresh) return this.cache;
    const loc = locate({ env: this.env, platform: this.platform, exists: this.exists });
    if (!loc) { this.cache = { installed: false, platform: this.platform }; return this.cache; }
    const [ver, help] = await Promise.all([this.runFn(loc.system, ['--version'], { timeout: 15000 }), this.runFn(loc.system, ['-accel', 'help'], { timeout: 15000 })]);
    const compiled = parseAccelHelp(help.stdout);
    const prefs = preferredAccels(this.platform, compiled);
    const hw = prefs.find((a) => !a.startsWith('tcg'));
    let accel = 'tcg'; let accelNote = null;
    if (hw) {
      const r = await this.probe(loc.system, hw);
      if (r.ok) accel = hw.split(',')[0]; else accelNote = r.text || null;
    }
    // ARM guests (#22): only emulated (TCG) – usable when the program answers and the firmware is there
    const arm = locateArm(loc.dir, { platform: this.platform, exists: this.exists });
    let aarch64 = null;
    if (arm) {
      const v = await this.runFn(arm.system, ['--version'], { timeout: 15000 }).catch(() => ({ code: 1, stdout: '' }));
      aarch64 = { system: arm.system, firmware: arm.firmware, version: parseVersion(v.stdout), ok: v.code === 0 && !!arm.firmware, accel: 'tcg' };
    }
    this.cache = {
      aarch64,
      installed: true, platform: this.platform, dir: loc.dir, system: loc.system, img: loc.img, version: parseVersion(ver.stdout),
      compiled, accel, accelArgs: accel === 'tcg' ? ['tcg'] : [prefs[0], 'tcg'], accelNote, firmware: findFirmware(loc.dir, { exists: this.exists }),
      // RAM snapshots (savevm) need dirty-page tracking – WHPX does not offer it, KVM/HVF/TCG do
      ramSnapshots: accel !== 'whpx',
    };
    return this.cache;
  }

  async img() {
    const i = await this.info();
    if (!i.installed || !i.img) throw U.fail(428, 'QEMU is not installed yet.', null, 'NO_QEMU');
    return i.img;
  }
  async imgRun(args, opts) {
    const r = await this.runFn(await this.img(), args, { timeout: 6 * 3600e3, ...opts });
    if (r.code !== 0) throw Object.assign(new Error((r.stderr || r.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ').replace(/^qemu-img(\.exe)?: /, '') || `qemu-img: exit code ${r.code}`), { status: 500 });
    return r;
  }

  /**
   * Encrypted disks (#15, qcow2 with LUKS): `key` is the path of a key file (written by the manager with restricted
   * rights and deleted right after). The key never appears on a command line – only the file name.
   */
  async create(file, bytes, { backing = null, backingFormat = 'qcow2', key = null } = {}) {
    const args = ['create', '-f', 'qcow2'];
    if (key) args.push(...keyObject(key, 'hwkey'));
    args.push('-o', `lazy_refcounts=on${key ? ',encrypt.format=luks,encrypt.key-secret=hwkey' : ''}`);
    if (backing) args.push('-b', backing, '-F', backingFormat);
    args.push(file);
    if (bytes) args.push(String(bytes));
    await this.imgRun(args);
  }
  /**
   * Converts any disk image QEMU can read (qcow2, vdi, vmdk, vhdx, vpc, raw) – with progress (0–100).
   * srcKey: the source is an encrypted qcow2; destKey: the result is encrypted (then never compressed – qcow2 cannot
   * do both).
   */
  async convert(src, dest, { to = 'qcow2', compress = false, onProgress, srcFormat = null, srcKey = null, destKey = null } = {}) {
    const args = ['convert', '-p'];
    if (srcKey) args.push(...keyObject(srcKey, 'hwsrc'));
    if (destKey) args.push(...keyObject(destKey, 'hwdst'));
    if (srcKey) args.push('--image-opts');
    else if (srcFormat) args.push('-f', srcFormat);
    args.push('-O', to);
    const enc = destKey && to === 'qcow2';
    if (compress && to === 'qcow2' && !enc) args.push('-c');
    if (enc) args.push('-o', 'encrypt.format=luks,encrypt.key-secret=hwdst');
    if (to === 'vmdk') args.push('-o', 'subformat=streamOptimized');
    if (to === 'vpc') args.push('-o', 'subformat=dynamic');
    args.push(srcKey ? imageOpts(src, 'hwsrc') : src, dest);
    const img = await this.img();
    await new Promise((resolve, reject) => {
      const child = spawn(img, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      const onData = (d) => { const m = String(d).match(/\((\d+(?:\.\d+)?)\/100%\)/g); if (m && onProgress) onProgress(Number(m[m.length - 1].match(/[\d.]+/)[0])); };
      child.stdout.on('data', onData);
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(Object.assign(new Error(err.trim().split(/\r?\n/).pop() || `qemu-img convert: exit code ${code}`), { status: 500 }))));
    });
  }
  async resize(file, bytes, { key = null } = {}) { await this.imgRun(key ? ['resize', ...keyObject(key, 'hwkey'), '--image-opts', imageOpts(file, 'hwkey'), String(bytes)] : ['resize', file, String(bytes)]); }
  /** Opens an encrypted disk with a key (lists its snapshots) – throws "Invalid password …" for a wrong key. */
  async checkKey(file, key) { await this.imgRun(['snapshot', ...keyObject(key, 'hwkey'), '--image-opts', '-l', imageOpts(file, 'hwkey')], { timeout: 120000 }); return true; }
  /** { format, virtualSize, actualSize, backing, snapshots: [{ name, date, vmStateSize }] } */
  async diskInfo(file) {
    const r = await this.imgRun(['info', '--output=json', '-U', file], { timeout: 60000 });
    return parseInfo(r.stdout);
  }
  async snapshot(file, action, name, { key = null } = {}) {
    const flag = { create: '-c', apply: '-a', delete: '-d' }[action];
    if (!flag) throw new Error('snapshot: unknown action');
    await this.imgRun(key ? ['snapshot', ...keyObject(key, 'hwkey'), '--image-opts', flag, name, imageOpts(file, 'hwkey')] : ['snapshot', flag, name, file], { timeout: 600000 });
  }
  async rebase(file, backing) { await this.imgRun(['rebase', '-f', 'qcow2', '-b', backing || '', '-F', 'qcow2', file]); }
}

/** qemu-img options for a key file and an encrypted qcow2 opened with it (paths with "," are doubled). */
function keyObject(keyFile, id) { return ['--object', `secret,id=${id},file=${U.qesc(keyFile)}`]; }
function imageOpts(file, id) { return `driver=qcow2,file.filename=${U.qesc(file)},encrypt.format=luks,encrypt.key-secret=${id}`; }

function parseInfo(json) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  return {
    ...(j.encrypted ? { encrypted: true } : {}),
    format: j.format, virtualSize: j['virtual-size'], actualSize: j['actual-size'] || null,
    backing: j['full-backing-filename'] || j['backing-filename'] || null,
    snapshots: (j.snapshots || []).map((s) => ({ name: s.name, date: (s['date-sec'] || 0) * 1000, vmStateSize: s['vm-state-size'] || 0 })),
  };
}

/** Disk format from the file name (for imports). */
function formatOf(file) {
  const ext = path.extname(String(file)).toLowerCase();
  return { '.qcow2': 'qcow2', '.qcow': 'qcow2', '.img': null, '.vdi': 'vdi', '.vmdk': 'vmdk', '.vhdx': 'vhdx', '.vhd': 'vpc', '.raw': 'raw', '.iso': 'raw' }[ext] ?? null;
}

/** How QEMU gets installed on this platform. */
function installPlan(platform = process.platform) {
  if (platform === 'win32') return { method: 'winget', id: 'SoftwareFreedomConservancy.QEMU', command: 'winget install --id SoftwareFreedomConservancy.QEMU -e', page: 'https://www.qemu.org/download/#windows' };
  if (platform === 'darwin') return { method: 'brew', command: 'brew install qemu', page: 'https://www.qemu.org/download/#macos' };
  return { method: 'package', command: 'sudo apt install qemu-system-x86 qemu-utils ovmf   # Fedora: sudo dnf install qemu-kvm qemu-img edk2-ovmf', page: 'https://www.qemu.org/download/#linux' };
}

module.exports = { QemuHost, keyObject, imageOpts, locate, locateArm, findFirmware, preferredAccels, parseAccelHelp, parseVersion, parseInfo, probeAccel, formatOf, installPlan, candidates, EXE, os };
