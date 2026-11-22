import { useEffect, useMemo, useState } from 'react';
import { Rocket, Disc3, HardDrive, PackageOpen, Box, Layers, FolderOpen, Cloud, KeyRound, AppWindow, ScrollText, SquareDashed, Globe, Container, PenLine, GitBranch, Activity, Terminal } from 'lucide-react';
import { get, post, useApi, waitJob, pickPath, canPickPath } from '@hostwerk/api';
import { Btn, Modal, Field, Seg, Switch, Callout, toast, InfoTip } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import { go, mem, nameKey } from './common';

/*
 * New VM in two steps: 1. where it comes from, 2. name and size (with good defaults per system). Ready-made Linux
 * (cloud image) is the first choice – it is ready to use in about a minute, with user, password/SSH key and guest agent.
 */
const SOURCES = [
  { id: 'cloud', color: 'var(--accent)', icon: Rocket, title: 'Ready-made Linux', text: 'Debian, Ubuntu, AlmaLinux or Fedora – ready in about a minute, with your user and SSH.' },
  { id: 'iso', color: '#0ea5e9', icon: Disc3, title: 'Install from ISO', text: 'Windows, Linux, BSD … – boots the installer, like a PC with a DVD.' },
  { id: 'disk', color: '#8b5cf6', icon: HardDrive, title: 'Existing disk', text: 'qcow2, VDI, VMDK, VHD(X) or raw image – from VirtualBox, VMware, Hyper-V or Proxmox.' },
  { id: 'ova', color: '#f59e0b', icon: PackageOpen, title: 'Appliance (OVA/OVF)', text: 'Exported VMs with CPU, memory and disks.' },
  { id: 'vbox', color: '#2563eb', icon: Layers, title: 'From VirtualBox', text: 'Take over a VirtualBox VM – VirtualBox keeps its copy.' },
  { id: 'template', color: '#10b981', icon: Box, title: 'From a template', text: 'Linked clone in seconds – only changes take space.' },
  { id: 'empty', color: '#64748b', icon: SquareDashed, title: 'Empty VM', text: 'Blank disk – insert an ISO later.' },
];
// App templates: icon and colour of the small tile in the list (like Hostwerk's engine cards)
const APP_LOOK = { nginx: [Globe, '#16a34a'], docker: [Container, '#0ea5e9'], wordpress: [PenLine, '#2563eb'], nextcloud: [Cloud, '#0891b2'], gitea: [GitBranch, '#65a30d'], 'uptime-kuma': [Activity, '#10b981'] };
const AppIco = ({ id }) => { const [I, c] = APP_LOOK[id] || [Terminal, '#64748b']; return <span className="engine-ico vm-app-ico" style={{ '--c': c }}><I size={16} aria-hidden="true" /></span>; };
const EXAMPLE_COMMANDS = ['apt-get install -y htop', 'echo ready > /root/ready'].join('\n');
const OS = [{ id: 'linux', label: 'Linux' }, { id: 'windows', label: 'Windows' }, { id: 'other', label: 'Other' }];

export function CreateDialog({ onClose, engines, initial = {} }) {
  const { data: cat } = useApi('/vms/catalog', [], { live: false });
  const { data: list } = useApi('/vms', [], { live: false });
  const { data: netData } = useApi('/vms/networks', [], { live: false });
  const { data: appData } = useApi('/vms/apps', [], { live: false });
  const apps = (appData && appData.items) || [];
  const nets = (netData && netData.networks) || [];
  const [source, setSource] = useState(initial.source || null);
  const [f, setF] = useState({ name: '', osType: 'linux', cpus: 2, memoryMb: 2048, diskGb: 20, image: 'debian-12', user: '', password: '', sshKeys: '', iso: '', file: '', uuid: initial.uuid || '', template: initial.template || '', start: true, firmware: '', unattended: true, drivers: true, winUser: '', winPassword: '', computerName: '', edition: 'Windows 11 Pro', language: 'de-DE', productKey: '', keyboard: /^de/i.test(navigator.language || '') ? 'de' : 'us', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '', encrypt: false, inNet: '', inNetIp: '', app: initial.app || '', startCommands: '', startScript: '', arch: 'x86_64' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v && v.target ? (v.target.type === 'checkbox' ? v.target.checked : v.target.value) : v }));
  const host = (engines && engines.host) || { cpus: 4, memoryMb: 8192 };
  const items = (cat && cat.items) || [];
  const clouds = items.filter((i) => i.kind === 'cloud');
  const armOk = !!(engines && engines.qemu && engines.qemu.aarch64 && engines.qemu.aarch64.ok);
  const isos = items.filter((i) => i.kind !== 'cloud');
  const entry = items.find((i) => i.id === f.image);
  const cached = new Set(((cat && cat.cache) || []).map((c) => c.id));
  const templates = ((list && list.vms) || []).filter((v) => v.template);
  const nameTaken = !!f.name.trim() && ((list && list.vms) || []).some((v) => nameKey(v.name) === nameKey(f.name));
  const vboxVms = ((list && list.vbox) || []).filter((v) => v.state === 'stopped' || v.state === 'saved');

  useEffect(() => { if (source === 'iso' && !isos.some((i) => i.id === f.image)) setF((x) => ({ ...x, image: '' })); if (source === 'cloud' && !clouds.some((i) => i.id === f.image)) setF((x) => ({ ...x, image: 'debian-12' })); }, [source, items.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // good sizes per system
    const d = f.osType === 'windows' ? { cpus: Math.min(4, host.cpus), memoryMb: Math.min(8192, host.memoryMb - 1024), diskGb: 80 } : { cpus: 2, memoryMb: 2048, diskGb: source === 'cloud' ? 20 : 30 };
    setF((x) => ({ ...x, ...d }));
  }, [f.osType, source]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (entry && entry.user && !f.user) setF((x) => ({ ...x, user: entry.user })); if (entry && entry.osType) setF((x) => ({ ...x, osType: entry.osType })); }, [f.image]); // eslint-disable-line react-hooks/exhaustive-deps

  const app = apps.find((a) => a.id === f.app) || null;
  const appFits = (a) => !!entry && (a.families || []).includes(entry.family);
  useEffect(() => { // an app brings its own sizes; an image without apt drops the app
    if (app && entry && !appFits(app)) { setF((x) => ({ ...x, app: '' })); return; }
    if (app) setF((x) => ({ ...x, memoryMb: Math.min(app.memoryMb, Math.max(512, host.memoryMb - 1024)), diskGb: Math.max(app.diskGb, 10) }));
  }, [f.app, f.image]); // eslint-disable-line react-hooks/exhaustive-deps
  // ARM (#22): from the image (ready-made Linux) or chosen (own ISO, empty VM, disk image)
  const arch = source === 'cloud' ? (entry && entry.arch) || 'x86_64' : ['empty', 'disk'].includes(source) || (source === 'iso' && !f.image) ? f.arch : 'x86_64';
  const memMax = Math.max(512, host.memoryMb - 512);
  const memWarn = f.memoryMb > host.memoryMb * 0.6;

  const pick = async (key, filters) => { const p = await pickPath({ mode: 'file', title: t('Choose a file'), filters }); if (p) set(key)(p); };

  const create = async () => {
    setBusy(true);
    try {
      const body = { ...f, source, sshKeys: f.sshKeys, name: f.name.trim(), image: ['cloud', 'iso'].includes(source) ? f.image || undefined : undefined, edition: /^\d+$/.test(f.edition) ? Number(f.edition) : f.edition, productKey: f.productKey.trim() || undefined, unattended: winAuto, nets: f.inNet ? [{ net: f.inNet, ip: f.inNetIp.trim() || null }] : undefined, encrypt: ['cloud', 'iso', 'empty'].includes(source) && f.encrypt };
      delete body.inNet; delete body.inNetIp;
      if (source !== 'cloud') { delete body.app; delete body.startCommands; delete body.startScript; }
      if (!body.app) delete body.app;
      if (['empty', 'disk'].includes(source) || (source === 'iso' && !f.image)) body.arch = f.arch; else delete body.arch;
      if (source === 'iso' && f.image) delete body.iso;
      if (!body.firmware) delete body.firmware;
      const r = await post('/vms', body);
      onClose();
      go(r.id);
      const j = await waitJob(r.job);
      if (j && j.state === 'done') toast.success(t('VM “{name}” is ready', { name: body.name }));
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  if (!source) {
    return (
      <Modal title="New virtual machine" subtitle="Where should it come from?" onClose={onClose} size="wide">
        <div className="vm-sources">
          {SOURCES.map((s, i) => {
            const off = (s.id === 'vbox' && !(engines && engines.vbox && engines.vbox.installed)) || (s.id === 'template' && !templates.length);
            return (
              <button key={s.id} type="button" className={`engine-card vm-source ${s.id === 'cloud' ? 'active' : ''}`} style={{ '--c': s.color, '--i': i }} disabled={off} onClick={() => setSource(s.id)}>
                <span className="row-tight vm-source-top"><span className="engine-ico"><s.icon size={20} aria-hidden="true" /></span><b className="vm-source-title">{t(s.title)}</b></span>
                <span className="vm-source-text small muted">{off ? (s.id === 'vbox' ? t('VirtualBox is not installed.') : t('No template yet – turn a VM into a template first.')) : t(s.text)}</span>
              </button>
            );
          })}
        </div>
      </Modal>
    );
  }

  const winAuto = source === 'iso' && f.osType === 'windows' && f.unattended;
  const valid = f.name.trim() && (source !== 'cloud' || (f.user && (f.password.length >= 6 || f.sshKeys.trim()))) && (!winAuto || (f.winUser.trim() && f.winPassword))
    && (source !== 'iso' || f.image || f.iso) && (!['disk', 'ova'].includes(source) || f.file) && (source !== 'vbox' || f.uuid) && (source !== 'template' || f.template);
  return (
    <Modal title={t(SOURCES.find((s) => s.id === source).title)} subtitle="Name and size – the defaults fit most cases." onClose={onClose} size="wide" dirty={!!f.name}
      footer={<><Btn className="btn ghost" onClick={() => setSource(null)}>Back</Btn><div className="grow" /><Btn className="btn" onClick={onClose}>Cancel</Btn><Btn className="btn primary" busy={busy} disabled={!valid} onClick={create}>Create VM</Btn></>}>
      <div className="stack">
        {source === 'cloud' && (
          <Field label="System">
            <div className="vm-images">
              {clouds.filter((i) => i.arch !== 'aarch64' || armOk).map((i) => (
                <label key={i.id} className={`vm-image ${f.image === i.id ? 'on' : ''}`}>
                  <input type="radio" name="img" checked={f.image === i.id} onChange={() => set('image')(i.id)} />
                  <Cloud size={16} aria-hidden="true" /> <span className="grow">{i.label}{i.arch === 'aarch64' && <span className="badge warn vm-arch">{t('ARM · slow')}</span>}</span>
                  <span className="small muted">{cached.has(i.id) ? t('downloaded') : `~${i.sizeMb} MB`}</span>
                </label>
              ))}
            </div>
          </Field>
        )}
        {source === 'iso' && (
          <Field label="Installer" hint="Downloaded from the official server, checksum checked – or your own ISO file.">
            <div className="vm-images">
              {isos.map((i) => (
                <label key={i.id} className={`vm-image ${f.image === i.id ? 'on' : ''}`}>
                  <input type="radio" name="img" checked={f.image === i.id} onChange={() => { set('image')(i.kind === 'manual' ? '' : i.id); set('osType')(i.osType || 'linux'); if (i.kind === 'manual') window.open(i.page, '_blank', 'noopener'); }} />
                  <Disc3 size={16} aria-hidden="true" /> <span className="grow">{i.label}</span>
                  <span className="small muted">{i.kind === 'manual' ? t('download page …') : cached.has(i.id) ? t('downloaded') : `~${i.sizeMb} MB`}</span>
                </label>
              ))}
              <label className={`vm-image ${!f.image ? 'on' : ''}`}>
                <input type="radio" name="img" checked={!f.image} onChange={() => set('image')('')} />
                <FolderOpen size={16} aria-hidden="true" /> <span className="grow">{t('My own ISO file')}</span>
              </label>
            </div>
            {!f.image && <div className="row"><input className="input grow" value={f.iso} onChange={set('iso')} placeholder={'C:\\Downloads\\Win11.iso'} />{canPickPath() && <Btn className="btn" icon={FolderOpen} onClick={() => pick('iso', [{ name: 'ISO', extensions: ['iso', 'img'] }])}>Choose …</Btn>}</div>}
          </Field>
        )}
        {['disk', 'ova'].includes(source) && (
          <Field label={source === 'ova' ? 'OVA or OVF file' : 'Disk image'} hint={source === 'disk' ? 'Hostwerk copies it into a new qcow2 disk – the original stays untouched.' : 'CPU, memory and disks are taken from the appliance.'}>
            <div className="row"><input className="input grow" value={f.file} onChange={set('file')} />{canPickPath() && <Btn className="btn" icon={FolderOpen} onClick={() => pick('file', source === 'ova' ? [{ name: 'OVA/OVF', extensions: ['ova', 'ovf'] }] : [{ name: 'Disk', extensions: ['qcow2', 'vdi', 'vmdk', 'vhd', 'vhdx', 'img', 'raw'] }])}>Choose …</Btn>}</div>
          </Field>
        )}
        {source === 'vbox' && (
          <Field label="VirtualBox VM" hint="Only switched-off VMs can be taken over. VirtualBox keeps its own copy.">
            <select className="select" value={f.uuid} onChange={(e) => { set('uuid')(e.target.value); const v = vboxVms.find((x) => x.uuid === e.target.value); if (v && !f.name) set('name')(v.name); }}>
              <option value="">{t('Choose …')}</option>
              {vboxVms.map((v) => <option key={v.uuid} value={v.uuid}>{v.name} · {v.osType}</option>)}
            </select>
          </Field>
        )}
        {source === 'template' && (
          <Field label="Template">
            <select className="select" value={f.template} onChange={set('template')}>
              <option value="">{t('Choose …')}</option>
              {templates.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </Field>
        )}
        <div className="grid grid-2">
          <Field label="Name" hint={nameTaken ? t('A VM with this name exists already – two VMs with the same name are hard to tell apart.') : undefined}><input className="input" value={f.name} onChange={set('name')} placeholder={source === 'cloud' ? 'web-test' : 'Windows 11'} maxLength={60} autoFocus aria-invalid={nameTaken || undefined} /></Field>
          {['iso', 'empty', 'disk'].includes(source) && <Field label="System"><Seg value={f.osType} onChange={set('osType')} options={arch === 'aarch64' ? OS.filter((o) => o.id !== 'windows') : OS} /></Field>}
          {armOk && (['empty', 'disk'].includes(source) || (source === 'iso' && !f.image)) && <Field label="Processor" hint="ARM64 runs emulated – much slower than a PC VM."><Seg value={f.arch} onChange={(v) => setF((x) => ({ ...x, arch: v, osType: v === 'aarch64' && x.osType === 'windows' ? 'linux' : x.osType }))} options={[{ id: 'x86_64', label: t('PC (x86-64)') }, { id: 'aarch64', label: 'ARM64' }]} /></Field>}
          <Field label="Keyboard layout" hint={source === 'cloud' ? 'Set in the VM, too.' : 'Used when Hostwerk types text into the VM.'}><Seg value={f.keyboard} onChange={set('keyboard')} options={[{ id: 'de', label: t('German') }, { id: 'us', label: t('English (US)') }]} /></Field>
        </div>
        {source === 'cloud' && (
          <div className="grid grid-2">
            <Field label="User" hint="Gets sudo rights."><input className="input" value={f.user} onChange={set('user')} autoComplete="off" /></Field>
            <Field label="Password" hint="At least 6 characters – or only an SSH key."><input className="input" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
            <Field label={<span className="row-tight"><KeyRound size={14} aria-hidden="true" /> {t('SSH key (optional)')}</span>} hint="Public key, e.g. the content of ~/.ssh/id_ed25519.pub.">
              <textarea className="input mono vm-key" rows={2} value={f.sshKeys} onChange={set('sshKeys')} placeholder="ssh-ed25519 AAAA… you@pc" />
            </Field>
            <Field label="Time zone"><input className="input" value={f.timezone} onChange={set('timezone')} /></Field>
          </div>
        )}
        {source === 'cloud' && apps.length > 0 && (
          <Field label={<span className="row-tight"><AppWindow size={14} aria-hidden="true" /> {t('App (optional)')}</span>} hint={entry && !apps.some(appFits) ? t('App templates need Debian or Ubuntu.') : t('Installed at the first start from the distribution or as the official container – takes a few minutes after the VM is up.')}>
            <div className="vm-apps">
              <label className={`vm-image ${!f.app ? 'on' : ''}`}><input type="radio" name="app" checked={!f.app} onChange={() => set('app')('')} /><AppIco id="" /><span className="grow">{t('No app – plain Linux')}</span></label>
              {apps.map((a) => (
                <label key={a.id} className={`vm-image ${f.app === a.id ? 'on' : ''} ${appFits(a) ? '' : 'off'}`} title={appFits(a) ? undefined : t('App templates need Debian or Ubuntu.')}>
                  <input type="radio" name="app" disabled={!appFits(a)} checked={f.app === a.id} onChange={() => set('app')(a.id)} />
                  <AppIco id={a.id} />
                  <span className="grow"><span className="vm-app-name">{t(a.label)}</span><span className="small muted vm-app-text">{t(a.text)}</span></span>
                  {a.forwards[0] && <span className="badge mono">{t('port {port}', { port: a.forwards[0].host })}</span>}
                </label>
              ))}
            </div>
            {app && app.forwards[0] && <div className="small muted">{t('Reachable on this PC at http://127.0.0.1:{port} (the next free port if it is taken). The VM page shows the button “{label}”.', { port: app.forwards[0].host, label: t(app.open || app.label) })}</div>}
          </Field>
        )}
        {source === 'cloud' && (
          <details className="card vm-start-script" open={!!(f.startCommands || f.startScript)}>
            <summary className="card-body row-tight"><ScrollText size={15} aria-hidden="true" /> <b>{t('Own commands at the first start (optional)')}</b></summary>
            <div className="card-body stack">
              <Field label="Commands" hint="One command per line, run once as root after the packages (cloud-init runcmd). Lines starting with # are skipped.">
                <textarea className="input mono" rows={3} value={f.startCommands} onChange={set('startCommands')} placeholder={EXAMPLE_COMMANDS} spellCheck={false} />
              </Field>
              <Field label="Bash script" hint="Written into the VM and run once as root after the commands. Output: /var/log/hostwerk-start-script.log.">
                <textarea className="input mono" rows={5} value={f.startScript} onChange={set('startScript')} placeholder={'#!/bin/bash\nset -e\n…'} spellCheck={false} />
              </Field>
            </div>
          </details>
        )}
        {source !== 'template' && source !== 'vbox' && source !== 'ova' && (
          <div className="grid grid-3">
            <Field label={t('CPU cores (of {n})', { n: host.cpus })}><input className="input" type="number" min={1} max={host.cpus} value={f.cpus} onChange={(e) => set('cpus')(Number(e.target.value))} /></Field>
            <Field label={t('Memory (MB, this PC: {mem})', { mem: mem(host.memoryMb) })}><input className="input" type="number" min={256} max={memMax} step={256} value={f.memoryMb} onChange={(e) => set('memoryMb')(Number(e.target.value))} /></Field>
            {['cloud', 'iso', 'empty'].includes(source) && <Field label="Disk (GB)" hint="Grows only as it fills."><input className="input" type="number" min={1} max={16384} value={f.diskGb} onChange={(e) => set('diskGb')(Number(e.target.value))} /></Field>}
          </div>
        )}
        {memWarn && <Callout kind="warn" dismissible={false}>{t('That is more than half of this PC’s memory – other programs may get slow while the VM runs.')}</Callout>}
        {f.osType === 'windows' && ['iso', 'empty'].includes(source) && (
          <div className="card"><div className="card-body stack">
            <label className="row"><Switch checked={f.drivers} onChange={set('drivers')} /> <span className="grow">{t('Add the virtio-win drivers (faster disk and network, guest agent)')}</span><InfoTip pop title="virtio-win">{t('About 850 MB from fedorapeople.org (Red Hat). The project publishes no checksum – Hostwerk holds the checksum of each version fixed after its first download.')}</InfoTip></label>
            {source === 'iso' && <label className="row"><Switch checked={f.unattended} onChange={set('unattended')} /> <span className="grow">{t('Install Windows automatically – no clicking through setup')}</span></label>}
            {winAuto && <>
              <div className="grid grid-2">
                <Field label="Windows user" hint="Local administrator, no Microsoft account."><input className="input" value={f.winUser} onChange={set('winUser')} autoComplete="off" /></Field>
                <Field label="Windows password"><input className="input" type="password" value={f.winPassword} onChange={set('winPassword')} autoComplete="new-password" /></Field>
                <Field label="Computer name" hint="Up to 15 letters, digits or “-”."><input className="input" value={f.computerName} onChange={set('computerName')} placeholder={f.name.replace(/[^A-Za-z0-9-]/g, '').slice(0, 15) || 'windows'} /></Field>
                <Field label="Language of the ISO"><select className="select" value={f.language} onChange={set('language')}>{['de-DE', 'de-AT', 'de-CH', 'en-US', 'en-GB'].map((l) => <option key={l} value={l}>{l}</option>)}</select></Field>
                <Field label="Edition" hint="Name as on the ISO, or its number (1 = first). Evaluation ISOs: 1."><input className="input" value={f.edition} onChange={set('edition')} list="vm-editions" /><datalist id="vm-editions">{['Windows 11 Pro', 'Windows 11 Home', 'Windows 11 Education', 'Windows 11 Enterprise', 'Windows 11 Enterprise Evaluation', '1'].map((e) => <option key={e} value={e} />)}</datalist></Field>
                <Field label="Product key (optional)"><input className="input mono" value={f.productKey} onChange={set('productKey')} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" autoComplete="off" /></Field>
              </div>
              <div className="small muted">{t('Windows 11 is installed without the TPM and Secure Boot check – QEMU on Windows cannot offer a TPM. The answer file with the password is deleted after the installation.')}</div>
            </>}
          </div></div>
        )}
        {f.osType === 'windows' && source === 'iso' && !winAuto && <Callout kind="info" dismissible={false} title={t('Windows 11')}>{t('Hostwerk sets UEFI, SATA and an Intel network card – the installer finds everything. Windows 11 asks for TPM and Secure Boot: in the setup press Shift+F10 and run “reg add HKLM\\SYSTEM\\Setup\\LabConfig /v BypassTPMCheck /t REG_DWORD /d 1” (also BypassSecureBootCheck).')}</Callout>}
        {['cloud', 'iso', 'empty'].includes(source) && (
          <div className="card"><div className="card-body stack">
            <label className="row"><Switch checked={f.encrypt} onChange={set('encrypt')} /> <span className="grow">{t('Encrypt the disk')}</span><InfoTip pop title={t('Encrypted disk')}>{t('AES-256 (LUKS) inside the qcow2 file. The key stays in Hostwerk’s secret store on this PC and is handed to QEMU only for the start. Note it down afterwards under Hardware → Encryption – it is needed to move the VM to another PC. Templates and linked clones are not possible.')}</InfoTip></label>
            {nets.length > 0 && (
              <div className="grid grid-2">
                <Field label="Internal network (optional)" hint="An extra network card that only connects VMs of this PC.">
                  <select className="select" value={f.inNet} onChange={async (e) => { const id = e.target.value; let ip = ''; if (id && source === 'cloud') { try { ip = (await get(`/vms/networks/${id}/suggest`)).ip || ''; } catch { ip = ''; } } setF((x) => ({ ...x, inNet: id, inNetIp: ip })); }}>
                    <option value="">{t('none')}</option>
                    {nets.map((n) => <option key={n.id} value={n.id}>{n.name} · {n.subnet}</option>)}
                  </select>
                </Field>
                {f.inNet && <Field label="Address in this network" hint={source === 'cloud' ? 'Set by cloud-init at the first start.' : 'Linux with guest agent: set at every start; otherwise set it in the VM.'}><input className="input mono" value={f.inNetIp} onChange={set('inNetIp')} placeholder="10.10.1.10/24" /></Field>}
              </div>
            )}
          </div></div>
        )}
        {arch === 'aarch64' && <Callout kind="warn" dismissible={false} title={t('ARM64 – emulated, slow')}>{t('An x86 PC cannot accelerate ARM guests: QEMU emulates every instruction (TCG), roughly 5 to 20 times slower than a PC VM. Fine for testing ARM software, not for daily work. The first start of a ready-made ARM Linux can take 10 minutes or more.')}</Callout>}
        {engines && engines.qemu && engines.qemu.accel === 'tcg' && arch !== 'aarch64' && <Callout kind="warn" dismissible={false}>{t('No hardware acceleration – the VM will be slow. On Windows switch on “Windows Hypervisor Platform”.')}</Callout>}
        <label className="row small"><Switch checked={f.start} onChange={set('start')} /> {t('Start right after creating')} <InfoTip pop title={t('Start')}>{t('The screen opens on the VM page. Ready-made Linux VMs need about a minute for the first start (users, SSH, guest agent).')}</InfoTip></label>
      </div>
    </Modal>
  );
}
