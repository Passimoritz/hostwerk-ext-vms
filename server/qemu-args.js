'use strict';
/*
 * QEMU command line for a VM – a pure function (tests/qemu-args.test.js), so every option can be checked without QEMU.
 *
 *   buildArgs(vm, { dir, accel, firmware, ports: { qmp, qga, serial, vnc }, platform, lanAllowed, loadvm,
 *                   nets: [{ local, remote, mac }] (internal networks), keyFile (encrypted disks) })
 *
 * Design:
 *  - q35 machine, accelerators in order of preference (QEMU falls back by itself: whpx → tcg, kvm → tcg, hvf → tcg).
 *  - Control through QMP on 127.0.0.1 only; guest agent and serial console as local TCP sockets.
 *  - Screen "web": no window, the framebuffer is read through QMP screendump; usb-tablet gives absolute mouse positions.
 *    Screen "window": QEMU's own window on this PC (sdl on Windows, gtk on Linux, cocoa on macOS).
 *  - Disks with explicit ids (disk0 …) so live snapshots (blockdev-snapshot-internal-sync) can name them.
 *  - Two CD drives on SATA: cd0 (installer ISO, can be changed while running) and seed (cloud-init data).
 */
const path = require('path');
const { qesc } = require('./util');

const SATA_PORTS = 6;

const firstAccel = (accel) => String((accel && accel[0]) || 'tcg').split(',')[0];

/** CPU vendor of this PC from the model name ("AMD Ryzen …", "Intel(R) Core …"). */
function hostVendor() {
  const m = String((require('os').cpus()[0] || {}).model || '');
  return /\bAMD\b/i.test(m) ? 'amd' : /intel/i.test(m) ? 'intel' : 'other';
}

/**
 * The CPU model: "host" only where the hypervisor passes the real CPU through. Windows under WHPX gets a named model of
 * the host's vendor – with "max" (and "host") Windows 11 shows a bluescreen PAGE_FAULT_IN_NONPAGED_AREA on its first
 * start from disk (seen on a Ryzen 7800X3D); EPYC-Rome/Genoa install through to the desktop. Linux runs fine with "max".
 */
function cpuFor(accel, vm, vendor = hostVendor()) {
  const first = firstAccel(accel);
  if (first === 'kvm' || first === 'hvf') return 'host';
  if (first === 'whpx' && vm && vm.osType === 'windows') return vendor === 'amd' ? 'EPYC-Rome' : vendor === 'intel' ? 'Skylake-Client' : 'max';
  return 'max';
}

/**
 * Under WHPX a reset of the VM (guest restart or system_reset) does not come back: Windows (WHPX's own interrupt
 * controller) is left paused for good, and Linux (kernel-irqchip=off) hangs as well – seen with a UEFI Linux guest on
 * QEMU/WHPX: `systemctl reboot`, then 0 % CPU, "Display output is not active", the firmware never starts again. So every
 * x86 VM under WHPX runs with -no-reboot: a restart ends QEMU and the runtime starts it again (a fresh start always
 * boots). KVM, HVF and TCG reset fine.
 */
function rebootByRestart(vm, accel) { return !!vm && vm.arch !== 'aarch64' && firstAccel(accel) === 'whpx'; }

/** Disk limits per disk (QEMU throttling): operations per second and bytes per second, both directions together. */
function throttle(l) {
  if (!l) return '';
  return `${l.iops ? `,throttling.iops-total=${l.iops}` : ''}${l.mbps ? `,throttling.bps-total=${l.mbps * 1048576}` : ''}`;
}

function displayFor(vm, platform) {
  if (vm.display !== 'window') return ['-display', 'none'];
  return ['-display', platform === 'win32' ? 'sdl' : platform === 'darwin' ? 'cocoa' : 'gtk'];
}

/**
 * 3D (#18): 'window' (virgl with OpenGL in QEMU's own window) or null. Not egl-headless for the Hostwerk screen: tried
 * on Windows with QEMU 11.1 – virgl renders (ANGLE/Direct3D on the Radeon), but every SET_SCANOUT fails ("ctrl 0x103,
 * error 0x1203"), so VNC and screendump show only "Display output is not active". 3D chosen with the Hostwerk screen
 * therefore runs as plain virtio.
 */
function glMode(vm) {
  return vm && vm.vga === 'virtio-gl' && vm.display === 'window' && vm.arch !== 'aarch64' ? 'window' : null;
}

function buildArgs(vm, opts) {
  if (vm && vm.arch === 'aarch64') return buildArmArgs(vm, opts);
  const { dir, accel = ['tcg'], firmware = null, ports = {}, platform = process.platform, lanAllowed = false, loadvm = null, nets = [], keyFile = null } = opts || {};
  if (!dir) throw new Error('buildArgs: dir is required');
  const a = [];
  const add = (...x) => a.push(...x);
  const file = (f) => qesc(path.isAbsolute(f) ? f : path.join(dir, f));

  add('-name', `guest=${qesc(vm.name)}`);
  add('-machine', `q35${vm.osType === 'windows' ? ',hpet=off' : ''}`);
  // Windows guests hang in the kernel with WHPX's userspace interrupt controller (kernel-irqchip=off) – seen with
  // Windows 11 26H2 on AMD/WHPX: the firmware logo stays, Setup never shows. Linux runs fine with it, so only Windows.
  for (const ac of accel) add('-accel', vm.osType === 'windows' ? ac.replace(/,kernel-irqchip=off\b/, '') : ac);
  add('-cpu', cpuFor(accel, vm, opts.hostVendor));
  if (rebootByRestart(vm, accel)) add('-no-reboot');
  add('-smp', String(vm.cpus));
  add('-m', String(vm.memoryMb));
  add('-nodefaults', '-no-user-config');
  if (vm.osType === 'windows') add('-rtc', 'base=localtime,driftfix=slew');
  else add('-rtc', 'base=utc');

  // Firmware: UEFI with its own variable store per VM (vars.fd in the VM folder)
  if (vm.firmware === 'uefi') {
    if (!firmware || !firmware.code) throw Object.assign(new Error('UEFI firmware (edk2) not found next to QEMU.'), { status: 500 });
    add('-drive', `if=pflash,format=raw,unit=0,readonly=on,file=${qesc(firmware.code)}`);
    add('-drive', `if=pflash,format=raw,unit=1,file=${file('vars.fd')}`);
  }

  // Disks and CD drives – boot order through bootindex
  const cdFirst = vm.boot === 'cdrom' && !!vm.cdrom;
  let boot = cdFirst ? 1 : 0;
  let sata = 0;
  // Encrypted disks (#15): the key comes from a file QEMU reads once at the start (deleted right after) – never on the
  // command line, which other programs on this PC could read
  const enc = (vm.disks || []).some((k) => k.encrypted);
  if (enc && !keyFile) throw Object.assign(new Error('The key of the encrypted disk is missing.'), { status: 409 });
  if (enc) add('-object', `secret,id=hwkey0,file=${qesc(keyFile)}`);
  for (const k of vm.disks || []) {
    const crypt = k.encrypted ? ',encrypt.format=luks,encrypt.key-secret=hwkey0' : '';
    add('-drive', `if=none,id=${k.id},file=${file(k.file)},format=${k.format || 'qcow2'}${crypt},cache=writeback,discard=unmap,detect-zeroes=unmap${throttle(vm.limits)}`);
    const bi = `bootindex=${boot++}`;
    if (k.bus === 'sata') add('-device', `ide-hd,drive=${k.id},bus=ide.${sata++},${bi}`);
    else if (k.bus === 'nvme') add('-device', `nvme,drive=${k.id},serial=hw-${k.id},${bi}`);
    else add('-device', `virtio-blk-pci,drive=${k.id},${bi}`);
  }
  if (sata > SATA_PORTS - (vm.drivers ? 3 : 2)) throw Object.assign(new Error('Too many SATA disks.'), { status: 400 });
  // cd0 exists even without an ISO – then a medium can be inserted later (blockdev-change-medium)
  add('-drive', `if=none,id=cd0,media=cdrom,readonly=on${vm.cdrom ? `,file=${qesc(vm.cdrom)}` : ''}`);
  add('-device', `ide-cd,id=cdrom0,drive=cd0,bus=ide.${sata++}${cdFirst ? ',bootindex=0' : vm.cdrom ? `,bootindex=${boot++}` : ''}`);
  if (vm.seed) {
    // cloud-init seed: Linux cloud kernels (Debian "cloud", Ubuntu "kvm") often lack AHCI/SATA-CD drivers but always have
    // virtio – so for Linux it is a read-only virtio disk (cloud-init finds it by the label "cidata"), else a SATA CD.
    if (vm.osType === 'linux') {
      add('-drive', `if=none,id=seed,format=raw,readonly=on,file=${file(vm.seed)}`);
      add('-device', 'virtio-blk-pci,drive=seed');
    } else {
      add('-drive', `if=none,id=seed,media=cdrom,readonly=on,file=${file(vm.seed)}`);
      add('-device', `ide-cd,id=seedcd,drive=seed,bus=ide.${sata++}`);
    }
  }
  // Windows: virtio-win drivers and guest agent as a further CD (Setup loads storage/network drivers from it)
  if (vm.drivers) {
    add('-drive', `if=none,id=drivers,media=cdrom,readonly=on,file=${qesc(vm.drivers)}`);
    add('-device', `ide-cd,id=driverscd,drive=drivers,bus=ide.${sata++}`);
  }

  // Network: user mode (NAT, no admin rights) with port forwarding – or a bridge through a TAP adapter (#14)
  const model = { virtio: 'virtio-net-pci', e1000e: 'e1000e', rtl8139: 'rtl8139' }[vm.net && vm.net.model] || 'virtio-net-pci';
  if (vm.net && vm.net.mode === 'bridge') {
    if (!vm.net.tap) throw Object.assign(new Error('Network bridge without a TAP adapter.'), { status: 400 });
    add('-netdev', `tap,id=n0,ifname=${qesc(vm.net.tap)}`);
    add('-device', `${model},netdev=n0,mac=${vm.net.mac}`);
  } else if (vm.net && vm.net.mode !== 'none') {
    const fw = (vm.net.forwards || []).map((f) => `,hostfwd=${f.proto}:${f.bind === 'lan' && lanAllowed ? '0.0.0.0' : '127.0.0.1'}:${f.host}-:${f.guest}`).join('');
    add('-netdev', `user,id=n0${fw}`);
    add('-device', `${model},netdev=n0,mac=${vm.net.mac}`);
  }
  // Internal networks (#7): one more NIC per network, frames as UDP datagrams to Hostwerk's switch on 127.0.0.1
  for (const [i, n] of (nets || []).entries()) {
    add('-netdev', `dgram,id=in${i},local.type=inet,local.host=127.0.0.1,local.port=${Number(n.local)},remote.type=inet,remote.host=127.0.0.1,remote.port=${Number(n.remote)}`);
    add('-device', `${model},netdev=in${i},mac=${n.mac}`);
  }

  // Screen, mouse (absolute), entropy, guest agent, serial console, control
  // 3D (#18): virgl renders on this PC's graphics card, shown in QEMU's own window (sdl/gtk/cocoa with gl=on) – no
  // VNC and no screendump next to that OpenGL context. Verified on Windows (QEMU 11.1, WHPX): the guest's GL renderer is
  // "virgl (AMD Radeon RX 9070 XT)", glmark2 ≈ 96 fps. In the Hostwerk screen 3D falls back to plain virtio (see glMode).
  const gl = glMode(vm);
  if (gl) add('-device', 'virtio-vga-gl'); else add('-vga', vm.vga === 'virtio' || vm.vga === 'virtio-gl' ? 'virtio' : 'std');
  const disp = displayFor(vm, platform);
  if (gl) disp[1] = `${disp[1]},gl=on`;
  add(...disp);
  // Sound (#19): plays on this PC's speakers – independent of where the screen is shown
  if (vm.sound) {
    const drv = platform === 'win32' ? 'dsound' : platform === 'darwin' ? 'coreaudio' : 'pa';
    add('-audiodev', `${drv},id=snd0`, '-device', 'ich9-intel-hda', '-device', 'hda-output,audiodev=snd0');
  }
  add('-device', 'qemu-xhci,id=xhci', '-device', 'usb-tablet,id=tablet0,bus=xhci.0'); // mouse events go to "tablet0" by id
  add('-device', 'virtio-rng-pci');
  if (ports.qga) {
    add('-chardev', `socket,id=qga0,host=127.0.0.1,port=${ports.qga},server=on,wait=off`);
    add('-device', 'virtio-serial-pci,id=vser0', '-device', 'virtserialport,bus=vser0.0,chardev=qga0,name=org.qemu.guest_agent.0');
    // Clipboard (#6): QEMU's built-in vdagent talks to spice-vdagent in the guest; QEMU's VNC (noVNC) carries the text.
    // mouse=off – the USB tablet stays in charge of the pointer
    add('-chardev', 'qemu-vdagent,id=vdagent,clipboard=on,mouse=off', '-device', 'virtserialport,bus=vser0.0,chardev=vdagent,name=com.redhat.spice.0');
  }
  if (ports.serial) {
    add('-chardev', `socket,id=ser0,host=127.0.0.1,port=${ports.serial},server=on,wait=off,logfile=${file('serial.log')},logappend=on`);
    add('-serial', 'chardev:ser0');
  }
  if (ports.vnc && !gl) add(...require('./vnc').vncArgs(ports.vnc)); // 127.0.0.1 only, reached through Hostwerk's login (/ws/vms/<id>/vnc)
  if (!ports.qmp) throw new Error('buildArgs: ports.qmp is required');
  add('-qmp', `tcp:127.0.0.1:${ports.qmp},server=on,wait=off`);
  add('-pidfile', file('qemu.pid'));
  if (loadvm) add('-loadvm', loadvm);
  return a;
}

/**
 * ARM VMs (#22) with qemu-system-aarch64: machine "virt", always TCG (no hardware acceleration for ARM guests on an x86
 * PC – slow), UEFI (edk2-aarch64 + own variable store), virtio everywhere. "virt" has no IDE/SATA and no PS/2: CDs sit
 * on virtio-scsi, keyboard and mouse are USB devices on xhci, the screen is virtio-gpu (edk2 and Linux both drive it).
 */
function buildArmArgs(vm, opts) {
  const { dir, firmware = null, ports = {}, platform = process.platform, lanAllowed = false, loadvm = null, nets = [], keyFile = null } = opts || {};
  if (!dir) throw new Error('buildArgs: dir is required');
  if (!firmware || !firmware.code) throw Object.assign(new Error('UEFI firmware for ARM (edk2-aarch64) not found next to QEMU.'), { status: 500 });
  const a = [];
  const add = (...x) => a.push(...x);
  const file = (f) => qesc(path.isAbsolute(f) ? f : path.join(dir, f));
  add('-name', `guest=${qesc(vm.name)}`);
  add('-machine', 'virt,gic-version=max');
  add('-accel', 'tcg');
  add('-cpu', 'max,pauth-impdef=on'); // all ARMv8/9 features; the cheap pointer authentication keeps TCG faster
  add('-smp', String(vm.cpus));
  add('-m', String(vm.memoryMb));
  add('-nodefaults', '-no-user-config');
  add('-rtc', 'base=utc');
  add('-drive', `if=pflash,format=raw,unit=0,readonly=on,file=${qesc(firmware.code)}`);
  add('-drive', `if=pflash,format=raw,unit=1,file=${file('vars.fd')}`);
  const enc = (vm.disks || []).some((k) => k.encrypted);
  if (enc && !keyFile) throw Object.assign(new Error('The key of the encrypted disk is missing.'), { status: 409 });
  if (enc) add('-object', `secret,id=hwkey0,file=${qesc(keyFile)}`);
  const cdFirst = vm.boot === 'cdrom' && !!vm.cdrom;
  let boot = cdFirst ? 1 : 0;
  for (const k of vm.disks || []) {
    if (k.bus === 'sata') throw Object.assign(new Error('ARM VMs have no SATA controller – use virtio or NVMe disks.'), { status: 400 });
    const crypt = k.encrypted ? ',encrypt.format=luks,encrypt.key-secret=hwkey0' : '';
    add('-drive', `if=none,id=${k.id},file=${file(k.file)},format=${k.format || 'qcow2'}${crypt},cache=writeback,discard=unmap,detect-zeroes=unmap${throttle(vm.limits)}`);
    const bi = `bootindex=${boot++}`;
    if (k.bus === 'nvme') add('-device', `nvme,drive=${k.id},serial=hw-${k.id},${bi}`);
    else add('-device', `virtio-blk-pci,drive=${k.id},${bi}`);
  }
  // CD drive on virtio-scsi (id cdrom0 like on x86, so changing the ISO while running works the same way)
  add('-device', 'virtio-scsi-pci,id=scsi0');
  add('-drive', `if=none,id=cd0,media=cdrom,readonly=on${vm.cdrom ? `,file=${qesc(vm.cdrom)}` : ''}`);
  add('-device', `scsi-cd,id=cdrom0,drive=cd0,bus=scsi0.0${cdFirst ? ',bootindex=0' : vm.cdrom ? `,bootindex=${boot++}` : ''}`);
  if (vm.seed) {
    add('-drive', `if=none,id=seed,format=raw,readonly=on,file=${file(vm.seed)}`);
    add('-device', vm.osType === 'linux' ? 'virtio-blk-pci,drive=seed' : 'scsi-cd,id=seedcd,drive=seed,bus=scsi0.0');
  }
  const model = { virtio: 'virtio-net-pci', e1000e: 'e1000e', rtl8139: 'rtl8139' }[vm.net && vm.net.model] || 'virtio-net-pci';
  if (vm.net && vm.net.mode === 'bridge') {
    if (!vm.net.tap) throw Object.assign(new Error('Network bridge without a TAP adapter.'), { status: 400 });
    add('-netdev', `tap,id=n0,ifname=${qesc(vm.net.tap)}`, '-device', `${model},netdev=n0,mac=${vm.net.mac}`);
  } else if (vm.net && vm.net.mode !== 'none') {
    const fw = (vm.net.forwards || []).map((f) => `,hostfwd=${f.proto}:${f.bind === 'lan' && lanAllowed ? '0.0.0.0' : '127.0.0.1'}:${f.host}-:${f.guest}`).join('');
    add('-netdev', `user,id=n0${fw}`, '-device', `${model},netdev=n0,mac=${vm.net.mac}`);
  }
  for (const [i, n] of (nets || []).entries()) {
    add('-netdev', `dgram,id=in${i},local.type=inet,local.host=127.0.0.1,local.port=${Number(n.local)},remote.type=inet,remote.host=127.0.0.1,remote.port=${Number(n.remote)}`);
    add('-device', `${model},netdev=in${i},mac=${n.mac}`);
  }
  add('-device', 'virtio-gpu-pci');
  add(...displayFor(vm, platform));
  if (vm.sound) {
    const drv = platform === 'win32' ? 'dsound' : platform === 'darwin' ? 'coreaudio' : 'pa';
    add('-audiodev', `${drv},id=snd0`, '-device', 'ich9-intel-hda', '-device', 'hda-output,audiodev=snd0');
  }
  add('-device', 'qemu-xhci,id=xhci', '-device', 'usb-tablet,id=tablet0,bus=xhci.0', '-device', 'usb-kbd,id=kbd0,bus=xhci.0');
  add('-device', 'virtio-rng-pci');
  if (ports.qga) {
    add('-chardev', `socket,id=qga0,host=127.0.0.1,port=${ports.qga},server=on,wait=off`);
    add('-device', 'virtio-serial-pci,id=vser0', '-device', 'virtserialport,bus=vser0.0,chardev=qga0,name=org.qemu.guest_agent.0');
    add('-chardev', 'qemu-vdagent,id=vdagent,clipboard=on,mouse=off', '-device', 'virtserialport,bus=vser0.0,chardev=vdagent,name=com.redhat.spice.0');
  }
  if (ports.serial) {
    add('-chardev', `socket,id=ser0,host=127.0.0.1,port=${ports.serial},server=on,wait=off,logfile=${file('serial.log')},logappend=on`);
    add('-serial', 'chardev:ser0'); // the PL011 UART of "virt" – UEFI and Linux print here
  }
  if (ports.vnc) add(...require('./vnc').vncArgs(ports.vnc));
  if (!ports.qmp) throw new Error('buildArgs: ports.qmp is required');
  add('-qmp', `tcp:127.0.0.1:${ports.qmp},server=on,wait=off`);
  add('-pidfile', file('qemu.pid'));
  if (loadvm) add('-loadvm', loadvm);
  return a;
}

/** The forwarding rule in QEMU's hostfwd_add / hostfwd_remove form (live changes while running). */
function hostfwdRule(f, lanAllowed) {
  return `${f.proto}:${f.bind === 'lan' && lanAllowed ? '0.0.0.0' : '127.0.0.1'}:${f.host}-:${f.guest}`;
}
function hostfwdKey(f, lanAllowed) {
  return `${f.proto}:${f.bind === 'lan' && lanAllowed ? '0.0.0.0' : '127.0.0.1'}:${f.host}`;
}

module.exports = { buildArgs, buildArmArgs, cpuFor, rebootByRestart, glMode, hostfwdRule, hostfwdKey, throttle };
