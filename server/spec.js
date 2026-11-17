'use strict';
/*
 * What a VM is (vm.json in its folder) and how input from the interface is checked. Everything here is pure – no files,
 * no programs – so it is tested directly (tests/spec.test.js).
 *
 *   { id, name, engine: 'qemu', osType: 'linux'|'windows'|'other', osLabel, cpus, memoryMb, firmware: 'bios'|'uefi',
 *     disks: [{ id: 'disk0', file: 'disk0.qcow2', bus: 'virtio'|'sata'|'nvme', format: 'qcow2'|'raw'|… }],
 *     cdrom: '<path to an ISO>'|null, seed: 'seed.iso'|null,
 *     net: { mode: 'user'|'none'|'bridge', tap, model: 'virtio'|'e1000e'|'rtl8139', mac, forwards: [{ id, proto, host, guest, bind, label }] },
 *     nets: [{ net, mac, ip }] (internal networks), shares: [{ id, name, path, readOnly, auto, token }] (shared folders),
 *     encryption: { format: 'luks', key: 'enc:…' } | null (disks with `encrypted: true`),
 *     display: 'web'|'window', vga: 'std'|'virtio', boot: 'disk'|'cdrom', autostart, autoRestart, onExit: 'shutdown'|'kill',
 *     arch: 'aarch64' (ARM VMs only, #22 – missing = x86_64), app: { id } (app template, #9),
 *     template, linkedTo, ssh: { user, forward, key }, notes, createdAt, snapshots: { <name>: { label, note, createdAt, parent, ram } },
 *     currentSnapshot }
 */
const { fail, macFor, clamp } = require('./util');

const OS_TYPES = ['linux', 'windows', 'other'];
const BUSES = ['virtio', 'sata', 'nvme'];
const NIC_MODELS = ['virtio', 'e1000e', 'rtl8139'];
const NET_MODES = ['user', 'none', 'bridge'];
const DISK_FORMATS = ['qcow2', 'raw', 'vdi', 'vmdk', 'vhdx', 'vpc'];
const NAME_RE = /^[^\u0000-\u001f<>"|?*\\/]{1,60}$/;
const SNAP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const MAC_RE = /^52:54:00(:[0-9a-f]{2}){3}$/;

const ARCHES = ['x86_64', 'aarch64'];

/**
 * Good defaults per kind of guest – Windows has no virtio drivers on its installer, so SATA and e1000e. ARM (#22): the
 * "virt" machine has no SATA/IDE and boots with UEFI only – virtio everywhere.
 */
function defaultsFor(osType, arch = 'x86_64') {
  if (arch === 'aarch64') return { cpus: 2, memoryMb: 2048, firmware: 'uefi', bus: 'virtio', model: 'virtio', vga: 'virtio', diskGb: osType === 'other' ? 10 : 20 };
  if (osType === 'windows') return { cpus: 4, memoryMb: 8192, firmware: 'uefi', bus: 'sata', model: 'e1000e', vga: 'std', diskGb: 80 };
  if (osType === 'other') return { cpus: 2, memoryMb: 2048, firmware: 'bios', bus: 'sata', model: 'e1000e', vga: 'std', diskGb: 20 };
  return { cpus: 2, memoryMb: 2048, firmware: 'bios', bus: 'virtio', model: 'virtio', vga: 'std', diskGb: 20 };
}

const int = (v, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : d; };
const pick = (v, list, d) => (list.includes(v) ? v : d);

/** One port forwarding rule (host port on this PC → port in the VM). */
function cleanForward(f, { lanAllowed = false } = {}) {
  const proto = pick(String(f && f.proto || 'tcp').toLowerCase(), ['tcp', 'udp'], null);
  if (!proto) throw fail(400, 'Protocol must be TCP or UDP.');
  const host = int(f.host, NaN);
  const guest = int(f.guest, NaN);
  if (!(host >= 1024 && host <= 65535)) throw fail(400, 'Port on this PC: between 1024 and 65535.');
  if (!(guest >= 1 && guest <= 65535)) throw fail(400, 'Port in the VM: between 1 and 65535.');
  const bind = f.bind === 'lan' ? 'lan' : 'local';
  if (bind === 'lan' && !lanAllowed) throw fail(403, 'Forwarding into the home network is switched off in the settings of this extension.');
  const label = String(f.label || '').replace(/[\u0000-\u001f]/g, '').slice(0, 40);
  const id = /^[a-z0-9-]{1,24}$/.test(String(f.id || '')) ? String(f.id) : `${proto}-${host}`;
  return { id, proto, host, guest, bind, label };
}
function checkForwards(list, opts) {
  const out = (Array.isArray(list) ? list : []).slice(0, 32).map((f) => cleanForward(f, opts));
  const seen = new Set();
  for (const f of out) {
    const k = `${f.proto}:${f.host}`;
    if (seen.has(k)) throw fail(409, 'Port {port} ({proto}) is forwarded twice.', { port: f.host, proto: f.proto.toUpperCase() });
    seen.add(k);
  }
  return out;
}

/**
 * Checks and completes a VM description. `prev` = the stored VM (for updates – fields that are not sent stay),
 * `host` = { cpus, memoryMb } of this PC (limits), `lanAllowed` from the settings.
 */
function cleanVm(input, { prev = null, host = { cpus: 8, memoryMb: 16384 }, lanAllowed = false } = {}) {
  const b = input || {};
  const base = prev || {};
  const osType = pick(b.osType ?? base.osType, OS_TYPES, 'linux');
  const arch = pick(b.arch ?? base.arch, ARCHES, 'x86_64');
  if (arch === 'aarch64' && osType === 'windows') throw fail(400, 'Windows on ARM is not supported – choose Linux or Other.');
  const d = defaultsFor(osType, arch);
  const name = String(b.name ?? base.name ?? '').trim();
  if (!NAME_RE.test(name)) throw fail(400, 'Name: 1–60 characters, without < > " | ? * \\ /.');
  const maxCpus = Math.max(1, Math.min(64, host.cpus || 1));
  const cpus = int(b.cpus ?? base.cpus, d.cpus);
  if (cpus < 1 || cpus > maxCpus) throw fail(400, 'CPU cores: between 1 and {max} (this PC has {max}).', { max: maxCpus });
  const maxMem = Math.max(256, (host.memoryMb || 2048) - 512);
  const memoryMb = int(b.memoryMb ?? base.memoryMb, d.memoryMb);
  if (memoryMb < 128 || memoryMb > maxMem) throw fail(400, 'Memory: between 128 MB and {max} MB (this PC keeps 512 MB for itself).', { max: maxMem });
  const net0 = { ...(base.net || {}), ...(b.net || {}) };
  const vm = {
    ...base,
    id: base.id || b.id,
    name,
    engine: 'qemu',
    osType,
    osLabel: String(b.osLabel ?? base.osLabel ?? '').slice(0, 60),
    cpus,
    memoryMb,
    firmware: pick(b.firmware ?? base.firmware, ['bios', 'uefi'], d.firmware),
    vga: pick(b.vga ?? base.vga, ['std', 'virtio', 'virtio-gl'], d.vga), // virtio-gl = 3D (virgl), only in an own window
    sound: !!(b.sound ?? base.sound),
    display: pick(b.display ?? base.display, ['web', 'window'], 'web'),
    boot: pick(b.boot ?? base.boot, ['disk', 'cdrom'], 'disk'),
    autostart: !!(b.autostart ?? base.autostart),
    autoRestart: !!(b.autoRestart ?? base.autoRestart),
    onExit: pick(b.onExit ?? base.onExit, ['shutdown', 'kill'], 'shutdown'),
    template: !!(b.template ?? base.template),
    keyboard: pick(b.keyboard ?? base.keyboard, ['us', 'de'], 'us'),
    autoSnap: cleanAutoSnap(b.autoSnap !== undefined ? b.autoSnap : base.autoSnap, base.autoSnap),
    limits: cleanLimits(b.limits !== undefined ? b.limits : base.limits, host),
    notes: String(b.notes ?? base.notes ?? '').slice(0, 4000),
    net: {
      mode: pick(net0.mode, NET_MODES, 'user'),
      model: pick(net0.model, NIC_MODELS, d.model),
      mac: MAC_RE.test(String(net0.mac || '')) ? net0.mac : macFor(base.id || b.id || name),
      forwards: checkForwards(net0.forwards, { lanAllowed }),
      // Network bridge (#14): the TAP adapter on this PC (only with mode "bridge")
      ...(net0.mode === 'bridge' ? { tap: require('./tap').checkTapName(net0.tap) } : {}),
    },
    // Internal networks (#7): up to two extra NICs, each in one network of this PC
    nets: cleanNets(b.nets !== undefined ? b.nets : base.nets, base.id || b.id || name),
    // Shared folders PC → VM (#13)
    shares: cleanShares(b.shares !== undefined ? b.shares : base.shares),
    // Encrypted disks (#15): { format: 'luks', key: 'enc:…' (sealed by Hostwerk) } – never from the interface
    encryption: base.encryption || null,
    disks: (Array.isArray(b.disks) ? b.disks : base.disks || []).map(cleanDisk),
    cdrom: b.cdrom !== undefined ? (b.cdrom ? String(b.cdrom) : null) : base.cdrom || null,
    seed: base.seed || null,
    drivers: b.drivers !== undefined ? (b.drivers ? String(b.drivers) : null) : base.drivers || null, // virtio-win ISO (third CD)
    install: base.install || null, // { state: 'running'|'done', startedAt, doneAt } while Windows installs itself
    snapshots: base.snapshots || {},
    currentSnapshot: base.currentSnapshot || null,
    createdAt: base.createdAt || Date.now(),
  };
  // ARM (#22): field only on ARM VMs (x86 descriptions stay as they were); UEFI, no SATA, virtio graphics
  if (arch === 'aarch64') {
    vm.arch = 'aarch64';
    vm.firmware = 'uefi';
    if (vm.vga !== 'virtio') vm.vga = 'virtio';
    if (vm.disks.some((k) => k.bus === 'sata')) throw fail(400, 'ARM VMs have no SATA controller – use virtio or NVMe disks.');
  } else delete vm.arch;
  if (vm.disks.length > 8) throw fail(400, 'At most 8 disks.');
  const ids = new Set();
  for (const k of vm.disks) { if (ids.has(k.id)) throw fail(400, 'Disk {id} exists twice.', { id: k.id }); ids.add(k.id); }
  const cds = vm.drivers ? 3 : 2; // CD drive + seed (+ driver CD for Windows)
  if (vm.disks.filter((k) => k.bus === 'sata').length + cds > 6) throw fail(400, 'At most {n} SATA disks (the controller has 6 ports, {cds} are for CD drives).', { n: 6 - cds, cds });
  return vm;
}

/** Automatic snapshots: how often and how many to keep. `last` (time of the last one) is kept from the stored VM. */
const SNAP_EVERY = { off: 0, hourly: 3600e3, '6h': 6 * 3600e3, daily: 24 * 3600e3, weekly: 7 * 24 * 3600e3 };
function cleanAutoSnap(a, prev) {
  const x = a || {};
  const every = Object.prototype.hasOwnProperty.call(SNAP_EVERY, x.every) ? x.every : 'off';
  const keep = Math.round(Number(x.keep ?? 24));
  if (every !== 'off' && !(keep >= 1 && keep <= 100)) throw fail(400, 'Keep between 1 and 100 automatic snapshots.');
  return { every, keep: every === 'off' ? Math.max(1, Math.min(100, keep || 24)) : keep, beforeUpdate: x.beforeUpdate !== false, last: (prev && prev.last) || x.last || null };
}
/**
 * Limits so this PC stays responsive: disk operations per second and MB/s (0 = no limit), share of the PC's cores the
 * VM may use (10–100 %), process priority.
 */
function cleanLimits(l, host = {}) {
  const x = l || {};
  const iops = Math.round(Number(x.iops) || 0);
  const mbps = Math.round(Number(x.mbps) || 0);
  const cpuShare = Math.round(Number(x.cpuShare ?? 100));
  if (iops && (iops < 50 || iops > 1000000)) throw fail(400, 'Disk operations: between 50 and 1,000,000 per second (0 = no limit).');
  if (mbps && (mbps < 1 || mbps > 100000)) throw fail(400, 'Disk speed: between 1 and 100,000 MB/s (0 = no limit).');
  if (!(cpuShare >= 10 && cpuShare <= 100)) throw fail(400, 'CPU share: between 10 and 100 %.');
  return { iops, mbps, cpuShare, priority: pick(x.priority, ['low', 'normal', 'high'], 'normal') };
}
/** Host cores a VM may run on for a share: the first ceil(share × cores), at least 1 → affinity bit mask. */
function affinityMask(share, cores) {
  const n = Math.max(1, Math.min(cores, Math.ceil((share / 100) * cores)));
  return n >= cores ? null : (2n ** BigInt(n) - 1n);
}

function cleanDisk(k, i) {
  const id = /^disk[0-9]{1,2}$/.test(String(k && k.id)) ? k.id : `disk${i}`;
  const file = String(k && k.file || `${id}.qcow2`);
  // Only a plain file name inside the VM folder – never a path elsewhere
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(file) || file.includes('..')) throw fail(400, 'Invalid disk file name.');
  const format = pick(k.format, DISK_FORMATS, 'qcow2');
  return { id, file, bus: pick(k.bus, BUSES, 'virtio'), format, ...(k.encrypted && format === 'qcow2' ? { encrypted: true } : {}) };
}

/* ---------------- Internal networks (#7) ---------------- */
const NET_ID_RE = /^[a-z][a-z0-9-]{1,23}$/;
const MAX_NETS = 2;
/** "10.10.1.5/24" → checked and normalised; no network/broadcast address, prefix 8–30. */
function checkCidr(v) {
  const m = String(v || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
  const bad = () => fail(400, 'IP address: like 10.10.1.5/24.');
  if (!m) throw bad();
  const o = m.slice(1, 5).map(Number);
  const prefix = m[5] ? Number(m[5]) : 24;
  if (o.some((x) => x > 255) || prefix < 8 || prefix > 30 || o[0] === 0 || o[0] === 127 || o[0] >= 224) throw bad();
  const ip = ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
  const host = ip % 2 ** (32 - prefix);
  if (host === 0 || host === 2 ** (32 - prefix) - 1) throw bad();
  return `${o.join('.')}/${prefix}`;
}
/** Memberships of a VM in internal networks: [{ net, mac, ip }] – the MAC is fixed per VM and network. */
function cleanNets(list, vmId) {
  const out = [];
  for (const x of (Array.isArray(list) ? list : []).slice(0, 8)) {
    const net = String(x && x.net || '');
    if (!NET_ID_RE.test(net)) throw fail(400, 'Unknown internal network.');
    if (out.some((y) => y.net === net)) throw fail(400, 'The VM is in network “{net}” twice.', { net });
    out.push({ net, mac: MAC_RE.test(String(x.mac || '')) ? x.mac : macFor(`${vmId}/${net}`), ip: x.ip ? checkCidr(x.ip) : null });
  }
  if (out.length > MAX_NETS) throw fail(400, 'A VM can be in at most {n} internal networks.', { n: MAX_NETS });
  return out;
}

/* ---------------- Shared folders (#13) ---------------- */
const SHARE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const MAX_SHARES = 4;
function cleanShares(list) {
  const out = [];
  for (const x of (Array.isArray(list) ? list : []).slice(0, 16)) {
    const name = String(x && x.name || '').trim();
    if (!SHARE_NAME_RE.test(name)) throw fail(400, 'Share name: letters, digits, space, ".", "_" or "-", up to 40 characters.');
    const p = String(x.path || '').trim();
    if (!p || p.length > 400 || /[\u0000-\u001f]/.test(p) || !require('path').isAbsolute(p)) throw fail(400, 'Choose a folder on this PC.');
    if (out.some((y) => y.name.toLowerCase() === name.toLowerCase())) throw fail(400, 'A share named “{name}” exists already.', { name });
    const id = /^share[0-9]{1,2}$/.test(String(x.id || '')) && !out.some((y) => y.id === x.id) ? x.id : null;
    out.push({ id, name, path: p, readOnly: x.readOnly !== false, auto: x.auto !== false, token: /^[a-f0-9]{32}$/.test(String(x.token || '')) ? x.token : require('./webdav').newToken() });
  }
  if (out.length > MAX_SHARES) throw fail(400, 'At most {n} shared folders per VM.', { n: MAX_SHARES });
  for (const s of out) if (!s.id) s.id = `share${[...Array(20).keys()].find((n) => !out.some((y) => y.id === `share${n}`))}`;
  return out;
}

function checkSnapName(name) {
  const n = String(name || '').trim();
  if (!SNAP_RE.test(n)) throw fail(400, 'Snapshot name: letters, digits, "." "_" "-", up to 48 characters.');
  return n;
}

/** Disk size in GB → bytes (1 – 16384 GB). */
function diskBytes(gb) {
  const n = Number(gb);
  if (!(n >= 1 && n <= 16384)) throw fail(400, 'Disk size: between 1 and 16384 GB.');
  return Math.round(n) * 1024 * 1024 * 1024;
}

/** Plain view for the interface (no internal fields). */
function publicVm(vm) {
  const { snapshots, ...rest } = vm;
  return { ...rest, snapshots: Object.entries(snapshots || {}).map(([name, s]) => ({ name, ...s })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)) };
}

/** RAM a set of running VMs needs, compared with this PC – for the warning before a start. */
function memoryCheck(runningMb, wantMb, hostMb) {
  const total = runningMb + wantMb;
  const ratio = hostMb ? total / hostMb : 1;
  return { total, ratio: Math.round(ratio * 100) / 100, level: ratio > 0.9 ? 'err' : ratio > 0.75 ? 'warn' : 'ok' };
}

module.exports = { ARCHES, cleanNets, cleanShares, checkCidr, NET_ID_RE, NET_MODES, MAX_NETS, MAX_SHARES, cleanAutoSnap, cleanLimits, affinityMask, SNAP_EVERY, cleanVm, cleanDisk, cleanForward, checkForwards, checkSnapName, diskBytes, defaultsFor, publicVm, memoryCheck, OS_TYPES, BUSES, NIC_MODELS, DISK_FORMATS, clamp };
