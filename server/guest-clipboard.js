'use strict';
/*
 * Clipboard of a Linux guest through the guest agent – for desktops where spice-vdagent does not carry the clipboard
 * (no spice-vdagent, or Wayland: KDE Plasma and GNOME without an XWayland clipboard bridge). qemu-ga runs as root; the
 * script finds the active graphical session (loginctl), then reads or sets the clipboard as that user with whatever
 * the guest has: wl-clipboard (Wayland), KDE's Klipper over D-Bus (qdbus), xclip or xsel (X11).
 *
 *   const r = await guestClipboard(agentCall, 'get')            → { ok: true, method: 'wl', text }
 *   await guestClipboard(agentCall, 'set', 'Hallo')             → { ok: true, method: 'wl' }
 *   not possible → { ok: false, reason: 'no-session' | 'no-tool' | 'failed', detail }
 *
 * The text travels as stdin (guest-exec input-data) and comes back as base64 – no quoting, any characters.
 *   await guestClipboard(agentCall, 'probe')                  → { ok: true, session: 'wayland', tools: ['wl', 'klipper'] }
 *
 * $1 = get|set|probe. HW_RUNTIME_ROOT only for the tests (default /run/user).
 */

const SCRIPT = String.raw`
op="$1"; RR="${'$'}{HW_RUNTIME_ROOT:-/run/user}"
U=''; T=''; D=''
for s in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do
  [ "$(loginctl show-session "$s" -p Active --value 2>/dev/null)" = yes ] || continue
  t=$(loginctl show-session "$s" -p Type --value 2>/dev/null)
  case "$t" in wayland|x11) ;; *) continue ;; esac
  U=$(loginctl show-session "$s" -p Name --value 2>/dev/null); D=$(loginctl show-session "$s" -p Display --value 2>/dev/null); T=$t; break
done
[ -n "$U" ] || { echo NOSESSION; exit 0; }
ID=$(id -u "$U" 2>/dev/null) || { echo NOSESSION; exit 0; }
R="$RR/$ID"
W=$(ls "$R" 2>/dev/null | grep -E '^wayland-[0-9]+$' | head -n 1)
[ -n "$D" ] || D=:0
XA=$(ls "$R"/xauth_* 2>/dev/null | head -n 1)
[ -n "$XA" ] || XA="$(getent passwd "$U" 2>/dev/null | cut -d: -f6)/.Xauthority"
run() { runuser -u "$U" -- env XDG_RUNTIME_DIR="$R" WAYLAND_DISPLAY="$W" DISPLAY="$D" XAUTHORITY="$XA" DBUS_SESSION_BUS_ADDRESS="unix:path=$R/bus" "$@"; }
Q=$(command -v qdbus6 || command -v qdbus-qt6 || command -v qdbus || command -v qdbus-qt5)
if [ "$op" = probe ]; then
  h=''
  [ -n "$W" ] && command -v wl-copy >/dev/null 2>&1 && command -v wl-paste >/dev/null 2>&1 && h="$h wl"
  [ -n "$Q" ] && h="$h klipper"
  command -v xclip >/dev/null 2>&1 && h="$h xclip"
  command -v xsel >/dev/null 2>&1 && h="$h xsel"
  echo "SESSION $T$h"; exit 0
fi
tmp=$(mktemp) || exit 1
trap 'rm -f "$tmp"' EXIT
tool=''
if [ "$op" = set ]; then
  cat > "$tmp"
  if [ -n "$W" ] && command -v wl-copy >/dev/null 2>&1; then tool=wl; run wl-copy < "$tmp" > /dev/null 2>&1 && { echo "OK wl"; exit 0; }; fi
  if [ -n "$Q" ]; then tool=klipper; run "$Q" org.kde.klipper /klipper setClipboardContents "$(cat "$tmp")" > /dev/null 2>&1 && { echo "OK klipper"; exit 0; }; fi
  if command -v xclip >/dev/null 2>&1; then tool=xclip; run xclip -selection clipboard -i < "$tmp" > /dev/null 2>&1 && { echo "OK xclip"; exit 0; }; fi
  if command -v xsel >/dev/null 2>&1; then tool=xsel; run xsel -b -i < "$tmp" > /dev/null 2>&1 && { echo "OK xsel"; exit 0; }; fi
else
  if [ -n "$W" ] && command -v wl-paste >/dev/null 2>&1; then tool=wl; run wl-paste -n -t text > "$tmp" 2>/dev/null && { echo "OK wl $(base64 -w0 < "$tmp")"; exit 0; }; fi
  if [ -n "$Q" ]; then tool=klipper; run "$Q" org.kde.klipper /klipper getClipboardContents > "$tmp" 2>/dev/null && { echo "OK klipper $(base64 -w0 < "$tmp")"; exit 0; }; fi
  if command -v xclip >/dev/null 2>&1; then tool=xclip; run xclip -o -selection clipboard > "$tmp" 2>/dev/null && { echo "OK xclip $(base64 -w0 < "$tmp")"; exit 0; }; fi
  if command -v xsel >/dev/null 2>&1; then tool=xsel; run xsel -b -o > "$tmp" 2>/dev/null && { echo "OK xsel $(base64 -w0 < "$tmp")"; exit 0; }; fi
  [ -n "$tool" ] && { echo "EMPTY $tool"; exit 0; }
fi
[ -n "$tool" ] && echo "FAILED $tool $T" || echo "NOTOOL $T"
`;

const MAX_TEXT = 256 * 1024;

/** Output of the script → result. */
function parseOutput(out, op) {
  const line = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
  const [word, a, b] = line.split(' ');
  if (word === 'SESSION') return { ok: true, session: a || null, tools: line.split(' ').slice(2).filter(Boolean) };
  if (word === 'OK') {
    if (op === 'set') return { ok: true, method: a };
    let text = b ? Buffer.from(b, 'base64').toString('utf8') : '';
    if (a === 'klipper') text = text.replace(/\n$/, ''); // qdbus adds a line break
    return { ok: true, method: a, text };
  }
  if (word === 'EMPTY') return { ok: true, method: a, text: '' };
  if (word === 'NOSESSION') return { ok: false, reason: 'no-session' };
  if (word === 'NOTOOL') return { ok: false, reason: 'no-tool', session: a || null };
  if (word === 'FAILED') return { ok: false, reason: 'failed', method: a, session: b || null };
  return { ok: false, reason: 'failed', detail: line.slice(0, 200) };
}

/**
 * Runs the script through the guest agent. agentCall(cmd, args, timeoutMs) = Runtime.agentCall.
 * Returns the parsed result; throws only when the agent itself fails.
 */
async function guestClipboard(agentCall, op, text = '', { timeout = 8000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!['get', 'set', 'probe'].includes(op)) throw new Error('guestClipboard: op must be get, set or probe');
  const args = { path: '/bin/sh', arg: ['-c', SCRIPT, 'hw-clipboard', op], 'capture-output': true };
  if (op === 'set') {
    const t = String(text == null ? '' : text);
    if (Buffer.byteLength(t) > MAX_TEXT) throw Object.assign(new Error('Too much text for the clipboard (256 KB at most through the guest agent).'), { status: 400 });
    args['input-data'] = Buffer.from(t, 'utf8').toString('base64');
  }
  const { pid } = await agentCall('guest-exec', args, 10000);
  const until = Date.now() + timeout;
  for (;;) {
    const s = await agentCall('guest-exec-status', { pid }, 10000);
    if (s && s.exited) return parseOutput(s['out-data'] ? Buffer.from(s['out-data'], 'base64').toString('utf8') : '', op);
    if (Date.now() > until) return { ok: false, reason: 'failed', detail: 'timeout' };
    await sleep(120);
  }
}

module.exports = { guestClipboard, parseOutput, SCRIPT, MAX_TEXT };
