import { useEffect, useState } from 'react';
import { Monitor, Plus, Cpu, Settings2, Layers, Play, Square, Power, Pause, Camera, Trash2, Download, Zap, HardDrive, History, Import, Network, Server, ExternalLink } from 'lucide-react';
import { post, del, put, useApi, waitJob, fmtBytes, fmtDate, openExternal } from '@hostwerk/api';
import { Btn, Empty, Loading, Callout, StatusPill, Tabs, Switch, SettingRow, TileEmpty, confirmDialog, promptDialog, toast, InfoTip } from '@hostwerk/ui';
import { AddTile } from '@hostwerk/kit';
import { t } from '@hostwerk/i18n';
import { CreateDialog } from './create';
import { VmDetail } from './detail';
import { Screen } from './screen';
import { BASE, STATE, stateOf, isOn, OsIcon, VmLogo, ipOf, mem, go, run, Crumbs } from './common';
import './style.css';

/*
 * Virtual machines – built like Hostwerk's web server and Minecraft pages:
 *   #/vms                 overview: tabs Machines · VirtualBox · Hyper-V · Settings, service cards in a grid
 *   #/vms/<id>/<tab>      one QEMU VM on its own page (detail.jsx)
 *   #/vms/vbox/<uuid>     one VirtualBox VM · #/vms/hyperv/<id> one Hyper-V VM
 *   #/vms/virtualbox · #/vms/hyperv · #/vms/settings   the other overview tabs
 */
const LIST_TABS = ['virtualbox', 'hyperv', 'settings'];

function VmsPage({ path = [] }) {
  const { data, reload, error } = useApi('/vms');
  const { data: engines, reload: reloadEngines } = useApi('/vms/engines', [], { live: false });
  const [creating, setCreating] = useState(() => (/[?&]new=1/.test(location.hash) ? {} : null));
  useEffect(() => { const t0 = setInterval(() => reload({ silent: true }), 5000); return () => clearInterval(t0); }, [reload]);
  const [first, second] = path;
  const newVm = (initial = {}) => setCreating(initial);
  const closeCreate = () => { setCreating(null); reload(); if (/[?&]new=1/.test(location.hash)) location.hash = BASE.slice(1); };
  const dialog = creating && <CreateDialog engines={engines} initial={creating} onClose={closeCreate} />;

  // One VM on its own page
  if (first === 'vbox' && second) return <>{<VboxPage uuid={second} reloadList={reload} onImport={(uuid) => newVm({ source: 'vbox', uuid })} />}{dialog}</>;
  if (first === 'hyperv' && second) return <HypervPage id={second} hv={(data && data.hyperv) || null} reloadList={reload} />;
  if (first && !LIST_TABS.includes(first) && first !== 'vbox') return <><VmDetail id={first} tab={second} engines={engines} reloadList={reload} />{dialog}</>;

  const q = engines && engines.qemu;
  const noQemu = !!(engines && q && !q.installed);
  const vms = (data && data.vms) || [];
  const vbox = (data && data.vbox) || [];
  const hv = (data && data.hyperv) || { available: false, vms: [] };
  const machines = vms.filter((v) => !v.template);
  const templates = vms.filter((v) => v.template);
  const vboxInstalled = !!(engines && engines.vbox && engines.vbox.installed);
  const tab = LIST_TABS.includes(first) ? first : 'machines';
  const tabs = [
    { id: 'machines', label: t('Machines'), icon: Monitor, badge: machines.length || undefined },
    ...(vboxInstalled || vbox.length ? [{ id: 'virtualbox', label: 'VirtualBox', icon: Layers, badge: vbox.length || undefined }] : []),
    ...(hv.available ? [{ id: 'hyperv', label: 'Hyper-V', icon: Server, badge: (hv.vms || []).length || undefined }] : []),
    { id: 'settings', label: t('Settings'), icon: Settings2 },
  ];

  return (
    <div className="page fade-in vm-page">
      <div className="page-head">
        <div>
          <h1><Monitor size={22} aria-hidden="true" /> {t('Virtual machines')}</h1>
          <p>{t('Whole computers in a window: ready-made Linux in a minute, Windows and every ISO – your VirtualBox VMs right next to them.')}</p>
        </div>
        <div className="actions">
          {q && q.installed && <span className="badge" title={t('Hardware acceleration')}>QEMU {q.version} · {q.accel === 'tcg' ? t('no acceleration') : q.accel.toUpperCase()}</span>}
          <Btn className="grad" icon={Plus} disabled={noQemu} onClick={() => newVm()}>New VM …</Btn>
        </div>
      </div>
      {noQemu && <InstallQemu engines={engines} onDone={() => { reloadEngines(); reload(); }} />}
      {q && q.installed && q.accel === 'tcg' && <Callout kind="warn" title={t('No hardware acceleration')}>{t('VMs run, but slowly. On Windows switch on “Windows Hypervisor Platform” (Turn Windows features on or off) and restart; on Linux add your user to the group “kvm”.')}{q.accelNote ? ` (${q.accelNote})` : ''}</Callout>}
      <Tabs value={tab} onChange={(v) => go(v === 'machines' ? '' : v)} tabs={tabs} />
      {error && !data ? <Callout kind="err" dismissible={false}>{error}</Callout> : !data ? <Loading /> : <>
        {tab === 'machines' && (machines.length || templates.length
          ? <Machines machines={machines} templates={templates} noQemu={noQemu} onNew={newVm} reload={reload} />
          : <Welcome noQemu={noQemu} onCreate={() => newVm()} hasVbox={vbox.length > 0} />)}
        {tab === 'virtualbox' && <VboxList list={vbox} installed={vboxInstalled} reload={reload} onImport={(uuid) => newVm({ source: 'vbox', uuid })} />}
        {tab === 'hyperv' && <HypervList hv={hv} />}
        {tab === 'settings' && <SettingsTab engines={engines} reload={() => { reloadEngines(); reload(); }} />}
      </>}
      {dialog}
    </div>
  );
}

/* ------------------------------------------------------------------ Machines (service cards) */
function Machines({ machines, templates, noQemu, onNew, reload }) {
  return (
    <div className="stack">
      <div className="grid grid-auto">
        {machines.map((v) => <VmCard key={v.id} vm={v} reload={reload} />)}
        {!noQemu && <AddTile onClick={() => onNew()} title={t('Another VM')} text={t('Ready-made Linux in a minute, any ISO or a VirtualBox VM')} chips={[{ label: 'Debian', color: '#d70a53' }, { label: 'Ubuntu', color: '#e95420' }, { label: 'Windows', color: '#0078d4' }, { label: 'ISO', color: '#0ea5e9' }, { label: 'VirtualBox', color: '#2563eb' }]} />}
      </div>
      {templates.length > 0 && <>
        <h3 className="vm-section">{t('Templates')} <InfoTip pop title={t('Templates')}>{t('Set up once, then new VMs from it in seconds as linked clones.')}</InfoTip></h3>
        <div className="grid grid-auto">{templates.map((v) => <VmCard key={v.id} vm={v} reload={reload} onFromTemplate={() => onNew({ source: 'template', template: v.id })} />)}</div>
      </>}
    </div>
  );
}

function VmCard({ vm, reload, onFromTemplate }) {
  const [busy, setBusy] = useState(null);
  const st = stateOf(vm);
  const on = isOn(st);
  const s = STATE[st] || STATE.stopped;
  const label = vm.creating ? t('Creating …') : vm.busy ? t(vm.busy) : t(s.label);
  const ip = ipOf(vm);
  const ssh = (vm.net && vm.net.forwards || []).find((f) => f.guest === 22 && f.proto === 'tcp');
  const act = async (p) => { setBusy(p); await run(() => post(`/vms/${vm.id}/${p}`)); setBusy(null); reload({ silent: true }); };
  const app = vm.appInfo && vm.appInfo.open;
  return (
    <div className={`card svc-card vm-card ${s.pill}`} onClick={() => go(vm.id)}>
      <div className="svc-top">
        <VmLogo vm={vm} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="svc-title ellipsis">{vm.name}</div>
          <div className="small muted ellipsis">{[vm.osLabel || (vm.osType === 'windows' ? 'Windows' : vm.osType === 'linux' ? 'Linux' : t('Other system')), vm.arch === 'aarch64' ? 'ARM64' : null, vm.appInfo ? t(vm.appInfo.label) : null].filter(Boolean).join(' · ')}</div>
        </div>
        {!vm.template && <StatusPill state={vm.creating || vm.busy ? 'starting' : s.pill} label={label} />}
        {vm.template && <span className="badge accent">{t('Template')}</span>}
      </div>
      <div className="svc-meta">
        <div><div className="k">{t('Hardware')}</div><div className="v">{vm.cpus} CPU · {mem(vm.memoryMb)}</div></div>
        <div><div className="k">{t('Address')}</div><div className="v mono small">{ip || (ssh ? `SSH :${ssh.host}` : '–')}</div></div>
        <div><div className="k">{t('Snapshots')}</div><div className="v">{(vm.snapshots || []).length}</div></div>
      </div>
      <div className="svc-actions" onClick={(e) => e.stopPropagation()}>
        {vm.template ? <Btn className="sm primary" icon={Plus} onClick={onFromTemplate}>New VM from it …</Btn>
          : vm.creating || vm.busy ? <span className="small muted">{label}</span>
            : !on ? <Btn className="sm primary" icon={Play} busy={busy === 'start'} disabled={vm.broken} onClick={() => act('start')}>Start</Btn>
              : <>
                <Btn className="sm" icon={Square} busy={busy === 'stop'} onClick={() => act('stop')}>Shut down</Btn>
                <Btn className="sm ghost" icon={Monitor} onClick={() => go(`${vm.id}/screen`)}>Screen</Btn>
              </>}
        {on && app && <button type="button" className="btn sm ghost right" onClick={() => openExternal(app.url)}><ExternalLink />{t(app.label)}</button>}
      </div>
    </div>
  );
}

function Welcome({ noQemu, onCreate, hasVbox }) {
  return (
    <div className="stack vm-welcome">
      <div className="card">
        <Empty icon={Monitor} title="No virtual machine yet" text="Whole computers in a window: test Linux or Windows, run servers isolated, try things without risk – with snapshots you can always go back."
          action={<div className="row-tight">
            <Btn className="grad" icon={Plus} disabled={noQemu} onClick={onCreate}>Create the first VM …</Btn>
            {hasVbox && <Btn icon={Layers} onClick={() => go('virtualbox')}>Your VirtualBox VMs</Btn>}
          </div>} />
      </div>
      <div className="grid grid-3">
        {[[Zap, '#16a34a', 'Ready in a minute', 'Ready-made Linux with your user and SSH – no installer to click through.'], [History, '#0ea5e9', 'Snapshots while running', 'Save the state before an update – and go back in seconds.'], [Layers, '#8b5cf6', 'Templates', 'Set up once, then new VMs from it in seconds as linked clones.']].map(([I, c, ti, tx]) => (
          <div key={ti} className="card"><div className="card-body vm-why">
            <span className="engine-ico" style={{ '--c': c }}><I size={18} aria-hidden="true" /></span>
            <div><b>{t(ti)}</b><div className="small muted">{t(tx)}</div></div>
          </div></div>
        ))}
      </div>
    </div>
  );
}

function InstallQemu({ engines, onDone }) {
  const [busy, setBusy] = useState(false);
  const plan = engines.install || {};
  const install = async () => {
    setBusy(true);
    try { const r = await post('/vms/engines/install-qemu'); const j = await waitJob(r.job); if (j && j.state === 'done') toast.success(t('QEMU is installed')); onDone(); } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  return (
    <Callout kind="warn" title={t('QEMU is needed')} dismissible={false}>
      {t('Hostwerk runs VMs with QEMU – free, open source and fast with the hypervisor of your system.')}{' '}
      {plan.method === 'winget' ? <Btn className="xs primary" icon={Download} busy={busy} onClick={install}>Install QEMU</Btn> : <code className="mono">{plan.command}</code>}
    </Callout>
  );
}

/* ------------------------------------------------------------------ VirtualBox */
const HV_COLOR = '#0078d4';
function VboxList({ list, installed, reload, onImport }) {
  if (!installed && !list.length) return <div className="card"><Empty icon={Layers} title="VirtualBox is not installed" text="Not needed – Hostwerk runs VMs with QEMU. With VirtualBox installed, its VMs show up here and can be taken over." /></div>;
  if (!list.length) return <div className="card"><Empty icon={Layers} title="No VirtualBox VM" text="VirtualBox has no VMs yet – the ones you create there show up here." /></div>;
  return (
    <div className="stack">
      <div className="small muted">{t('Hostwerk starts and stops these VMs through VirtualBox and takes them over into QEMU on request – it only deletes VMs it created itself.')}</div>
      <div className="grid grid-auto">
        {list.map((v) => {
          const s = STATE[v.state] || STATE.stopped;
          const on = v.state === 'running' || v.state === 'paused';
          const act = (a) => run(async () => { await post(`/vms/vbox/${v.uuid}/${a}`); reload({ silent: true }); });
          return (
            <div key={v.uuid} className={`card svc-card vm-card ${s.pill}`} onClick={() => go(`vbox/${v.uuid}`)}>
              <div className="svc-top">
                <VmLogo vboxUuid={v.uuid} osType={v.osType} />
                <div className="grow" style={{ minWidth: 0 }}><div className="svc-title ellipsis">{v.name}</div><div className="small muted ellipsis">{v.osType}</div></div>
                <StatusPill state={s.pill} label={t(s.label)} />
              </div>
              <div className="svc-actions" onClick={(e) => e.stopPropagation()}>
                {!on ? <Btn className="sm primary" icon={Play} onClick={() => act('start')}>Start</Btn> : <Btn className="sm" icon={Square} onClick={() => act('acpi')}>Shut down</Btn>}
                {!on && <Btn className="sm ghost" icon={Import} onClick={() => onImport(v.uuid)}>Take over …</Btn>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function VboxPage({ uuid, reloadList, onImport }) {
  const { data: vm, error, reload } = useApi(`/vms/vbox/${uuid}`, [uuid]);
  useEffect(() => { const t0 = setInterval(() => reload({ silent: true }), 5000); return () => clearInterval(t0); }, [reload]);
  if (error && !vm) return <NotFound title="VirtualBox VM not found" text={error} back="virtualbox" />;
  if (!vm) return <div className="page"><Loading /></div>;
  const s = STATE[vm.state] || STATE.stopped;
  const on = vm.state === 'running' || vm.state === 'paused';
  const act = (a, body) => run(async () => { await post(`/vms/vbox/${uuid}/${a}`, body); await reload({ silent: true }); reloadList(); });
  const snap = async () => { const name = await promptDialog({ title: t('Take a snapshot'), label: t('Name'), value: `snap-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`, confirm: t('Take snapshot') }); if (name) act('snapshot', { action: 'take', name }); };
  const restore = async (n) => { if (await confirmDialog({ title: t('Restore “{name}”?', { name: n }), text: t('VirtualBox goes back to this state.'), confirm: t('Restore'), danger: true })) act('snapshot', { action: 'restore', name: n }); };
  const remove = async () => { if (await confirmDialog({ title: t('Delete “{name}”?', { name: vm.name }), text: t('Hostwerk created this VirtualBox VM – it is deleted with its disks.'), confirm: t('Delete'), danger: true })) { if (await run(() => del(`/vms/vbox/${uuid}`))) { go('virtualbox'); reloadList(); } } };
  return (
    <div className="page fade-in vm-page">
      <div className="page-head">
        <div>
          <Crumbs items={[['virtualbox', 'VirtualBox'], [null, vm.name]]} />
          <h1><VmLogo vboxUuid={uuid} osType={vm.osType} small /> {vm.name} <StatusPill state={s.pill} label={t(s.label)} /></h1>
          <p>{[vm.osType, vm.cpus && `${vm.cpus} CPU`, vm.memoryMb && `${mem(vm.memoryMb)} RAM`, vm.firmware && vm.firmware.toUpperCase(), 'VirtualBox'].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="actions">
          {!on ? <>
            <Btn icon={Import} onClick={() => onImport(uuid)} disabled={vm.state !== 'stopped' && vm.state !== 'saved'}>Take over into QEMU …</Btn>
            <Btn className="ghost" onClick={() => act('start', { window: true })}>Start with window</Btn>
            <Btn className="primary" icon={Play} onClick={() => act('start')}>Start</Btn>
          </> : <>
            {vm.state === 'paused' ? <Btn icon={Play} onClick={() => act('resume')}>Resume</Btn> : <Btn className="ghost" icon={Pause} onClick={() => act('pause')}>Pause</Btn>}
            <Btn className="ghost" onClick={() => act('savestate')}>Save state</Btn>
            <Btn className="ghost" icon={Power} title={t('Power off')} aria-label={t('Power off')} onClick={async () => { if (await confirmDialog({ title: t('Power off?'), text: t('Like pulling the plug.'), confirm: t('Power off'), danger: true })) act('poweroff'); }} />
            <Btn className="primary" icon={Square} onClick={() => act('acpi')}>Shut down</Btn>
          </>}
        </div>
      </div>
      <div className="stack">
        {vm.state === 'running' && <Screen vm={{ ...vm, id: vm.uuid }} vbox active />}
        <div className="grid grid-2">
          <div className="card"><div className="card-head"><HardDrive size={16} aria-hidden="true" /><h3>{t('Disks')}</h3><span className="grow" /></div>
            {!vm.disks.length ? <TileEmpty icon={HardDrive} text="No disk." /> : <div className="list-rows">{vm.disks.map((d) => <div key={d.path} className="list-row-item"><HardDrive size={16} aria-hidden="true" /><div className="grow" style={{ minWidth: 0 }}><div className="list-row-title">{d.controller} {d.port}:{d.device}</div><div className="list-row-sub small mono ellipsis">{d.path}</div></div></div>)}</div>}
          </div>
          <div className="card"><div className="card-head"><Camera size={16} aria-hidden="true" /><h3>{t('Snapshots')}</h3><span className="grow" /><Btn className="sm" icon={Camera} onClick={snap}>Take snapshot …</Btn></div>
            {!vm.snapshots.length ? <TileEmpty icon={History} text="No snapshots." /> : <div className="list-rows">{vm.snapshots.map((x) => <div key={x.uuid || x.name} className="list-row-item" style={{ paddingLeft: `calc(var(--sp-4) + ${x.depth * 18}px)` }}><History size={16} aria-hidden="true" /><div className="grow"><div className="list-row-title">{x.name} {vm.currentSnapshot === x.name && <span className="badge accent">{t('current')}</span>}</div>{x.description && <div className="list-row-sub small muted">{x.description}</div>}</div>{!on && <Btn className="xs" onClick={() => restore(x.name)}>Restore</Btn>}</div>)}</div>}
          </div>
        </div>
        {vm.managed ? <div className="row"><span className="grow small muted">{t('Created by Hostwerk.')}</span><Btn className="danger sm" icon={Trash2} onClick={remove}>Delete …</Btn></div>
          : <div className="small muted">{t('Created in VirtualBox – Hostwerk does not delete it. Take it over into QEMU to manage it fully here.')}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Hyper-V */
function HypervList({ hv }) {
  if (!hv.access) return <div className="card"><Empty icon={Server} title="Hyper-V needs administrator rights" text="Listing Hyper-V VMs needs administrator rights – start Hostwerk as administrator or join the group “Hyper-V Administrators”, then sign in to Windows again." /></div>;
  if (!(hv.vms || []).length) return <div className="card"><Empty icon={Server} title="No Hyper-V VM" text="Hyper-V has no VMs on this PC." /></div>;
  return (
    <div className="grid grid-auto">
      {hv.vms.map((v) => {
        const s = STATE[v.state] || STATE.stopped;
        return (
          <div key={v.id} className={`card svc-card vm-card ${s.pill}`} onClick={() => go(`hyperv/${v.id}`)}>
            <div className="svc-top">
              <div className="svc-icon" style={{ background: `linear-gradient(135deg, ${HV_COLOR}, ${HV_COLOR}aa)` }}><Server size={20} aria-hidden="true" /></div>
              <div className="grow" style={{ minWidth: 0 }}><div className="svc-title ellipsis">{v.name}</div><div className="small muted ellipsis">{[v.cpus && `${v.cpus} CPU`, v.memoryMb && mem(v.memoryMb), v.generation && t('Generation {n}', { n: v.generation })].filter(Boolean).join(' · ')}</div></div>
              <StatusPill state={s.pill} label={t(s.label)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HypervPage({ id, hv, reloadList }) {
  const [busy, setBusy] = useState(null);
  if (!hv) return <div className="page"><Loading /></div>;
  const vm = (hv.vms || []).find((v) => v.id === id);
  if (!hv.available || !vm) return <NotFound title="Hyper-V VM not found" text={hv.available ? 'It may have been removed in the Hyper-V Manager.' : 'This PC has no Hyper-V (Windows Home) – nothing to show.'} back={hv.available ? 'hyperv' : ''} />;
  const s = STATE[vm.state] || STATE.stopped;
  const act = async (a, body) => { setBusy(a); try { await post(`/vms/hyperv/${vm.id}/${a}`, body || {}); reloadList(); } catch (e) { toast.error(e.message); } finally { setBusy(null); } };
  const checkpoint = async () => { const name = await promptDialog({ title: t('Create a checkpoint'), label: t('Name'), value: `hostwerk-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`, confirm: t('Create') }); if (name) act('checkpoint', { name }); };
  const on = vm.state === 'running' || vm.state === 'paused';
  return (
    <div className="page fade-in vm-page">
      <div className="page-head">
        <div>
          <Crumbs items={[['hyperv', 'Hyper-V'], [null, vm.name]]} />
          <h1><span className="svc-icon vm-h1-icon" style={{ background: `linear-gradient(135deg, ${HV_COLOR}, ${HV_COLOR}aa)` }}><Server size={18} aria-hidden="true" /></span> {vm.name} <StatusPill state={s.pill} label={t(s.label)} /></h1>
          <p>{[vm.cpus && `${vm.cpus} CPU`, vm.memoryMb && `${mem(vm.memoryMb)} RAM`, vm.generation && t('Generation {n}', { n: vm.generation }), vm.version && `v${vm.version}`, 'Hyper-V'].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="actions">
          <Btn icon={Camera} busy={busy === 'checkpoint'} onClick={checkpoint}>Checkpoint …</Btn>
          {!on ? <Btn className="primary" icon={Play} busy={busy === 'start'} onClick={() => act('start')}>Start</Btn> : <>
            <Btn className="ghost" icon={Power} busy={busy === 'turnoff'} onClick={async () => { if (await confirmDialog({ title: t('Turn off?'), text: t('Like pulling the plug.'), confirm: t('Turn off'), danger: true })) act('turnoff'); }}>Turn off</Btn>
            <Btn className="primary" icon={Square} busy={busy === 'stop'} onClick={() => act('stop')}>Shut down</Btn>
          </>}
        </div>
      </div>
      <div className="stack">
        <Callout kind="info" dismissible={false} title={t('Read-only view')}>{t('Hostwerk lists Hyper-V VMs and can start, shut down and checkpoint them. Hyper-V allows that only to administrators (or the group “Hyper-V Administrators”) – if Windows refuses, start Hostwerk as administrator. Screen and settings stay in the Hyper-V Manager.')}</Callout>
        <div className="card"><div className="card-body small stack">
          <div>{t('State')}: {t(s.label)}{vm.status ? ` · ${vm.status}` : ''}</div>
          {vm.uptimeS > 0 && <div>{t('Running for {min} minutes', { min: Math.round(vm.uptimeS / 60) })}</div>}
          <div>{t('Checkpoints')}: {vm.checkpoints}</div>
          {vm.notes && <div className="muted">{vm.notes}</div>}
          <div className="mono muted">{vm.id}</div>
        </div></div>
      </div>
    </div>
  );
}

function NotFound({ title, text, back = '' }) {
  return (
    <div className="page fade-in vm-page">
      <div className="card"><Empty icon={Monitor} title={title} text={text} action={<Btn onClick={() => go(back)}>Back to the overview</Btn>} /></div>
    </div>
  );
}

/* ------------------------------------------------------------------ Settings tab (engines, networks, images) */
function SettingsTab({ engines, reload }) {
  const { data: cat, reload: again } = useApi('/vms/catalog', [], { live: false });
  const { data: hvInfo } = useApi('/vms/hyperv', [], { live: false });
  if (!engines) return <Loading />;
  const q = engines.qemu || {};
  const lan = engines.config && engines.config.lanForwards;
  const setLan = async (v) => { if (v && !(await confirmDialog({ title: t('Allow forwarding into the home network?'), text: t('Forwards marked “home network” are then reachable by every device in your network. Only for services with their own password.'), confirm: t('Allow') }))) return; await run(() => put('/vms/config', { lanForwards: v })); reload(); };
  const hvText = !hvInfo ? '…' : !hvInfo.available ? (hvInfo.reason === 'not-windows' ? t('Only on Windows.') : t('Not available on this PC (Windows Home has no Hyper-V) – not needed.')) : hvInfo.access ? t('{n} VMs – listed next to the QEMU VMs; start, shut down and checkpoints need administrator rights.', { n: (hvInfo.vms || []).length }) : t('Installed, but listing its VMs needs administrator rights (or the group “Hyper-V Administrators”).');
  return (
    <div className="grid grid-2">
      <div className="stack">
        <div className="card"><div className="card-head"><Cpu size={16} aria-hidden="true" /><h3>{t('Engines')}</h3><span className="grow" /></div>
          <div className="card-body">
            <SettingRow title="QEMU" text={q.installed ? `${t('Version')} ${q.version} · ${q.dir}` : t('Not installed.')}>
              {q.installed && <span className={`badge ${q.accel === 'tcg' ? 'warn' : 'ok'}`}>{q.accel === 'tcg' ? t('no acceleration') : q.accel.toUpperCase()}</span>}
            </SettingRow>
            {q.installed && <>
              <SettingRow title={t('UEFI firmware')} text={t('Needed for Windows 11 and other UEFI systems.')}><span className={`badge ${q.firmware ? 'ok' : 'warn'}`}>{q.firmware ? t('available') : t('missing')}</span></SettingRow>
              <SettingRow title={t('ARM64 guests')} text={q.aarch64 && q.aarch64.ok ? t('available – emulated without acceleration (slow)') : q.aarch64 ? t('qemu-system-aarch64 found, but no ARM firmware') : t('not available (qemu-system-aarch64 missing)')} />
              <SettingRow title={t('Snapshots with memory')} text={q.ramSnapshots ? t('yes') : t('no – this accelerator cannot save the memory; disk snapshots work while running')} />
            </>}
            <SettingRow title="VirtualBox" text={engines.vbox.installed ? t('Version {v} – its VMs are listed too and can be taken over into QEMU.', { v: engines.vbox.version }) : t('Not installed – not needed.')} />
            <SettingRow title="Hyper-V" text={hvText} />
          </div>
        </div>
        <div className="card"><div className="card-head"><Settings2 size={16} aria-hidden="true" /><h3>{t('Settings')}</h3><span className="grow" /></div>
          <div className="card-body">
            <SettingRow title={t('Allow port forwarding into the home network')} text={t('Forwards marked “home network” are then reachable by every device in your network.')}><Switch checked={!!lan} onChange={setLan} /></SettingRow>
            <SettingRow title={t('VM folder')} text={<span className="mono">{engines.root}</span>} />
          </div>
        </div>
      </div>
      <div className="stack">
        <NetworksCard />
        <div className="card"><div className="card-head"><Download size={16} aria-hidden="true" /><h3>{t('Downloaded images')}</h3><span className="grow" /></div>
          {!(cat && cat.cache && cat.cache.length) ? <TileEmpty icon={HardDrive} text="None – images are downloaded when a VM needs them and kept for the next one." /> : (
            <div className="list-rows">{cat.cache.map((c) => (
              <div key={c.file} className="list-row-item"><HardDrive size={16} aria-hidden="true" /><div className="grow"><div className="list-row-title">{c.label}</div><div className="list-row-sub small muted">{fmtBytes(c.size)} · {fmtDate(c.t)}</div></div>
                <Btn className="xs ghost" icon={Trash2} aria-label={t('Delete')} title={t('Delete')} onClick={async () => { await run(() => del(`/vms/images/${encodeURIComponent(c.file)}`)); again(); }} /></div>
            ))}</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Internal networks of this PC (#7): VMs in the same network reach each other directly; nothing leaves the PC. */
function NetworksCard() {
  const { data, reload } = useApi('/vms/networks', [], { live: false });
  const list = (data && data.networks) || [];
  const add = async () => { const name = await promptDialog({ title: t('New internal network'), text: t('VMs in the same internal network reach each other directly – nothing leaves this PC.'), label: t('Name'), value: '', confirm: t('Create') }); if (name && await run(() => post('/vms/networks', { name }), 'Created')) reload(); };
  const rename = async (n) => { const name = await promptDialog({ title: t('Rename network'), label: t('Name'), value: n.name, confirm: t('Save') }); if (name && await run(() => put(`/vms/networks/${n.id}`, { name }))) reload(); };
  const remove = async (n) => { if (await confirmDialog({ title: t('Delete network “{name}”?', { name: n.name }), confirm: t('Delete'), danger: true })) { if (await run(() => del(`/vms/networks/${n.id}`))) reload(); } };
  return (
    <div className="card">
      <div className="card-head"><Network size={16} aria-hidden="true" /><h3>{t('Internal networks')}</h3><span className="grow" /><Btn className="sm" icon={Plus} onClick={add}>New …</Btn></div>
      {!list.length ? <TileEmpty icon={Network} text="None yet – an internal network connects VMs of this PC with each other (e.g. web server and database)." /> : (
        <div className="list-rows">{list.map((n) => (
          <div key={n.id} className="list-row-item">
            <Network size={16} aria-hidden="true" />
            <div className="grow"><div className="list-row-title">{n.name} <span className="badge mono">{n.subnet}</span>{n.active > 0 && <span className="badge ok">{t('{n} running', { n: n.active })}</span>}</div><div className="list-row-sub small muted">{n.members.length ? n.members.map((x) => `${x.name}${x.ip ? ` (${x.ip})` : ''}`).join(', ') : t('no VMs yet')}</div></div>
            <Btn className="xs ghost" onClick={() => rename(n)}>Rename</Btn>
            <Btn className="xs ghost" icon={Trash2} aria-label={t('Delete')} disabled={n.members.length > 0} title={n.members.length ? t('VMs are still in this network') : t('Delete')} onClick={() => remove(n)} />
          </div>
        ))}</div>
      )}
    </div>
  );
}

/** Overview tile: VMs with their state. */
function VmsTile() {
  const { data } = useApi('/vms');
  if (!data) return null;
  const vms = (data.vms || []).filter((v) => !v.template);
  if (!vms.length) return <TileEmpty icon={Monitor} text="No virtual machine yet." action="Create VM" href="#/vms?new=1" />;
  return (
    <div className="card-body list-rows">
      {vms.slice(0, 6).map((v) => { const st = stateOf(v); return (
        <a key={v.id} className="list-row-item" href={`#/vms/${v.id}`}><OsIcon vm={v} size={16} /><span className="grow ellipsis">{v.name}</span><span className={`vm-dot ${st}`} /><span className="small muted">{t((STATE[st] || STATE.stopped).label)}</span></a>
      ); })}
    </div>
  );
}

export default {
  pages: { main: VmsPage },
  slots: {
    'dashboard.tiles': [{ id: 'vms', title: 'Virtual machines', icon: Monitor, size: 'third', Component: VmsTile }],
  },
  nav: {
    tip: (o) => {
      const kind = o && o.kinds && o.kinds.vm;
      const list = kind ? kind.items || [] : null;
      return { text: t('Virtual machines with QEMU – and your VirtualBox VMs.'), lines: list && list.map((v) => ({ name: v.name, state: v.state === 'running' ? 'running' : 'stopped', text: v.osLabel || '' })) };
    },
  },
};
