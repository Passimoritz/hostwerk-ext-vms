import { useState, useSyncExternalStore } from 'react';
import { get, post, put, useApi, waitJob, pickPath, canPickPath } from '@hostwerk/api';
import { Btn, Modal, Field, Seg, Callout, promptDialog, toast } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import { run, nameKey } from './common';

/*
 * Dialogs that the page of a VM and the right-click menu of its card share: take a snapshot (name, note, memory),
 * export a disk (which disk, which format) and rename. A menu entry has no component to hold a dialog – so one outlet
 * (<DialogOutlet /> in the page) shows whatever openDialog() asks for and answers through a promise.
 */
let current = null;
const subs = new Set();
const emit = () => { for (const l of subs) l(); };

/** Shows <Component {...props} onClose={(result) => …} /> → the result (undefined when closed). */
export function openDialog(Component, props) {
  return new Promise((resolve) => { current = { Component, props, resolve }; emit(); });
}
export function DialogOutlet() {
  const d = useSyncExternalStore((l) => { subs.add(l); return () => subs.delete(l); }, () => current, () => current);
  if (!d) return null;
  const close = (v) => { if (current === d) { current = null; emit(); } d.resolve(v); };
  return <d.Component {...d.props} onClose={close} />;
}

/* ------------------------------------------------------------------ Rename */
/** The same rule as the server (spec.js NAME_RE): 1–60 characters, none that a folder name cannot hold. */
// eslint-disable-next-line no-control-regex
const NAME_RE = /^[^\u0000-\u001f<>"|?*\\/]{1,60}$/;
export async function renameVm(vm, after) {
  const name = await promptDialog({
    title: t('Rename “{name}”', { name: vm.name }),
    text: t('Only the name changes – folder, disks, snapshots and addresses stay as they are.'),
    label: t('Name'), value: vm.name, confirm: t('Rename'),
    validate: (v) => (NAME_RE.test(String(v).trim()) ? null : t('1–60 characters, without < > " | ? * \\ /.')),
  });
  if (!name || name.trim() === vm.name) return false;
  const ok = await run(() => put(`/vms/${vm.id}`, { name: name.trim() }), 'Renamed');
  if (ok && after) after();
  return !!ok;
}

/* ------------------------------------------------------------------ Snapshot */
const SNAP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
/** snap-YYYYMMDDhhmm in the time of this PC (the list shows local time too – UTC read like an hour off). */
export const snapStamp = (d = new Date()) => `snap-${[d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()].map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('')}`;

function SnapshotDialog({ vm, on, ramOk, onClose }) {
  const [name, setName] = useState(snapStamp);
  const [note, setNote] = useState('');
  const [ram, setRam] = useState(!!(on && ramOk));
  const taken = (vm.snapshots || []).some((s) => nameKey(s.name) === nameKey(name));
  const bad = !SNAP_RE.test(name.trim());
  const submit = () => { if (!bad && !taken) onClose({ name: name.trim(), note: note.trim(), ram: !!(on && ramOk && ram) }); };
  return (
    <Modal title="Take a snapshot" subtitle={vm.name} onClose={() => onClose()}
      footer={<><div className="grow" /><Btn className="btn" onClick={() => onClose()}>Cancel</Btn><Btn className="btn primary" disabled={bad || taken} onClick={submit}>Take snapshot</Btn></>}>
      <div className="stack">
        <div className="small muted">{on ? (ramOk ? t('The VM keeps running. With memory, restoring continues exactly where it was.') : t('The VM keeps running; the disks are saved at this moment (with the guest agent the file system is frozen briefly).')) : t('Saves the state of all disks.')}</div>
        <Field label="Name" hint={taken ? t('A snapshot with this name exists already.') : bad && name ? t('Letters, digits, “.”, “_” and “-”, up to 48 characters.') : undefined}>
          <input className="input mono" autoFocus value={name} maxLength={48} aria-invalid={bad || taken || undefined} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        </Field>
        <Field label="Note (optional)" hint="What this state is – e.g. “before the update to PHP 8.4”.">
          <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        </Field>
        {on && ramOk && <label className="check small"><input type="checkbox" checked={ram} onChange={(e) => setRam(e.target.checked)} />{t('Include memory')}</label>}
      </div>
    </Modal>
  );
}

/** Asks for name and note, takes the snapshot. → true when taken. */
export async function takeSnapshot(vm, on, after) {
  // whether this accelerator can save the memory of a running VM (WHPX cannot) – only asked when it matters
  let ramOk = false;
  if (on) { try { const e = await get('/vms/engines'); ramOk = !!(e && e.qemu && e.qemu.ramSnapshots); } catch { ramOk = false; } }
  const r = await openDialog(SnapshotDialog, { vm, on, ramOk });
  if (!r) return false;
  const ok = await run(() => post(`/vms/${vm.id}/snapshots`, r), 'Snapshot taken');
  if (ok && after) after();
  return !!ok;
}

/* ------------------------------------------------------------------ Export */
const FORMATS = [
  { id: 'vdi', label: 'VDI', text: 'VirtualBox' },
  { id: 'vmdk', label: 'VMDK', text: 'VMware, VirtualBox' },
  { id: 'vhdx', label: 'VHDX', text: 'Hyper-V' },
  { id: 'vhd', label: 'VHD', text: 'Hyper-V (older), Azure' },
  { id: 'qcow2', label: 'qcow2', text: 'QEMU, Proxmox, libvirt' },
];
function ExportDialog({ vm, onClose }) {
  const disks = vm.diskInfo || vm.disks || [];
  const [what, setWhat] = useState('ova');
  const [disk, setDisk] = useState(disks[0] ? disks[0].id : 'disk0');
  const [format, setFormat] = useState('vdi');
  const fmt = FORMATS.find((f) => f.id === format);
  return (
    <Modal title="Export" subtitle={vm.name} onClose={() => onClose()}
      footer={<><div className="grow" /><Btn className="btn" onClick={() => onClose()}>Cancel</Btn><Btn className="btn primary" onClick={() => onClose(what === 'ova' ? { ova: true } : { disk, format })}>Next</Btn></>}>
      <div className="stack">
        <Field label="What" hint={what === 'ova' ? t('One file (OVA) with every disk and the hardware – CPU, memory, firmware. VirtualBox, VMware and Proxmox import it as a ready VM.') : t('Only the disk – for a VM you set up yourself in the other program.')}>
          <Seg value={what} onChange={setWhat} options={[{ id: 'ova', label: t('The whole VM (OVA)') }, { id: 'disk', label: t('One disk') }]} />
        </Field>
        {what === 'ova' && <div className="small muted">{t('The VM stays as it is – the export is a copy for another program. Snapshots are not part of it; the disks are written in their current state. This takes about as long as copying the disks.')}</div>}
        {what === 'ova' && vm.encryption && <Callout kind="warn" dismissible={false}>{t('The disk is encrypted – the exported file is not. Other programs cannot read QEMU’s encryption.')}</Callout>}
      </div>
      {what === 'disk' && <div className="stack vm-export-disk">
        {disks.length > 1 && (
          <Field label="Disk">
            <select className="select" value={disk} onChange={(e) => setDisk(e.target.value)}>
              {disks.map((d) => <option key={d.id} value={d.id}>{d.id} · {d.file}</option>)}
            </select>
          </Field>
        )}
        <Field label="Format" hint={t('For: {programs}', { programs: t(fmt.text) })}>
          <Seg value={format} onChange={setFormat} options={FORMATS.map(({ id, label }) => ({ id, label }))} />
        </Field>
        <div className="small muted">{t('The VM stays as it is – the export is a copy for another program. Snapshots are not part of it; the disk is written in its current state.')}</div>
        {vm.encryption && <Callout kind="warn" dismissible={false}>{t('The disk is encrypted – the exported file is not. Other programs cannot read QEMU’s encryption.')}</Callout>}
      </div>}
    </Modal>
  );
}

/** Export: the whole VM as an appliance (OVA) or one disk (vdi, vmdk, vhdx, vhd, qcow2) – then where to. */
export async function exportVm(vm) {
  const choice = await openDialog(ExportDialog, { vm });
  if (!choice) return;
  const base = String(vm.name).replace(/[^\w.\- ]+/g, '_').trim() || vm.id;
  const file = choice.ova ? `${base}.ova` : `${base}-${choice.disk}.${choice.format}`;
  let dest = null;
  if (window.hostwerk && window.hostwerk.pickPath) dest = await pickPath({ mode: 'save', title: t('Save as'), defaultPath: file });
  else if (canPickPath()) {
    // in a browser Hostwerk's picker can only open what exists – so the folder is chosen and the file name added
    const dir = await pickPath({ mode: 'folder', title: t('Folder for “{file}”', { file }) });
    if (dir) dest = `${String(dir).replace(/[\\/]+$/, '')}${/\\/.test(dir) || /^[A-Za-z]:/.test(dir) ? '\\' : '/'}${file}`;
  } else dest = await promptDialog({ title: t('Save as'), text: t('Full path of the new file on the PC Hostwerk runs on.'), label: t('Path'), value: '', placeholder: file });
  if (!dest) return;
  const r = await run(() => (choice.ova ? post(`/vms/${vm.id}/export-ova`, { dest }) : post(`/vms/${vm.id}/export`, { ...choice, dest })));
  if (r && r.job) { const j = await waitJob(r.job).catch((e) => { toast.error(e.message); return null; }); if (j && j.result) toast.success(t('Exported to {path}', { path: j.result.path })); }
}

/* ------------------------------------------------------------------ New password in the VM */
function PasswordDialog({ vm, onClose }) {
  const { data, error } = useApi(`/vms/${vm.id}/guest/users`, [vm.id], { live: false });
  const users = (data && data.users) || [];
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  // the VM's own user first (from the creation), else the first person's account – root only when there is no other
  const preferred = (vm.ssh && vm.ssh.user) || (vm.install && vm.install.user) || users.find((u) => u !== 'root' && u !== 'Administrator') || users[0] || '';
  const who = user || preferred;
  const ok = !!who && password.length >= 1 && password.length <= 128;
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    const r = await run(() => post(`/vms/${vm.id}/guest/password`, { user: who, password }));
    setBusy(false);
    if (r) { toast.success(t('New password set for {user}', { user: who })); onClose(true); }
  };
  return (
    <Modal title="New password in the VM" subtitle={vm.name} onClose={() => onClose()}
      footer={<><div className="grow" /><Btn className="btn" onClick={() => onClose()}>Cancel</Btn><Btn className="btn primary" busy={busy} disabled={!ok} onClick={submit}>Set password</Btn></>}>
      <div className="stack">
        <div className="small muted">{t('Hostwerk sets the password inside the running VM through the guest agent – the old one is not needed. For a VM you are locked out of.')}</div>
        {error && <Callout kind="err" dismissible={false}>{error}</Callout>}
        <Field label="User">
          {users.length ? (
            <select className="select" value={who} onChange={(e) => setUser(e.target.value)}>
              {!users.includes(who) && who && <option value={who}>{who}</option>}
              {users.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          ) : <input className="input" value={who} onChange={(e) => setUser(e.target.value)} placeholder={vm.osType === 'windows' ? 'Administrator' : 'root'} autoComplete="off" />}
        </Field>
        <Field label="New password" hint="Hostwerk does not store it – note it in your password manager.">
          <div className="row">
            <input className="input grow" type={show ? 'text' : 'password'} autoFocus value={password} maxLength={128} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
            <Btn className="btn" type="button" onClick={() => setShow(!show)}>{show ? t('Hide') : t('Show')}</Btn>
          </div>
        </Field>
      </div>
    </Modal>
  );
}
/** Asks for the user and a new password and sets it in the running VM. */
export const resetPassword = (vm) => openDialog(PasswordDialog, { vm });
