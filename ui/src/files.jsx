import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Download, File, Folder, FolderOpen, FolderPlus, HardDrive, Link2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { get, post, fmtBytes, fmtDate, apiUrl } from '@hostwerk/api';
import { Btn, Callout, Empty, Loading, confirmDialog, promptDialog, toast } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import { run } from './common';

/*
 * The files of a running VM – through the guest agent, no network share and no SSH needed: walk through the folders,
 * download a file, put files into the folder that is open (button or drag & drop), make a folder, delete.
 */
const ICON = { dir: Folder, file: File, link: Link2 };
/** The path of an entry: at the top of a Windows VM the entries are the drives themselves ("C:\"). */
const join = (dir, name, sep) => (!dir ? name : `${dir}${dir.endsWith(sep) ? '' : sep}${name}`);

export function GuestFiles({ vm, on }) {
  const agent = vm.status && vm.status.agent;
  const ready = on && !!(agent && agent.ok);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const [over, setOver] = useState(false);
  const picker = useRef(null);
  const seq = useRef(0);

  // dir undefined: the home (desktop) of the VM's user
  const open = useCallback(async (dir) => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const r = await get(`/vms/${vm.id}/guest/files${dir === undefined ? '' : `?path=${encodeURIComponent(dir)}`}`);
      if (mine !== seq.current) return;
      setData(r); setInput(r.path); setError(null);
    } catch (e) { if (mine === seq.current) setError(e.message); } finally { if (mine === seq.current) setLoading(false); }
  }, [vm.id]);
  useEffect(() => { setData(null); setError(null); if (ready) open(undefined); }, [vm.id, ready, open]);

  // the sub-tab must not stay blank: say why there is nothing to see yet
  if (!on) return <div className="card"><Empty icon={FolderOpen} title="The VM is off" text="The files inside the VM are reached through the guest agent while the VM runs." /></div>;
  if (!ready) return <div className="card"><Empty icon={FolderOpen} title="Waiting for the guest agent …" text="The files of the VM need the guest agent (qemu-guest-agent). Ready-made Linux VMs bring it along; on Windows install it from the virtio-win ISO." /></div>;

  const dir = data ? data.path : '';
  const sep = data ? data.sep : '/';
  const drives = !!data && !dir; // Windows: the list of drives – nothing to put there
  const reload = () => open(dir);
  const upload = async (files) => {
    for (const f of files) {
      setBusy(f.name);
      try {
        const res = await fetch(apiUrl(`/api/vms/${vm.id}/guest/upload?name=${encodeURIComponent(f.name)}&dir=${encodeURIComponent(dir)}`), { method: 'POST', body: f, credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' } });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        toast.success(t('Copied into the VM: {path}', { path: j.path }));
      } catch (e) { toast.error(e.message); }
    }
    setBusy(null); reload();
  };
  const download = (e) => {
    const a = document.createElement('a');
    a.href = apiUrl(`/api/vms/${vm.id}/guest/download?path=${encodeURIComponent(join(dir, e.name, sep))}`);
    a.download = e.name;
    document.body.append(a); a.click(); a.remove();
  };
  const newFolder = async () => {
    const name = await promptDialog({ title: t('New folder'), text: t('In {path}', { path: dir }), label: t('Name'), value: '', confirm: t('Create') });
    if (name && await run(() => post(`/vms/${vm.id}/guest/files/mkdir`, { path: dir, name }))) reload();
  };
  const remove = async (e) => {
    const target = join(dir, e.name, sep);
    if (!(await confirmDialog({ title: t('Delete “{name}” in the VM?', { name: e.name }), text: e.type === 'dir' ? t('The folder {path} is deleted with everything in it. This cannot be undone – take a snapshot first if unsure.', { path: target }) : t('The file {path} is deleted. This cannot be undone.', { path: target }), confirm: t('Delete'), danger: true }))) return;
    if (await run(() => post(`/vms/${vm.id}/guest/files/delete`, { path: target }), 'Deleted')) reload();
  };
  const onDrop = (e) => {
    e.preventDefault(); e.stopPropagation(); setOver(false);
    const files = [...(e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files : [])];
    if (files.length && !drives) upload(files);
  };

  return (
    <div className={`card vm-drop ${over ? 'over' : ''}`} onDragOver={(e) => { if (!drives && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div className="card-head"><FolderOpen size={16} aria-hidden="true" /><h3>{t('Files in the VM')}</h3><span className="grow" />
        <div className="row-tight">
          <Btn className="sm" icon={FolderPlus} disabled={!data || drives} onClick={newFolder}>New folder …</Btn>
          <Btn className="sm primary" icon={Upload} disabled={!data || drives || !!busy} onClick={() => picker.current && picker.current.click()}>Upload …</Btn>
          <input ref={picker} type="file" multiple hidden onChange={(e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) upload(files); }} />
        </div>
      </div>
      <div className="card-body stack">
        <form className="row vm-files-bar" onSubmit={(e) => { e.preventDefault(); open(input.trim()); }}>
          <Btn className="btn" type="button" icon={ArrowUp} disabled={!data || data.parent === null} title={t('One folder up')} aria-label={t('One folder up')} onClick={() => open(data.parent)} />
          <input className="input mono grow" value={input} onChange={(e) => setInput(e.target.value)} placeholder={vm.osType === 'windows' ? 'C:\\Users' : '/home'} aria-label={t('Folder in the VM')} spellCheck={false} />
          <Btn className="btn" type="submit">Open</Btn>
          <Btn className="btn ghost" type="button" icon={RefreshCw} title={t('Read the folder again')} aria-label={t('Read the folder again')} onClick={reload} />
        </form>
        {error && <Callout kind="err" dismissible={false}>{error}</Callout>}
        {busy && <div className="small muted">{t('Copying {name} into the VM …', { name: busy })}</div>}
      </div>
      {!data ? (loading ? <Loading inline /> : null) : !data.entries.length ? <div className="card-body"><Empty icon={FolderOpen} title="This folder is empty" text="Drop files here or use “Upload …” to put them into this folder of the VM." /></div> : (
        <div className={`list-rows vm-files ${loading ? 'vm-files-loading' : ''}`}>
          {data.entries.map((e) => {
            const Icon = drives ? HardDrive : ICON[e.type] || File;
            const isDir = e.type === 'dir';
            // a link may lead to a folder (/bin → usr/bin): opening it is offered too – a link to a file says so
            const canOpen = isDir || e.type === 'link';
            return (
              <div key={e.name} className="list-row-item">
                <Icon size={16} aria-hidden="true" />
                <div className="grow vm-files-name">
                  {canOpen ? <button type="button" className="link-btn vm-files-open" onClick={() => open(join(dir, e.name, sep))}>{e.name}</button> : <span className="list-row-title">{e.name}</span>}
                  {e.type === 'link' && <span className="badge">{t('link')}</span>}
                </div>
                {!drives && <span className="small muted vm-files-size">{isDir ? '' : fmtBytes(e.size)}</span>}
                {!drives && <span className="small muted vm-files-date">{e.mtime ? fmtDate(e.mtime) : ''}</span>}
                {!drives && (isDir ? <span className="vm-files-gap" /> : <Btn className="btn xs ghost" icon={Download} title={t('Download')} aria-label={t('Download {name}', { name: e.name })} onClick={() => download(e)} />)}
                {!drives && <Btn className="btn xs ghost" icon={Trash2} title={t('Delete')} aria-label={t('Delete {name}', { name: e.name })} onClick={() => remove(e)} />}
              </div>
            );
          })}
        </div>
      )}
      {data && data.truncated && <div className="card-body small muted">{t('Only the first 1000 entries are shown – open a subfolder or use “Commands in the VM” for more.')}</div>}
      {over && <div className="vm-drop-hint">{t('Drop to copy into {path}', { path: dir })}</div>}
    </div>
  );
}
