# Package 5 – app templates, Ask AI about the screen, Hyper-V, ARM VMs

New files: `server/apps.js`, `server/ai.js`, `server/hyperv.js`, `tests/package5.test.js`, `tests/live/package5.js`.
Changed: `cloudinit.js` (app setup, own commands and script), `manager.js` (create with `app`/`startCommands`/`startScript`/
`arch`, `appStatus`, `screenContext`, `aiExplain`, Hyper-V), `spec.js` (`arch`), `qemu-args.js` (`buildArmArgs`),
`qemu-host.js` (`locateArm`, `info().aarch64`), `runtime.js` (ARM program/firmware), `catalog.js` (ARM64 images), `routes.js`,
`index.js` (HyperV, `host.ai.quick`, `host.aiExtend`), `manifest.json` (permission `use:ai`), UI (`create.jsx`, `detail.jsx`,
`index.jsx`, `style.css`), `locales/de.json`.

## #9 App templates and own start scripts

`server/apps.js` holds six apps as data – each: Debian/Ubuntu packages, a fixed bash setup script, port forwards, the address
the overview opens:

| App | How | Forward (this PC → VM) | RAM / disk |
|---|---|---|---|
| Nginx web server | apt `nginx`, own start page | 8080 → 80 | 1 GB / 10 GB |
| Docker host | apt `docker.io` (+ `docker-compose-v2` or `docker-compose`), user in group `docker` | – | 2 GB / 20 GB |
| WordPress | apt `apache2 mariadb-server php … wordpress`; DB + random DB password in the guest, `/etc/wordpress/config-default.php`, Apache site | 8080 → 80 | 2 GB / 15 GB |
| Nextcloud | container `nextcloud:stable` (Docker Hub) | 8081 → 80 | 2 GB / 20 GB |
| Gitea | container `gitea/gitea:1` | 3000 → 3000 | 1 GB / 15 GB |
| Uptime Kuma | container `louislam/uptime-kuma:1` | 3001 → 3001 | 1 GB / 10 GB |

Only for images of the families `debian`/`ubuntu` (apt) – others are refused with 400. A host port taken by another VM
moves to the next one (`addAppForwards`), and right before the first start one that another program on this PC uses moves on,
too (`freeAppPorts`). The forwards have the ids `app-<id>` (e.g. `app-web`); `view().appInfo.open` = `{ url, port, label }`.

**cloud-init:** the app's packages join `packages:`; the setup script goes base64 through `write_files` to
`/var/lib/hostwerk/app.sh` (0700 root) and runs once in `runcmd` (after the packages):
`bash app.sh >>/var/log/hostwerk-app.log 2>&1 && touch app-ready || touch app-failed`. Own commands (one per line, `#` lines
skipped, max. 50 × 2000 characters) become one `["sh", "-c", <command>]` entry each – written with `yq()`: a JSON string with
`\u`/`\U` escapes for everything outside printable ASCII, so PyYAML (YAML 1.1) reads it back exactly (U+2028, emoji …) and no
input can add YAML keys or list entries (tested with a YAML parser and in `tests/package5.test.js`). The own bash script
(≤ 64 KB, `#!/bin/bash` added if missing) goes base64 to `/var/lib/hostwerk/start-script.sh` and runs after the commands
(log `/var/log/hostwerk-start-script.log`, markers `start-script-done/-failed`). The VM keeps `cloud.start: true`.

`GET /vms/:id/app` → `{ app, script: ok|running|failed|none, log }` through the guest agent (marker files + last log lines).
UI: in the create dialog for "Ready-made Linux" an app list (apps that do not fit the image are greyed out) and a folding card
"Own commands at the first start" (commands + bash script); on the VM's overview a card with the state ("Installing …",
"Ready", "Setup failed" + log) and the button "Open WordPress" etc. (`http://127.0.0.1:<port>/`, "on this PC").

## #20 Ask AI about the screen – what Hostwerk's AI can take

Checked in Hostwerk's code:
- The AI **chat** can see images: files attached in the chat composer (`POST /api/ai/chats/:id/files`) go to vision models as
  images (`chats.js` `toWire`: online providers always, Ollama models with the capability `vision`, Claude-Code bridge never);
  online providers need the privacy switch "images" (`ask`/`always`/`never`, default `ask`).
- What **extensions** get is text only: `host.ai.quick.run(task, { text, context })` (system prompt + text, max. 6000
  characters), `openAiPanel/askAi/openAiExplain` (attachment `{ kind: 'text', text }` ≤ 8000 characters, `kind: 'file'` only
  reads text files), `host.aiExtend({ context })` (text). There is no SDK way to hand the chat a picture.

So the button sends **text context** and says so plainly. `manager.screenContext(id)` → VM name/arch, system (guest agent's
OS and kernel), state/accelerator/CPU/RAM/firmware/boot medium, Windows install state, app template state, guest agent (host
name, addresses, file systems ≥ fill), last 6 QEMU guest events, last 40 lines of the serial console (escape sequences removed,
`password=…`/`token: …` blanked), ≤ 6000 characters. `GET /vms/:id/ai/context` returns it; `POST /vms/:id/ai/explain`
asks `host.ai.quick` (`explain`) with it – while the AI is off or not set up: **409 `AI_OFF` "The AI assistant is off or not
set up – nothing was sent."** (nothing leaves the PC).
UI (screen tab): button "Ask AI about the screen …" (`btn-ai`, only while `useAiReady()`), a dialog with the screenshot (shown,
not sent), the question and the exact text that goes out, a callout "Only text is sent – not the picture" (with the hint to
attach a saved screenshot in the AI chat for a vision model), then `openAiPanel({ question, context: { kind: 'text', … } })`.
The VM page also reports `useAiContext({ kind: 'vm', id, label })` so Ctrl+J attaches the VM.

**AI tools** (`server/ai.js`, `host.aiExtend`): `vm_list`, `vm_apps`, `vm_screen` (risk `read`), `vm_start`, `vm_create`
(cloud VM, optional app template, random password reported back), `vm_from_template` (linked clone of a VM template) – `change`
with `describe() → { ask, verb, effect, undo }`; `vm_stop` – `change`, with `force: true` `system` (risk as a function of the
arguments, like Hostwerk's `pc_power`). Own @ source `vm` (search/resolve = the screen context). Group `vms`, vocabulary.
Manifest permission `use:ai` (for `host.ai.quick`; check stays 100/100).

## #21 Hyper-V

`server/hyperv.js`: one PowerShell call (read-only) – `Get-Module -ListAvailable Hyper-V` → `HWHV:NOMODULE` (quietly "not
available", remembered until `?fresh=1`, no PowerShell every few seconds), else `Get-VM | Select … | ConvertTo-Json` after
`HWHV:OK`, or `HWHV:DENIED` + message (no admin rights → "Installed, but listing its VMs needs administrator rights").
`parseVms` takes one object or a list, state as name or enum number (2 running, 3 off, 6 saved, 9 paused, 3277x
transitions), `Uptime` as seconds/TimeSpan object/text, drops entries without a GUID. Actions (`start`, `stop` = `Stop-VM
-Force`, `turnoff`, `checkpoint` with a checked name) only by GUID (`Get-VM -Id '<guid>'`), refusals with "access denied"
become 403 "Hyper-V needs administrator rights …". `GET /vms` carries `hyperv`; `GET /vms/hyperv`,
`POST /vms/hyperv/:guid/:action`. UI: group "Hyper-V" in the list, a read-only detail page with Start/Shut down/Turn off/
Checkpoint and the admin explanation, a card in "Engines & settings". Unit-tested with fake `ConvertTo-Json` output;
**not verified with real Hyper-V** (this PC is Windows 11 Home).

## #22 ARM VMs

`C:\Program Files\qemu\qemu-system-aarch64.exe` (QEMU 11.1.0) exists; `-accel help` → `tcg` only. Firmware
`share\edk2-aarch64-code.fd` + `share\edk2-arm-vars.fd` (64 MB each). A firmware-only run
(`-machine virt -cpu max,pauth-impdef=on -m 1024`, pflash code+vars, `-display none`, 15 s) printed on the PL011 serial port
`UEFI firmware (version edk2-stable202408-prebuilt.qemu.org …)`, BdsDxe, and the "UEFI Interactive Shell v2.2".

- `vm.arch: 'aarch64'` (missing = x86_64, so existing descriptions stay byte-identical). `cleanVm`: UEFI forced, graphics
  `virtio`, Windows and SATA refused; `defaultsFor(os, 'aarch64')`: virtio disk/NIC.
- `buildArmArgs`: `-machine virt,gic-version=max -accel tcg -cpu max,pauth-impdef=on`, pflash code (read-only) + own
  `vars.fd`, virtio-blk/NVMe disks, **CD on virtio-scsi** (`scsi-cd id=cdrom0` – live ISO change keeps working), seed as
  virtio-blk (Linux), `virtio-gpu-pci` screen, `qemu-xhci` + `usb-tablet` + **`usb-kbd`** ("virt" has no PS/2), virtio-rng,
  guest agent, serial = PL011, VNC, QMP like x86. Never WHPX.
- `qemu-host.locateArm` + `info().aarch64 = { system, firmware, version, ok, accel: 'tcg' }`; the runtime starts
  `qemu-system-aarch64` with the ARM firmware for ARM VMs, `status.accel = 'tcg'`.
- Catalog: Debian 12 ARM64, Debian 13 ARM64 (SHA512SUMS), Ubuntu 24.04 ARM64 (SHA256SUMS). **Raspberry Pi OS is not listed**:
  the images (with published `.sha256`) are made for Raspberry Pi boards (no UEFI, Pi firmware/device tree) and do not boot
  on QEMU's "virt" machine.
- UI: ARM images marked "ARM · slow" (only offered when `aarch64.ok`), processor choice for own ISO/empty VM/disk image, a
  warning "ARM64 – emulated, slow" (roughly 5–20× slower), badge "ARM64 · emulated" on the VM, a line in "Engines & settings".

**Real ARM guest not booted** – no ARM image is on this PC and downloading was not allowed. Needed for that test:
`https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-arm64.qcow2` – 340,197,376 bytes (≈ 324 MiB,
Last-Modified 12 Nov 2026 per HEAD request), checksum from
`https://cloud.debian.org/images/cloud/bookworm/latest/SHA512SUMS` (line `debian-12-genericcloud-arm64.qcow2`). Hostwerk
downloads and checks it itself when "Debian 12 (Bookworm) · ARM64" is chosen.

## Real-life test

`node tests/live/package5.js <work folder with vms/.images>` – Hostwerk on port 7866, Debian 12 image from the cache (the
test switches downloads off and answers the checksum list with the cached hash). Report in `<work>/report-p5/report.md`.

### Result (16 Nov 2026, this PC: Windows 11 Home, QEMU 11.1, WHPX)

2026-11-16T22:21:39.150Z · 12/12 passed

| | Step | Time | Result |
|---|---|---|---|
| ✓ | Hostwerk test instance with the extension (port 7866) | 1.7 s | &lt;work folder&gt;\hw-p5\extensions\vms |
| ✓ | #21 Hyper-V detection: quietly “not available” on this PC (Windows 11 Home) | 0.2 s | reason no-module, 195 ms (PowerShell, read-only), list field available=false, start → 404 “Hyper-V ist auf diesem PC nicht verfügbar.” |
| ✓ | #20 AI tools registered through host.aiExtend (risk classes, describe) | 0.0 s | vm_list (read), vm_apps (read), vm_screen (read), vm_start (change), vm_stop (change/system), vm_create (change), vm_from_template (change); @ source “Virtuelle Maschinen” |
| ✓ | #9 Two app VMs from templates: Nginx (with own commands + bash script) and Docker host | 122.9 s | Debian GNU/Linux 12 (bookworm) / Debian GNU/Linux 12 (bookworm); Nginx forwards 2223→22, 8080→80; button “Open the web page” → http://127.0.0.1:8080/ |
| ✓ | #9 App setup finished in both guests (marker app-ready, read through the guest agent) | 0.2 s | nginx app=ok script=ok; docker app=ok; 0 s after the agent answered |
| ✓ | #9 Nginx: the forwarded web port answers from this PC | 0.0 s | GET http://127.0.0.1:8080/ → 200, “Nginx on p5-nginx works” |
| ✓ | #9 Docker host: docker runs hello-world, user is in the group docker | 3.7 s | Hello from Docker! · hwtest docker · Docker version 20.10.24+dfsg1, build 297e128 |
| ✓ | #9 Own start commands and bash script ran once and left their markers | 0.3 s | p5-cmd p5-nginx · p5-script ü root · app-ready · app.sh · start-script-done · start-script.sh · 700 |
| ✓ | #20 Ask AI about the screen: context that would be sent (text only) | 1.0 s | 4064 characters, 40 serial lines, agent=true, image=false; first line “Virtual machine “P5 Nginx” in Hostwerk (QEMU).”; screen PNG 1695 bytes stays on the PC (saved to report-p5/ai-context-nginx.txt) |
| ✓ | #20 With the AI off: clear refusal, nothing sent | 0.1 s | AI of the test instance was ready=true, switched off → /api/ai/quick ready=false; POST /vms/p5-nginx/ai/explain → 409 “Der KI-Helfer ist aus oder nicht eingerichtet – es wurde nichts gesendet.” |
| ✓ | #22 ARM VM without an OS: qemu-system-aarch64 through Hostwerk, UEFI on the serial console and screen | 11.8 s | ArmTrngLib could not be correctly initialized. · BdsDxe: failed to load Boot0001 "UEFI Misc Device" from PciRoot(0x0)/Pci(0x1,0x0): Not Found · BdsDxe: loading Boot0002 "EFI Internal Shell" from Fv(64074AFE-340A-4BE6-94BA-91B5B4D0F71E)/FvFile(7C04A583-9E3E-4F1C-AD65-E05268D0B4D1); screen 1280×800 PNG; process qemu-system-aarch64 -machine virt, accel tcg; AI context says “Virtual machine “P5 ARM” in Hostwerk (QEMU, ARM64, emulated without acceleration).” |
| ✓ | Clean-up: test VMs powered off and deleted | 0.0 s | p5-nginx, p5-docker, p5-arm |
Before the passing run the test script itself needed two fixes (`head -n 4` cut the hello-world output; the fresh test instance had found a local AI and was "ready" – the test now switches the AI off in memory for that instance only). No product change was needed.

### The other four app templates (17 Nov 2026, `tests/live/apps.js`, 16/16)

`node tests/live/apps.js <work folder> [--only=wordpress,gitea,nextcloud,uptime-kuma]` – port 7869, two VMs at a time
(RAM), Debian 12 from the image cache, packages and containers from the internet in the guest. Each app: setup marker
`app-ready`, the app really used through the "Open …" address on this PC, then a VM restart (`POST /vms/:id/restart`) and
the app back with its data (the guest uptime is checked, so the VM really rebooted). Whole run 7 min 52 s.

| App | Setup after the agent answered | Used through the "Open" address | After the restart |
|---|---|---|---|
| WordPress (8080) | 0 s | wizard `/wp-admin/install.php` → installed, start page shows the blog title, login → 302 with session cookie, title in MariaDB | blog still there, 14 s, guest uptime 10 s |
| Gitea 1.27.3 (3000) | 0–20 s | installation page | page answers, 18 s, guest uptime 14 s |
| Nextcloud 34.0.6 (8081) | 101 s (image pull) | `status.php` installed false → true after `occ maintenance:install` (sqlite), WebDAV PUT 201, GET returns the file unchanged (ä ö ü) | the uploaded file is still there, 23 s |
| Uptime Kuma 1 (3001) | 20 s | `/` → `/dashboard`, "Uptime Kuma" | page answers, 30 s |

No product change was needed. Clean-up: all test VMs powered off and deleted.
