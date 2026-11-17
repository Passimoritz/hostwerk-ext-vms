import { useEffect, useState } from 'react';
import { Monitor, Plus, Cpu, Settings2, Layers, Play, Square, Power, Pause, Camera, Trash2, Download, Zap, HardDrive, History, Import, Network, Server } from 'lucide-react';
import { post, del, put, useApi, waitJob, fmtBytes, fmtDate } from '@hostwerk/api';
import { Btn, Empty, Loading, Callout, StatusPill, MasterDetail, SideSheet, Switch, Field, StatBar, TileEmpty, confirmDialog, promptDialog, toast, InfoTip } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import { CreateDialog } from './create';
import { VmDetail } from './detail';
import { Screen } from './screen';
import { BASE, STATE, stateOf, isOn, OsIcon, mem, go, run } from './common';
import './style.css';

/*
 * Virtual machines: list on the left (QEMU VMs, templates, VirtualBox VMs), the chosen VM on the right with its
 * screen, console, snapshots, hardware, network and backups. Route: #/vms/<id>/<tab> · #/vms/vbox/<uuid>.
 */
function VmsPage({ path = [] }) {
  const { data, reload, error } = useApi('/vms');
  const { data: engines, reload: reloadEngines } = useApi('/vms/engines', [], { live: false });
  const [creating, setCreating] = useState(() => /[?&]new=1/.test(location.hash) ? {} : null);
  const [sheet, setSheet] = useState(false);
  useEffect(() => { const t0 = setInterval(() => reload({ silent: true }), 5000); return () => clearInterval(t0); }, [reload]);
  const q = engines && engines.qemu;
  const noQemu = engines && q && !q.installed;
  // Like every Hostwerk page: .page (margins, width) with .page-head (title, text, actions on the right)
  const head = (
    <div className="page-head">
      <div>
        <h1><Monitor size={22} aria-hidden="true" /> {t('Virtual machines')}</h1>
        <p>{t('Whole computers in a window: ready-made Linux in a minute, Windows and every ISO – your VirtualBox VMs right next to them.')}</p>
      </div>
      <div className="actions">
        <Btn icon={Settings2} onClick={() => setSheet(true)}>Engines & settings …</Btn>
        <Btn className="grad" icon={Plus} disabled={noQemu} onClick={() => setCreating({})}>New VM …</Btn>
      </div>
    </div>
  );
  if (error && !data) return <div className="page fade-in">{head}<Callout kind="err" dismissible={false}>{error}</Callout></div>;
  if (!data) return <div className="page fade-in">{head}<Loading /></div>;
  const vms = data.vms || [];
  const vbox = data.vbox || [];
  const hv = data.hyperv || { available: false, vms: [] };
  const hvVms = hv.vms || [];
  const [first, second] = path;
  const sel = first === 'vbox' ? { vbox: second } : first === 'hyperv' ? { hyperv: second || '' } : first ? { id: first, tab: second } : null;
  const running = vms.filter((v) => isOn(stateOf(v))).length + vbox.filter((v) => v.state === 'running').length + hvVms.filter((v) => v.state === 'running').length;

  const list = (
    <div className="vm-list">
      <div className="md-group">{t('Virtual machines')}</div>
      {!vms.length && <div className="small muted vm-list-empty">{t('None yet.')}</div>}
      {vms.filter((v) => !v.template).map((v) => <VmItem key={v.id} vm={v} active={sel && sel.id === v.id} />)}
      {vms.some((v) => v.template) && <div className="md-group">{t('Templates')}</div>}
      {vms.filter((v) => v.template).map((v) => <VmItem key={v.id} vm={v} active={sel && sel.id === v.id} />)}
      {vbox.length > 0 && <div className="md-group">VirtualBox</div>}
      {vbox.map((v) => (
        <button key={v.uuid} type="button" className={`md-item vm-item ${sel && sel.vbox === v.uuid ? 'active' : ''}`} onClick={() => go(`vbox/${v.uuid}`)}>
          <Layers size={18} aria-hidden="true" />
          <span className="grow ellipsis"><span className="vm-item-name">{v.name}</span><span className="small muted ellipsis">{v.osType}</span></span>
          <span className={`vm-dot ${v.state}`} title={t((STATE[v.state] || STATE.stopped).label)} />
        </button>
      ))}
      {hv.available && <div className="md-group">Hyper-V</div>}
      {hv.available && !hv.access && (
        <button type="button" className={`md-item vm-item ${sel && sel.hyperv === '' ? 'active' : ''}`} onClick={() => go('hyperv')}>
          <Server size={18} aria-hidden="true" />
          <span className="grow ellipsis"><span className="vm-item-name">Hyper-V</span><span className="small muted ellipsis">{t('needs administrator rights')}</span></span>
        </button>
      )}
      {hvVms.map((v) => (
        <button key={v.id} type="button" className={`md-item vm-item ${sel && sel.hyperv === v.id ? 'active' : ''}`} onClick={() => go(`hyperv/${v.id}`)}>
          <Server size={18} aria-hidden="true" />
          <span className="grow ellipsis"><span className="vm-item-name">{v.name}</span><span className="small muted ellipsis">{[v.cpus && `${v.cpus} CPU`, v.memoryMb && mem(v.memoryMb), v.generation && t('Generation {n}', { n: v.generation })].filter(Boolean).join(' · ')}</span></span>
          <span className={`vm-dot ${v.state}`} title={t((STATE[v.state] || STATE.stopped).label)} />
        </button>
      ))}
    </div>
  );

  let detail;
  if (!vms.length && !vbox.length && !hvVms.length && !sel) {
    detail = <Welcome engines={engines} onCreate={() => setCreating({})} />;
  } else if (sel && sel.hyperv !== undefined) detail = <HypervDetail id={sel.hyperv} hv={hv} reloadList={reload} />;
  else if (sel && sel.vbox) detail = <VboxDetail uuid={sel.vbox} engines={engines} reloadList={reload} onImport={(uuid) => setCreating({ source: 'vbox', uuid })} />;
  else if (sel && sel.id) detail = <VmDetail id={sel.id} tab={sel.tab} engines={engines} reloadList={reload} />;
  else if (!vms.length) detail = <Welcome engines={engines} onCreate={() => setCreating({})} />;
  else detail = <Empty icon={Monitor} title="Choose a VM" text="Or create a new one – a ready-made Linux takes about a minute." action={<Btn className="grad" icon={Plus} onClick={() => setCreating({})}>New VM …</Btn>} />;

  return (
    <div className="page fade-in vm-page">
      {head}
      <div className="vm-toolbar">
        <StatBar items={[
          { label: t('Running'), value: `${running} / ${vms.filter((v) => !v.template).length + vbox.length + hvVms.length}` },
          { label: t('Engine'), value: q ? (q.installed ? `QEMU ${q.version || ''}` : t('QEMU missing')) : '…' },
          { label: t('Acceleration'), value: q && q.installed ? (q.accel === 'tcg' ? t('none (slow)') : q.accel.toUpperCase()) : '–' },
          { label: t('This PC'), value: engines ? `${engines.host.cpus} CPU · ${mem(engines.host.memoryMb)}${engines.host.freeGb != null ? ` · ${engines.host.freeGb} GB ${t('free')}` : ''}` : '…' },
        ]} />
      </div>
      {noQemu && <InstallQemu engines={engines} onDone={() => { reloadEngines(); reload(); }} />}
      {q && q.installed && q.accel === 'tcg' && <Callout kind="warn" title={t('No hardware acceleration')}>{t('VMs run, but slowly. On Windows switch on “Windows Hypervisor Platform” (Turn Windows features on or off) and restart; on Linux add your user to the group “kvm”.')}{q.accelNote ? ` (${q.accelNote})` : ''}</Callout>}
      <MasterDetail listLabel={t('Virtual machines')} list={list} detail={detail} />
      {creating && <CreateDialog engines={engines} initial={creating} onClose={() => { setCreating(null); reload(); if (/[?&]new=1/.test(location.hash)) location.hash = BASE.slice(1); }} />}
      {sheet && <EnginesSheet engines={engines} onClose={() => setSheet(false)} reload={() => { reloadEngines(); reload(); }} />}
    </div>
  );
}

function VmItem({ vm, active }) {
  const st = stateOf(vm);
  return (
    <button type="button" className={`md-item vm-item ${active ? 'active' : ''}`} onClick={() => go(vm.id)}>
      <OsIcon vm={vm} />
      <span className="grow ellipsis"><span className="vm-item-name">{vm.name}</span><span className="small muted ellipsis">{vm.creating ? t('Creating …') : vm.busy ? t(vm.busy) : [vm.osLabel, `${vm.cpus} CPU`, mem(vm.memoryMb)].filter(Boolean).join(' · ')}</span></span>
      {!vm.template && <span className={`vm-dot ${st}`} title={t((STATE[st] || STATE.stopped).label)} />}
    </button>
  );
}

function Welcome({ engines, onCreate }) {
  return (
    <div className="vm-welcome stack">
      <Empty icon={Monitor} title="Virtual machines" text="Whole computers in a window: test Linux or Windows, run servers isolated, try things without risk – with snapshots you can always go back." action={<Btn className="grad" icon={Plus} disabled={engines && engines.qemu && !engines.qemu.installed} onClick={onCreate}>Create the first VM …</Btn>} />
      <div className="grid grid-3 vm-why">
        {[[Zap, 'Ready in a minute', 'Ready-made Linux with your user and SSH – no installer to click through.'], [History, 'Snapshots while running', 'Save the state before an update – and go back in seconds.'], [Layers, 'Templates', 'Set up once, then new VMs from it in seconds as linked clones.']].map(([I, ti, tx]) => (
          <div key={ti} className="card"><div className="card-body stack"><I size={20} aria-hidden="true" /><b>{t(ti)}</b><span className="small muted">{t(tx)}</span></div></div>
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
      {plan.method === 'winget' ? <Btn className="btn xs primary" icon={Download} busy={busy} onClick={install}>Install QEMU</Btn> : <code className="mono">{plan.command}</code>}
    </Callout>
  );
}

function EnginesSheet({ engines, onClose, reload }) {
  const { data: cat, reload: again } = useApi('/vms/catalog', [], { live: false });
  if (!engines) return null;
  const q = engines.qemu || {};
  const lan = engines.config && engines.config.lanForwards;
  const setLan = async (v) => { if (v && !(await confirmDialog({ title: t('Allow forwarding into the home network?'), text: t('Forwards marked “home network” are then reachable by every device in your network. Only for services with their own password.'), confirm: t('Allow') }))) return; await run(() => put('/vms/config', { lanForwards: v })); reload(); };
  return (
    <SideSheet title="Engines & settings" onClose={onClose}>
      <div className="stack">
        <div className="card"><div className="card-head"><Cpu size={16} aria-hidden="true" /><h3>QEMU</h3><span className="grow" /></div><div className="card-body stack small">
          {q.installed ? <>
            <div>{t('Version')} {q.version} · <span className="mono">{q.dir}</span></div>
            <div>{t('Acceleration')}: <b>{q.accel === 'tcg' ? t('none (TCG emulation)') : q.accel.toUpperCase()}</b> <InfoTip pop title={t('Acceleration')}>{t('WHPX (Windows), KVM (Linux) and HVF (macOS) run the VM directly on the processor – almost as fast as the PC itself. Without it QEMU emulates every instruction.')}</InfoTip></div>
            <div>{t('UEFI firmware')}: {q.firmware ? t('available') : t('missing')}</div>
            <div>{t('ARM64 guests')}: {q.aarch64 && q.aarch64.ok ? t('available – emulated without acceleration (slow)') : q.aarch64 ? t('qemu-system-aarch64 found, but no ARM firmware') : t('not available (qemu-system-aarch64 missing)')}</div>
            <div>{t('Snapshots with memory')}: {q.ramSnapshots ? t('yes') : t('no – this accelerator cannot save the memory; disk snapshots work while running')}</div>
          </> : <div>{t('Not installed.')} <code className="mono">{engines.install.command}</code></div>}
        </div></div>
        <HypervCard />
        <div className="card"><div className="card-head"><Layers size={16} aria-hidden="true" /><h3>VirtualBox</h3><span className="grow" /></div><div className="card-body small">{engines.vbox.installed ? t('Version {v} – its VMs are listed too and can be taken over into QEMU.', { v: engines.vbox.version }) : t('Not installed – not needed.')}</div></div>
        <div className="card"><div className="card-head"><Settings2 size={16} aria-hidden="true" /><h3>{t('Settings')}</h3><span className="grow" /></div><div className="card-body stack">
          <label className="row"><Switch checked={!!lan} onChange={setLan} /> <span className="grow">{t('Allow port forwarding into the home network')}</span></label>
          <div className="small muted">{t('VM folder')}: <span className="mono">{engines.root}</span></div>
        </div></div>
        <NetworksCard />
        <div className="card"><div className="card-head"><Download size={16} aria-hidden="true" /><h3>{t('Downloaded images')}</h3><span className="grow" /></div>
          {!(cat && cat.cache && cat.cache.length) ? <TileEmpty icon={HardDrive} text="None – images are downloaded when a VM needs them and kept for the next one." /> : (
            <div className="list-rows">{cat.cache.map((c) => (
              <div key={c.file} className="list-row-item"><HardDrive size={16} aria-hidden="true" /><div className="grow"><div className="list-row-title">{c.label}</div><div className="list-row-sub small muted">{fmtBytes(c.size)} · {fmtDate(c.t)}</div></div>
                <Btn className="btn xs ghost" icon={Trash2} aria-label={t('Delete')} onClick={async () => { await run(() => del(`/vms/images/${encodeURIComponent(c.file)}`)); again(); }} /></div>
            ))}</div>
          )}
        </div>
      </div>
    </SideSheet>
  );
}

/** Hyper-V on this PC (#21): only shown as information – Windows Home has no Hyper-V. */
function HypervCard() {
  const { data } = useApi('/vms/hyperv', [], { live: false });
  const text = !data ? '…' : !data.available ? (data.reason === 'not-windows' ? t('Only on Windows.') : t('Not available on this PC (Windows Home has no Hyper-V) – not needed.')) : data.access ? t('{n} VMs – listed next to the QEMU VMs; start, shut down and checkpoints need administrator rights.', { n: (data.vms || []).length }) : t('Installed, but listing its VMs needs administrator rights (or the group “Hyper-V Administrators”).');
  return <div className="card"><div className="card-head"><Server size={16} aria-hidden="true" /><h3>Hyper-V</h3><span className="grow" /></div><div className="card-body small">{text}</div></div>;
}

/** A Hyper-V VM (#21): read-only view, start/stop/checkpoint through PowerShell when allowed. */
function HypervDetail({ id, hv, reloadList }) {
  const [busy, setBusy] = useState(null);
  const vm = (hv.vms || []).find((v) => v.id === id);
  if (!hv.available) return <Empty icon={Server} title="Hyper-V is not available" text="This PC has no Hyper-V (Windows Home) – nothing to show." />;
  if (!vm) return <Empty icon={Server} title="Hyper-V" text={hv.access ? 'Choose a Hyper-V VM in the list.' : 'Listing Hyper-V VMs needs administrator rights – start Hostwerk as administrator or join the group “Hyper-V Administrators”, then sign in to Windows again.'} />;
  const s = STATE[vm.state] || STATE.stopped;
  const act = async (a, body) => { setBusy(a); try { await post(`/vms/hyperv/${vm.id}/${a}`, body || {}); reloadList(); } catch (e) { toast.error(e.message); } finally { setBusy(null); } };
  const checkpoint = async () => { const name = await promptDialog({ title: t('Create a checkpoint'), label: t('Name'), value: `hostwerk-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`, confirm: t('Create') }); if (name) act('checkpoint', { name }); };
  const on = vm.state === 'running' || vm.state === 'paused';
  return (
    <div className="stack">
      <div className="row vm-head">
        <span className="vm-head-icon"><Server size={22} aria-hidden="true" /></span>
        <div className="grow"><h2 className="vm-title">{vm.name} <span className="badge">Hyper-V</span></h2><div className="small muted">{[vm.cpus && `${vm.cpus} CPU`, vm.memoryMb && `${mem(vm.memoryMb)} RAM`, vm.generation && t('Generation {n}', { n: vm.generation }), vm.version && `v${vm.version}`].filter(Boolean).join(' · ')}</div></div>
        <StatusPill state={s.pill} label={t(s.label)} />
        <div className="row-tight">
          {!on ? <Btn className="btn primary" icon={Play} busy={busy === 'start'} onClick={() => act('start')}>Start</Btn> : <>
            <Btn className="btn ghost" icon={Power} busy={busy === 'turnoff'} onClick={async () => { if (await confirmDialog({ title: t('Turn off?'), text: t('Like pulling the plug.'), confirm: t('Turn off'), danger: true })) act('turnoff'); }}>Turn off</Btn>
            <Btn className="btn primary" icon={Square} busy={busy === 'stop'} onClick={() => act('stop')}>Shut down</Btn>
          </>}
          <Btn className="btn" icon={Camera} busy={busy === 'checkpoint'} onClick={checkpoint}>Checkpoint …</Btn>
        </div>
      </div>
      <Callout kind="info" dismissible={false} title={t('Read-only view')}>{t('Hostwerk lists Hyper-V VMs and can start, shut down and checkpoint them. Hyper-V allows that only to administrators (or the group “Hyper-V Administrators”) – if Windows refuses, start Hostwerk as administrator. Screen and settings stay in the Hyper-V Manager.')}</Callout>
      <div className="card"><div className="card-body small stack">
        <div>{t('State')}: {t(s.label)}{vm.status ? ` · ${vm.status}` : ''}</div>
        {vm.uptimeS > 0 && <div>{t('Running for {min} minutes', { min: Math.round(vm.uptimeS / 60) })}</div>}
        <div>{t('Checkpoints')}: {vm.checkpoints}</div>
        {vm.notes && <div className="muted">{vm.notes}</div>}
        <div className="mono muted">{vm.id}</div>
      </div></div>
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
      <div className="card-head"><Network size={16} aria-hidden="true" /><h3>{t('Internal networks')}</h3><span className="grow" /><Btn className="btn xs" icon={Plus} onClick={add}>New …</Btn></div>
      {!list.length ? <TileEmpty icon={Network} text="None yet – an internal network connects VMs of this PC with each other (e.g. web server and database)." /> : (
        <div className="list-rows">{list.map((n) => (
          <div key={n.id} className="list-row-item">
            <Network size={16} aria-hidden="true" />
            <div className="grow"><div className="list-row-title">{n.name} <span className="badge mono">{n.subnet}</span>{n.active > 0 && <span className="badge ok">{t('{n} running', { n: n.active })}</span>}</div><div className="list-row-sub small muted">{n.members.length ? n.members.map((x) => `${x.name}${x.ip ? ` (${x.ip})` : ''}`).join(', ') : t('no VMs yet')}</div></div>
            <Btn className="btn xs ghost" onClick={() => rename(n)}>Rename</Btn>
            <Btn className="btn xs ghost" icon={Trash2} aria-label={t('Delete')} disabled={n.members.length > 0} title={n.members.length ? t('VMs are still in this network') : undefined} onClick={() => remove(n)} />
          </div>
        ))}</div>
      )}
    </div>
  );
}

function VboxDetail({ uuid, engines, reloadList, onImport }) {
  const { data: vm, error, reload } = useApi(`/vms/vbox/${uuid}`, [uuid]);
  useEffect(() => { const t0 = setInterval(() => reload({ silent: true }), 5000); return () => clearInterval(t0); }, [reload]);
  if (error && !vm) return <Empty icon={Layers} title="VirtualBox VM not found" text={error} />;
  if (!vm) return <Loading />;
  const s = STATE[vm.state] || STATE.stopped;
  const on = vm.state === 'running' || vm.state === 'paused';
  const act = (a, body) => run(async () => { await post(`/vms/vbox/${uuid}/${a}`, body); await reload({ silent: true }); reloadList(); });
  const snap = async () => { const name = await promptDialog({ title: t('Take a snapshot'), label: t('Name'), value: `snap-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`, confirm: t('Take snapshot') }); if (name) act('snapshot', { action: 'take', name }); };
  const restore = async (n) => { if (await confirmDialog({ title: t('Restore “{name}”?', { name: n }), text: t('VirtualBox goes back to this state.'), confirm: t('Restore'), danger: true })) act('snapshot', { action: 'restore', name: n }); };
  return (
    <div className="stack">
      <div className="row vm-head">
        <span className="vm-head-icon"><Layers size={22} aria-hidden="true" /></span>
        <div className="grow"><h2 className="vm-title">{vm.name} <span className="badge">VirtualBox</span></h2><div className="small muted">{[vm.osType, vm.cpus && `${vm.cpus} CPU`, vm.memoryMb && `${mem(vm.memoryMb)} RAM`, vm.firmware.toUpperCase()].filter(Boolean).join(' · ')}</div></div>
        <StatusPill state={s.pill} label={t(s.label)} />
        <div className="row-tight">
          {!on ? <>
            <Btn className="btn" icon={Import} onClick={() => onImport(uuid)} disabled={vm.state !== 'stopped' && vm.state !== 'saved'}>Take over into QEMU …</Btn>
            <Btn className="btn ghost" onClick={() => act('start', { window: true })}>Start with window</Btn>
            <Btn className="btn primary" icon={Play} onClick={() => act('start')}>Start</Btn>
          </> : <>
            {vm.state === 'paused' ? <Btn className="btn" icon={Play} onClick={() => act('resume')}>Resume</Btn> : <Btn className="btn ghost" icon={Pause} onClick={() => act('pause')}>Pause</Btn>}
            <Btn className="btn ghost" onClick={() => act('savestate')}>Save state</Btn>
            <Btn className="btn ghost" icon={Power} onClick={async () => { if (await confirmDialog({ title: t('Power off?'), text: t('Like pulling the plug.'), confirm: t('Power off'), danger: true })) act('poweroff'); }}>Power off</Btn>
            <Btn className="btn primary" icon={Square} onClick={() => act('acpi')}>Shut down</Btn>
          </>}
        </div>
      </div>
      {on && vm.state === 'running' && <Screen vm={{ ...vm, id: vm.uuid }} vbox active />}
      <div className="grid grid-2">
        <div className="card"><div className="card-head"><HardDrive size={16} aria-hidden="true" /><h3>{t('Disks')}</h3><span className="grow" /></div><div className="list-rows">{vm.disks.map((d) => <div key={d.path} className="list-row-item"><HardDrive size={16} aria-hidden="true" /><div className="grow"><div className="list-row-title">{d.controller} {d.port}:{d.device}</div><div className="list-row-sub small mono ellipsis">{d.path}</div></div></div>)}</div></div>
        <div className="card"><div className="card-head"><Camera size={16} aria-hidden="true" /><h3>{t('Snapshots')}</h3><span className="grow" /><Btn className="btn sm" icon={Camera} onClick={snap}>Take snapshot …</Btn></div>
          {!vm.snapshots.length ? <TileEmpty icon={History} text="No snapshots." /> :<div className="list-rows">{vm.snapshots.map((x) => <div key={x.uuid || x.name} className="list-row-item" style={{ paddingLeft: `calc(var(--sp-4) + ${x.depth * 18}px)` }}><History size={16} aria-hidden="true" /><div className="grow"><div className="list-row-title">{x.name} {vm.currentSnapshot === x.name && <span className="badge accent">{t('current')}</span>}</div>{x.description && <div className="list-row-sub small muted">{x.description}</div>}</div>{!on && <Btn className="btn xs" onClick={() => restore(x.name)}>Restore</Btn>}</div>)}</div>}
        </div>
      </div>
      {vm.managed && <div className="row"><div className="grow" /><Btn className="btn danger sm" icon={Trash2} onClick={async () => { if (await confirmDialog({ title: t('Delete “{name}”?', { name: vm.name }), text: t('Hostwerk created this VirtualBox VM – it is deleted with its disks.'), confirm: t('Delete'), danger: true })) { if (await run(() => del(`/vms/vbox/${uuid}`))) { go(); reloadList(); } } }}>Delete …</Btn></div>}
    </div>
  );
}

/** Overview tile: running VMs with a dot each. */
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
