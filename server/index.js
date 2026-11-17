'use strict';
/*
 * Virtual machines (QEMU + VirtualBox) as a native Hostwerk extension.
 * Provides the service "vms" for other extensions: list(), get(id), start(id), stop(id), detail(id).
 */
const path = require('path');
const { VmManager } = require('./manager');
const { QemuHost } = require('./qemu-host');
const { VBox } = require('./vbox');
const { HyperV } = require('./hyperv');
const { routes } = require('./routes');
const { vmKind } = require('./kind');
const U = require('./util');

exports.activate = (host) => {
  U.setT((s, v) => host.t(s, v));
  const { ManagedProcess, registry } = host.core('proc');
  const { runJob } = host.core('jobs');
  const dl = host.core('download');
  const root = process.env.HW_VMS_DIR || path.join(host.ctx.paths.base, 'vms');
  // Keys of encrypted disks (#15) are sealed with Hostwerk's secret store – without it encryption is not offered
  let secrets = null;
  try { const s = host.core('secrets'); if (s && typeof s.seal === 'function' && typeof s.open === 'function') secrets = s; } catch { /* older Hostwerk */ }
  // Ask AI about the screen (#20): Hostwerk's short AI answers (text only) – stable service since SDK 3.3, "use:ai"
  const ai = host.ai && host.ai.quick && (typeof host.supports !== 'function' || host.supports('ai.quick')) ? host.ai.quick : null;
  const m = new VmManager({
    root, qhost: new QemuHost(), vbox: new VBox(), hyperv: new HyperV(), ai, Proc: ManagedProcess, registry, runJob, secrets,
    downloadFile: (url, dest, o) => dl.downloadFile(url, dest, o), fetchText: (url) => dl.fetchText(url, { timeout: 30000 }),
    broadcast: (msg) => host.broadcast(msg),
  });
  // Fluid screen (#1): WebSocket /ws/vms/<id>/vnc → QEMU's VNC on 127.0.0.1 – Hostwerk checks the login before
  let vncProxy = null;
  try {
    vncProxy = require('./vnc').attachVncProxy({
      host,
      resolvePort: (id) => { const r = m.runtimes.get(id); return r && r.isRunning() && r.ports && r.ports.vnc ? r.ports.vnc : null; },
      maxPerVm: 4,
    });
  } catch (e) { console.warn('[vms] VNC bridge not available:', e.message); }
  host.provide('vms', { list: () => m.list(), get: (id) => m.view(m.get(id)), detail: (id) => m.detail(id), start: (id) => m.start(id), stop: (id) => m.stop(id) });
  routes(host.router, m);
  if (typeof host.serviceKind === 'function') host.serviceKind(vmKind(m));
  // AI tools (#20): list, screen as text, start/stop, create from an app template or a VM template – changing ones ask first
  if (typeof host.aiExtend === 'function') host.aiExtend(require('./ai').vmsAi(m));
  if (typeof host.contribute === 'function') {
    const name = (id) => { try { return m.get(id).name; } catch { return id; } };
    const ACT = { start: 'gestartet', stop: 'heruntergefahren', poweroff: 'ausgeschaltet', restart: 'neu gestartet', pause: 'angehalten', resume: 'fortgesetzt', snapshots: 'Snapshot angelegt', backups: 'Sicherung erstellt', clone: 'kopiert', export: 'Platte exportiert' };
    host.contribute('audit', { routes: [[/^\/vms\/([a-z][a-z0-9-]+)\/(start|stop|poweroff|restart|pause|resume|snapshots|backups|clone|export)$/, (mm) => ({ kind: 'VM', target: name(mm[1]), action: ACT[mm[2]], undo: mm[2] === 'start' ? { method: 'POST', path: `/vms/${mm[1]}/stop`, label: 'wieder herunterfahren' } : mm[2] === 'stop' ? { method: 'POST', path: `/vms/${mm[1]}/start`, label: 'wieder starten' } : null })]] });
    // The click robot must not create, delete, install or start VMs (real programs, big downloads)
    host.contribute('clickguard', { block: [/^\/vms$/, /^\/vms\/engines\/install-qemu/, /^\/vms\/[^/]+\/(start|restart|clone|from-template|backups|export|disks|snapshots|template|encrypt|unlock|disk-key|shares)/, /^\/vms\/vbox\//, /^\/vms\/hyperv\/[^/]+\//, /^\/vms\/[^/]+\/ai\/explain/, /^\/vms\/networks/, /^\/vms\/[^/]+$/] });
    host.contribute('advisor', { kind: 'vm', label: 'Virtuelle Maschine', open: { id: 'vm', route: '/vms' }, start: /virtuelle maschine|virtual machine|\bvm\b|virtualbox|qemu|hyper-?v|vmware|linux testen|windows testen|ubuntu|debian/i });
    host.contribute('search', { run: (match) => m.list().filter((v) => match(v.name) || match(v.osLabel || '')).slice(0, 8).map((v) => ({ type: 'VM', label: v.name, hint: v.osLabel || 'VM', href: `#/vms/${v.id}` })) });
    host.contribute('health', {
      run: async () => {
        const out = [];
        if (!m.vms.size) return out;
        const q = await m.qhost.info().catch(() => null);
        if (q && !q.installed) out.push({ level: 'warn', area: 'VMs', text: host.t('QEMU is missing – virtual machines cannot start.'), fix: '#/vms' });
        else if (q && q.accel === 'tcg') out.push({ level: 'info', area: 'VMs', text: host.t('VMs run without hardware acceleration (slow). On Windows switch on “Windows Hypervisor Platform”.'), fix: '#/vms' });
        // 3D (#18): the cloud kernels of Debian (linux-image-cloud-amd64) have no virtio-gpu driver – seen live: no
        // /dev/dri, so virgl stays unused. The standard kernel has it.
        for (const id of m.vms.keys()) {
          const r = m.runtimes.get(id);
          const kernel = r && r.isRunning() && require('./qemu-args').glMode(r.vm) && r.agentInfo && r.agentInfo.kernel;
          if (kernel && /-cloud-/.test(kernel)) out.push({ level: 'info', area: 'VMs', text: host.t('“{name}” has 3D switched on, but its kernel ({kernel}) has no 3D graphics driver. In the VM: sudo apt install linux-image-amd64 && sudo apt remove "linux-image-*cloud*", then restart.', { name: name(id), kernel }), fix: `#/vms/${id}` });
        }
        return out;
      },
    });
  }
  // Messages (disk full, failed automatic snapshot) through Hostwerk's notification channels when available, else a toast
  // own switch under Settings → Notifications (SDK 2.10): desktop message and push for warnings about VMs
  let canNotify = false;
  try { if (host.notifications) { host.notifications.register('warnings', { de: 'Virtuelle Maschinen: Warnungen (Platte voll, Snapshot fehlgeschlagen)', en: 'Virtual machines: warnings (disk full, snapshot failed)' }); canNotify = true; } } catch { /* older Hostwerk */ }
  m.onNotify = (kind, text) => {
    host.broadcast({ type: 'toast', kind, text });
    if (canNotify) { try { host.notifications.notify('warnings', { title: host.t('Virtual machines'), text, kind, url: '#/vms' }); } catch { /* only the toast */ } }
  };
  if (!process.env.HW_TEST || process.env.HW_VMS_SCHEDULER === '1') m.startScheduler();
  host.on('autostart', () => (process.env.HW_TEST ? [] : [() => m.autostart()]));
  // Runs when Hostwerk quits AND when the extension is updated or switched off. VMs are never stopped here: on an update
  // the new instance takes them over (adoptRunning), and when Hostwerk quits it stops every process itself through its
  // stopFn – a clean guest shutdown (or power-off, if the VM is set to that), with more time than this hook has.
  host.on('shutdown', async () => { m.stopScheduler(); if (vncProxy) vncProxy.close(); m.detachAll(); m.switches.closeAll(); await m.stopShareServer().catch(() => {}); });
  // VMs whose QEMU kept running through an update of this extension
  m.adoptRunning().then((ids) => { if (ids.length) console.log(`[vms] took over running VMs: ${ids.join(', ')}`); }).catch(() => {}); // eslint-disable-line no-console
  exports.manager = m; // for tests and other extensions in the same process
};

exports.deactivate = () => {};
