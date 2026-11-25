import { useEffect, useRef, useState } from 'react';
import { Keyboard, ChevronDown, ClipboardPaste, Type, Unlock } from 'lucide-react';
import { get, post } from '@hostwerk/api';
import { Btn, Switch, InfoTip, toast } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';

/*
 * What both screens share (screen.jsx – pictures, vnc.jsx – noVNC):
 *   - the shortcut menu: combos this PC, Windows or the browser catch before the page sees them (sent through QMP
 *     send-key, /api/vms/<id>/combo – the same for both screens) plus "Type the clipboard" as the way that always works
 *   - Keyboard Lock: in full screen the browser hands over Alt+Tab, the Windows key, Ctrl+W … (Chromium/Electron)
 *   - the release key: Right Ctrl on its own, like VirtualBox's host key
 *   - the shared clipboard switch, remembered on this PC
 * The menu is drawn inside the screen card, so it also works in full screen (Hostwerk's own menus live outside it).
 */

export const RELEASE_KEY = 'ControlRight';

/** Groups of the shortcut menu: [combo id (server/keys.js COMBOS), label]. */
export const COMBO_GROUPS = [
  ['System', [['ctrl-alt-del', 'Ctrl+Alt+Del'], ['ctrl-shift-esc', 'Ctrl+Shift+Esc'], ['alt-tab', 'Alt+Tab'], ['alt-shift-tab', 'Alt+Shift+Tab'], ['alt-f4', 'Alt+F4'], ['alt-esc', 'Alt+Esc'], ['print', 'Print'], ['alt-print', 'Alt+Print']]],
  ['Windows key', [['meta', 'Windows key'], ['meta-d', 'Win+D'], ['meta-e', 'Win+E'], ['meta-l', 'Win+L'], ['meta-r', 'Win+R'], ['meta-tab', 'Win+Tab'], ['meta-v', 'Win+V'], ['meta-space', 'Win+Space'], ['ctrl-esc', 'Ctrl+Esc']]],
  ['Linux', [['ctrl-alt-f1', 'Ctrl+Alt+F1'], ['ctrl-alt-f2', 'Ctrl+Alt+F2'], ['ctrl-alt-f3', 'Ctrl+Alt+F3'], ['ctrl-alt-f4', 'Ctrl+Alt+F4'], ['ctrl-alt-f7', 'Ctrl+Alt+F7'], ['ctrl-alt-backspace', 'Ctrl+Alt+Backspace'], ['alt-f2', 'Alt+F2'], ['alt-space', 'Alt+Space']]],
  ['Edit', [['ctrl-c', 'Ctrl+C'], ['ctrl-v', 'Ctrl+V'], ['ctrl-x', 'Ctrl+X'], ['ctrl-a', 'Ctrl+A'], ['ctrl-z', 'Ctrl+Z'], ['ctrl-y', 'Ctrl+Y'], ['ctrl-shift-c', 'Ctrl+Shift+C'], ['ctrl-shift-v', 'Ctrl+Shift+V'], ['shift-insert', 'Shift+Insert']]],
  ['Browser and windows', [['ctrl-w', 'Ctrl+W'], ['ctrl-t', 'Ctrl+T'], ['ctrl-n', 'Ctrl+N'], ['ctrl-shift-t', 'Ctrl+Shift+T'], ['ctrl-tab', 'Ctrl+Tab'], ['ctrl-shift-tab', 'Ctrl+Shift+Tab'], ['ctrl-q', 'Ctrl+Q'], ['ctrl-r', 'Ctrl+R'], ['f5', 'F5'], ['f11', 'F11'], ['f12', 'F12'], ['esc', 'Esc']]],
];

/* ---------------- Keyboard Lock (only takes effect in full screen) ---------------- */
const kb = () => (typeof navigator !== 'undefined' && navigator.keyboard && typeof navigator.keyboard.lock === 'function' ? navigator.keyboard : null);
/**
 * Locks all keys while `on` and the page is in full screen.
 * Returns 'locked', 'denied' (in full screen, but the browser or an older Hostwerk refuses the lock – Alt+Tab and the
 * Windows key then stay with this PC) or '' (not in full screen / not wanted).
 */
export function useKeyboardLock(on) {
  const [state, setState] = useState('');
  const [full, setFull] = useState(typeof document !== 'undefined' && !!document.fullscreenElement);
  useEffect(() => {
    const f = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);
  useEffect(() => {
    if (!on || !full) { setState(''); return undefined; }
    const k = kb();
    if (!k) { setState('denied'); return undefined; }
    let alive = true;
    k.lock().then(() => { if (alive) setState('locked'); }).catch(() => { if (alive) setState('denied'); });
    return () => { alive = false; try { k.unlock(); } catch { /* ignore */ } setState(''); };
  }, [on, full]);
  return state;
}

/**
 * Right Ctrl pressed and let go on its own = release. Feed every key event; returns true on the release.
 *   const tap = releaseTap();  …  if (tap(e)) release();
 */
export function releaseTap() {
  let armed = false;
  return (e) => {
    if (e.type === 'keydown') {
      if (e.code === RELEASE_KEY) { if (!e.repeat) armed = true; } else armed = false;
      return false;
    }
    if (e.type === 'keyup' && e.code === RELEASE_KEY) { const hit = armed; armed = false; return hit; }
    return false;
  };
}

/* ---------------- Shared clipboard ---------------- */
const PREF = 'hw-vms-clipboard';
export function useClipboardPref() {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(PREF) !== 'off'; } catch { return true; } });
  const set = (v) => { setOn(v); try { localStorage.setItem(PREF, v ? 'on' : 'off'); } catch { /* ignore */ } };
  return [on, set];
}
export async function readHostClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('no clipboard');
  return navigator.clipboard.readText();
}
export async function writeHostClipboard(text) {
  if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
  await navigator.clipboard.writeText(text);
}

/**
 * How the VM's clipboard works, asked now and then: { helper, mode, session, tools }
 *   mode 'vdagent' (QEMU's VNC clipboard ⇄ spice-vdagent), 'agent' (Linux: guest agent + wl-clipboard/Klipper/xclip),
 *   'none' (only typing), null while unknown. See Runtime.clipboardMode.
 */
export function useClipboardInfo(vmId, on) {
  const [info, setInfo] = useState({ helper: null, mode: null, session: null, tools: [] });
  useEffect(() => {
    if (!on || !vmId) return undefined;
    let alive = true; let timer = null;
    const tick = async () => {
      try { const r = await get(`/vms/${vmId}/clipboard`); if (alive && r) setInfo({ helper: typeof r.helper === 'boolean' ? r.helper : null, mode: r.mode || null, session: r.session || null, tools: r.tools || [] }); } catch { /* VM stopped */ }
      if (alive) timer = setTimeout(tick, 15000);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [vmId, on]);
  return info;
}

/**
 * Clipboard through the server (GET/POST /api/vms/<id>/clipboard) – the simple screen always, the fluid screen when the
 * guest agent carries it. push(): this PC's clipboard → VM (when it changed). Text copied in the VM is fetched every
 * `poll` ms (0 = not) and once when the screen gives the keyboard back – right when you go to paste it on this PC.
 */
export function useServerClipboard({ base, enabled, poll, captured }) {
  const seen = useRef({ seq: null, fromGuest: null, toGuest: null });
  const pull = useRef(null);
  pull.current = async () => {
    const r = await get(`${base}/clipboard?watch=1`);
    const s = seen.current;
    if (s.seq == null) { s.seq = r.seq; return; } // what the guest copied before this page opened stays there
    if (r.seq === s.seq) return;
    s.seq = r.seq;
    if (r.text && r.text !== s.toGuest && r.text !== s.fromGuest) { s.fromGuest = r.text; await writeHostClipboard(r.text).catch(() => {}); }
  };
  useEffect(() => {
    if (!enabled || !poll) return undefined;
    let alive = true; let timer = null;
    const tick = async () => {
      let wait = poll;
      if (!document.hidden) { try { await pull.current(); } catch { wait = Math.max(poll, 5000); } }
      if (alive) timer = setTimeout(tick, wait);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [base, enabled, poll]);
  // the keyboard went back to this PC: fetch once more (a copy right before leaving the VM)
  const was = useRef(captured);
  useEffect(() => {
    if (enabled && was.current && !captured) pull.current().catch(() => {});
    if (enabled && seen.current.seq == null) pull.current().catch(() => {});
    was.current = captured;
  }, [captured, enabled]);
  const push = async ({ loud = false } = {}) => {
    let text;
    try { text = await readHostClipboard(); } catch { if (loud) toast.error(t('The browser does not allow reading the clipboard here.')); return false; }
    const s = seen.current;
    if (!text) { if (loud) toast.error(t('The clipboard of this PC holds no text.')); return false; }
    if (!loud && (text === s.toGuest || text === s.fromGuest)) return false;
    try { await post(`${base}/clipboard`, { text }); s.toGuest = text; return true; } catch (e) { if (loud) toast.error(e.message); return false; }
  };
  return { push, seen };
}

/** Text of the host clipboard typed into the VM key by key – works without any helper in the guest. */
export async function typeClipboard(base) {
  let text;
  try { text = await readHostClipboard(); } catch { toast.error(t('The browser does not allow reading the clipboard here.')); return; }
  if (!text) { toast.error(t('The clipboard of this PC holds no text.')); return; }
  if (text.length > 4000) { toast.error(t('Too long to type – 4000 characters at most.')); return; }
  try { await post(`${base}/type`, { text }); } catch (e) { toast.error(e.message); }
}

/* ---------------- Pieces of the bar ---------------- */

/** Shortcut menu (a button that opens a list of buttons). `only` limits the combos (VirtualBox). */
export function ComboMenu({ onCombo, onTypeClipboard, onTypeText, disabled = false, only = null }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const pop = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const out = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const el = wrap.current;
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); const b = el.querySelector('button'); if (b) b.focus(); } };
    document.addEventListener('mousedown', out);
    el.addEventListener('keydown', key);
    const first = pop.current && pop.current.querySelector('button');
    if (first) first.focus();
    return () => { document.removeEventListener('mousedown', out); el.removeEventListener('keydown', key); };
  }, [open]);
  const groups = only ? COMBO_GROUPS.map(([g, items]) => [g, items.filter(([id]) => only.includes(id))]).filter(([, items]) => items.length) : COMBO_GROUPS;
  const pick = (fn) => () => { setOpen(false); fn(); };
  return (
    <div className="vm-combo" ref={wrap}>
      <Btn className="btn ghost xs" icon={Keyboard} disabled={disabled} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t('Shortcuts')} <ChevronDown size={12} aria-hidden="true" />
      </Btn>
      {open && (
        <div ref={pop} className="vm-combo-pop" role="group" aria-label={t('Send a shortcut to the VM')}>
          {(onTypeClipboard || onTypeText) && (
            <div className="vm-combo-group">
              {onTypeClipboard && <button type="button" className="vm-combo-item" onClick={pick(onTypeClipboard)}><ClipboardPaste size={13} aria-hidden="true" /> {t('Type the clipboard of this PC')}</button>}
              {onTypeText && <button type="button" className="vm-combo-item" onClick={pick(onTypeText)}><Type size={13} aria-hidden="true" /> {t('Type text …')}</button>}
            </div>
          )}
          {groups.map(([g, items]) => (
            <div key={g} className="vm-combo-group">
              <div className="vm-combo-head small muted">{t(g)}</div>
              <div className="vm-combo-keys">
                {items.map(([id, label]) => <button type="button" key={id} className="vm-combo-item" onClick={pick(() => onCombo(id))}>{t(label)}</button>)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Release" button – shown while the VM has the keyboard. */
export function ReleaseButton({ onRelease }) {
  return <Btn className="btn xs" icon={Unlock} onClick={onRelease} title="Give keyboard and mouse back to this PC (Right Ctrl)">Release</Btn>;
}

/** Info about the keyboard: what goes to the VM, the release key and what never reaches it. */
export function KeyboardInfo() {
  return (
    <InfoTip pop title={t('Keyboard in the VM')}>
      {t('While the screen has the keyboard, every key goes to the VM – also Ctrl+C, Ctrl+V and Ctrl+W. Right Ctrl on its own gives the keyboard back. In full screen Alt+Tab, the Windows key and Esc go to the VM as well (hold Esc to leave full screen). Ctrl+Alt+Del never reaches a page – use the shortcuts menu for it.')}
    </InfoTip>
  );
}

/** Switch for the shared clipboard with the explanation and the way it works in this VM. */
export function ClipboardSwitch({ on, onChange, info = {}, simple = false }) {
  const mode = info.mode;
  return (
    <div className="row-tight small vm-clip">
      <label className="row-tight"><Switch checked={on} onChange={onChange} /> <span>{t('Shared clipboard')}</span></label>
      {on && mode === 'none' && <span className="badge warn">{t('no helper in the VM')}</span>}
      {on && mode === 'agent' && <span className="badge">{t('through the guest agent')}</span>}
      <InfoTip pop title={t('Shared clipboard')}>
        {t('Copy in the VM with Ctrl+C and paste here with Ctrl+V – and the other way round: what you copied on this PC is in the VM as soon as you click into the screen.')}{' '}
        {t('The VM needs a small helper for this: Windows gets it with the guest tools Hostwerk installs, Linux desktops with spice-vdagent (most bring it along; under Wayland not every desktop supports it). Without the helper, “Type the clipboard of this PC” in the shortcuts menu types the text key by key.')}{' '}
        {t('On Linux under Wayland (KDE, GNOME) Hostwerk goes through the guest agent instead: it uses wl-clipboard, KDE’s clipboard or xclip of the signed-in user. Text copied in the VM then arrives when you leave the screen, or after about two seconds.')}
        {simple ? ` ${t('The simple screen fetches text copied in the VM about once a second.')}` : ''}
        {on && mode === 'none' && info.session ? ` ${t('Install wl-clipboard (Wayland) or xclip (X11) in the VM to fix this.')}` : ''}
      </InfoTip>
    </div>
  );
}
