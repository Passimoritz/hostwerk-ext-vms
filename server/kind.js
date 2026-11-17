'use strict';
/*
 * VMs as Hostwerk service kind "vm" (SDK 3.5): overview tile and headline, search, sidebar dots, start/stop, files,
 * scheduled tasks, backup centre, ports for firewall/router and alerts – all through Hostwerk's shared building blocks.
 */
function vmKind(m) {
  const state = (id) => { const s = m.stateOf(id); return s.state === 'paused' ? 'running' : s.state; };
  return {
    kind: 'vm',
    label: { de: 'Virtuelle Maschinen', en: 'Virtual machines' },
    one: { de: 'Virtuelle Maschine', en: 'Virtual machine' },
    icon: 'monitor', color: '#0ea5e9', route: '/vms', api: '/vms', newHref: '#/vms?new=1',
    list: () => m.list().filter((v) => !v.template).map((v) => ({ id: v.id, name: v.name, ...v })),
    get: (id) => m.view(m.get(id)),
    proc: (id) => { const s = m.stateOf(id); return { ...s, state: state(id), extra: { paused: s.state === 'paused', accel: s.accel || null } }; },
    start: (id) => m.start(id),
    stop: (id) => m.stop(id),
    restart: (id) => m.restart(id),
    detail: (v) => [v.osLabel || null, `${v.cpus} CPU`, `${v.memoryMb >= 1024 ? `${Math.round(v.memoryMb / 102.4) / 10} GB` : `${v.memoryMb} MB`} RAM`].filter(Boolean).join(' · '),
    dir: (id) => m.dirOf(id),
    fileRoot: (v) => ({ path: m.dirOf(v.id) }),
    ports: (v) => ((v.net && v.net.forwards) || []).map((f) => ({ port: f.host, label: `${v.name}: ${f.label || f.guest}`, proto: f.proto.toUpperCase(), public: f.bind === 'lan' })),
    headline: () => {
      const all = m.list().filter((v) => !v.template);
      const running = all.filter((v) => ['running', 'paused', 'starting'].includes(m.stateOf(v.id).state)).length;
      return { icon: 'monitor', value: `${running}/${all.length}`, label: { de: 'VMs laufen', en: 'VMs running' }, sub: null };
    },
    metrics: ['cpu', 'ram'],
    /*
     * Moving to another PC, mirror, "keep when removing" and clone (#16) – Hostwerk packs the VM folder, sends it and
     * calls place() on the target. Only switched-off VMs (dir() refuses running ones and linked clones). An encrypted
     * VM arrives locked: its key is sealed for this PC and never travels with the disks – it is entered once on the
     * target (Hardware → Encryption; the key is shown here under the same place).
     */
    copy: {
      folder: 'vms',
      zip: 'vm.zip',
      skip: ['vm.json', 'qemu.pid', '.screen.png', 'serial.log', '.hwkey-*', '*.restore', '*.compact', '*.encrypt'],
      moveNote: {
        de: 'Nur ausgeschaltete VMs ziehen um (Platten, Snapshots, UEFI-Variablen). Verknüpfte Klone brauchen ihre Vorlage – vorher eine volle Kopie machen. Eine verschlüsselte VM kommt gesperrt an: Den Schlüssel unter „Hardware → Verschlüsselung“ hier ablesen und dort eingeben. Pakete sind auf 8 GB begrenzt.',
        en: 'Only switched-off VMs move (disks, snapshots, UEFI variables). Linked clones need their template – make a full copy first. An encrypted VM arrives locked: read the key here under “Hardware → Encryption” and enter it there. Packages are limited to 8 GB.',
      },
      dir: (id) => m.copyDir(id),
      dirFor: (id) => m.dirOf(id),
      isRunning: (id) => m.isRunning(id),
      entry: (id) => m.copyEntry(id),
      place: (o) => m.copyPlace(o),
      afterFiles: (id) => m.copyAfterFiles(id),
      add: (entry) => m.copyAdd(entry),
      clone: (id, o, job) => m.copyClone(id, o, job),
      probe: (id) => m.copyProbe(id),
    },
    backups: {
      prefix: 'vm',
      list: (id) => m.listBackups(id),
      dir: (id) => m.backupDir(id),
      create: (id, label) => m.backup(id, label),
      restore: (id, file) => m.restoreBackup(id, file),
      remove: (id, file) => m.removeBackup(id, file),
    },
    tasks: {
      control: {
        type: 'vm',
        label: { de: 'Virtuelle Maschine steuern', en: 'Control a virtual machine' },
        help: 'target = VM id, command = start|stop|restart|poweroff|snapshot|backup',
        fields: [{ key: 'command', type: 'select', default: 'snapshot', label: { de: 'Befehl', en: 'Command' },
          options: [['start', 'Start', 'Starten'], ['stop', 'Shut down', 'Herunterfahren'], ['restart', 'Restart', 'Neu starten'], ['poweroff', 'Power off', 'Ausschalten'], ['snapshot', 'Take a snapshot', 'Snapshot anlegen'], ['backup', 'Back up', 'Sichern']]
            .map(([value, en, de]) => ({ value, label: { de, en } })) }],
        validate: (a) => { m.get(a.target); },
        clean: (a) => ({ command: ['start', 'stop', 'restart', 'poweroff', 'snapshot', 'backup'].includes(a.command) ? a.command : 'snapshot' }),
        async run(a) {
          const c = a.command || 'snapshot';
          if (c === 'start') await m.start(a.target);
          else if (c === 'stop') await m.stop(a.target);
          else if (c === 'poweroff') await m.stop(a.target, { force: true });
          else if (c === 'restart') await m.restart(a.target);
          else if (c === 'snapshot') { await m.takeSnapshot(a.target, { name: `auto-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`, note: 'Scheduled task' }); }
          else if (c === 'backup') { const j = m.backup(a.target, 'auto'); await j.promise; }
          return 'ok';
        },
      },
    },
  };
}

module.exports = { vmKind };
