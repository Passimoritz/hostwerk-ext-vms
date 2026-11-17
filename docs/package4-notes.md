# Package 4 – internal networks, shared folders, bridge, encrypted disks, moving VMs

New files: `server/netswitch.js`, `server/webdav.js`, `server/tap.js`, `tests/package4.test.js`, `tests/live/package4.js`.
Changed: `spec.js` (fields `nets`, `shares`, `net.mode: 'bridge'` + `net.tap`, `encryption`, `disks[].encrypted`),
`qemu-args.js`, `runtime.js`, `manager.js`, `qemu-host.js` (key options), `cloudinit.js` (`network-config`), `kind.js`
(`copy`), `routes.js`, `index.js`, UI (`create.jsx`, `detail.jsx`, `index.jsx`), `locales/de.json`.

## #7 Internal networks between VMs

Networks live in `<root>/.config.json` → `networks: [{ id, name, n }]` (`n` = 1…250 → suggested subnet
`10.10.<n>.0/24`). A VM has `nets: [{ net, mac, ip }]`, at most 2; the MAC is `macFor('<vm id>/<net id>')`.

**Why not QEMU's multicast socket:** checked with QEMU 11.1 on this PC – `-netdev socket,mcast=230.0.0.1:…,localaddr=127.0.0.1`
and `-netdev dgram,…remote.host=230.0.0.1` both fail with *"can't bind ip=230.0.0.1 to socket: Unknown error"* (QEMU binds
the socket to the group address, which Windows refuses). Point-to-point UDP works, so each internal NIC is

    -netdev dgram,id=inN,local.type=inet,local.host=127.0.0.1,local.port=<NIC port>,remote.type=inet,remote.host=127.0.0.1,remote.port=<switch port>

and `server/netswitch.js` is a learning Ethernet switch per network inside Hostwerk (UDP on 127.0.0.1, port chosen by the
system). It forwards one frame per datagram, learns MAC → port, floods broadcasts/unknown destinations, and drops
datagrams that do not come from 127.0.0.1 and from a NIC port registered right now. It opens with the first running
member and closes with the last one. Nothing leaves the PC.

Addresses: new ready-made Linux VMs get a cloud-init `network-config` (v2: NAT NIC `hwnat` with DHCP + `hwinN` static,
matched by MAC). For every Linux VM with the guest agent Hostwerk also sets the address after each start (finds the NIC by
MAC, `ip addr add` if missing) – so joining later works without touching the guest. Windows: the same through PowerShell
(`New-NetIPAddress`), **not verified on a real Windows guest**. Without the agent the address is set in the guest by hand.

## #13 Shared folders PC → VM – the choice

Options looked at: virtfs/9p (not in QEMU for Windows), Windows file sharing/SMB to the VM (needs administrator rights
for a share and a second network; QEMU's built-in `smb=` needs Samba – not available on Windows), copying through the
guest agent (exists already for single files, no live folder). Picked: **a small WebDAV server inside Hostwerk on
127.0.0.1** (`server/webdav.js`, no new program, no download, no admin rights). QEMU's user network maps the guest address
`10.0.2.2` to the PC's `127.0.0.1` (verified: the guest reads and writes through it), so only VMs of this PC reach it.

- One server for all VMs, port kept in `.config.json` (`sharePort`, default from 47950) so addresses in guests stay valid.
- Address per folder: `http://10.0.2.2:<port>/<token>/`, token = 32 random hex characters, answered **only while the VM
  runs** (otherwise 404). Read-only folders refuse PUT/DELETE/MKCOL/MOVE/COPY/PROPPATCH (403). Paths never leave the
  folder (`..`, backslashes, drive letters, links/junctions pointing outside → 403/404). The VM folder of Hostwerk itself
  cannot be shared.
- Linux: "Mount now" (and automatically after each start when "mount at every start" is on) runs through the guest agent:
  installs `davfs2` in the guest if missing (package from the guest's own distribution mirror), writes
  `/etc/davfs2/secrets`, `use_locks 0`, mounts at `/mnt/hostwerk/<name>` (`ro` for read-only shares, owner = the VM user).
- Windows: the UI copies `net use * "http://10.0.2.2:<port>/<token>/" /persistent:yes` – to be run by the signed-in user
  (a drive mapped by the agent as SYSTEM would not be visible). Needs the WebClient service (on by default on desktop
  Windows). **Not verified on a real Windows guest.**
- Shared folders need the NAT network (not with the bridge).

## #14 Network bridge

Detection only: `Get-NetAdapter -IncludeHidden` (read-only) → adapters with component id `tap0901`/`tap0801` or
description "TAP-Windows". With `net.mode: 'bridge'` and `net.tap: '<adapter name>'` QEMU starts with
`-netdev tap,id=n0,ifname=<adapter>`; a missing adapter refuses the start (409) with a clear text. Hostwerk installs
nothing; the UI explains: install TAP-Windows (OpenVPN, admin rights), then bridge it with the real card in
`ncpa.cpl`. Port forwarding and shared folders do not apply in bridge mode. **Not verified with a real TAP adapter** (none
on this PC, and installing one was not allowed).

## #15 Encrypted disks

qcow2 with LUKS (AES-256-XTS). The key (64 hex characters, random) is sealed with Hostwerk's secret store
(`host.core('secrets').seal` → `enc:…`) and stored only like that in `vm.json` (`encryption: { format: 'luks', key }`);
disks carry `encrypted: true`. Without the secret store encryption is not offered.

QEMU and qemu-img get the key through a **short-lived key file** in the VM folder (`.hwkey-<random>`: created empty and
exclusive, `icacls /inheritance:r /grant:r <user>:F`, then written; overwritten and deleted right after – for QEMU as soon
as QMP answers, i.e. after the disks were opened). Never on a command line. Leftovers are removed when the extension loads.

Covered: creating (cloud image converted encrypted, ISO/empty created encrypted), adding/attaching disks, resizing,
offline snapshots, backups (encrypted, not compressed – qcow2 cannot do both; live backups use QEMU's secret `hwkey0`),
restore, compact, full copies (same key), export (decrypted – other programs cannot read it), encrypting an existing VM
(job; needs no snapshots), showing the key, unlocking with a key (checked against the disk). Refused: templates and
linked clones of encrypted VMs.

## #16 Moving to another Hostwerk PC

`kind.copy` as Hostwerk core expects it (see `services/transfer.js`, `svcclone.js`, `mirror.js`, `keepservices.js`):
`folder: 'vms'`, `zip: 'vm.zip'`, `skip` (vm.json, qemu.pid, key files …), `dir` (refuses running/busy VMs, linked clones
and templates with clones), `dirFor`, `entry` (vm.json without id/autostart + network names), `place` (new id, no
autostart, networks by name – created if missing, addresses already taken there are dropped with a note, host ports taken
there move to the next free one, shares only where the folder exists, ISO/driver paths only if present), `afterFiles`
(writes its own vm.json again), `add` (keep → new Hostwerk), `clone` (with data = full copy, without = same hardware with
an empty disk), `probe` (start, still running after 8 s, power off).

Encrypted VMs: the key never travels with the disks – it is sealed for the source PC. On the target the VM is **locked**
until the key is entered (Hardware → Encryption → "Enter key …"; read it on the source with "Show key …"). "Keep when
removing Hostwerk" works without that step: Hostwerk re-seals the `enc:` value with the new key.

Packages are limited to 8 GB by Hostwerk (`MAX_PACKAGE`).

## Real-life test

`node tests/live/package4.js <work folder with vms/.images>` – Hostwerk on port 7865, Debian 12 cloud image from the
cache (refuses to run if the cached image is outdated instead of downloading). See the report in
`<work>/report-p4/report.md`.
