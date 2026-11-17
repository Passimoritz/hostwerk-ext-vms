import { useEffect, useRef, useState } from 'react';
import { Keyboard, Maximize2, Camera, MousePointer2, Type, Pause, Play } from 'lucide-react';
import { apiUrl, post } from '@hostwerk/api';
import { Btn, Seg, promptDialog, toast } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';

/*
 * The VM's screen inside Hostwerk: QEMU renders into its framebuffer, the page fetches it as PNG (only when it changed –
 * ETag) and draws it on a canvas. Click into the picture to capture keyboard and mouse; Esc twice (or the button) lets
 * go again. Keys go by their physical position (KeyboardEvent.code), so the guest's keyboard layout decides – like a
 * real PC. Shortcuts this PC would catch (Ctrl+Alt+Del …) are buttons.
 */
const COMBOS = [['ctrl-alt-del', 'Ctrl+Alt+Del'], ['ctrl-alt-f1', 'Ctrl+Alt+F1'], ['ctrl-alt-f2', 'Ctrl+Alt+F2'], ['alt-tab', 'Alt+Tab'], ['meta', 'Windows key'], ['alt-f4', 'Alt+F4']];

export function Screen({ vm, vbox = false, active = true }) {
  const canvas = useRef(null);
  const wrap = useRef(null);
  const [size, setSize] = useState(null);
  const [captured, setCaptured] = useState(false);
  const [fps, setFps] = useState('normal');
  const [err, setErr] = useState(null);
  const queue = useRef([]);
  const lastEsc = useRef(0);
  const base = vbox ? `/vms/vbox/${vm.uuid}` : `/vms/${vm.id}`;

  // Frames: QEMU on change only (ETag), VirtualBox as a screenshot every few seconds
  useEffect(() => {
    if (!active) return undefined;
    let alive = true; let etag = null; let timer = null;
    const delay = vbox ? 2500 : fps === 'fast' ? 120 : fps === 'slow' ? 1000 : 300;
    const tick = async () => {
      if (!alive) return;
      if (!document.hidden) {
        try {
          const res = await fetch(apiUrl(`/api${base}/screen`), { credentials: 'same-origin', headers: etag ? { 'If-None-Match': etag } : {} });
          if (res.status === 200) {
            etag = res.headers.get('ETag');
            const bmp = await createImageBitmap(await res.blob());
            const c = canvas.current;
            if (c && alive) {
              if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; setSize([bmp.width, bmp.height]); }
              c.getContext('2d').drawImage(bmp, 0, 0);
            }
            setErr(null);
          } else if (res.status !== 304) { const j = await res.json().catch(() => null); setErr((j && j.error) || `HTTP ${res.status}`); }
        } catch (e) { setErr(e.message); }
      }
      if (alive) timer = setTimeout(tick, delay);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [base, active, fps, vbox]);

  // Input is batched (one request per animation frame)
  const flush = useRef(null);
  const send = (ev) => {
    if (vbox) return;
    queue.current.push(ev);
    if (flush.current) return;
    flush.current = requestAnimationFrame(() => {
      flush.current = null;
      const events = queue.current.splice(0);
      if (events.length) post(`${base}/input`, { events }).catch(() => {});
    });
  };
  const pos = (e) => { const r = canvas.current.getBoundingClientRect(); return { t: 'm', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
  const BTN = ['left', 'middle', 'right'];

  useEffect(() => {
    if (!captured || vbox) return undefined;
    const key = (d) => (e) => {
      if (e.code === 'Escape' && d) { const now = Date.now(); if (now - lastEsc.current < 400) { setCaptured(false); return; } lastEsc.current = now; }
      e.preventDefault(); e.stopPropagation();
      send({ t: 'k', c: e.code, d });
    };
    const down = key(true); const up = key(false);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); };
  }, [captured, vbox]); // eslint-disable-line react-hooks/exhaustive-deps

  const typeText = async () => {
    const text = await promptDialog({ title: t('Type text'), text: t('Hostwerk types the text into the VM key by key (US keyboard layout).'), label: t('Text'), confirm: t('Type') });
    if (!text) return;
    try { await post(vbox ? `${base}/type` : `${base}/type`, { text }); } catch (e) { toast.error(e.message); }
  };
  const combo = async (c) => { try { await post(vbox ? `${base}/ctrl-alt-del` : `${base}/combo`, { combo: c }); } catch (e) { toast.error(e.message); } };
  const shot = () => { const c = canvas.current; if (!c) return; const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = `${vm.name || 'vm'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`; a.click(); };
  const full = () => { const el = wrap.current; if (el && el.requestFullscreen) el.requestFullscreen().catch(() => {}); };

  return (
    <div className="vm-screen-card">
      <div className="row vm-screen-bar">
        {!vbox && <span className={`badge ${captured ? 'accent' : ''}`}><MousePointer2 size={13} aria-hidden="true" /> {captured ? t('Keyboard and mouse go to the VM – press Esc twice to release') : t('Click into the screen to use keyboard and mouse')}</span>}
        {vbox && <span className="badge">VirtualBox · {t('screenshot every few seconds')}</span>}
        <div className="grow" />
        <div className="row-tight">
          {(vbox ? COMBOS.slice(0, 1) : COMBOS).map(([id, label]) => <Btn key={id} className="btn ghost xs" onClick={() => combo(id)} icon={Keyboard}>{label}</Btn>)}
          <Btn className="btn ghost xs" icon={Type} onClick={typeText}>Type text …</Btn>
          <Btn className="btn ghost xs" icon={Camera} onClick={shot} title="Save screenshot">Screenshot</Btn>
          <Btn className="btn ghost xs" icon={Maximize2} onClick={full} title="Full screen">Full screen</Btn>
          {!vbox && <Seg value={fps} onChange={setFps} options={[{ value: 'slow', label: t('Saving') }, { value: 'normal', label: t('Normal') }, { value: 'fast', label: t('Smooth') }]} />}
        </div>
      </div>
      <div ref={wrap} className={`vm-screen ${captured ? 'captured' : ''}`}>
        {err && <div className="vm-screen-msg small">{err}</div>}
        <canvas
          ref={canvas}
          tabIndex={0}
          aria-label={t('Screen of {name}', { name: vm.name })}
          className="vm-canvas"
          style={size ? { aspectRatio: `${size[0]} / ${size[1]}` } : undefined}
          onMouseDown={(e) => { if (vbox) return; if (!captured) { setCaptured(true); canvas.current.focus(); return; } e.preventDefault(); send(pos(e)); send({ t: 'b', b: BTN[e.button] || 'left', d: true }); }}
          onMouseUp={(e) => { if (!captured || vbox) return; send(pos(e)); send({ t: 'b', b: BTN[e.button] || 'left', d: false }); }}
          onMouseMove={(e) => { if (captured && !vbox) send(pos(e)); }}
          onWheel={(e) => { if (!captured || vbox) return; const b = e.deltaY < 0 ? 'wheel-up' : 'wheel-down'; send({ t: 'b', b, d: true }); send({ t: 'b', b, d: false }); }}
          onContextMenu={(e) => { if (captured) e.preventDefault(); }}
          onBlur={() => setCaptured(false)}
        />
      </div>
    </div>
  );
}

export function PausedNote({ onResume }) {
  return <div className="row small muted"><Pause size={14} aria-hidden="true" /> {t('The VM is paused.')} <Btn className="btn xs" icon={Play} onClick={onResume}>Resume</Btn></div>;
}
