import { useEffect, useRef, useState } from 'react';
import { Play, Square, Power, Pause, RotateCcw, Camera, Trash2, Copy, Box, Disc3, Plus, HardDrive, Network, Archive, Terminal, ScrollText, LayoutDashboard, Monitor, Cpu, MemoryStick, History, Download, Upload, Layers, FolderOpen, KeyRound, Settings2, AppWindow, ExternalLink, Sparkles, ArrowLeftRight, Cable, Clock, Disc, Gauge, Globe, Info, Keyboard, Lock, MoreHorizontal, Plug, SlidersHorizontal, StickyNote, SquareTerminal } from 'lucide-react';
import { get, post, put, del, useApi, useLogs, waitJob, pickPath, canPickPath, fmtDate, fmtBytes, apiUrl } from '@hostwerk/api';
import { Btn, Tabs, StatusPill, Field, Seg, Switch, Callout, Empty, Loading, Modal, confirmDialog, promptDialog, toast, InfoTip, SettingRow, Sparkline } from '@hostwerk/ui';
import { Console as LogConsole, runInTerminal, useAiReady, openAiPanel, useAiContext } from '@hostwerk/kit';
import { t } from '@hostwerk/i18n';
import { Screen, PausedNote } from './screen';
import { VncScreen } from './vnc';
import { STATE, stateOf, isOn, OsIcon, VmLogo, ipOf, Crumbs, mem, gb, copy, run, go } from './common';
import { removeVm, cloneVm as cloneAction, toggleTemplate, exportVm, moveVm } from './menu';
import { CreateDialog } from './create';

/*
 * One VM on its own page – like Hostwerk's web server and Minecraft pages: breadcrumbs, name with state, the power
 * actions on the right, a few main tabs; related views sit together as sub-tabs (screen · serial console · commands,
 * snapshots · backups). Addresses stay #/vms/<id>/<sub>.
 */
const groupsOf = (vm) => [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, subs: [['overview']] },
  ...(vm.template ? [] : [{ id: 'screen', label: 'Screen', icon: Monitor, subs: [['screen', 'Screen', Monitor], ['console', 'Serial console', Terminal], ['guest', 'Commands in the VM', SquareTerminal]] }]),
  { id: 'snapshots', label: 'Snapshots', title: 'Snapshots & backups', icon: History, badge: (vm.snapshots || []).length || undefined, subs: [['snapshots', 'Snapshots', History], ['backups', 'Backups', Archive]] },
  { id: 'hardware', label: 'Hardware', icon: Cpu, subs: [['hardware']] },
  { id: 'network', label: 'Network', icon: Network, subs: [['network']] },
  { id: 'log', label: 'Log', icon: ScrollText, subs: [['log']] },
];

export function VmDetail({ id, tab, engines, reloadList }) {
  const { data: vm, error, reload } = useApi(`/vms/${id}`, [id]);
  const [dialog, setDialog] = useState(null);
  const [pngScreen, setPngScreen] = useState(false);
  const [askAi, setAskAi] = useState(false);
  const aiReady = useAiReady();
  useEffect(() => setPngScreen(false), [id]);
  // another tab or VM starts at the top (Hostwerk keeps the scroll position within one page – Hardware opened half way down)
  useEffect(() => { const el = document.getElementById('hauptinhalt'); if (el) el.scrollTop = 0; }, [id, tab]);
  // Ctrl+J attaches this VM (own @ source "vm" of the extension: state, agent, serial console as text)
  useAiContext(vm && vm.id === id ? { kind: 'vm', id: vm.id, label: vm.name } : null);
  useEffect(() => { const t0 = setInterval(() => reload({ silent: true }), 4000); return () => clearInterval(t0); }, [reload]);
  if (error && !vm) {
    return (
      <div className="page fade-in vm-page">
        <div className="card"><Empty icon={Monitor} title="VM not found" text={error} action={<Btn onClick={() => go()}>Back to the overview</Btn>} /></div>
      </div>
    );
  }
  if (!vm || vm.id !== id) return <div className="page"><Loading /></div>;
  const st = stateOf(vm);
  const on = isOn(st);
  const groups = groupsOf(vm);
  const known = groups.some((g) => g.subs.some(([sid]) => sid === tab));
  const cur = known ? tab : on && !vm.template ? 'screen' : 'overview';
  const group = groups.find((g) => g.subs.some(([sid]) => sid === cur)) || groups[0];
  const act = (p, body, ok) => run(async () => { await post(`/vms/${id}/${p}`, body); await reload({ silent: true }); reloadList(); }, ok);
  const powerOff = async () => { if (await confirmDialog({ title: t('Power off “{name}”?', { name: vm.name }), text: t('Like pulling the plug – data the VM has not saved is lost.'), confirm: t('Power off'), danger: true })) act('poweroff'); };
  const reset = async () => { if (await confirmDialog({ title: t('Reset “{name}”?', { name: vm.name }), text: t('Restarts the VM at once, like the reset button of a PC – unsaved data is lost.'), confirm: t('Reset'), danger: true })) act('reset'); };
  const remove = () => removeVm(vm, () => { go(); reloadList(); });
  const cloneVm = (linked) => cloneAction(vm, linked, reloadList);
  const busy = vm.busy || vm.creating;
  const s = STATE[st] || STATE.stopped;
  const ip = ipOf(vm);
  const goTab = (x) => go(`${id}/${x}`);

  return (
    <div className="page fade-in vm-page">
      <div className="page-head">
        <div>
          <Crumbs items={vm.template ? [[null, t('Templates')], [null, vm.name]] : [[null, vm.name]]} />
          <h1>
            <VmLogo vm={vm} small /> {vm.name}{' '}
            {vm.template ? <span className="badge accent">{t('Template')}</span> : <StatusPill state={busy ? 'starting' : s.pill} label={t(busy ? (vm.creating ? 'Creating' : vm.busy) : s.label)} />}
            {vm.linkedTo && <span className="badge">{t('Linked clone')}</span>}
            {vm.arch === 'aarch64' && <span className="badge warn" title={t('No hardware acceleration for ARM on this PC – emulated, slow.')}>{t('ARM64 · emulated')}</span>}
          </h1>
          <p>{[vm.osLabel || (vm.osType === 'windows' ? 'Windows' : vm.osType === 'linux' ? 'Linux' : t('Other system')), `${vm.cpus} CPU`, `${mem(vm.memoryMb)} RAM`, on && vm.status && vm.status.accel ? vm.status.accel.toUpperCase() : null, ip].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="actions">
          {vm.template ? <Btn className="grad" icon={Plus} onClick={() => setDialog({ source: 'template', template: vm.id })}>New VM from template …</Btn>
            : !on ? <Btn className="primary" icon={Play} disabled={!!busy || vm.broken || (vm.encryption && vm.encryption.locked)} onClick={() => act('start', {}, null)}>Start</Btn>
              : <>
                {st === 'paused' ? <Btn icon={Play} onClick={() => act('resume')}>Resume</Btn> : <Btn className="ghost" icon={Pause} disabled={st !== 'running'} onClick={() => act('pause')}>Pause</Btn>}
                <Btn className="ghost" icon={RotateCcw} title={t('Reset')} aria-label={t('Reset')} disabled={st !== 'running'} onClick={reset} />
                <Btn className="ghost" icon={Power} title={t('Power off')} aria-label={t('Power off')} onClick={powerOff} />
                <Btn className="primary" icon={Square} disabled={st === 'stopping'} onClick={() => act('stop', {}, 'Shutting down')}>Shut down</Btn>
              </>}
        </div>
      </div>
      {vm.broken && <Callout kind="err" title={t('Creation was interrupted')} dismissible={false}>{t('Hostwerk quit while this VM was being created. Delete it and create it again.')} <Btn className="xs danger" onClick={remove}>Delete</Btn></Callout>}
      {vm.creating && <Callout kind="info" title={t('The VM is being created')} dismissible={false}>{t('Hostwerk downloads and prepares the disk – this page fills in as soon as it is ready.')}</Callout>}
      {vm.install && vm.install.state === 'running' && <Callout kind="info" title={t('Windows installs itself')} dismissible={false}>{t('This takes about 15–40 minutes and restarts a few times – no need to click anything. Hostwerk switches to booting from the disk as soon as Windows reports through the guest agent.')}</Callout>}
      {vm.status && vm.status.state === 'error' && <Callout kind="err" title={t('The VM stopped with an error')} dismissible={false}>{vm.status.error}{vm.status.hint ? ` – ${vm.status.hint}` : ''} <Btn className="xs" onClick={() => goTab('log')}>Log</Btn></Callout>}
      {vm.encryption && vm.encryption.locked && <Callout kind="warn" title={t('Disk key needed')} dismissible={false}>{t('The disks of this VM are encrypted with a key that is not stored on this PC (moved from another PC or Hostwerk installed again). Enter it under Hardware → Encryption.')} <Btn className="xs" onClick={() => goTab('hardware')}>Hardware</Btn></Callout>}
      <Tabs value={group.id} onChange={(g) => goTab((groups.find((x) => x.id === g) || groups[0]).subs[0][0])} tabs={groups.map(({ subs, ...g }) => ({ ...g, label: t(g.label), title: g.title ? t(g.title) : undefined }))} />
      {group.subs.length > 1 && <div className="sub-tabs"><Seg value={cur} onChange={goTab} options={group.subs.map(([sid, label, icon]) => ({ id: sid, label: t(label), icon }))} /></div>}
      <div className="vm-tab-body">
        {cur === 'overview' && <Overview vm={vm} on={on} engines={engines} onClone={cloneVm} onRemove={remove} reload={reload} reloadList={reloadList} />}
        {cur === 'screen' && (on ? <div className="stack">
          {st === 'paused' && <PausedNote onResume={() => act('resume')} />}
          {/* fluid VNC screen when QEMU offers it; the PNG screen as fallback (older VMs, paired machines, no connection) */}
          <FileDrop vm={vm}>
            {vm.status && vm.status.ports && vm.status.ports.vnc && !pngScreen
              ? <VncScreen key={`${vm.id}-${vm.status.startedAt}`} vm={vm} onFallback={() => setPngScreen(true)} />
              : <Screen vm={vm} active />}
          </FileDrop>
          <div className="row small vm-screen-foot">
            <span className="muted grow">{t('Drop files on the screen to copy them into the VM.')}</span>
            {aiReady && <Btn className="xs btn-ai" icon={Sparkles} onClick={() => setAskAi(true)}>Ask AI about the screen …</Btn>}
            <Btn className="ghost xs" icon={Download} onClick={() => fetchFromVm(vm)}>Get a file from the VM …</Btn>
            {vm.status && vm.status.ports && vm.status.ports.vnc && <Btn className="ghost xs" onClick={() => setPngScreen(!pngScreen)}>{pngScreen ? t('Fluid screen (VNC)') : t('Simple screen (images)')}</Btn>}
          </div>
        </div> : vm.display === 'window' && vm.vga === 'virtio-gl'
          ? <div className="card"><Empty icon={Monitor} title="The VM is off" text="With 3D the screen opens in its own window on this PC when the VM starts." action={<Btn className="primary" icon={Play} disabled={!!busy} onClick={() => act('start')}>Start</Btn>} /></div>
          : <div className="card"><Empty icon={Monitor} title="The VM is off" text="Start it to see its screen." action={<Btn className="primary" icon={Play} disabled={!!busy || vm.broken} onClick={() => act('start')}>Start</Btn>} /></div>)}
        {cur === 'console' && <SerialConsole vm={vm} on={on} />}
        {cur === 'guest' && <GuestPanel vm={vm} on={on} />}
        {cur === 'snapshots' && <Snapshots vm={vm} on={on} engines={engines} reload={reload} />}
        {cur === 'backups' && <Backups vm={vm} on={on} reload={reload} />}
        {cur === 'hardware' && <Hardware vm={vm} on={on} reload={reload} />}
        {cur === 'network' && <NetworkTab vm={vm} on={on} reload={reload} engines={engines} />}
        {cur === 'log' && <ProcLog vm={vm} />}
      </div>
      {dialog && <CreateDialog engines={engines} initial={dialog} onClose={() => { setDialog(null); reloadList(); }} />}
      {askAi && aiReady && <AskAiDialog vm={vm} onClose={() => setAskAi(false)} />}
    </div>
  );
}

/** Overview: state and connection on the left, behaviour and management on the right – nothing else. */
function Overview({ vm, on, engines, onClone, onRemove, reload, reloadList }) {
  const agent = vm.status && vm.status.agent;
  const stats = vm.status && vm.status.stats;
  const used = (vm.diskInfo || []).reduce((a, d) => a + (d.actualSize || 0), 0);
  const size = (vm.diskInfo || []).reduce((a, d) => a + (d.virtualSize || 0), 0);
  const toggle = (k) => async (v) => { await run(() => put(`/vms/${vm.id}`, { [k]: v })); reload({ silent: true }); };
  const template = () => toggleTemplate(vm, () => { reload({ silent: true }); reloadList(); });
  const ip = ipOf(vm);
  return (
    <div className="grid grid-2">
      <div className="stack">
        <div className="card">
          <div className="card-head"><Gauge size={16} aria-hidden="true" /><h3>{t('State')}</h3><span className="grow" /></div>
          <div className="card-body stack">
            <div className="svc-meta">
              <div><div className="k">CPU</div><div className="v">{on && stats ? `${Math.round(stats.cpu)} %` : `${vm.cpus} ${t('cores')}`}</div></div>
              <div><div className="k">{t('Memory')}</div><div className="v">{on && stats ? fmtBytes(stats.memory) : mem(vm.memoryMb)}</div></div>
              <div><div className="k">{t('Disks')}</div><div className="v">{gb(used)} / {gb(size)}</div></div>
              <div><div className="k">{t('IP address')}</div><div className="v mono small">{ip || '–'}</div></div>
            </div>
            {vm.memory && vm.memory.level !== 'ok' && !on && <Callout kind={vm.memory.level === 'err' ? 'err' : 'warn'} dismissible={false}>{t('Together with the running VMs this one needs {total} MB – this PC has {host} MB.', { total: vm.memory.total, host: engines && engines.host ? engines.host.memoryMb : '?' })}</Callout>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><Plug size={16} aria-hidden="true" /><h3>{t('Connect')}</h3><span className="grow" />
            <InfoTip pop title={t('Guest agent')}>{t('A small helper inside the VM (qemu-guest-agent). With it Hostwerk sees the IP addresses, shuts down cleanly and freezes the file system for consistent snapshots and backups. Ready-made Linux VMs bring it along; on Windows install it from the virtio-win ISO.')}</InfoTip>
          </div>
          <div className="card-body stack">
            {on && <div className="row-tight small"><span className={`vm-dot ${agent && agent.ok ? 'running' : 'starting'}`} aria-hidden="true" /><span className={agent && agent.ok ? '' : 'muted'}>{agent && agent.ok ? t('Guest agent connected') : t('Waiting for the guest agent …')}</span></div>}
            {vm.ssh ? <>
              <code className="mono vm-code vm-code-wrap">{vm.ssh.command}</code>
              <div className="row-tight"><Btn className="xs" icon={Copy} onClick={() => copy(vm.ssh.command)}>Copy</Btn>{on && <Btn className="xs" icon={Terminal} onClick={() => runInTerminal(vm.ssh.command, { title: vm.name })}>Terminal</Btn>}</div>
              <div className="small muted">{t('SSH is forwarded from port {port} on this PC.', { port: vm.ssh.port })}{vm.cloud ? ` ${t('Sign in with the user and password from the creation.')}` : ''}</div>
            </> : <div className="small muted">{t('No SSH forwarding – add one under Network.')}</div>}
            {agent && agent.ok && agent.os && <div className="small muted">{agent.os}{agent.hostname ? ` · ${agent.hostname}` : ''}{(agent.addresses || []).length > 1 ? ` · ${agent.addresses.filter((a) => a.type === 'ipv4').map((a) => `${a.iface} ${a.ip}`).join(', ')}` : ''}</div>}
          </div>
        </div>
        {(vm.appInfo || (vm.cloud && vm.cloud.start)) && <AppCard vm={vm} on={on} />}
      </div>
      <div className="stack">
        <div className="card">
          <div className="card-head"><SlidersHorizontal size={16} aria-hidden="true" /><h3>{t('Behaviour')}</h3><span className="grow" /></div>
          <div className="card-body">
            {!vm.template && <>
              <SettingRow title={t('Start with Hostwerk')}><Switch checked={!!vm.autostart} onChange={toggle('autostart')} /></SettingRow>
              <SettingRow title={t('Restart after a crash')}><Switch checked={!!vm.autoRestart} onChange={toggle('autoRestart')} /></SettingRow>
            </>}
            <SettingRow title={t('When Hostwerk quits')}><Seg value={vm.onExit || 'shutdown'} onChange={toggle('onExit')} options={[{ id: 'shutdown', label: t('Shut down cleanly') }, { id: 'kill', label: t('Power off') }]} /></SettingRow>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><Settings2 size={16} aria-hidden="true" /><h3>{t('Manage')}</h3><span className="grow" /></div>
          <div className="card-body stack">
            <div className="row-tight vm-manage">
              <Btn className="sm" icon={Copy} disabled={on} title={on ? t('Shut the VM down first') : t('A full, independent copy.')} onClick={() => onClone(false)}>Copy …</Btn>
              {!vm.template && <Btn className="sm" icon={Layers} disabled={on || !!vm.encryption} title={vm.encryption ? t('Not for encrypted VMs') : t('Shares the disk – fast and small.')} onClick={() => onClone(true)}>Clone …</Btn>}
              <Btn className="sm" icon={Box} disabled={on || !!vm.linkedTo || (!vm.template && !!vm.encryption)} title={vm.template ? t('New VMs start from it as linked clones.') : t('Set up once, then new VMs from it in seconds as linked clones.')} onClick={template}>{vm.template ? t('Normal VM again') : t('Template')}</Btn>
              <ExportButton vm={vm} on={on} />
              {!vm.template && <Btn className="sm" icon={ArrowLeftRight} disabled={on} title={on ? t('Shut the VM down first') : t('Moves the VM with all disks to Hostwerk on another PC.')} onClick={() => moveVm(vm)}>Move to another PC …</Btn>}
            </div>
            {on && <div className="small muted">{t('Copy, clone, template and export work while the VM is off.')}</div>}
            <div className="small muted">{t('Folder')}{vm.importedFrom ? ` · ${t('taken over from VirtualBox “{name}”', { name: vm.importedFrom.name })}` : ''}</div>
            <code className="mono small vm-code vm-code-wrap">{vm.dir}</code>
            <div className="row"><span className="grow" /><Btn className="sm danger" icon={Trash2} onClick={onRemove}>Delete …</Btn></div>
          </div>
        </div>
        <Notes vm={vm} reload={reload} />
      </div>
    </div>
  );
}

/** App template (#9) and own start script: state of the setup in the guest and the button that opens the app. */
const APP_STATE = { ok: ['ok', 'Ready'], running: ['', 'Installing …'], failed: ['err', 'Setup failed'], none: ['', '–'], unknown: ['', 'Waiting for the guest agent …'] };
function AppCard({ vm, on }) {
  const info = vm.appInfo;
  const [st, setSt] = useState(null);
  const [showLog, setShowLog] = useState(false);
  useEffect(() => {
    setSt(null);
    if (!on) return undefined;
    let alive = true; let timer = null;
    const tick = async () => {
      let again = true;
      try { const r = await get(`/vms/${vm.id}/app`); if (!alive) return; setSt(r); again = r.app === 'running' || r.script === 'running' || r.app === 'unknown'; } catch { /* agent not there yet */ }
      if (alive && again) timer = setTimeout(tick, 10000);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [vm.id, on]);
  const pill = (k) => { const [cls, label] = APP_STATE[k] || APP_STATE.unknown; return <span className={`badge ${cls}`}>{t(label)}</span>; };
  const open = info && info.open;
  return (
    <div className="card vm-app-card">
      <div className="card-head"><AppWindow size={16} aria-hidden="true" /><h3>{info ? t(info.label) : t('Start script')}</h3><span className="grow" />{on && st && info && pill(st.app)}</div>
      <div className="card-body stack">
        {open && <div className="row">
          <a className={`btn ${on && st && st.app === 'ok' ? 'primary' : ''}`} href={open.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" /> {t(open.label || 'Open')}</a>
          <code className="mono small">{open.url}</code>
          <span className="small muted grow">{t('on this PC')}</span>
        </div>}
        {info && !on && <div className="small muted">{t('Start the VM – the app is set up at the first start and runs with every start after that.')}</div>}
        {on && info && (!st || st.app === 'running' || st.app === 'unknown') && <div className="small muted">{t('The first start installs the app – this takes a few minutes after the VM is up.')}</div>}
        {vm.cloud && vm.cloud.start && <div className="row small">{t('Own start commands/script')}: {on && st ? pill(st.script === 'none' ? 'ok' : st.script) : <span className="muted">{t('run once at the first start')}</span>}</div>}
        {on && st && st.log && <>
          <Btn className="btn ghost xs" onClick={() => setShowLog(!showLog)}>{showLog ? t('Hide log') : t('Show log')}</Btn>
          {showLog && <pre className="mono small vm-code">{st.log}</pre>}
        </>}
      </div>
    </div>
  );
}

/**
 * Ask AI about the screen (#20): Hostwerk's AI services for extensions carry text only – so the AI gets what Hostwerk
 * knows about the screen as text (state, guest agent, serial console). The dialog shows exactly that text first.
 */
function AskAiDialog({ vm, onClose }) {
  const { data, error } = useApi(`/vms/${vm.id}/ai/context`, [vm.id], { live: false });
  const [q, setQ] = useState(t('What does the screen of this VM show, and what does the error there mean?'));
  const ask = () => {
    if (!data) return;
    openAiPanel({ question: q.trim() || t('What does the screen of this VM show?'), context: { kind: 'text', id: `vm-screen:${vm.id}`, label: t('Screen of {name} (as text)', { name: vm.name }), text: data.text } });
    onClose();
  };
  return (
    <Modal title="Ask AI about the screen" subtitle={vm.name} onClose={onClose} size="wide"
      footer={<><div className="grow" /><Btn className="btn" onClick={onClose}>Cancel</Btn><Btn className="btn primary" icon={Sparkles} disabled={!data} onClick={ask}>Ask</Btn></>}>
      <div className="stack">
        <Callout kind="info" dismissible={false} title={t('Only text is sent – not the picture')}>{t('Hostwerk’s AI gets the text below: state, guest agent, last events and the last lines of the serial console. The screenshot itself stays on this PC. To show the AI the picture, save a screenshot and attach it in the AI chat – that needs a model that can see images.')}</Callout>
        <img className="vm-ai-shot" src={apiUrl(`/api/vms/${vm.id}/screen`)} alt={t('Screen of {name}', { name: vm.name })} />
        <Field label="Question"><input className="input" value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} /></Field>
        <Field label="What the AI gets">{error ? <div className="small err">{error}</div> : <pre className="mono vm-ai-context">{data ? data.text : '…'}</pre>}</Field>
      </div>
    </Modal>
  );
}

function Notes({ vm, reload }) {
  const [text, setText] = useState(vm.notes || '');
  useEffect(() => setText(vm.notes || ''), [vm.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = text !== (vm.notes || '');
  return (
    <div className="card">
      <div className="card-head"><StickyNote size={16} aria-hidden="true" /><h3>{t('Notes')}</h3><span className="grow" />{dirty && <Btn className="btn xs primary" onClick={async () => { await run(() => put(`/vms/${vm.id}`, { notes: text }), 'Saved'); reload({ silent: true }); }}>Save</Btn>}</div>
      <div className="card-body"><textarea className="input vm-notes" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Passwords belong in the password manager – here: what the VM is for, what runs on it …')} /></div>
    </div>
  );
}

function ExportButton({ vm, on }) {
  return <Btn className="sm" icon={Upload} disabled={on} onClick={() => exportVm(vm)}>Export …</Btn>;
}

function SerialConsole({ vm, on }) {
  const [text, setText] = useState('');
  const [line, setLine] = useState('');
  const seq = useRef(null);
  const box = useRef(null);
  useEffect(() => {
    if (!on) return undefined;
    let alive = true; let timer = null;
    const tick = async () => {
      try {
        const r = await get(`/vms/${vm.id}/serial${seq.current != null ? `?since=${seq.current}` : ''}`);
        if (!alive) return;
        // eslint-disable-next-line no-control-regex
        const clean = String(r.text || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '');
        if (clean) setText((x) => (r.reset ? clean : (x + clean).slice(-200000)));
        seq.current = r.seq;
      } catch { /* the VM may be starting */ }
      if (alive) timer = setTimeout(tick, 700);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [vm.id, on]);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [text]);
  // in a card like the screen and the commands tab – the three sub-tabs look alike while the VM is off
  if (!on) return <div className="card"><Empty icon={Terminal} title="The VM is off" text="The serial console shows what the VM writes to its first serial port – boot messages and a login on Linux." /></div>;
  const send = async (data) => { try { await post(`/vms/${vm.id}/serial`, { data }); } catch (e) { toast.error(e.message); } };
  return (
    <div className="card">
      <div className="card-body stack">
        <pre ref={box} className="vm-serial mono" aria-live="polite">{text || t('No output yet. Linux cloud images print their boot messages and a login here; press Enter if the screen stays empty.')}</pre>
        <form className="row" onSubmit={(e) => { e.preventDefault(); send(`${line}\r`); setLine(''); }}>
          <input className="input mono grow" value={line} onChange={(e) => setLine(e.target.value)} placeholder={t('Input – Enter sends')} aria-label={t('Serial input')} />
          {/* type="button": inside the form a plain button would also submit the line (input + Enter sent twice) */}
          <Btn className="btn" type="button" onClick={() => send('\r')}>Enter</Btn>
          <Btn className="btn" type="button" onClick={() => send('\x03')}>Ctrl+C</Btn>
        </form>
      </div>
    </div>
  );
}

function Snapshots({ vm, on, engines, reload }) {
  const list = vm.snapshots || [];
  const ramOk = engines && engines.qemu && engines.qemu.ramSnapshots;
  const take = async () => {
    const name = await promptDialog({ title: t('Take a snapshot'), text: on ? (ramOk ? t('The VM keeps running. With memory, restoring continues exactly where it was.') : t('The VM keeps running; the disks are saved at this moment (with the guest agent the file system is frozen briefly).')) : t('Saves the state of all disks.'), label: t('Name'), value: `snap-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`, confirm: t('Take snapshot'), checkbox: on && ramOk ? { label: t('Include memory'), checked: true } : null });
    if (!name) return;
    const value = typeof name === 'object' ? name.value : name;
    const ram = typeof name === 'object' ? !!name.checked : false;
    if (await run(() => post(`/vms/${vm.id}/snapshots`, { name: value, ram }), 'Snapshot taken')) reload({ silent: true });
  };
  const restore = async (s) => {
    if (on && !s.ram) { toast.warn(t('Shut the VM down first to restore a disk snapshot.')); return; }
    if (!(await confirmDialog({ title: t('Restore “{name}”?', { name: s.name }), text: t('Everything that changed since this snapshot is lost (take a snapshot first if unsure).'), confirm: t('Restore'), danger: true }))) return;
    if (await run(() => post(`/vms/${vm.id}/snapshots/${encodeURIComponent(s.name)}/restore`), 'Restored')) reload({ silent: true });
  };
  const remove = async (s) => { if (await confirmDialog({ title: t('Delete snapshot “{name}”?', { name: s.name }), text: t('The VM stays as it is now.'), confirm: t('Delete'), danger: true })) { if (await run(() => del(`/vms/${vm.id}/snapshots/${encodeURIComponent(s.name)}`))) reload({ silent: true }); } };
  const depth = (s) => { let d = 0; let p = s.parent; const byName = Object.fromEntries(list.map((x) => [x.name, x])); while (p && byName[p] && d < 20) { d++; p = byName[p].parent; } return d; };
  const auto = vm.autoSnap || { every: 'off', keep: 24, beforeUpdate: true };
  const setAuto = async (patch) => { if (await run(() => put(`/vms/${vm.id}`, { autoSnap: { ...auto, ...patch } }))) reload({ silent: true }); };
  return (
    <div className="stack">
    {!vm.template && (
      <div className="card">
        <div className="card-head"><Clock size={16} aria-hidden="true" /><h3>{t('Automatic snapshots')}</h3><span className="grow" />{auto.last && <span className="small muted">{t('last: {date}', { date: fmtDate(auto.last) })}</span>}</div>
        <div className="card-body stack">
          <div className="row vm-auto">
            <Seg value={auto.every} onChange={(v) => setAuto({ every: v })} options={[{ id: 'off', label: t('Off') }, { id: 'hourly', label: t('Hourly') }, { id: '6h', label: t('Every 6 h') }, { id: 'daily', label: t('Daily') }, { id: 'weekly', label: t('Weekly') }]} />
            {auto.every !== 'off' && <label className="row-tight small">{t('keep the newest')} <input className="input vm-num" type="number" min={1} max={100} value={auto.keep} onChange={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= 100) setAuto({ keep: n }); }} aria-label={t('Number of automatic snapshots to keep')} /></label>}
          </div>
          <label className="row small"><Switch checked={auto.beforeUpdate !== false} onChange={(v) => setAuto({ beforeUpdate: v })} /> {t('Snapshot before every system update (“Update system …”)')}</label>
          <div className="small muted">{t('Automatic snapshots are marked “auto”; older ones are deleted by themselves, your own never. A switched-off VM gets one only after it ran again.')}</div>
        </div>
      </div>
    )}
    <div className="card">
      <div className="card-head"><Camera size={16} aria-hidden="true" /><h3>{t('Snapshots')}</h3><span className="grow" /><Btn className="btn primary sm" icon={Camera} disabled={vm.template || !!vm.busy} onClick={take}>Take snapshot …</Btn></div>
      {!list.length ? <div className="card-body"><Empty icon={History} title="No snapshots yet" text={on ? 'Snapshots work while the VM runs – ideal before an update or an experiment.' : 'A snapshot saves the current state – go back to it any time.'} /></div> : (
        <div className="list-rows">
          {list.map((s) => (
            <div key={s.name} className={`list-row-item vm-snap ${vm.currentSnapshot === s.name ? 'current' : ''}`} style={{ paddingLeft: `calc(var(--sp-4) + ${depth(s) * 18}px)` }}>
              <History size={16} aria-hidden="true" />
              <div className="grow">
                <div className="list-row-title">{s.name} {vm.currentSnapshot === s.name && <span className="badge accent">{t('current state')}</span>} {s.ram && <span className="badge">{t('with memory')}</span>} {s.live && !s.ram && <span className="badge">{s.frozen ? t('live, consistent') : t('live')}</span>} {s.auto && <span className="badge">auto</span>}</div>
                <div className="list-row-sub small muted">{fmtDate(s.createdAt)}{s.label ? ` · ${s.label}` : ''}</div>
              </div>
              <Btn className="btn xs" icon={RotateCcw} onClick={() => restore(s)}>Restore</Btn>
              <Btn className="btn xs ghost" icon={Trash2} onClick={() => remove(s)} title="Delete" aria-label={t('Delete')} />
            </div>
          ))}
        </div>
      )}
    </div>
    </div>
  );
}

function Hardware({ vm, on, reload }) {
  const [f, setF] = useState({ cpus: vm.cpus, memoryMb: vm.memoryMb, firmware: vm.firmware, vga: vm.vga, display: vm.display, boot: vm.boot, osType: vm.osType, sound: !!vm.sound });
  useEffect(() => setF({ cpus: vm.cpus, memoryMb: vm.memoryMb, firmware: vm.firmware, vga: vm.vga, display: vm.display, boot: vm.boot, osType: vm.osType, sound: !!vm.sound }), [vm.id, vm.cpus, vm.memoryMb, vm.firmware, vm.vga, vm.display, vm.boot, vm.sound]); // eslint-disable-line react-hooks/exhaustive-deps
  // compare like the form holds it: switches as booleans, number fields as text (an input gives "2048" for 2048)
  const dirty = Object.keys(f).some((k) => (k === 'sound' ? f.sound !== !!vm.sound : String(f[k]) !== String(vm[k])));
  const save = async () => { if (await run(() => put(`/vms/${vm.id}`, f), 'Saved')) reload({ silent: true }); };
  const setCd = async (iso) => { if (await run(() => put(`/vms/${vm.id}`, { cdrom: iso }), iso ? 'ISO inserted' : 'Ejected')) reload({ silent: true }); };
  const chooseIso = async () => { const p = canPickPath() ? await pickPath({ mode: 'file', title: t('Choose an ISO'), filters: [{ name: 'ISO', extensions: ['iso', 'img'] }] }) : await promptDialog({ title: t('Insert ISO'), label: t('Path'), value: '' }); if (p) setCd(p); };
  const addDisk = async () => { const v = await promptDialog({ title: t('Add a disk'), label: t('Size in GB'), value: '20', confirm: t('Add') }); if (v && await run(() => post(`/vms/${vm.id}/disks`, { sizeGb: Number(v) }), 'Disk added')) reload({ silent: true }); };
  const grow = async (d) => { const v = await promptDialog({ title: t('Enlarge {disk}', { disk: d.id }), text: t('The partition inside grows on its own on ready-made Linux; otherwise enlarge it in the VM.'), label: t('New size in GB'), value: String(Math.ceil((d.virtualSize || 0) / 2 ** 30) + 10), confirm: t('Enlarge') }); if (v && await run(() => put(`/vms/${vm.id}/disks/${d.id}`, { sizeGb: Number(v) }), 'Enlarged')) reload({ silent: true }); };
  const dropDisk = async (d) => { if (await confirmDialog({ title: t('Remove {disk}?', { disk: d.id }), text: t('The disk file is deleted.'), confirm: t('Remove'), danger: true })) { if (await run(() => del(`/vms/${vm.id}/disks/${d.id}`))) reload({ silent: true }); } };
  const compact = async (d) => {
    if (!(await confirmDialog({ title: t('Compact {disk}?', { disk: d.id }), text: t('Unused space goes back to this PC. Tip: run “Free unused blocks” while the VM runs first, then shut it down and compact.'), confirm: t('Compact') }))) return;
    const r = await run(() => post(`/vms/${vm.id}/disks/${d.id}/compact`));
    if (r && r.job) { const j = await waitJob(r.job).catch((e) => { toast.error(e.message); return null; }); if (j && j.result) toast.success(t('Compacted: {saved} given back', { saved: fmtBytes(j.result.saved) })); reload({ silent: true }); }
  };
  const attach = async () => {
    const p = canPickPath() ? await pickPath({ mode: 'file', title: t('Choose a disk image'), filters: [{ name: 'Disk', extensions: ['qcow2', 'vdi', 'vmdk', 'vhd', 'vhdx', 'img', 'raw'] }] }) : await promptDialog({ title: t('Attach a disk'), label: t('Path'), value: '' });
    if (!p) return;
    const r = await run(() => post(`/vms/${vm.id}/disks`, { file: p }));
    if (r && r.job) { await waitJob(r.job).then(() => toast.success(t('Disk attached'))).catch((e) => toast.error(e.message)); reload({ silent: true }); }
  };
  const off = on;
  // while the VM runs these switches cannot change – show them disabled instead of silently ignoring a click
  const lock = (opts) => opts.map((o) => ({ ...o, disabled: off }));
  return (
    <div className="stack">
      {on && <Callout kind="info" dismissible={false}>{t('CPU, memory, firmware and disks change when the VM is off. The ISO can be changed while it runs.')}</Callout>}
      <div className="card">
        <div className="card-head"><Cpu size={16} aria-hidden="true" /><h3>{t('System')}</h3><span className="grow" />{dirty && <Btn className="btn primary sm" disabled={off} onClick={save}>Save</Btn>}</div>
        <div className="card-body grid grid-3">
          <Field label="CPU cores"><input className="input" type="number" min={1} disabled={off} value={f.cpus} onChange={(e) => setF({ ...f, cpus: Number(e.target.value) })} /></Field>
          <Field label="Memory (MB)"><input className="input" type="number" min={256} step={256} disabled={off} value={f.memoryMb} onChange={(e) => setF({ ...f, memoryMb: Number(e.target.value) })} /></Field>
          <Field label="Firmware"><Seg value={f.firmware} onChange={(v) => !off && setF({ ...f, firmware: v })} options={lock([{ id: 'bios', label: 'BIOS' }, { id: 'uefi', label: 'UEFI' }])} /></Field>
          <Field label="Graphics" hint={f.vga === 'virtio-gl' ? t('3D (experimental) works in the own window only – in Hostwerk the screen uses virtio.') : undefined}><Seg value={f.vga} onChange={(v) => !off && setF({ ...f, vga: v, ...(v === 'virtio-gl' ? { display: 'window' } : {}) })} options={lock([{ id: 'std', label: t('Standard') }, { id: 'virtio', label: 'virtio' }, { id: 'virtio-gl', label: t('3D (experimental)') }])} /></Field>
          <Field label="Sound" hint="Plays on this PC’s speakers."><label className="row"><Switch checked={f.sound} disabled={off} onChange={(v) => setF({ ...f, sound: v })} /> <span>{f.sound ? t('On') : t('Off')}</span></label></Field>
          <Field label="Screen" hint="In Hostwerk, or as a separate window on this PC (smoother for desktops)."><Seg value={f.display} onChange={(v) => !off && setF({ ...f, display: v })} options={lock([{ id: 'web', label: t('In Hostwerk') }, { id: 'window', label: t('Own window') }])} /></Field>
          <Field label="Boot from"><Seg value={f.boot} onChange={(v) => !off && setF({ ...f, boot: v })} options={lock([{ id: 'disk', label: t('Disk') }, { id: 'cdrom', label: 'ISO' }])} /></Field>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><HardDrive size={16} aria-hidden="true" /><h3>{t('Disks')}</h3><span className="grow" /><div className="row-tight"><Btn className="btn sm" icon={FolderOpen} disabled={off} onClick={attach}>Attach existing …</Btn><Btn className="btn sm" icon={Plus} disabled={off} onClick={addDisk}>Add disk …</Btn></div></div>
        <div className="list-rows">
          {(vm.diskInfo || []).map((d) => (
            <div key={d.id} className="list-row-item">
              <HardDrive size={16} aria-hidden="true" />
              <div className="grow"><div className="list-row-title">{d.id} <span className="badge">{d.bus}</span>{d.backing && <span className="badge">{t('linked')}</span>}</div><div className="list-row-sub small muted">{t('{used} used of {size}', { used: gb(d.actualSize), size: gb(d.virtualSize) })} · <span className="mono">{d.file}</span></div></div>
              <Btn className="btn xs" disabled={off || !!d.backing} onClick={() => compact(d)} title={d.backing ? t('Linked disks cannot be compacted') : undefined}>Compact …</Btn>
              <Btn className="btn xs" disabled={off} onClick={() => grow(d)}>Enlarge …</Btn>
              {(vm.diskInfo || []).length > 1 && <Btn className="btn xs ghost" icon={Trash2} disabled={off} onClick={() => dropDisk(d)} aria-label={t('Remove')} />}
            </div>
          ))}
        </div>
      </div>
      <Encryption vm={vm} on={on} reload={reload} />
      <Limits vm={vm} reload={reload} />
      <div className="card">
        <div className="card-head"><Keyboard size={16} aria-hidden="true" /><h3>{t('Keyboard')}</h3><span className="grow" /></div>
        <div className="card-body row">
          <Seg value={vm.keyboard || 'us'} onChange={async (k) => { if (await run(() => put(`/vms/${vm.id}`, { keyboard: k }))) reload({ silent: true }); }} options={[{ id: 'de', label: t('German') }, { id: 'us', label: t('English (US)') }]} />
          <span className="small muted grow">{t('The layout the VM uses – Hostwerk types text with it (“Type text …” on the screen).')}</span>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><Disc size={16} aria-hidden="true" /><h3>{t('CD/DVD drive')}</h3><span className="grow" /></div>
        <div className="card-body row">
          <Disc3 size={16} aria-hidden="true" />
          <span className="grow mono small ellipsis">{vm.cdrom || t('empty')}</span>
          <Btn className="btn sm" icon={FolderOpen} onClick={chooseIso}>Insert ISO …</Btn>
          {vm.cdrom && <Btn className="btn sm ghost" onClick={() => setCd(null)}>Eject</Btn>}
        </div>
      </div>
    </div>
  );
}

/** Encrypted disks (#15): state, encrypt an existing VM, show the key (to note it down or move the VM), enter it after a move. */
function Encryption({ vm, on, reload }) {
  const [key, setKey] = useState(null);
  const enc = vm.encryption;
  const encrypt = async () => {
    if (!(await confirmDialog({ title: t('Encrypt the disks of “{name}”?', { name: vm.name }), text: t('Every disk is rewritten encrypted (AES-256, LUKS) – this takes as long as copying it. The key is kept in Hostwerk’s secret store on this PC. Note it down afterwards (“Show key …”): without it the disks cannot be read on another PC.'), confirm: t('Encrypt') }))) return;
    const r = await run(() => post(`/vms/${vm.id}/encrypt`));
    if (r && r.job) { await waitJob(r.job).then(() => toast.success(t('Disks encrypted'))).catch((e) => toast.error(e.message)); reload({ silent: true }); }
  };
  const show = async () => { if (!(await confirmDialog({ title: t('Show the disk key?'), text: t('Whoever has this key and the disk files can read the VM. Keep it like a password (e.g. in the password manager).'), confirm: t('Show') }))) return; const r = await run(() => get(`/vms/${vm.id}/disk-key`)); if (r) setKey(r.key); };
  const unlock = async () => {
    const k = await promptDialog({ title: t('Enter the disk key'), text: t('The VM was moved here or Hostwerk was installed again – enter the key noted on the other PC (Hardware → Encryption → Show key).'), label: t('Disk key'), value: '', confirm: t('Unlock') });
    if (k && await run(() => post(`/vms/${vm.id}/unlock`, { key: k }), 'Unlocked')) reload({ silent: true });
  };
  return (
    <div className="card">
      <div className="card-head"><Lock size={16} aria-hidden="true" /><h3>{t('Encryption')}</h3><span className="grow" />{enc ? <span className={`badge ${enc.locked ? 'warn' : 'ok'}`}>{enc.locked ? t('locked') : t('encrypted')}</span> : <span className="badge">{t('not encrypted')}</span>}</div>
      <div className="card-body stack">
        <div className="small muted">{enc ? t('The disks are encrypted (qcow2 with LUKS, AES-256). QEMU gets the key from a file that only exists for a moment while starting; vm.json holds it sealed by Hostwerk only. Backups and copies stay encrypted; an exported disk is decrypted.') : t('Encrypted disks protect the VM when the PC, a backup or the disk files get into other hands. A little slower; templates and linked clones are not possible.')}</div>
        <div className="row">
          {!enc && <Btn className="btn" icon={KeyRound} disabled={on || !!vm.template || !!vm.linkedTo || (vm.snapshots || []).length > 0} onClick={encrypt} title={(vm.snapshots || []).length ? t('Delete the snapshots first – encrypting rewrites the disks.') : on ? t('Shut the VM down first') : undefined}>Encrypt disks …</Btn>}
          {enc && !enc.locked && <Btn className="btn" icon={KeyRound} onClick={show}>Show key …</Btn>}
          {enc && enc.locked && <Btn className="btn primary" icon={KeyRound} onClick={unlock}>Enter key …</Btn>}
        </div>
        {key && <div className="row"><code className="mono grow vm-code">{key}</code><Btn className="btn xs" icon={Copy} onClick={() => copy(key)}>Copy</Btn><Btn className="btn xs ghost" onClick={() => setKey(null)}>Hide</Btn></div>}
      </div>
    </div>
  );
}

/** Files dropped on the screen go into the VM (desktop/home of its user) through the guest agent. */
function FileDrop({ vm, children }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(null);
  const drop = async (e) => {
    e.preventDefault(); setOver(false);
    const files = [...(e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files : [])];
    for (const f of files) {
      setBusy(f.name);
      try {
        const res = await fetch(apiUrl(`/api/vms/${vm.id}/guest/upload?name=${encodeURIComponent(f.name)}`), { method: 'POST', body: f, credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' } });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        toast.success(t('Copied into the VM: {path}', { path: j.path }));
      } catch (err) { toast.error(err.message); }
    }
    setBusy(null);
  };
  return (
    <div className={`vm-drop ${over ? 'over' : ''}`} onDragOver={(e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)} onDrop={drop}>
      {children}
      {(over || busy) && <div className="vm-drop-hint">{busy ? t('Copying {name} into the VM …', { name: busy }) : t('Drop to copy into the VM')}</div>}
    </div>
  );
}
async function fetchFromVm(vm) {
  const p = await promptDialog({ title: t('Get a file from the VM'), text: t('Full path in the VM, e.g. /home/user/report.pdf or C:\\Users\\user\\Desktop\\report.pdf.'), label: t('Path in the VM'), value: '', confirm: t('Download') });
  if (!p) return;
  const a = document.createElement('a');
  a.href = apiUrl(`/api/vms/${vm.id}/guest/download?path=${encodeURIComponent(p)}`);
  a.download = p.split(/[\\/]/).pop();
  document.body.append(a); a.click(); a.remove();
}

/** Limits so this PC stays responsive – also changed while the VM runs. */
function Limits({ vm, reload }) {
  const cur = vm.limits || { iops: 0, mbps: 0, cpuShare: 100, priority: 'normal' };
  const [f, setF] = useState(cur);
  useEffect(() => setF(vm.limits || cur), [vm.id, JSON.stringify(vm.limits)]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(f) !== JSON.stringify(cur);
  const save = async () => { if (await run(() => put(`/vms/${vm.id}`, { limits: { ...f, iops: Number(f.iops) || 0, mbps: Number(f.mbps) || 0, cpuShare: Number(f.cpuShare) } }), 'Saved')) reload({ silent: true }); };
  return (
    <div className="card">
      <div className="card-head"><Gauge size={16} aria-hidden="true" /><h3>{t('Limits')}</h3><span className="grow" />{dirty && <Btn className="btn primary sm" onClick={save}>Save</Btn>}</div>
      <div className="card-body stack">
        <div className="small muted">{t('So this PC stays responsive. Changes apply at once, also while the VM runs.')}</div>
        <div className="grid grid-2">
          <Field label={t('CPU share: {pct} % of this PC', { pct: f.cpuShare })} hint="The VM only runs on this share of the PC’s cores.">
            <input type="range" className="vm-range" min={10} max={100} step={5} value={f.cpuShare} onChange={(e) => setF({ ...f, cpuShare: Number(e.target.value) })} aria-label={t('CPU share')} />
          </Field>
          <Field label="Priority"><Seg value={f.priority} onChange={(v) => setF({ ...f, priority: v })} options={[{ id: 'low', label: t('Low') }, { id: 'normal', label: t('Normal') }, { id: 'high', label: t('High') }]} /></Field>
          <Field label="Disk operations per second" hint="0 = no limit"><input className="input" type="number" min={0} step={50} value={f.iops} onChange={(e) => setF({ ...f, iops: e.target.value })} /></Field>
          <Field label="Disk speed (MB/s)" hint="0 = no limit"><input className="input" type="number" min={0} value={f.mbps} onChange={(e) => setF({ ...f, mbps: e.target.value })} /></Field>
        </div>
      </div>
    </div>
  );
}

/** What runs inside the VM: disks, update, a command – all through the guest agent. */
function GuestPanel({ vm, on }) {
  const agent = vm.status && vm.status.agent;
  const [cmd, setCmd] = useState('');
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  // the sub-tab must not stay blank: say why there is nothing to run yet
  if (!on) return <div className="card"><Empty icon={SquareTerminal} title="The VM is off" text="Commands, system updates and the disk usage inside the VM work through the guest agent while the VM runs." /></div>;
  if (!agent || !agent.ok) return <div className="card"><Empty icon={SquareTerminal} title="Waiting for the guest agent …" text="Commands in the VM need the guest agent (qemu-guest-agent). Ready-made Linux VMs bring it along; on Windows install it from the virtio-win ISO." /></div>;
  const exec = async (e) => {
    e.preventDefault();
    if (!cmd.trim()) return;
    setBusy(true);
    try { const r = await post(`/vms/${vm.id}/guest/exec`, { command: cmd }); setOut(r); } catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };
  const update = async () => {
    if (!(await confirmDialog({ title: t('Update the system of “{name}”?', { name: vm.name }), text: t('Hostwerk takes a snapshot first, then installs all updates of the system. If something breaks, restore the snapshot.'), confirm: t('Update') }))) return;
    const r = await run(() => post(`/vms/${vm.id}/guest/update`));
    if (r && r.job) { const j = await waitJob(r.job).catch((err) => { toast.error(err.message); return null; }); if (j && j.result) toast.success(j.result.reboot ? t('Updated – the VM wants a restart') : t('Updated')); }
  };
  const trim = async () => { const r = await run(() => post(`/vms/${vm.id}/guest/trim`)); if (r) toast.success(t('Unused blocks freed – compact the disk after shutting down to give the space back.')); };
  return (
    <div className="card">
      <div className="card-head"><Info size={16} aria-hidden="true" /><h3>{t('Inside the VM')}</h3><span className="grow" /><div className="row-tight"><Btn className="btn sm" onClick={trim}>Free unused blocks</Btn><Btn className="btn sm primary" icon={Download} onClick={update}>Update system …</Btn></div></div>
      <div className="card-body stack">
        {(agent.fs || []).map((f) => (
          <div key={f.mount} className="stack vm-fs">
            <div className="row small"><span className="mono grow">{f.mount}</span><span className={f.pct >= 90 ? 'badge err' : f.pct >= 80 ? 'badge warn' : 'muted'}>{t('{used} of {total} used', { used: fmtBytes(f.used), total: fmtBytes(f.total) })}</span></div>
            <div className="progress" role="progressbar" aria-label={f.mount} aria-valuenow={f.pct} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${Math.max(2, f.pct || 0)}%` }} /></div>
          </div>
        ))}
        <form className="row" onSubmit={exec}>
          <input className="input mono grow" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder={vm.osType === 'windows' ? 'Get-Process | Select -First 5' : 'df -h; uptime'} aria-label={t('Command in the VM')} />
          <Btn className="btn" busy={busy} disabled={!cmd.trim()} type="submit">Run</Btn>
        </form>
        {out && <pre className="vm-serial mono vm-exec">{out.timedOut ? t('No answer within the time limit – the command may still be running.') : `${out.out}${out.err ? `\n${out.err}` : ''}\n[${t('exit code {code}', { code: out.code })}]`}</pre>}
      </div>
    </div>
  );
}

/* ---------- Package 4: internal networks (#7), shared folders (#13), network bridge (#14) ---------- */
function InternalNets({ vm, on, reload }) {
  const { data, reload: again } = useApi('/vms/networks', [vm.id]);
  const [add, setAdd] = useState(null);
  const nets = (data && data.networks) || [];
  const mine = vm.nets || [];
  const nameOf = (id) => (nets.find((n) => n.id === id) || {}).name || id;
  const save = async (list) => { if (await run(() => put(`/vms/${vm.id}`, { nets: list.map((x) => ({ net: x.net, ip: x.ip || null })) }), 'Saved')) { reload({ silent: true }); again(); return true; } return false; };
  const open = async () => {
    const free = nets.filter((n) => !mine.some((x) => x.net === n.id));
    const first = free[0];
    let ip = '';
    if (first) { try { ip = (await get(`/vms/networks/${first.id}/suggest`)).ip || ''; } catch { ip = ''; } }
    setAdd({ net: first ? first.id : '', ip });
  };
  const newNet = async () => {
    const name = await promptDialog({ title: t('New internal network'), text: t('VMs in the same internal network reach each other directly – nothing leaves this PC.'), label: t('Name'), value: t('Lab'), confirm: t('Create') });
    if (!name) return;
    const n = await run(() => post('/vms/networks', { name }));
    if (n) { await again(); let ip = ''; try { ip = (await get(`/vms/networks/${n.id}/suggest`)).ip || ''; } catch { ip = ''; } setAdd({ net: n.id, ip }); }
  };
  const setup = vm.guestSetup && vm.guestSetup.nets;
  return (
    <div className="card">
      <div className="card-head"><Network size={16} aria-hidden="true" /><h3>{t('Internal networks')}</h3><span className="grow" /><Btn className="btn sm" icon={Plus} disabled={on || mine.length >= 2} onClick={nets.length ? open : newNet} title={on ? t('Shut the VM down first') : undefined}>Join …</Btn></div>
      <div className="card-body small muted">{t('A second (and third) network card that only connects VMs of this PC with each other – for a database next to a web server, a lab or a test network. Up to two networks per VM.')}</div>
      {!mine.length ? <div className="card-body"><Empty icon={Network} title="Not in an internal network" text="Create one under “Settings” on the overview of the VMs – or right here when joining." /></div> : (
        <div className="list-rows">
          {mine.map((x) => {
            const s = setup && setup.find((y) => y.net === x.net);
            return (
              <div key={x.net} className="list-row-item">
                <Network size={16} aria-hidden="true" />
                <div className="grow">
                  <div className="list-row-title">{nameOf(x.net)} {x.ip ? <span className="badge mono">{x.ip}</span> : <span className="badge">{t('address set in the VM')}</span>} {s && <span className={`badge ${s.ok ? 'ok' : 'warn'}`}>{s.ok ? t('set in the VM ({iface})', { iface: s.iface }) : t('not set in the VM')}</span>}</div>
                  <div className="list-row-sub small mono">{x.mac}</div>
                </div>
                <Btn className="btn xs ghost" icon={Trash2} disabled={on} aria-label={t('Leave')} onClick={() => save(mine.filter((y) => y !== x))} />
              </div>
            );
          })}
        </div>
      )}
      <div className="card-body small muted">{t('Linux with the guest agent gets the address automatically at every start. Otherwise set it in the VM yourself (e.g. sudo ip addr add 10.10.1.10/24 dev <card>); Windows: network settings of the second adapter.')}</div>
      {add && (
        <Modal title="Join an internal network" onClose={() => setAdd(null)} footer={<><Btn className="btn ghost" onClick={newNet}>New network …</Btn><div className="grow" /><Btn className="btn" onClick={() => setAdd(null)}>Cancel</Btn><Btn className="btn primary" disabled={!add.net} onClick={async () => { if (await save([...mine, add])) setAdd(null); }}>Join</Btn></>}>
          <div className="stack">
            <Field label="Network">
              <select className="select" value={add.net} onChange={async (e) => { const id = e.target.value; let ip = ''; try { ip = (await get(`/vms/networks/${id}/suggest`)).ip || ''; } catch { ip = ''; } setAdd({ net: id, ip }); }}>
                {nets.filter((n) => !mine.some((x) => x.net === n.id)).map((n) => <option key={n.id} value={n.id}>{n.name} · {n.subnet}</option>)}
              </select>
            </Field>
            <Field label="Address in this network (optional)" hint="Empty: the VM sets its address itself."><input className="input mono" value={add.ip} onChange={(e) => setAdd({ ...add, ip: e.target.value })} placeholder="10.10.1.10/24" /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function SharedFolders({ vm, on, reload }) {
  const [add, setAdd] = useState(null);
  const [busy, setBusy] = useState(null);
  const shares = vm.shares || [];
  const agent = vm.status && vm.status.agent && vm.status.agent.ok;
  const userNet = !vm.net || vm.net.mode === 'user';
  const save = async (list) => { if (await run(() => put(`/vms/${vm.id}`, { shares: list.map(({ id, name, path, readOnly, auto, token }) => ({ id, name, path, readOnly, auto, token })) }), 'Saved')) { reload({ silent: true }); return true; } return false; };
  const choose = async () => { const p = canPickPath() ? await pickPath({ mode: 'folder', title: t('Choose a folder') }) : await promptDialog({ title: t('Folder on this PC'), label: t('Path'), value: '' }); if (p) setAdd((x) => ({ ...x, path: p, name: x.name || String(p).split(/[\\/]/).filter(Boolean).pop() || '' })); };
  const mount = async (s) => {
    setBusy(s.id);
    try {
      const r = await post(`/vms/${vm.id}/shares/${s.id}/mount`);
      if (r.windows) { copy(r.command); toast.success(t('Command copied – run it in the VM (PowerShell or cmd) as the signed-in user.')); } else toast.success(t('Mounted in the VM: {path}', { path: r.mount }));
      reload({ silent: true });
    } catch (e) { toast.error(e.message); } finally { setBusy(null); }
  };
  return (
    <div className="card">
      <div className="card-head"><FolderOpen size={16} aria-hidden="true" /><h3>{t('Shared folders')}</h3><span className="grow" /><Btn className="btn sm" icon={Plus} disabled={shares.length >= 4 || !userNet} onClick={() => setAdd({ name: '', path: '', readOnly: true, auto: true })}>Share a folder …</Btn></div>
      <div className="card-body small muted">{t('Folders of this PC inside the VM – over a small file server of Hostwerk that only the VMs of this PC reach (address 10.0.2.2 in the VM), protected by a random key per folder. Linux mounts them by itself (davfs2, installed on first use); Windows maps them as a network drive.')}</div>
      {!userNet && <div className="card-body"><Callout kind="info" dismissible={false}>{t('Shared folders need the normal network (NAT) of the VM.')}</Callout></div>}
      {!shares.length ? <div className="card-body"><Empty icon={FolderOpen} title="No shared folders" text="Share a project folder, downloads or a music collection with the VM." /></div> : (
        <div className="list-rows">
          {shares.map((s) => {
            const st = vm.guestSetup && (vm.guestSetup.shares || []).find((y) => y.id === s.id);
            return (
              <div key={s.id} className="list-row-item">
                <FolderOpen size={16} aria-hidden="true" />
                <div className="grow">
                  <div className="list-row-title">{s.name} <span className="badge">{s.readOnly ? t('read only') : t('read and write')}</span>{st && <span className={`badge ${st.ok ? 'ok' : 'warn'}`}>{st.ok ? t('mounted') : t('not mounted')}</span>}</div>
                  <div className="list-row-sub small mono ellipsis">{s.path} → {vm.osType === 'windows' ? s.url : s.mount}</div>
                </div>
                {vm.osType === 'windows' ? <Btn className="btn xs" icon={Copy} onClick={() => copy(s.windows)} title={s.windows}>Copy command</Btn>
                  : <Btn className="btn xs" busy={busy === s.id} disabled={!on || !agent} onClick={() => mount(s)} title={!agent ? t('Needs the running VM with guest agent') : undefined}>Mount now</Btn>}
                <Btn className="btn xs ghost" icon={Trash2} aria-label={t('Remove')} onClick={() => save(shares.filter((y) => y !== s))} />
              </div>
            );
          })}
        </div>
      )}
      {add && (
        <Modal title="Share a folder with the VM" onClose={() => setAdd(null)} footer={<><div className="grow" /><Btn className="btn" onClick={() => setAdd(null)}>Cancel</Btn><Btn className="btn primary" disabled={!add.name.trim() || !add.path} onClick={async () => { if (await save([...shares, { ...add, name: add.name.trim() }])) setAdd(null); }}>Share</Btn></>}>
          <div className="stack">
            <Field label="Folder on this PC"><div className="row"><input className="input grow mono" value={add.path} onChange={(e) => setAdd({ ...add, path: e.target.value })} placeholder={t('C:\\Users\\…\\Projects')} /><Btn className="btn" icon={FolderOpen} onClick={choose}>Choose …</Btn></div></Field>
            <Field label="Name in the VM" hint="Linux: /mnt/hostwerk/<name>"><input className="input" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} /></Field>
            <label className="row small"><Switch checked={add.readOnly} onChange={(v) => setAdd({ ...add, readOnly: v })} /> {t('Read only – the VM cannot change or delete anything')}</label>
            {vm.osType !== 'windows' && <label className="row small"><Switch checked={add.auto} onChange={(v) => setAdd({ ...add, auto: v })} /> {t('Mount at every start (Linux with guest agent)')}</label>}
          </div>
        </Modal>
      )}
    </div>
  );
}

const bridgeHowto = () => t('A bridge needs the free “TAP-Windows” driver (from OpenVPN, installing it needs administrator rights – Hostwerk never installs it). Then, once: Network Connections (ncpa.cpl) → select the TAP adapter and your network card → right-click → “Bridge Connections”. Wi-Fi cards often cannot be bridged.');
function NetMode({ vm, on, reload }) {
  const { data } = useApi('/vms/taps', [vm.id], { live: false });
  const taps = (data && data.taps) || [];
  const mode = (vm.net && vm.net.mode) || 'user';
  const set = async (patch) => { if (await run(() => put(`/vms/${vm.id}`, { net: patch }), 'Saved')) reload({ silent: true }); };
  return (
    <div className="card">
      <div className="card-head"><Globe size={16} aria-hidden="true" /><h3>{t('Connection')}</h3><span className="grow" /></div>
      <div className="card-body stack">
        <Seg value={mode} onChange={(v) => { if (on) return; if (v === 'bridge') { if (taps[0]) set({ mode: 'bridge', tap: vm.net.tap || taps[0].name }); else toast.warn(t('No TAP adapter on this PC yet – see the note below.')); } else set({ mode: v }); }} options={[{ id: 'user', label: t('NAT (recommended)') }, { id: 'bridge', label: t('Network bridge') }, { id: 'none', label: t('No network') }].map((o) => ({ ...o, disabled: on }))} />
        {mode === 'bridge' && taps.length > 0 && (
          <Field label="TAP adapter"><select className="select" value={vm.net.tap || ''} disabled={on} onChange={(e) => set({ mode: 'bridge', tap: e.target.value })}>{taps.map((x) => <option key={x.name} value={x.name}>{x.name} · {x.description} · {x.status}</option>)}{vm.net.tap && !taps.some((x) => x.name === vm.net.tap) && <option value={vm.net.tap}>{vm.net.tap} ({t('missing')})</option>}</select></Field>
        )}
        <div className="small muted">{mode === 'bridge' ? t('The VM is its own device in your home network and gets its address from your router. Port forwarding and shared folders do not apply.') : mode === 'none' ? t('The VM has no network (internal networks still work).') : t('The VM is behind its own small router (NAT): internet yes, reachable from this PC through port forwarding.')}</div>
        {/* how to set up a bridge: as a note when the bridge is chosen, otherwise folded away (NAT is what almost everyone uses) */}
        {mode === 'bridge' ? (
          <Callout kind={taps.length ? 'info' : 'warn'} dismissible={false} title={t('Network bridge on Windows')}>
            {taps.length ? t('{n} TAP adapter(s) found.', { n: taps.length }) : t('No TAP adapter found.')} {bridgeHowto()}
          </Callout>
        ) : !taps.length && (
          <details className="small muted vm-details"><summary>{t('Network bridge on Windows')}</summary><p>{t('No TAP adapter found.')} {bridgeHowto()}</p></details>
        )}
        {on && <div className="small muted">{t('Change when the VM is off.')}</div>}
      </div>
    </div>
  );
}

function NetworkTab({ vm, on, reload, engines }) {
  const [add, setAdd] = useState(null);
  const lan = engines && engines.config && engines.config.lanForwards;
  const forwards = (vm.net && vm.net.forwards) || [];
  const save = async (list) => { if (await run(() => put(`/vms/${vm.id}`, { net: { forwards: list } }), on ? 'Changed while running' : 'Saved')) { reload({ silent: true }); return true; } return false; };
  const model = async (m) => { if (await run(() => put(`/vms/${vm.id}`, { net: { model: m } }))) reload({ silent: true }); };
  return (
    <div className="stack">
      <NetMode vm={vm} on={on} reload={reload} />
      <InternalNets vm={vm} on={on} reload={reload} />
      <SharedFolders vm={vm} on={on} reload={reload} />
      <div className="card">
        <div className="card-head"><ArrowLeftRight size={16} aria-hidden="true" /><h3>{t('Port forwarding')}</h3><span className="grow" /><Btn className="btn sm primary" icon={Plus} onClick={() => setAdd({ proto: 'tcp', host: '', guest: '', label: '', bind: 'local' })}>Add …</Btn></div>
        <div className="card-body small muted">{t('The VM is behind its own small router (NAT) and reaches the internet. Services in the VM are reachable from this PC through these forwards – also added or removed while the VM runs.')}</div>
        {!forwards.length ? <div className="card-body"><Empty icon={Network} title="No forwarding" text="Add one for SSH (22), a web server (80) or RDP (3389)." /></div> : (
          <div className="list-rows">
            {forwards.map((f) => (
              <div key={`${f.proto}${f.host}`} className="list-row-item">
                <Network size={16} aria-hidden="true" />
                <div className="grow"><div className="list-row-title">{f.label || `${f.guest}`} <span className="badge">{f.proto.toUpperCase()}</span>{f.bind === 'lan' && <span className="badge warn">{t('home network')}</span>}</div><div className="list-row-sub small mono">{f.bind === 'lan' ? '0.0.0.0' : '127.0.0.1'}:{f.host} → VM:{f.guest}</div></div>
                {f.proto === 'tcp' && [80, 8080, 443, 3000, 8000].includes(f.guest) && <Btn className="btn xs" onClick={() => window.open(`${f.guest === 443 ? 'https' : 'http'}://127.0.0.1:${f.host}/`, '_blank', 'noopener')}>Open</Btn>}
                <Btn className="btn xs ghost" icon={Trash2} aria-label={t('Remove')} onClick={() => save(forwards.filter((x) => x !== f))} />
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <div className="card-head"><Cable size={16} aria-hidden="true" /><h3>{t('Network card')}</h3><span className="grow" /></div>
        <div className="card-body row">
          <Seg value={vm.net.model} onChange={(m) => !on && model(m)} options={[{ id: 'virtio', label: 'virtio' }, { id: 'e1000e', label: 'Intel e1000e' }, { id: 'rtl8139', label: 'Realtek 8139' }].map((o) => ({ ...o, disabled: on }))} />
          <span className="small muted grow">{t('virtio is fastest (Linux); Windows installers know e1000e.')} {on ? t('Change when the VM is off.') : ''}</span>
          <span className="mono small">{vm.net.mac}</span>
        </div>
      </div>
      {add && (
        <Modal title="Add port forwarding" onClose={() => setAdd(null)} footer={<><div className="grow" /><Btn className="btn" onClick={() => setAdd(null)}>Cancel</Btn><Btn className="btn primary" disabled={!add.host || !add.guest} onClick={async () => { if (await save([...forwards, { ...add, host: Number(add.host), guest: Number(add.guest) }])) setAdd(null); }}>Add</Btn></>}>
          <div className="stack">
            <div className="row-tight">{[['SSH', 22, 2222], ['HTTP', 80, 8080], ['HTTPS', 443, 8443], ['RDP', 3389, 13389]].map(([l, g, h]) => <Btn key={l} className="btn xs" onClick={() => setAdd({ ...add, label: l, guest: g, host: h + (forwards.length ? forwards.length : 0) })}>{l}</Btn>)}</div>
            <div className="grid grid-3">
              <Field label="Name"><input className="input" value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} /></Field>
              <Field label="Port in the VM"><input className="input" type="number" value={add.guest} onChange={(e) => setAdd({ ...add, guest: e.target.value })} /></Field>
              <Field label="Port on this PC"><input className="input" type="number" value={add.host} onChange={(e) => setAdd({ ...add, host: e.target.value })} /></Field>
            </div>
            <Field label="Protocol"><Seg value={add.proto} onChange={(v) => setAdd({ ...add, proto: v })} options={[{ id: 'tcp', label: 'TCP' }, { id: 'udp', label: 'UDP' }]} /></Field>
            <label className="row small"><Switch checked={add.bind === 'lan'} disabled={!lan} onChange={(v) => setAdd({ ...add, bind: v ? 'lan' : 'local' })} /> {t('Reachable from the home network')} {!lan && <span className="muted">({t('switch on in the settings of this page first')})</span>}</label>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Backups({ vm, on, reload }) {
  const { data: list, reload: again } = useApi(`/vms/${vm.id}/backups`, [vm.id]);
  const create = async () => {
    const label = await promptDialog({ title: t('Back up “{name}”', { name: vm.name }), text: on ? t('The VM keeps running – QEMU copies the disks at this moment (consistent with the guest agent).') : t('Copies all disks compressed.'), label: t('Label (optional)'), value: '', confirm: t('Back up') });
    if (label === null || label === undefined) return;
    const r = await run(() => post(`/vms/${vm.id}/backups`, { label }));
    if (r && r.job) { await waitJob(r.job).then(() => toast.success(t('Backed up'))).catch((e) => toast.error(e.message)); again(); }
  };
  const restore = async (b) => {
    if (!(await confirmDialog({ title: t('Restore backup from {date}?', { date: fmtDate(b.time) }), text: t('The disks are replaced by the backup. Snapshots of the VM are removed.'), confirm: t('Restore'), danger: true }))) return;
    const r = await run(() => post(`/vms/${vm.id}/backups/restore`, { file: b.file }));
    if (r && r.job) { await waitJob(r.job).then(() => toast.success(t('Restored'))).catch((e) => toast.error(e.message)); reload({ silent: true }); }
  };
  const remove = async (b) => { if (await confirmDialog({ title: t('Delete backup?'), confirm: t('Delete'), danger: true })) { await run(() => del(`/vms/${vm.id}/backups/${b.file}`)); again(); } };
  return (
    <div className="card">
      <div className="card-head"><Archive size={16} aria-hidden="true" /><h3>{t('Backups')}</h3><span className="grow" /><Btn className="btn primary sm" icon={Archive} onClick={create}>Back up now …</Btn></div>
      <div className="card-body small muted">{t('Backups also appear in Hostwerk’s backup centre, where you can schedule them.')}</div>
      {!list ? <Loading inline /> : !list.length ? <div className="card-body"><Empty icon={Archive} title="No backups yet" text="A backup is a complete copy outside the VM folder – unlike snapshots it survives a broken disk." /></div> : (
        <div className="list-rows">
          {list.map((b) => (
            <div key={b.file} className="list-row-item">
              <Archive size={16} aria-hidden="true" />
              <div className="grow"><div className="list-row-title">{fmtDate(b.time)} {b.live && <span className="badge">{t('while running')}</span>}</div><div className="list-row-sub small muted">{[b.label, gb(b.size)].filter(Boolean).join(' · ')}</div></div>
              <Btn className="btn xs" icon={Download} disabled={on} onClick={() => restore(b)}>Restore</Btn>
              <Btn className="btn xs ghost" icon={Trash2} aria-label={t('Delete')} onClick={() => remove(b)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProcLog({ vm }) {
  const [lines, setLines] = useLogs(`vm-${vm.id}`);
  return <LogConsole lines={lines} onClear={() => setLines([])} height={420} />;
}
