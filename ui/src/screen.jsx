import { useEffect, useId, useRef, useState } from 'react';
import { Maximize2, Minimize2, Camera, MousePointer2, Type, ClipboardPaste } from 'lucide-react';
import { apiUrl, get, post } from '@hostwerk/api';
import { Btn, Seg, promptDialog, toast } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import { ComboMenu, ReleaseButton, KeyboardInfo, ClipboardSwitch, useKeyboardLock, useClipboardPref, useClipboardHelper, releaseTap, readHostClipboard, writeHostClipboard, typeClipboard } from './keyboard';

/*
 * The VM's screen inside Hostwerk: QEMU renders into its framebuffer, the page fetches it as PNG (only when it changed –
 * ETag) and draws it on a canvas. Click into the picture (or Enter on it) to capture keyboard and mouse; Right Ctrl on
 * its own, the "Release" button or a click outside lets go again. Keys go by their physical position
 * (KeyboardEvent.code), so the guest's keyboard layout decides – like a real PC. Every key the page sees is kept from
 * Hostwerk and the browser; in full screen Keyboard Lock hands over Alt+Tab and the Windows key as well. Modifiers still
 * held when the page loses the keyboard are released in the guest. Shortcuts this PC catches anyway (Ctrl+Alt+Del …)
 * are in the shortcuts menu.
 *
 * Shared clipboard: the server keeps a small VNC connection for the clipboard (server/clipboard.js); the page offers
 * this PC's clipboard when the screen gets the keyboard and polls for text copied in the guest.
 */
export function Screen({ vm, vbox = false, active = true }) {
  const canvas = useRef(null);
  const card = useRef(null);
  const [size, setSize] = useState(null);
  const [captured, setCaptured] = useState(false);
  const [fps, setFps] = useState('normal');
  const [err, setErr] = useState(null);
  const [isFull, setIsFull] = useState(false);
  const [clipOn, setClipOn] = useClipboardPref();
  const hintId = useId();
  const queue = useRef([]);
  const pressed = useRef(new Set());
  const clipSeen = useRef({ seq: null, fromGuest: null, toGuest: null });
  const base = vbox ? `/vms/vbox/${vm.uuid}` : `/vms/${vm.id}`;
  const locked = useKeyboardLock(captured && !vbox);
  const helper = useClipboardHelper(vbox ? null : vm.id, clipOn && active);

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

  useEffect(() => {
    const f = () => setIsFull(document.fullscreenElement === card.current);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);

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
  /** Keys still held go up in the guest (and every modifier, to be sure) – nothing stays stuck after Alt+Tab or a blur. */
  const letGo = () => {
    if (vbox) return;
    for (const c of pressed.current) send({ t: 'k', c, d: false });
    pressed.current.clear();
    send({ t: 'r' });
  };
  const pos = (e) => { const r = canvas.current.getBoundingClientRect(); return { t: 'm', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
  const BTN = ['left', 'middle', 'right'];

  /* ---------- shared clipboard ---------- */
  const toGuest = async () => {
    if (vbox || !clipOn) return;
    let text;
    try { text = await readHostClipboard(); } catch { return; } // not allowed here – "Paste" and "Type the clipboard" still work
    const s = clipSeen.current;
    if (!text || text === s.toGuest || text === s.fromGuest) return;
    try { await post(`${base}/clipboard`, { text }); s.toGuest = text; } catch { /* no clipboard in this VM */ }
  };
  useEffect(() => {
    if (vbox || !active || !clipOn) return undefined;
    let alive = true; let timer = null;
    const tick = async () => {
      let wait = 1000;
      if (!document.hidden) {
        try {
          const r = await get(`${base}/clipboard?watch=1`);
          const s = clipSeen.current;
          if (s.seq == null) s.seq = r.seq; // what the guest copied before this page opened stays there
          else if (r.seq !== s.seq) {
            s.seq = r.seq;
            if (r.text && r.text !== s.toGuest) { s.fromGuest = r.text; await writeHostClipboard(r.text).catch(() => {}); }
          }
        } catch { wait = 5000; }
      }
      if (alive) timer = setTimeout(tick, wait);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [base, vbox, active, clipOn]);

  /* ---------- keyboard ---------- */
  const capture = () => { if (vbox) return; setCaptured(true); if (canvas.current) canvas.current.focus(); toGuest(); };
  const release = () => { letGo(); setCaptured(false); if (canvas.current) canvas.current.blur(); };

  useEffect(() => {
    if (!captured || vbox) return undefined;
    const tap = releaseTap();
    const key = (d) => (e) => {
      if (e.isComposing) return;
      e.preventDefault(); e.stopPropagation();
      if (tap(e)) { send({ t: 'k', c: e.code, d: false }); pressed.current.delete(e.code); release(); return; }
      if (d) pressed.current.add(e.code); else pressed.current.delete(e.code);
      send({ t: 'k', c: e.code, d });
    };
    const down = key(true); const up = key(false);
    // back to the page after Alt+Tab: the clipboard of this PC may have changed meanwhile
    const back = () => toGuest();
    const hide = () => { if (document.hidden) letGo(); };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', hide);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', hide);
    };
  }, [captured, vbox, clipOn]); // eslint-disable-line react-hooks/exhaustive-deps

  const typeText = async () => {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    // QEMU types with the layout of the VM (Hardware → Keyboard); VirtualBox always as on a US keyboard
    const text = await promptDialog({ title: t('Type text'), text: vbox ? t('Hostwerk types the text into the VM key by key (US keyboard layout).') : t('Hostwerk types the text into the VM key by key – with the keyboard layout set under Hardware → Keyboard.'), label: t('Text'), confirm: t('Type') });
    if (!text) return;
    try { await post(`${base}/type`, { text }); } catch (e) { toast.error(e.message); }
  };
  const combo = async (c) => { try { await post(vbox ? `${base}/ctrl-alt-del` : `${base}/combo`, { combo: c }); } catch (e) { toast.error(e.message); } if (captured && canvas.current) canvas.current.focus(); };
  const paste = async () => {
    let text;
    try { text = await readHostClipboard(); } catch { toast.error(t('The browser does not allow reading the clipboard here.')); return; }
    if (!text) { toast.error(t('The clipboard of this PC holds no text.')); return; }
    try { await post(`${base}/clipboard`, { text }); clipSeen.current.toGuest = text; toast.success(t('Clipboard sent to the VM – paste it there with Ctrl+V')); } catch (e) { toast.error(e.message); }
  };
  const shot = () => { const c = canvas.current; if (!c) return; const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = `${vm.name || 'vm'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`; a.click(); };
  const full = () => {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    const el = card.current; if (el && el.requestFullscreen) el.requestFullscreen().then(() => { if (!vbox) capture(); }).catch(() => {});
  };

  const status = !captured ? t('Click into the screen to use keyboard and mouse')
    : locked ? t('All keys go to the VM – Right Ctrl gives them back')
      : t('Keyboard and mouse go to the VM – Right Ctrl gives them back');
  return (
    <div ref={card} className={`vm-screen-card ${isFull ? 'full' : ''}`}>
      <div className="row vm-screen-bar">
        {!vbox && <span className={`badge ${captured ? 'accent' : ''}`} role="status" aria-live="polite"><MousePointer2 size={13} aria-hidden="true" /> {status}</span>}
        {!vbox && <KeyboardInfo />}
        {!vbox && captured && <ReleaseButton onRelease={release} />}
        {vbox && <span className="badge">VirtualBox · {t('screenshot every few seconds')}</span>}
        <div className="grow" />
        <div className="row-tight">
          {!vbox && <ClipboardSwitch on={clipOn} onChange={setClipOn} helper={helper} simple />}
          <ComboMenu onCombo={combo} only={vbox ? ['ctrl-alt-del'] : null} onTypeClipboard={() => typeClipboard(base)} onTypeText={typeText} />
          {!vbox && <Btn className="btn ghost xs" icon={ClipboardPaste} onClick={paste} title="Send this PC's clipboard to the VM">Paste</Btn>}
          {vbox && <Btn className="btn ghost xs" icon={Type} onClick={typeText}>Type text …</Btn>}
          <Btn className="btn ghost xs" icon={Camera} onClick={shot} title="Save screenshot">Screenshot</Btn>
          <Btn className="btn ghost xs" icon={isFull ? Minimize2 : Maximize2} onClick={full} title={isFull ? 'Leave full screen' : 'Full screen – all keys go to the VM'}>{isFull ? 'Leave full screen' : 'Full screen'}</Btn>
          {!vbox && <Seg value={fps} onChange={setFps} options={[{ id: 'slow', label: t('Saving') }, { id: 'normal', label: t('Normal') }, { id: 'fast', label: t('Smooth') }]} />}
        </div>
      </div>
      <div className={`vm-screen ${captured ? 'captured' : ''}`}>
        {err && <div className="vm-screen-msg small">{err}</div>}
        <canvas
          ref={canvas}
          tabIndex={0}
          aria-label={t('Screen of {name}', { name: vm.name })}
          aria-describedby={vbox ? undefined : hintId}
          className="vm-canvas"
          style={size ? { aspectRatio: `${size[0]} / ${size[1]}` } : undefined}
          onMouseDown={(e) => { if (vbox) return; if (!captured) { capture(); return; } e.preventDefault(); send(pos(e)); send({ t: 'b', b: BTN[e.button] || 'left', d: true }); }}
          onMouseUp={(e) => { if (!captured || vbox) return; send(pos(e)); send({ t: 'b', b: BTN[e.button] || 'left', d: false }); }}
          onMouseMove={(e) => { if (captured && !vbox) send(pos(e)); }}
          onWheel={(e) => { if (!captured || vbox) return; const b = e.deltaY < 0 ? 'wheel-up' : 'wheel-down'; send({ t: 'b', b, d: true }); send({ t: 'b', b, d: false }); }}
          onKeyDown={(e) => { if (!captured && !vbox && e.key === 'Enter') { e.preventDefault(); capture(); } }}
          onContextMenu={(e) => { if (captured) e.preventDefault(); }}
          onBlur={() => { if (captured) { letGo(); setCaptured(false); } }}
        />
        {!vbox && <span id={hintId} className="sr-only">{t('Press Enter to type in the VM. Right Ctrl on its own gives the keyboard back.')}</span>}
      </div>
    </div>
  );
}
