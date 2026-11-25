'use strict';
/*
 * Clipboard of Linux guests through the guest agent (server/guest-clipboard.js): the shell script runs for real in a
 * POSIX sh with stand-ins for loginctl, runuser, wl-clipboard, qdbus and xclip (skipped where no sh exists), the agent
 * calls and the choice of the way (Runtime.clipboardMode) are checked with a fake agent. No VM.
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const G = require('../server/guest-clipboard');
const { Runtime } = require('../server/runtime');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hw-vms-gc-'));
const SH = ['/bin/sh', 'C:\\Program Files\\Git\\bin\\sh.exe'].find((c) => { try { return spawnSync(c, ['-c', 'exit 0']).status === 0; } catch { return false; } });

/** A fake guest: bin/ with stand-ins, a runtime dir per user, the clipboard as a file. */
function guest({ type = 'wayland', tools = ['wl-copy', 'wl-paste'], clip = '', active = 'yes' } = {}) {
  const d = tmp();
  const bin = path.join(d, 'bin'); fs.mkdirSync(bin);
  const run = path.join(d, 'run', '1000'); fs.mkdirSync(run, { recursive: true });
  if (type === 'wayland') fs.writeFileSync(path.join(run, 'wayland-0'), '');
  const clipFile = path.join(d, 'clip').replace(/\\/g, '/');
  fs.writeFileSync(clipFile, clip);
  const w = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  w('loginctl', `case "$1" in
  list-sessions) echo "c1 120 gdm seat0"; echo "3 1000 anna seat0 tty2" ;;
  show-session) case "$2:$4" in
    c1:Active) echo no ;; c1:Type) echo wayland ;;
    3:Active) echo ${active} ;; 3:Type) echo ${type} ;; 3:Name) echo anna ;; 3:Display) echo "" ;;
  esac ;;
esac`);
  w('id', 'echo 1000');
  w('getent', 'echo "anna:x:1000:1000::/home/anna:/bin/sh"');
  // runuser -u anna -- env K=V … cmd args: note the session variables, then run the command
  w('runuser', `[ "$1" = -u ] && [ "$2" = anna ] && [ "$3" = -- ] || exit 9
shift 3; [ "$1" = env ] && shift
while case "$1" in *=*) true ;; *) false ;; esac; do export "$1"; shift; done
echo "$XDG_RUNTIME_DIR|$WAYLAND_DISPLAY|$DBUS_SESSION_BUS_ADDRESS" > "${clipFile}.env"
exec "$@"`);
  if (tools.includes('wl-copy')) w('wl-copy', `cat > "${clipFile}"`);
  if (tools.includes('wl-paste')) w('wl-paste', `cat "${clipFile}"`);
  if (tools.includes('qdbus')) w('qdbus', `if [ "$3" = getClipboardContents ]; then cat "${clipFile}"; echo; else printf '%s' "$4" > "${clipFile}"; fi`);
  if (tools.includes('xclip')) w('xclip', `if [ "$1" = -o ]; then cat "${clipFile}"; else cat > "${clipFile}"; fi`);
  const toSh = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, l) => `/${l.toLowerCase()}`);
  // the stand-ins go first (Git's sh on Windows puts its own /usr/bin in front, with a real "id")
  const env = { ...process.env, HW_STUBS: toSh(bin), HW_RUNTIME_ROOT: toSh(path.join(d, 'run')) };
  const exec = (op, input) => {
    const r = spawnSync(SH, ['-c', `PATH="$HW_STUBS:$PATH"
${G.SCRIPT}`, 'hw-clipboard', op], { env, input: Buffer.from(input == null ? '' : input, 'utf8') });
    return G.parseOutput(r.stdout.toString('utf8'), op);
  };
  return { exec, clip: () => fs.readFileSync(clipFile, 'utf8'), env: () => fs.readFileSync(`${clipFile}.env`, 'utf8').trim() };
}

test('script: Wayland session – probe, get and set with wl-clipboard as the signed-in user', { skip: !SH && 'no POSIX sh' }, () => {
  const g = guest({ clip: 'Grüße aus Kairo – ÄÖÜ ß € 🎉\nzweite Zeile' });
  assert.deepEqual(g.exec('probe'), { ok: true, session: 'wayland', tools: ['wl'] });
  assert.deepEqual(g.exec('get'), { ok: true, method: 'wl', text: 'Grüße aus Kairo – ÄÖÜ ß € 🎉\nzweite Zeile' });
  assert.match(g.env(), /\/run\/1000\|wayland-0\|unix:path=.*\/run\/1000\/bus$/);
  assert.deepEqual(g.exec('set', "Vom PC: 'quotes' \"und\" $HOME `x` ;rm -rf"), { ok: true, method: 'wl' });
  assert.equal(g.clip(), "Vom PC: 'quotes' \"und\" $HOME `x` ;rm -rf"); // stdin, nothing is interpreted
});

test('script: KDE without wl-clipboard uses Klipper over D-Bus; X11 uses xclip', { skip: !SH && 'no POSIX sh' }, () => {
  const k = guest({ tools: ['qdbus'], clip: 'aus Klipper' });
  assert.deepEqual(k.exec('probe'), { ok: true, session: 'wayland', tools: ['klipper'] });
  assert.deepEqual(k.exec('get'), { ok: true, method: 'klipper', text: 'aus Klipper' }); // qdbus' extra line break removed
  assert.deepEqual(k.exec('set', 'nach Klipper'), { ok: true, method: 'klipper' });
  assert.equal(k.clip(), 'nach Klipper');
  const x = guest({ type: 'x11', tools: ['xclip', 'wl-copy', 'wl-paste'], clip: 'x11 text' });
  assert.deepEqual(x.exec('probe'), { ok: true, session: 'x11', tools: ['xclip'] }); // no Wayland socket → no wl
  assert.deepEqual(x.exec('get'), { ok: true, method: 'xclip', text: 'x11 text' });
});

test('script: nobody signed in, or no tool in the VM', { skip: !SH && 'no POSIX sh' }, () => {
  assert.deepEqual(guest({ active: 'no' }).exec('get'), { ok: false, reason: 'no-session' });
  const none = guest({ tools: [] });
  assert.deepEqual(none.exec('probe'), { ok: true, session: 'wayland', tools: [] });
  assert.deepEqual(none.exec('get'), { ok: false, reason: 'no-tool', session: 'wayland' });
  assert.deepEqual(none.exec('set', 'x'), { ok: false, reason: 'no-tool', session: 'wayland' });
});

test('guestClipboard: guest-exec with stdin as base64, polls the status, decodes the answer', async () => {
  const calls = [];
  let polls = 0;
  const agentCall = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'guest-exec') return { pid: 42 };
    polls += 1;
    if (polls < 2) return { exited: false };
    return { exited: true, exitcode: 0, 'out-data': Buffer.from(`OK wl ${Buffer.from('ä€', 'utf8').toString('base64')}\n`).toString('base64') };
  };
  const r = await G.guestClipboard(agentCall, 'get', '', { sleep: async () => {} });
  assert.deepEqual(r, { ok: true, method: 'wl', text: 'ä€' });
  assert.equal(calls[0][1].path, '/bin/sh');
  assert.deepEqual(calls[0][1].arg.slice(2), ['hw-clipboard', 'get']);
  assert.equal(calls[0][1]['input-data'], undefined);
  calls.length = 0; polls = 5;
  await G.guestClipboard(agentCall, 'set', 'Straße', { sleep: async () => {} });
  assert.equal(Buffer.from(calls[0][1]['input-data'], 'base64').toString('utf8'), 'Straße');
  await assert.rejects(() => G.guestClipboard(agentCall, 'set', 'x'.repeat(G.MAX_TEXT + 1)), /256 KB/);
  await assert.rejects(() => G.guestClipboard(agentCall, 'rm'), /op must be/);
  assert.equal(G.parseOutput('garbage', 'get').ok, false);
});

/* ---------------- which way: Runtime.clipboardMode ---------------- */
function rt({ osType = 'linux', helper = true, probe = 'SESSION wayland wl', agentOk = true } = {}) {
  const r = new Runtime({ id: 'v', name: 'v', osType, disks: [] }, { qhost: {}, Proc: class {}, dir: tmp() });
  r.isRunning = () => true;
  r.ports = { qmp: 1, qga: 2, vnc: 5910 };
  r.agentInfo = { ok: agentOk };
  r.qmp = { exec: async () => [{ label: 'vdagent', 'frontend-open': helper }] };
  r.sets = [];
  let clip = 'erste';
  r.agentCall = async (cmd, args) => {
    if (cmd === 'guest-exec') { r.last = args.arg[3]; if (args['input-data']) { clip = Buffer.from(args['input-data'], 'base64').toString('utf8'); r.sets.push(clip); } return { pid: 1 }; }
    const out = r.last === 'probe' ? probe : r.last === 'set' ? 'OK wl' : `OK wl ${Buffer.from(clip).toString('base64')}`;
    return { exited: true, 'out-data': Buffer.from(out).toString('base64') };
  };
  r.setGuestClip = (t) => { clip = t; };
  return r;
}

test('runtime: Wayland goes through the agent even when spice-vdagentd holds the port; X11 + vdagent stays on VNC', async () => {
  assert.equal((await rt({ probe: 'SESSION wayland wl klipper' }).clipboardMode()).mode, 'agent');
  assert.equal((await rt({ probe: 'SESSION x11 xclip' }).clipboardMode()).mode, 'vdagent');
  assert.equal((await rt({ probe: 'SESSION x11 xclip', helper: false }).clipboardMode()).mode, 'agent');
  assert.equal((await rt({ probe: 'SESSION wayland', helper: false }).clipboardMode()).mode, 'none'); // no tool, no vdagent
  assert.equal((await rt({ osType: 'windows', helper: true }).clipboardMode()).mode, 'vdagent');
  assert.equal((await rt({ osType: 'windows', helper: false }).clipboardMode()).mode, 'none');
  assert.equal((await rt({ agentOk: false, helper: null }).clipboardMode()).mode, 'vdagent');
  const m = await rt({ probe: 'SESSION wayland wl' }).clipboardMode();
  assert.deepEqual([m.session, m.tools], ['wayland', ['wl']]);
});

test('runtime: through the agent – copies in the guest count up, text from this PC does not', async () => {
  const r = rt();
  const a = await r.clipboardGet({ watch: true });
  assert.equal(a.mode, 'agent'); assert.equal(a.text, 'erste'); assert.equal(a.ready, true);
  const b = await r.clipboardGet({ watch: true });
  assert.equal(b.seq, a.seq); // unchanged
  r.setGuestClip('kopiert in der VM');
  const c = await r.clipboardGet({ watch: true });
  assert.equal(c.seq, a.seq + 1); assert.equal(c.text, 'kopiert in der VM');
  await r.clipboardSet('vom PC');
  assert.deepEqual(r.sets, ['vom PC']);
  const d = await r.clipboardGet({ watch: true });
  assert.equal(d.seq, c.seq); // our own text is not a new copy of the guest
});
