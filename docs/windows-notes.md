# Windows guests – integration notes (package 2 groundwork)

New, self-contained files: `server/windows.js`, `tests/windows.test.js`. Nothing existing was changed.

## What `server/windows.js` provides

| Export | Purpose |
|---|---|
| `unattendXml(opts)` | `autounattend.xml` for Windows 10/11 and Server (x64). Throws `fail(400, …)` on bad input. |
| `unattendIso(opts)` | Buffer: ISO 9660 + Joliet, volume `UNATTEND`, one file `autounattend.xml` (via `buildIso`). |
| `cleanUnattend(opts)` | Validation only (useful to check the form before creating anything). |
| `VIRTIO_WIN` | Catalog-style entry for the virtio-win ISO (`kind: 'iso'`, `resolver: 'virtio-win'`, `checksum: false`). |
| `resolveVirtioWin({ fetchText })` | → `{ url, file, version, hash, algo }` – current stable release, versioned **https** URL. `hash` is `null` today (see below). |
| `LANGUAGES` | Supported `language`/`locale` values: de-DE, de-AT, de-CH, en-US, en-GB. |

Options of `unattendXml`: `user`, `password` (required, 1–127), `computerName` (1–15, `[A-Za-z0-9-]`, not only digits),
`language` (UI language of Setup/Windows, default `de-DE` – **must exist on the ISO**), `locale` (formats + keyboard,
default = language), `timezone` (Windows id, default `W. Europe Standard Time`), `edition` (name, default
`Windows 11 Pro`, or index 1–99), `productKey` (optional), `firmware` (`uefi`|`bios`), `bypassChecks` (default true),
`diskBus` (`sata`|`virtio`), `drivers` (default true; virtio-win driver paths + guest tools), `autoLogon` (default true, once).

What the answer file does: wipes disk 0 (UEFI: EFI 300 MB FAT32 + MSR 16 MB + NTFS rest; BIOS: 500 MB active NTFS +
NTFS rest), installs the edition by `/IMAGE/NAME` or `/IMAGE/INDEX`, sets LabConfig bypass keys (TPM, Secure Boot, RAM,
and also CPU), loads viostor/vioscsi/NetKVM/Balloon from the virtio-win CD in WinPE, creates a local administrator (no
Microsoft account: BypassNRO, HideOnlineAccountScreens, ProtectYourPC=3), logs on once automatically and then runs:
1. `virtio-win-guest-tools.exe /install /quiet /norestart` from whatever drive has it (all drivers + QEMU guest agent),
2. removes the AutoLogon `DefaultPassword` from the registry,
3. deletes `C:\Windows\Panther\unattend.xml` and `Panther\Unattend\*.xml` (they hold the password in plain text).

## Wiring (VM creation, source `iso`, `osType: 'windows'`)

1. Validate early with `cleanUnattend()` so form errors show before disks are created.
2. Write `unattendIso(opts)` to the VM folder, e.g. `unattend.iso` (contains the password – VM folder only, never logs).
3. Download virtio-win once into the shared ISO/download folder: `resolveVirtioWin({ fetchText })` → url/file.
4. QEMU drives (all SATA `ide-cd`, Windows Setup has no virtio drivers before step 2 of WinPE):
   - `cd0` = Windows ISO, `boot: 'cdrom'` (as today),
   - second CD = `unattend.iso` (could reuse the existing `vm.seed` slot: `qemu-args.js` already puts the seed on SATA
     for non-Linux guests – `seed: 'unattend.iso'` might be enough),
   - third CD = virtio-win ISO (new field, see below).
5. After the installation (guest agent answers, or first boot from disk), detach and delete `unattend.iso`, switch
   `boot` back to `disk`. The virtio-win CD can stay or be ejected.
6. Optional afterwards: switch NIC to `virtio` and disk to `virtio` – the drivers are installed by then.

**SATA port budget:** the AHCI controller has 6 ports (`SATA_PORTS = 6` in `qemu-args.js`). `spec.js` currently
reserves 2 (CD + seed) → max 4 SATA disks. With a third CD for Windows only **3 SATA disks** remain; the check in
`cleanVm` (`+ 2`) and in `buildArgs` (`SATA_PORTS - 2`) must become `+ 3` / `- 3` when the driver CD is attached
(Windows-only, or always if simpler). Error text "At most 4 SATA disks …" needs a variant for 3.

Note on drive letters: inside WinPE the CDs usually get D:, E:, F: in SATA order. Driver paths are listed for D:–H:;
Setup skips missing ones.

## Spec fields to add (suggestion)

- `vm.drivers: '<path to virtio-win.iso>' | null` – third SATA CD.
- `vm.seed: 'unattend.iso'` for Windows (existing field), or a separate `vm.unattend`.
- `vm.install: { state: 'pending'|'done' }` or similar, to know when to remove the unattend ISO.
- Creation form (not stored in vm.json!): `user`, `password`, `computerName`, `language`, `timezone`, `edition`,
  `productKey`, `bypassChecks`.

## Texts that need German translations (locales/de.json)

- `Windows user name: 1–20 characters, without " / \ [ ] : ; | = , + * ? < > @.`
- `Windows user name: Administrator, Guest and other built-in names are not allowed.`
- `Windows password: 1 to 127 characters, no line breaks.`
- `Computer name: 1–15 letters, digits or "-", not only digits.`
- `Unsupported Windows language: {lang}`
- `Invalid Windows time zone: {tz}`
- `Windows edition: a name or an index between 1 and 99.`
- `Product key: 25 letters or digits in five groups (XXXXX-XXXXX-XXXXX-XXXXX-XXXXX).`
- `A virtio disk needs the virtio-win drivers during setup.`
- `virtio-win drivers for Windows` (catalog label), `virtio-win release list could not be read.` (plain Error, 500)

## Open points / unsure

- **virtio-win has no published checksum for the ISO** (checked 2026-11-16): `archive-virtio/virtio-win-<v>-<r>/CHECKSUM`
  lists only MD5 sums of the RPMs; the yum repo has `gpgcheck=0`. `resolveVirtioWin` returns `hash: null` (and would use
  a sha256 automatically if one appears in CHECKSUM). The integrator must decide: download unverified over https from
  the versioned URL (TLS only), or pin known hashes per version in code. Also: `stable-virtio/…` **redirects (301) to an
  `http://` URL** – never download through the redirect; use the URL returned by `resolveVirtioWin`.
  If `fetchText` refuses that redirect when reading the `stable-virtio/` listing, the function falls back to the newest
  folder in `archive-virtio/` (which today is the same release, but could be a newer "latest" build in the future).
- **Product key / edition:** no key is written by default; the edition is chosen by `/IMAGE/NAME` ("Windows 11 Pro").
  Retail multi-edition ISOs may still show the product-key page when no key is given – not verified in a VM yet. If so,
  the user can press "I don't have a product key", or the integrator can pass a key. Microsoft publishes generic KMS
  client keys (learn.microsoft.com, "Key Management Services (KMS) client activation and product keys") that install
  without activating; I deliberately did not hard-code any key. Windows Server evaluation ISOs need no key, but their
  image names differ (`Windows Server 2022 SERVERSTANDARD`, `… SERVERDATACENTER`, `(Desktop Experience)` variants) –
  the UI should offer index or name; reading the names from `install.wim` would need wimlib/DISM (not done).
- **UI language must match the ISO.** A German ISO with `language: 'en-US'` may stop Setup. Default `de-DE`.
- **BypassNRO**: recent Windows 11 builds reportedly ignore this registry value; the local account from the answer file
  plus `HideOnlineAccountScreens` should still avoid the Microsoft-account screen. Not tested on 24H2/25H2.
- `BypassCPUCheck` is set in addition to the three requested keys (harmless, helps with unusual QEMU CPU models).
- `net accounts /maxpwage:UNLIMITED` is run in specialize so the local password does not expire after 42 days.
- Windows reads Joliet names on CDs; the 8.3 primary name would be `AUTOUNAT.XML`. If a Setup version only looked at
  primary names it would not find the file – not expected, but verify once in a real install.
- **Verified end-to-end (17 Nov 2026):** Windows 11 Enterprise Evaluation (de-DE, build 26100) installs unattended in
  QEMU 11.1/WHPX on a Ryzen 7 7800X3D in 11 minutes: local user signs in, virtio drivers present, no answer-file copy left
  in Panther, restart boots from disk (`tests/live/package2.js`, 6/6). What it took:
  - **No `kernel-irqchip=off` for Windows** – with WHPX's userspace interrupt controller Windows stays at the TianoCore
    logo ("Bitte warten") with every CPU model.
  - **No `-cpu max` / `host` for Windows under WHPX** – Windows 11 shows a bluescreen PAGE_FAULT_IN_NONPAGED_AREA (0x50)
    on its first start from disk (WinPE itself runs). Named models work: AMD → `EPYC-Rome` (Genoa also checked),
    Intel → `Skylake-Client` (chosen by analogy, not tested on an Intel PC).
  - **Resets pause QEMU** – with WHPX's in-kernel interrupt controller every reset (guest restart or `system_reset`)
    ends in STOP, and `cont` does not help. Windows VMs therefore run with `-no-reboot`: a restart ends QEMU
    (SHUTDOWN guest-reset) and the runtime starts it again at once, without the "press any key" Enter presses.
    Since 1.2.0 this holds for every x86 VM under WHPX: a UEFI Linux guest hangs on `systemctl reboot` as well
    (0 % CPU, "Display output is not active", the firmware never starts again).
  - **Panther copies** – the agent can report before the last first-logon command ran, so the delete is now the first
    first-logon command and Hostwerk deletes the copies once more through the guest agent (warning if one is left).
  - The guest agent reports Windows 11 as "Windows 10 …" (`guest-get-osinfo`); WMI says Windows 11.
