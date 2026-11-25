# VNC screen (roadmap #1) – integration notes

New files (nothing existing was changed):

| File | What |
|---|---|
| `server/vnc.js` | WebSocket ↔ TCP bridge to QEMU's VNC server, `vncArgs(port)`, `pickVncPort(freePort, avoid)` |
| `ui/src/vnc.jsx` | `VncScreen({ vm, onFallback, onClipboard, active, viewOnly })` with noVNC, plus `vncUrl(id)` |
| `tests/vnc.test.js` | fake VNC server + plain http server, 12 tests |
| `../package.json` (workspace) | devDependency `@novnc/novnc` **1.7.0** (exact, released 2026-04-28) |

## How the WebSocket is authenticated – no Hostwerk core change needed

Hostwerk (`hostwerk/server/index.js`, `onUpgrade`) handles every HTTP upgrade like this:

```js
if (!req.url.startsWith('/ws') || !authed(req) || !originOk(req)) { socket.destroy(); return; }
if (req.url.startsWith('/ws/term')) { … }
if (ctx.extNative.upgrade(req, socket, head)) return;   // → host.on('upgrade', fn) of native extensions
wss.handleUpgrade(…)                                     // generic event channel
```

So the supported way is `host.on('upgrade', fn)` (SDK, `services/extnative.js`; used the same way by
hostwerk-ext-hostwerk-network for `/ws/m/…`). The core has already checked the login **exactly like for /api**
(`hw_token` cookie on the UI host, `x-hostwerk-token`, `x-hostwerk-key`, or a remote-access session on the HTTPS port –
the remote-access server registers the same `onUpgrade`) and the Origin. `fn` returns `true` to take the socket.

Consequence: the path has to start with `/ws`. **`/api/vms/<id>/vnc` can never work in Hostwerk** – the core destroys
non-`/ws` upgrades before extensions see them. The endpoint is therefore **`/ws/vms/<id>/vnc`**. (vnc.js also accepts
`/api/vms/<id>/vnc`, but only a plain server, e.g. the tests, can deliver that.)

`ws` comes from `host.lib('ws')` (Hostwerk's dependency `ws@^8.22`, in `LIBS`); outside Hostwerk vnc.js resolves it
from `hostwerk/node_modules`.

## Wiring (for the integrator)

### 1. Port – `server/runtime.js`, `allocPorts()` / `releasePorts()`

QEMU's `-vnc` takes a display number (port = 5900 + display), so the port must be ≥ 5900:

```js
const { pickVncPort } = require('./vnc');
// in allocPorts(), after serial:
const vnc = this.vm.display === 'none' ? null : await pickVncPort(U.freePort, avoid); // avoid already holds qmp/qga/serial
if (vnc) { avoid.add(vnc); usedPorts.add(vnc); }
return { qmp, qga, serial, vnc };
// releasePorts(): for (const k of ['qmp', 'qga', 'serial', 'vnc']) if (this.ports[k]) usedPorts.delete(this.ports[k]);
```

(`pickVncPort` starts at 5910 so a VNC server a user runs on 5900/5901 is left alone. If `avoid` is not a Set
containing usedPorts, pass `new Set(usedPorts)`.)

### 2. QEMU arguments – `server/qemu-args.js`, `buildArgs(vm, { ports })`

```js
const { vncArgs } = require('./vnc');
if (o.ports && o.ports.vnc) args.push(...vncArgs(o.ports.vnc)); // → -vnc 127.0.0.1:<display>,password=off
```

Keep `-display none` / `sdl` as today – `-vnc` is an additional display and works with both. TCP on 127.0.0.1 only
(QEMU on Windows has no unix sockets for VNC). Nothing but the bridge (which needs Hostwerk login) can reach it from
outside; other local processes on this PC could connect – same trust level as the existing QMP/QGA/serial ports.

Note: `ports` is part of `Runtime.status()`, so `vnc` will show up in the VM view – harmless, also useful for
"open in an external VNC viewer".

### 3. Register the bridge – `server/index.js`, `activate(host)`

```js
const { attachVncProxy } = require('./vnc');
// after `const m = new VmManager(…)`:
const vncProxy = attachVncProxy({
  host,
  resolvePort: (id) => {
    const r = m.runtimes.get(id);
    return r && r.isRunning() && r.ports && r.ports.vnc ? r.ports.vnc : null; // stopped / VirtualBox / unknown → 404
  },
  maxPerVm: 4,
  log: (...a) => host.log(...a),
});
host.on('shutdown', () => vncProxy.close());
// exports.deactivate = () => { if (vncProxy) vncProxy.close(); }   (keep a module-level reference)
```

`host.on('upgrade')` returns an unsubscribe function, which `close()` calls – deactivating the extension removes the hook.

### 4. UI – `ui/src/detail.jsx` / `ui/src/screen.jsx`

Prefer `VncScreen`, fall back to the PNG `Screen` once it reports failure:

```jsx
import { VncScreen } from './vnc';
const [png, setPng] = useState(false);            // reset when vm.id changes
…
{cur === 'screen' && on && (png || !vm.ports?.vnc
  ? <Screen vm={vm} active />
  : <VncScreen vm={vm} onFallback={() => setPng(true)} onClipboard={(text) => …} />)}
```

- Use `vm.ports?.vnc` (from `status()`) when available, so VMs started before the update go straight to PNG.
- `onFallback(reason)` fires when the very first connection fails (`unreachable`, `closed`, `security`), when 6
  reconnects in a row fail after a drop (`dropped`), or immediately when the UI shows a paired machine
  (`remote-machine` – see risks). A small "Switch to VNC / PNG" toggle is nice to have.
- Paused VMs: QEMU's VNC keeps serving the last frame; `PausedNote` can stay on top as today.
- `display: 'window'` VMs: VNC works in addition to the SDL window.

New English UI strings (for `locales/de.json`):
`Connecting to the screen …`, `Connection lost – reconnecting …`, `Screen connection failed`, `View only`,
`Keyboard and mouse go to the VM – click outside to release`, `Auto resolution`, `The guest takes the size of this box`,
`Paste`, `Send this PC's clipboard to the VM`, `Clipboard sent to the VM`,
`The browser does not allow reading the clipboard here.`, `Try again`. (Reused from screen.jsx: `Click into the screen
to use keyboard and mouse`, `Screenshot`, `Save screenshot`, `Full screen`, `Screen of {name}`, `Windows key`.)

## Bundle size

noVNC is bundled into `ui/index.js` (build-native.js resolves it from the workspace `node_modules`; verified with a
throw-away extension that imported `vnc.jsx`, then deleted). `vnc.jsx` + noVNC ≈ **196 KB minified, ≈ 60 KB gzip**;
today's `ui/index.js` is 83 KB → ≈ 280 KB. build-native has no code splitting, so it cannot be lazy-loaded without a
change in the SDK. noVNC 1.7 uses a top-level `await` (WebCodecs H.264 probe) – fine, the bundle is an ES module and
build-native already emits top-level `await` itself.

## Guest resize ("window size follows the page")

`VncScreen` sets `scaleViewport = true` (always fits) and `resizeSession = true` (asks the server for the box size via
SetDesktopSize). That only takes effect when QEMU's VNC server advertises ExtendedDesktopSize **and** the guest's display
driver honours the new size (in practice: `-vga virtio` / virtio-gpu with a Linux KMS driver, or a Windows guest with the
virtio-gpu driver + agent). With `-vga std` the picture is just scaled. The "Auto resolution" badge shows when noVNC
reports `capabilities.resize`. **Verify live with QEMU 11.1** – not testable without QEMU.

## Changes in Hostwerk core – none required

Optional, smallest patches (not applied):

1. **Paired machines** (`hostwerk-ext-hostwerk-network/server/machines.js`, `bridge()`): it only forwards `/term`;
   to make VNC work when the UI shows another PC, forward `/vms/…` too:
   `` remote = new WebSocket(`wss://${u.host}/ws${/^\/(term|vms\/)/.test(rest) ? rest : ''}`, …) `` and pass
   `protocol` (`['binary']`) to the remote WebSocket. `vnc.jsx` would then use `/ws/m/<machine>/vms/<id>/vnc`
   (via `currentMachine()`), and the `remote-machine` fallback can go.
2. **Lazy loading** (build-native.js): `splitting: true` + `outdir` would let `import('./vnc')` load noVNC only when
   the screen tab opens. Not needed for correctness.

## Risks / open points

- **Old Hostwerk / extension without the bridge:** the core's generic `/ws` channel accepts any `/ws/*` upgrade and
  sends a JSON hello; noVNC fails the RFB handshake, never fires `connect` → `onFallback('closed'|'unreachable')`. Works,
  but costs one round trip; checking `vm.ports?.vnc` first avoids it.
- **Keyboard:** noVNC uses QEMU's extended key events (scancodes), so the guest layout decides – same as the PNG path.
  Since 1.3.0 (`ui/src/keyboard.jsx`, shared by both screens): Right Ctrl on its own releases the keyboard (listener in the
  capture phase on the container, noVNC still gets the key); in full screen (the whole card, so the bar stays) Keyboard
  Lock (`navigator.keyboard.lock()`) hands over Alt+Tab, the Windows key and Esc (hold Esc leaves full screen). On
  focus loss the page also sends `{ t: 'r' }` to `/input` – every modifier up through QMP, so none stays stuck. What
  no page can catch (Ctrl+Alt+Del, and Ctrl+W/T/N outside full screen in a browser) is in the shortcuts menu, sent with
  QMP `send-key` through `/combo` (named combos in `server/keys.js`, or `{ keys: [qcodes] }`).
- **Clipboard:** guest → browser (`onClipboard`) and `Paste` (browser → guest) only work if QEMU has a clipboard backend
  (`-chardev qemu-vdagent,id=vdagent,clipboard=on -device virtio-serial -device virtserialport,chardev=vdagent,name=com.redhat.spice.0`
  and spice-vdagent in the guest). Without it the events are simply not delivered.
  **Verified with Windows 11 (17 Nov 2026, `tests/live/clipboard.js`, 6/6):** the SPICE agent comes with the virtio-win
  guest tools Hostwerk installs at first logon (service `spice-agent`). QEMU offers the extended clipboard
  (caps 0x1b000001: text; request, notify, provide). Windows → PC: notify → request → provide, UTF-8 intact. PC → Windows:
  the client notifies, QEMU requests the text only when Windows pastes, then the client provides it (NUL-terminated
  UTF-8, zlib per message). Text with ä ö ü ß € arrives unchanged both ways.
  **Since 1.3.0 wired up in the UI:** noVNC's `clipboard` event writes to this PC's clipboard (it was not connected in
  `detail.jsx` before, so guest → PC never arrived), and this PC's clipboard is offered with `clipboardPasteFrom` when the
  screen gets the focus (and when the window comes back after Alt+Tab) – Ctrl+C / Ctrl+V work across without a button.
  A switch "Shared clipboard" (localStorage `hw-vms-clipboard`) turns it off. The simple (PNG) screen uses the server's
  own clipboard client `server/clipboard.js` (same RFB extended clipboard, no pictures) via `GET /api/vms/<id>/clipboard?watch=1`
  (`{ helper, ready, text, seq, at }`, polled once a second) and `POST /api/vms/<id>/clipboard { text }`. `helper`
  comes from QMP `query-chardev` (`frontend-open` of the `vdagent` chardev = spice-vdagent opened its port).
  Fallback without a helper: "Type the clipboard of this PC" (`/type`, US/German layout).
  Linux under Wayland: spice-vdagentd (system part) opens the port, but the session agent cannot reach a Wayland
  clipboard. `Runtime.clipboardMode()` therefore asks the guest agent for the active session (`server/guest-clipboard.js`,
  op `probe`: loginctl → session type and the tools there) and picks `agent` for Wayland (or X11 without vdagent):
  get/set run as the signed-in user via `runuser` with wl-clipboard, Klipper (qdbus) or xclip/xsel; the text goes as
  guest-exec stdin and comes back as base64. The screens fetch every 2 s only while they hold the keyboard, and once
  when they let go. Mode `none` (no vdagent, no tool): typing is the way.
- **Keyboard Lock in Hostwerk's window:** Electron asks the session's permission handler for `keyboardLock`; Hostwerk
  up to 3.4.1 refused it (only clipboard and full screen were allowed) – then the bar says that Alt+Tab and the Windows
  key stay with this PC. Hostwerk core commit "Tastatursperre (Keyboard Lock) im Vollbild erlauben" allows it.
- **Shared sessions:** several tabs may watch the same VM (`shared: true`, max 4 per VM in the bridge, 5th → HTTP 429).
- **Local exposure:** the VNC port has no password; anything on this PC can connect to 127.0.0.1:<port>. Optional
  hardening: `password=on` + QMP `change-vnc-password` per start, and send the password from the bridge – noVNC
  would then need `credentials`; not done.
- **Backpressure:** bridge pauses the TCP side when > 4 MB are queued for the browser; idle connections get a ping every
  30 s and are dropped if the pong is missing.
- **VirtualBox VMs:** no VNC (VRDE is RDP) → `resolvePort` returns null → PNG fallback.
