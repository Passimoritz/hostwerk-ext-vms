import { Monitor, Pause, Play, Camera, Cpu, Power, Import, Square, Copy, Layers, Box, Upload } from 'lucide-react';
import { post, del, waitJob, pickPath, canPickPath } from '@hostwerk/api';
import { confirmDialog, promptDialog, toast } from '@hostwerk/ui';
import { serviceMenu, contextMenu } from '@hostwerk/kit';
import { t } from '@hostwerk/i18n';
import { stateOf, isOn, ipOf, go, run } from './common';

/*
 * Right-click menus – Hostwerk's own service menu (like web servers and Minecraft servers): open, start/stop/restart,
 * power off by force, open folder, copy SSH command and address, favourite, picture, clone, AI helper, move to another
 * PC and delete; plus what only a VM has (screen, pause, snapshot, hardware).
 */

/** Delete a VM after typing its name (same question as on its page). */
export async function removeVm(vm, after) {
  if (!(await confirmDialog({ title: t('Delete “{name}”?', { name: vm.name }), text: t('The VM folder with all disks and snapshots is deleted. Backups stay.'), confirm: t('Delete'), danger: true, typeToConfirm: vm.name }))) return false;
  const ok = await run(() => del(`/vms/${vm.id}`), 'Deleted');
  if (ok && after) after();
  return !!ok;
}

/* Aktionen, die es auf der Seite einer VM (Verwalten) und im Rechtsklick-Menü gleich gibt */

/** Kopie (linked = verknüpfter Klon, teilt die Platte). */
export async function cloneVm(vm, linked, after) {
  const name = await promptDialog({ title: linked ? t('Linked clone') : t('Copy VM'), text: linked ? t('Shares the disk with “{name}” – fast and small, but “{name}” must stay.', { name: vm.name }) : t('A full, independent copy.'), label: t('Name'), value: `${vm.name} 2`, confirm: t('Create') });
  if (!name) return;
  const r = await run(() => post(`/vms/${vm.id}/clone`, { name, linked }));
  if (r && r.job) { go(r.id); await waitJob(r.job).catch((e) => toast.error(e.message)); if (after) after(); }
}
/** Vorlage ein/aus. */
export async function toggleTemplate(vm, after) {
  if (await run(() => post(`/vms/${vm.id}/template`, { on: !vm.template }), vm.template ? 'Is a normal VM again' : 'Is a template now') && after) after();
}
/** Platte exportieren (vdi, vmdk, vhdx, vhd, qcow2). */
export async function exportVm(vm) {
  const format = await promptDialog({ title: t('Export disk'), text: t('Format: vdi (VirtualBox), vmdk (VMware), vhdx (Hyper-V), vhd or qcow2.'), label: t('Format'), value: 'vdi', confirm: t('Next') });
  if (!format) return;
  const dest = canPickPath() ? await pickPath({ mode: 'save', title: t('Save as'), defaultPath: `${vm.id}.${format === 'vhd' ? 'vhd' : format}` }) : await promptDialog({ title: t('Save as'), label: t('Path'), value: '' });
  if (!dest) return;
  const r = await run(() => post(`/vms/${vm.id}/export`, { disk: 'disk0', format: format.trim().toLowerCase(), dest }));
  if (r && r.job) { const j = await waitJob(r.job).catch((e) => { toast.error(e.message); return null; }); if (j && j.result) toast.success(t('Exported to {path}', { path: j.result.path })); }
}
/** Auf einen anderen PC umziehen – Hostwerks eigener Dialog (wie im Rechtsklick-Menü). */
export const moveVm = (vm) => window.dispatchEvent(new CustomEvent('hw:move', { detail: { kind: 'vm', id: vm.id } }));

export function vmMenu(e, vm, { reload, onRemoved } = {}) {
  const st = stateOf(vm);
  const on = isOn(st);
  const done = () => reload && reload({ silent: true });
  const act = (p, body, ok) => run(async () => { await post(`/vms/${vm.id}/${p}`, body); done(); }, ok);
  const snapshot = async () => {
    const name = await promptDialog({ title: t('Take a snapshot'), label: t('Name'), value: `snap-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`, confirm: t('Take snapshot') });
    if (name) act('snapshots', { name }, 'Snapshot taken');
  };
  const busy = !!(vm.busy || vm.creating);
  const ip = ipOf(vm);
  // the list carries the forwards, the page the ready command – both give the same line
  const fwd = ((vm.net && vm.net.forwards) || []).find((f) => f.guest === 22 && f.proto === 'tcp');
  const ssh = (vm.ssh && vm.ssh.command) || (fwd ? `ssh -p ${fwd.host} 127.0.0.1` : null);
  const extra = [
    on && st !== 'stopping' && { label: t('Open the screen'), icon: Monitor, onClick: () => go(`${vm.id}/screen`) },
    st === 'paused' ? { label: t('Resume'), icon: Play, onClick: () => act('resume') }
      : st === 'running' && { label: t('Pause'), icon: Pause, onClick: () => act('pause') },
    !vm.template && { label: t('Take a snapshot …'), icon: Camera, disabled: busy, onClick: snapshot },
    { label: t('Hardware …'), icon: Cpu, onClick: () => go(`${vm.id}/hardware`) },
    // Wie „Verwalten“ auf der Seite der VM (nur ausgeschaltet)
    !on && !busy && { label: t('Copy …'), icon: Copy, onClick: () => cloneVm(vm, false, done) },
    !on && !busy && !vm.template && !vm.encryption && { label: t('Clone …'), icon: Layers, onClick: () => cloneVm(vm, true, done) },
    !on && !busy && !vm.linkedTo && (vm.template || !vm.encryption) && { label: vm.template ? t('Normal VM again') : t('Template'), icon: Box, onClick: () => toggleTemplate(vm, done) },
    !on && !busy && { label: t('Export …'), icon: Upload, onClick: () => exportVm(vm) },
  ].filter(Boolean);
  serviceMenu(e, {
    icon: { kind: 'vm', id: vm.id },
    move: vm.template || on ? null : { kind: 'vm', id: vm.id },
    name: vm.name,
    // Hostwerk's menu knows running/starting/stopping/error/stopped – a paused VM counts as running
    state: busy ? 'starting' : st === 'paused' ? 'running' : st,
    base: vm.template || busy ? null : `/vms/${vm.id}`,
    href: `#/vms/${vm.id}`,
    dir: vm.dir,
    copy: [ssh && [t('Copy SSH command'), ssh], ip && [t('Copy IP address'), ip]].filter(Boolean),
    extra,
    remove: on ? null : () => removeVm(vm, () => { if (onRemoved) onRemoved(); done(); }),
    removeLabel: t('Delete …'),
  });
}

/** VirtualBox VMs: VirtualBox does the work, Hostwerk only starts, stops and takes over. */
export function vboxMenu(e, v, { reload, onImport } = {}) {
  const on = v.state === 'running' || v.state === 'paused';
  const act = (a) => run(async () => { await post(`/vms/vbox/${v.uuid}/${a}`); if (reload) reload({ silent: true }); });
  contextMenu(e, [
    { label: t('Open'), icon: Monitor, onClick: () => go(`vbox/${v.uuid}`) },
    !on ? { label: t('Start'), icon: Play, onClick: () => act('start') } : { label: t('Shut down'), icon: Square, onClick: () => act('acpi') },
    on && { label: t('Power off'), icon: Power, danger: true, onClick: async () => { if (await confirmDialog({ title: t('Power off “{name}”?', { name: v.name }), text: t('Like pulling the plug – data the VM has not saved is lost.'), confirm: t('Power off'), danger: true })) act('poweroff'); } },
    !on && onImport && '-',
    !on && onImport && { label: t('Take over into QEMU …'), icon: Import, onClick: () => onImport(v.uuid) },
  ].filter(Boolean));
}
