import { Monitor, Pause, Play, Camera, Cpu, Power, Import, Square } from 'lucide-react';
import { post, del } from '@hostwerk/api';
import { confirmDialog, promptDialog } from '@hostwerk/ui';
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
