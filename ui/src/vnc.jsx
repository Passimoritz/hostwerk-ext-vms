import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, Camera, ClipboardPaste, MousePointer2, RefreshCw } from 'lucide-react';
import * as hwApi from '@hostwerk/api';
import { Btn, promptDialog, toast } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import RFB from '@novnc/novnc';
import { ComboMenu, ReleaseButton, KeyboardInfo, ClipboardSwitch, useKeyboardLock, useClipboardPref, useClipboardHelper, releaseTap, readHostClipboard, writeHostClipboard, typeClipboard } from './keyboard';

/*
 * The VM's screen over VNC (noVNC) – fluid, with the guest's own cursor. The browser talks to /ws/vms/<id>/vnc, which
 * server/vnc.js bridges to QEMU's VNC server on 127.0.0.1. The picture scales to the page; where the guest supports it
 * (ExtendedDesktopSize: virtio-gpu / std-vga with a guest driver) the guest resolution follows the size of the box.
 *
 * Keyboard: noVNC takes every key while its canvas has the focus (and keeps it from Hostwerk and the browser). Right
 * Ctrl on its own, "Release" or a click outside gives it back; in full screen Keyboard Lock also hands over Alt+Tab and
 * the Windows key. Shortcuts no page can catch are in the shortcuts menu (QMP send-key, like the simple screen).
 *
 * Clipboard: text copied in the guest arrives as noVNC's "clipboard" event and goes into this PC's clipboard; this PC's
 * clipboard is offered to the guest whenever the screen gets the keyboard – so Ctrl+C / Ctrl+V work across. Needs
 * spice-vdagent in the guest (QEMU's qemu-vdagent chardev, see qemu-args.js).
 *
 * If the very first connection fails (old Hostwerk, proxy missing, VNC not configured, paired machine), or reconnecting
 * keeps failing, onFallback(reason) is called – the caller then shows the PNG screen (screen.jsx) instead.
 *
 *   <VncScreen vm={vm} onFallback={() => setVnc(false)} />
 */
const MAX_RETRIES = 6; // reconnect attempts after a drop before giving up (→ onFallback)

export function vncUrl(id) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/vms/${encodeURIComponent(id)}/vnc`;
}

export function VncScreen({ vm, onFallback, onClipboard, active = true, viewOnly = false }) {
  const target = useRef(null);
  const card = useRef(null);
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
  const [clipOn, setClipOn] = useClipboardPref();
  const clipOnRef = useRef(clipOn);
  clipOnRef.current = clipOn;
  const clipSeen = useRef({ fromGuest: null, toGuest: null });
  const locked = useKeyboardLock(focused && !viewOnly);
  const helper = useClipboardHelper(vm && vm.id, clipOn && active && !viewOnly);
  const base = `/vms/${vm.id}`;

  /** This PC's clipboard → the guest (it pastes it with its own Ctrl+V). */
  const toGuest = async () => {
    const rfb = rfbRef.current;
    if (!rfb || viewOnly || !clipOnRef.current) return;
    let text;
    try { text = await readHostClipboard(); } catch { return; } // not allowed here – "Paste" still asks visibly
    const s = clipSeen.current;
    if (!text || text === s.toGuest || text === s.fromGuest) return;
    try { rfb.clipboardPasteFrom(text); s.toGuest = text; } catch { /* not connected */ }
  };

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
      // Copied in the guest → this PC's clipboard
      rfb.addEventListener('clipboard', (e) => {
        const text = e.detail && typeof e.detail.text === 'string' ? e.detail.text : null;
        if (text == null) return;
        if (clip.current) clip.current(text);
        if (!clipOnRef.current || viewOnly) return;
        const s = clipSeen.current;
        if (text === s.toGuest) return; // our own text coming back
        s.fromGuest = text;
        writeHostClipboard(text).catch(() => {});
      });
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

  // Focus follows the canvas: noVNC captures keyboard and mouse while it has focus. Right Ctrl on its own lets go.
  useEffect(() => {
    const el = target.current;
    if (!el) return undefined;
    const tap = releaseTap();
    const fin = () => { setFocused(true); toGuest(); };
    const fout = () => {
      setFocused(false);
      // noVNC lets go of its keys on blur; the same once more through QMP, in case a key-up got lost on the way
      if (!viewOnly) hwApi.post(`${base}/input`, { events: [{ t: 'r' }] }).catch(() => {});
    };
    // capture phase on the container: sees the keys before noVNC's canvas, without taking them away
    const key = (e) => { if (tap(e) && rfbRef.current) rfbRef.current.blur(); };
    el.addEventListener('focusin', fin);
    el.addEventListener('focusout', fout);
    el.addEventListener('keydown', key, true);
    el.addEventListener('keyup', key, true);
    return () => {
      el.removeEventListener('focusin', fin); el.removeEventListener('focusout', fout);
      el.removeEventListener('keydown', key, true); el.removeEventListener('keyup', key, true);
    };
  }, [base, viewOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from another window (Alt+Tab) with the screen still focused: this PC's clipboard may have changed
  useEffect(() => {
    if (!focused) return undefined;
    const back = () => toGuest();
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, [focused]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const f = () => setIsFull(document.fullscreenElement === card.current);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);

  const refocus = () => { if (rfbRef.current) rfbRef.current.focus(); };
  const combo = async (id) => {
    try { await hwApi.post(`${base}/combo`, { combo: id }); } catch (e) { toast.error(e.message); }
    refocus();
  };
  const typeText = async () => {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    const text = await promptDialog({ title: t('Type text'), text: t('Hostwerk types the text into the VM key by key – with the keyboard layout set under Hardware → Keyboard.'), label: t('Text'), confirm: t('Type') });
    if (!text) return;
    try { await hwApi.post(`${base}/type`, { text }); } catch (e) { toast.error(e.message); }
  };
  const paste = async () => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    try {
      const text = await readHostClipboard();
      if (!text) { toast.error(t('The clipboard of this PC holds no text.')); return; }
      rfb.clipboardPasteFrom(text);
      clipSeen.current.toGuest = text;
      toast.success(t('Clipboard sent to the VM – paste it there with Ctrl+V'));
    } catch (e) { toast.error(t('The browser does not allow reading the clipboard here.')); }
    refocus();
  };
  const shot = () => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    const a = document.createElement('a');
    a.href = rfb.toDataURL('image/png');
    a.download = `${vm.name || 'vm'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    a.click();
  };
  const full = () => {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    const el = card.current; if (el && el.requestFullscreen) el.requestFullscreen().then(refocus).catch(() => {});
  };
  const release = () => { if (rfbRef.current) rfbRef.current.blur(); };
  const retry = () => { setState('connecting'); setAttempt((n) => n + 1); };

  const connected = state === 'connected';
  return (
    <div ref={card} className={`vm-screen-card ${isFull ? 'full' : ''}`}>
      <div className="row vm-screen-bar">
        <span className={`badge ${focused ? 'accent' : ''}`} role="status" aria-live="polite">
          <MousePointer2 size={13} aria-hidden="true" />{' '}
          {state === 'connecting' ? t('Connecting to the screen …')
            : state === 'reconnecting' ? t('Connection lost – reconnecting …')
              : state === 'failed' ? t('Screen connection failed')
                : viewOnly ? t('View only')
                  : !focused ? t('Click into the screen to use keyboard and mouse')
                    : locked ? t('All keys go to the VM – Right Ctrl gives them back')
                      : t('Keyboard and mouse go to the VM – Right Ctrl gives them back')}
        </span>
        {!viewOnly && <KeyboardInfo />}
        {!viewOnly && focused && <ReleaseButton onRelease={release} />}
        {connected && canResize && <span className="badge" title={t('The guest takes the size of this box')}>{t('Auto resolution')}</span>}
        <div className="grow" />
        <div className="row-tight">
          {!viewOnly && <ClipboardSwitch on={clipOn} onChange={setClipOn} helper={helper} />}
          {!viewOnly && <ComboMenu disabled={!connected} onCombo={combo} onTypeClipboard={() => typeClipboard(base)} onTypeText={typeText} />}
          {!viewOnly && <Btn className="btn ghost xs" icon={ClipboardPaste} disabled={!connected} onClick={paste} title="Send this PC's clipboard to the VM">Paste</Btn>}
          <Btn className="btn ghost xs" icon={Camera} disabled={!connected} onClick={shot} title="Save screenshot">Screenshot</Btn>
          <Btn className="btn ghost xs" icon={isFull ? Minimize2 : Maximize2} onClick={full} title={isFull ? 'Leave full screen' : 'Full screen – all keys go to the VM'}>{isFull ? 'Leave full screen' : 'Full screen'}</Btn>
          {state === 'failed' && <Btn className="btn ghost xs" icon={RefreshCw} onClick={retry}>Try again</Btn>}
        </div>
      </div>
      <div className={`vm-screen ${focused ? 'captured' : ''}`} style={{ alignItems: 'stretch' }}>
        {state !== 'connected' && state !== 'connecting' && <div className="vm-screen-msg small">{state === 'reconnecting' ? t('Connection lost – reconnecting …') : t('Screen connection failed')}</div>}
        <div
          ref={target}
          aria-label={t('Screen of {name}', { name: vm.name })}
          className="vm-vnc"
          style={{ width: '100%', height: isFull ? '100%' : 'min(72vh, calc(100vw * 0.5625))', minHeight: 240 }}
        />
      </div>
    </div>
  );
}
