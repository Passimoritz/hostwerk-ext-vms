import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Maximize2, Camera, ClipboardPaste, MousePointer2, RefreshCw } from 'lucide-react';
import * as hwApi from '@hostwerk/api';
import { Btn, toast } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import RFB from '@novnc/novnc';

/*
 * The VM's screen over VNC (noVNC) – fluid, with the guest's own cursor. The browser talks to /ws/vms/<id>/vnc, which
 * server/vnc.js bridges to QEMU's VNC server on 127.0.0.1. The picture scales to the page; where the guest supports it
 * (ExtendedDesktopSize: virtio-gpu / std-vga with a guest driver) the guest resolution follows the size of the box.
 *
 * If the very first connection fails (old Hostwerk, proxy missing, VNC not configured, paired machine), or reconnecting
 * keeps failing, onFallback(reason) is called – the caller then shows the PNG screen (screen.jsx) instead.
 *
 *   <VncScreen vm={vm} onFallback={() => setVnc(false)} onClipboard={(text) => …} />
 */

// X11 keysyms for combos the browser or this PC would catch
const XK = { Control_L: 0xffe3, Alt_L: 0xffe9, Super_L: 0xffeb, Tab: 0xff09, F1: 0xffbe, F2: 0xffbf, F4: 0xffc1 };
const KEYS = {
  'ctrl-alt-f1': [[XK.Control_L, 'ControlLeft'], [XK.Alt_L, 'AltLeft'], [XK.F1, 'F1']],
  'ctrl-alt-f2': [[XK.Control_L, 'ControlLeft'], [XK.Alt_L, 'AltLeft'], [XK.F2, 'F2']],
  'alt-tab': [[XK.Alt_L, 'AltLeft'], [XK.Tab, 'Tab']],
  meta: [[XK.Super_L, 'MetaLeft']],
  'alt-f4': [[XK.Alt_L, 'AltLeft'], [XK.F4, 'F4']],
};
const COMBOS = [['ctrl-alt-del', 'Ctrl+Alt+Del'], ['ctrl-alt-f1', 'Ctrl+Alt+F1'], ['ctrl-alt-f2', 'Ctrl+Alt+F2'], ['alt-tab', 'Alt+Tab'], ['meta', 'Windows key'], ['alt-f4', 'Alt+F4']];
const MAX_RETRIES = 6; // reconnect attempts after a drop before giving up (→ onFallback)

export function vncUrl(id) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/vms/${encodeURIComponent(id)}/vnc`;
}

export function VncScreen({ vm, onFallback, onClipboard, active = true, viewOnly = false }) {
  const target = useRef(null);
  const wrap = useRef(null);
  const rfbRef = useRef(null);
  const fallback = useRef(onFallback);
  const clip = useRef(onClipboard);
  fallback.current = onFallback;
  clip.current = onClipboard;
  const [state, setState] = useState('connecting'); // connecting | connected | reconnecting | failed
  const [focused, setFocused] = useState(false);
  const [canResize, setCanResize] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const [attempt, setAttempt] = useState(0); // bump = connect again

  useEffect(() => {
    if (!active || !vm || !vm.id || !target.current) return undefined;
    // A paired machine is reached through /ws/m/<machine>, which only forwards its event channel and terminal
    if (typeof hwApi.currentMachine === 'function' && hwApi.currentMachine()) { if (fallback.current) fallback.current('remote-machine'); return undefined; }
    let alive = true;
    let everConnected = false;
    let retries = 0;
    let timer = null;
    let rfb = null;

    const open = () => {
      if (!alive) return;
      try {
        rfb = new RFB(target.current, vncUrl(vm.id), { wsProtocols: ['binary'], shared: true });
      } catch (e) {
        setState('failed');
        if (fallback.current) fallback.current(e && e.message ? e.message : 'websocket');
        return;
      }
      rfbRef.current = rfb;
      rfb.scaleViewport = true; // fit into the box
      rfb.resizeSession = true; // ask the guest to take the box size (only where the server/guest support it)
      rfb.clipViewport = false;
      rfb.focusOnClick = true;
      rfb.viewOnly = !!viewOnly;
      rfb.background = 'transparent';
      rfb.addEventListener('connect', () => {
        everConnected = true; retries = 0;
        if (alive) setState('connected');
      });
      rfb.addEventListener('disconnect', (e) => {
        if (rfbRef.current === rfb) rfbRef.current = null;
        if (!alive) return;
        setFocused(false);
        if (!everConnected) {
          // Never got a picture: proxy missing, VNC not configured, VM not running – the PNG screen takes over
          setState('failed');
          if (fallback.current) fallback.current(e.detail && e.detail.clean ? 'closed' : 'unreachable');
          return;
        }
        if (retries >= MAX_RETRIES) { setState('failed'); if (fallback.current) fallback.current('dropped'); return; }
        retries += 1;
        setState('reconnecting');
        timer = setTimeout(open, Math.min(10000, 500 * 2 ** retries));
      });
      rfb.addEventListener('securityfailure', () => { if (alive && !everConnected && fallback.current) fallback.current('security'); });
      rfb.addEventListener('credentialsrequired', () => { try { rfb.disconnect(); } catch { /* ignore */ } });
      rfb.addEventListener('capabilities', () => { if (alive) setCanResize(!!(rfb.capabilities && rfb.capabilities.resize)); });
      rfb.addEventListener('clipboard', (e) => { if (clip.current && e.detail && typeof e.detail.text === 'string') clip.current(e.detail.text); });
    };
    open();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      if (rfb) { try { rfb.disconnect(); } catch { /* ignore */ } }
      rfbRef.current = null;
    };
  }, [vm && vm.id, active, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (rfbRef.current) rfbRef.current.viewOnly = !!viewOnly; }, [viewOnly]);

  // Focus follows the canvas: noVNC captures keyboard and mouse while it has focus
  useEffect(() => {
    const el = target.current;
    if (!el) return undefined;
    const fin = () => setFocused(true);
    const fout = () => setFocused(false);
    el.addEventListener('focusin', fin);
    el.addEventListener('focusout', fout);
    return () => { el.removeEventListener('focusin', fin); el.removeEventListener('focusout', fout); };
  }, []);

  useEffect(() => {
    const f = () => setIsFull(document.fullscreenElement === wrap.current);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);

  const combo = useCallback((id) => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    if (id === 'ctrl-alt-del') { rfb.sendCtrlAltDel(); return; }
    const keys = KEYS[id];
    if (!keys) return;
    for (const [sym, code] of keys) rfb.sendKey(sym, code, true);
    for (const [sym, code] of [...keys].reverse()) rfb.sendKey(sym, code, false);
    rfb.focus();
  }, []);

  const paste = async () => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) { rfb.clipboardPasteFrom(text); toast.success(t('Clipboard sent to the VM')); }
    } catch (e) { toast.error(t('The browser does not allow reading the clipboard here.')); }
  };
  const shot = () => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    const a = document.createElement('a');
    a.href = rfb.toDataURL('image/png');
    a.download = `${vm.name || 'vm'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    a.click();
  };
  const full = () => { const el = wrap.current; if (el && el.requestFullscreen) el.requestFullscreen().catch(() => {}); };
  const retry = () => { setState('connecting'); setAttempt((n) => n + 1); };

  const connected = state === 'connected';
  return (
    <div className="vm-screen-card">
      <div className="row vm-screen-bar">
        <span className={`badge ${focused ? 'accent' : ''}`}>
          <MousePointer2 size={13} aria-hidden="true" />{' '}
          {state === 'connecting' ? t('Connecting to the screen …')
            : state === 'reconnecting' ? t('Connection lost – reconnecting …')
              : state === 'failed' ? t('Screen connection failed')
                : viewOnly ? t('View only')
                  : focused ? t('Keyboard and mouse go to the VM – click outside to release') : t('Click into the screen to use keyboard and mouse')}
        </span>
        {connected && canResize && <span className="badge" title={t('The guest takes the size of this box')}>{t('Auto resolution')}</span>}
        <div className="grow" />
        <div className="row-tight">
          {!viewOnly && COMBOS.map(([id, label]) => <Btn key={id} className="btn ghost xs" disabled={!connected} onClick={() => combo(id)} icon={Keyboard}>{label}</Btn>)}
          {!viewOnly && <Btn className="btn ghost xs" icon={ClipboardPaste} disabled={!connected} onClick={paste} title="Send this PC's clipboard to the VM">Paste</Btn>}
          <Btn className="btn ghost xs" icon={Camera} disabled={!connected} onClick={shot} title="Save screenshot">Screenshot</Btn>
          <Btn className="btn ghost xs" icon={Maximize2} onClick={full} title="Full screen">Full screen</Btn>
          {state === 'failed' && <Btn className="btn ghost xs" icon={RefreshCw} onClick={retry}>Try again</Btn>}
        </div>
      </div>
      <div ref={wrap} className={`vm-screen ${focused ? 'captured' : ''}`} style={{ alignItems: 'stretch' }}>
        {state !== 'connected' && state !== 'connecting' && <div className="vm-screen-msg small">{state === 'reconnecting' ? t('Connection lost – reconnecting …') : t('Screen connection failed')}</div>}
        <div
          ref={target}
          aria-label={t('Screen of {name}', { name: vm.name })}
          style={{ width: '100%', height: isFull ? '100vh' : 'min(72vh, calc(100vw * 0.5625))', minHeight: 240 }}
        />
      </div>
    </div>
  );
}
