'use strict';
/*
 * Unattended Windows installation: an answer file (autounattend.xml) on a small extra CD, plus the virtio-win driver
 * ISO. Windows Setup looks for "autounattend.xml" in the root of every removable drive and CD, so the VM gets three CD
 * drives: the Windows ISO (boot), the UNATTEND ISO built here, and virtio-win (drivers + QEMU guest agent).
 *
 *   unattendXml({ user, password, computerName, language, locale, timezone, edition, productKey, firmware,
 *                 bypassChecks, diskBus, drivers, autoLogon }) → string
 *   unattendIso(opts) → Buffer (ISO 9660 + Joliet, volume "UNATTEND", file autounattend.xml)
 *   VIRTIO_WIN, resolveVirtioWin({ fetchText }) → { url, file, version, hash, algo }
 *
 * Every user value is checked first and XML-escaped when written, so no value can break the file
 * (tests/windows.test.js). Errors are thrown with fail(400, …) like the other modules.
 *
 * Works for Windows 10/11 and Windows Server 2016–2025, x64 only.
 */
const { fail } = require('./util');
const { buildIso } = require('./iso');
const { parseSums } = require('./catalog');

/* ---------------- checks ---------------- */

// Windows: user names up to 20 characters, none of " / \ [ ] : ; | = , + * ? < > @
const USER_BAD = /["/\\[\]:;|=,+*?<>@\u0000-\u001f\u007f]/;
const RESERVED_USERS = new Set(['administrator', 'guest', 'defaultaccount', 'wdagutilityaccount', 'system', 'none']);
const COMPUTER_RE = /^[A-Za-z0-9-]{1,15}$/;
const TZ_RE = /^[A-Za-z0-9][A-Za-z0-9 ().+,-]{0,63}$/;
const KEY_RE = /^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/;
// Characters XML 1.0 does not allow at all (escaping cannot help)
const XML_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/;

/** Language → keyboard layout (InputLocale). The UI language must exist on the Windows ISO. */
const LANGUAGES = {
  'de-DE': '0407:00000407',
  'de-AT': '0c07:00000407',
  'de-CH': '0807:00000807',
  'en-US': '0409:00000409',
  'en-GB': '0809:00000809',
};

/** & < > " ' → entities. */
function xmlEscape(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function cleanUnattend(o) {
  const user = String(o.user ?? '').trim();
  if (!user || user.length > 20 || USER_BAD.test(user) || /^[. ]+$/.test(user) || user.endsWith('.')) {
    throw fail(400, 'Windows user name: 1–20 characters, without " / \\ [ ] : ; | = , + * ? < > @.');
  }
  if (RESERVED_USERS.has(user.toLowerCase())) throw fail(400, 'Windows user name: Administrator, Guest and other built-in names are not allowed.');
  // A password is required: Windows would otherwise create an account without one, and AutoLogon needs it anyway.
  const password = o.password == null ? '' : String(o.password);
  if (!password || password.length > 127 || XML_BAD.test(password) || /[\r\n]/.test(password)) {
    throw fail(400, 'Windows password: 1 to 127 characters, no line breaks.');
  }
  const computerName = String(o.computerName ?? '').trim();
  if (!COMPUTER_RE.test(computerName) || /^\d+$/.test(computerName) || computerName.startsWith('-')) {
    throw fail(400, 'Computer name: 1–15 letters, digits or "-", not only digits.');
  }
  const language = o.language == null || o.language === '' ? 'de-DE' : String(o.language);
  if (!Object.prototype.hasOwnProperty.call(LANGUAGES, language)) throw fail(400, 'Unsupported Windows language: {lang}', { lang: language });
  const locale = o.locale == null || o.locale === '' ? language : String(o.locale);
  if (!Object.prototype.hasOwnProperty.call(LANGUAGES, locale)) throw fail(400, 'Unsupported Windows language: {lang}', { lang: locale });
  const timezone = o.timezone == null || o.timezone === '' ? 'W. Europe Standard Time' : String(o.timezone);
  if (!TZ_RE.test(timezone)) throw fail(400, 'Invalid Windows time zone: {tz}', { tz: timezone });

  // Edition: a name from the ISO ("Windows 11 Pro", "Windows Server 2022 SERVERSTANDARD") or an index (1, 2, …)
  let edition = o.edition == null || o.edition === '' ? 'Windows 11 Pro' : o.edition;
  if (typeof edition === 'number' || /^\d+$/.test(String(edition))) {
    const n = Number(edition);
    if (!Number.isInteger(n) || n < 1 || n > 99) throw fail(400, 'Windows edition: a name or an index between 1 and 99.');
    edition = { index: n };
  } else {
    const name = String(edition).trim();
    if (!name || name.length > 80 || XML_BAD.test(name) || /[\r\n]/.test(name)) throw fail(400, 'Windows edition: a name or an index between 1 and 99.');
    edition = { name };
  }

  const productKey = String(o.productKey ?? '').trim().toUpperCase();
  if (productKey && !KEY_RE.test(productKey)) throw fail(400, 'Product key: 25 letters or digits in five groups (XXXXX-XXXXX-XXXXX-XXXXX-XXXXX).');

  const firmware = o.firmware === 'bios' ? 'bios' : 'uefi';
  const diskBus = o.diskBus === 'virtio' ? 'virtio' : 'sata';
  const drivers = o.drivers !== false;
  if (diskBus === 'virtio' && !drivers) throw fail(400, 'A virtio disk needs the virtio-win drivers during setup.');
  return {
    user, password, computerName, language, locale, timezone, edition, productKey, firmware, diskBus, drivers,
    bypassChecks: o.bypassChecks !== false,
    autoLogon: o.autoLogon !== false,
  };
}

/* ---------------- answer file ---------------- */

const COMP = 'processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"';
const comp = (name, body) => [`    <component name="${name}" ${COMP}>`, ...body.map((l) => `      ${l}`), '    </component>'];
const tag = (name, value) => `<${name}>${xmlEscape(value)}</${name}>`;

/** Driver folders on the virtio-win ISO. Setup skips paths that do not exist, so every likely drive letter is listed. */
const DRIVER_DIRS = ['viostor', 'vioscsi', 'NetKVM', 'Balloon'];
const DRIVER_OS = ['w11', 'w10', '2k25', '2k22', '2k19'];
const DRIVER_LETTERS = ['D', 'E', 'F', 'G', 'H'];
function driverPaths() {
  const out = [];
  for (const l of DRIVER_LETTERS) for (const d of DRIVER_DIRS) for (const v of DRIVER_OS) out.push(`${l}:\\${d}\\${v}\\amd64`);
  return out;
}

function diskConfiguration(firmware) {
  const parts = firmware === 'uefi'
    ? [{ type: 'EFI', size: 300, format: 'FAT32', label: 'System' }, { type: 'MSR', size: 16 }, { type: 'Primary', extend: true, format: 'NTFS', label: 'Windows', letter: 'C' }]
    : [{ type: 'Primary', size: 500, active: true, format: 'NTFS', label: 'System' }, { type: 'Primary', extend: true, format: 'NTFS', label: 'Windows', letter: 'C' }];
  const L = ['<DiskConfiguration>', '  <Disk wcm:action="add">', '    <DiskID>0</DiskID>', '    <WillWipeDisk>true</WillWipeDisk>', '    <CreatePartitions>'];
  parts.forEach((p, i) => {
    L.push('      <CreatePartition wcm:action="add">', `        <Order>${i + 1}</Order>`, `        <Type>${p.type}</Type>`);
    L.push(p.extend ? '        <Extend>true</Extend>' : `        <Size>${p.size}</Size>`, '      </CreatePartition>');
  });
  L.push('    </CreatePartitions>', '    <ModifyPartitions>');
  parts.forEach((p, i) => {
    L.push('      <ModifyPartition wcm:action="add">', `        <Order>${i + 1}</Order>`, `        <PartitionID>${i + 1}</PartitionID>`);
    if (p.active) L.push('        <Active>true</Active>');
    if (p.format) L.push(`        <Format>${p.format}</Format>`, `        <Label>${p.label}</Label>`);
    if (p.letter) L.push(`        <Letter>${p.letter}</Letter>`);
    L.push('      </ModifyPartition>');
  });
  L.push('    </ModifyPartitions>', '  </Disk>', '  <WillShowUI>OnError</WillShowUI>', '</DiskConfiguration>');
  return { lines: L, windowsPartition: parts.length };
}

function runSync(listTag, itemTag, cmds) {
  const L = [`<${listTag}>`];
  cmds.forEach((c, i) => {
    L.push(`  <${itemTag} wcm:action="add">`, `    <Order>${i + 1}</Order>`, `    ${tag('Path', c)}`, `  </${itemTag}>`);
  });
  L.push(`</${listTag}>`);
  return L;
}

const REG_LAB = 'HKLM\\SYSTEM\\Setup\\LabConfig';
const GUEST_TOOLS = 'virtio-win-guest-tools.exe';
/*
 * First logon: find the virtio-win CD (the drive with virtio-win-guest-tools.exe in its root) and install all drivers
 * plus the QEMU guest agent silently. Get-PSDrive covers every drive letter, not only D–H.
 */
const INSTALL_TOOLS = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "'
  + `$d = Get-PSDrive -PSProvider FileSystem | Where-Object { Test-Path -LiteralPath ($_.Root + '${GUEST_TOOLS}') } | Select-Object -First 1; `
  + `if ($d) { Start-Process -Wait -FilePath ($d.Root + '${GUEST_TOOLS}') -ArgumentList '/install','/quiet','/norestart' }"`;

/** Builds autounattend.xml. Throws fail(400, …) for invalid input. */
function unattendXml(opts) {
  const s = cleanUnattend(opts || {});
  const kbd = LANGUAGES[s.locale];
  const disk = diskConfiguration(s.firmware);
  const imageKey = s.edition.index ? ['/IMAGE/INDEX', String(s.edition.index)] : ['/IMAGE/NAME', s.edition.name];
  const password = ['<Password>', `  ${tag('Value', s.password)}`, '  <PlainText>true</PlainText>', '</Password>'];

  /* windowsPE: language of Setup, drivers, disk layout, edition, hardware checks */
  const pe = [];
  pe.push(...comp('Microsoft-Windows-International-Core-WinPE', [
    '<SetupUILanguage>', `  ${tag('UILanguage', s.language)}`, '</SetupUILanguage>',
    tag('InputLocale', kbd), tag('SystemLocale', s.locale), tag('UILanguage', s.language), tag('UserLocale', s.locale),
  ]));
  if (s.drivers) {
    const P = ['<DriverPaths>'];
    driverPaths().forEach((p, i) => P.push(`  <PathAndCredentials wcm:action="add" wcm:keyValue="${i + 1}">`, `    ${tag('Path', p)}`, '  </PathAndCredentials>'));
    P.push('</DriverPaths>');
    pe.push(...comp('Microsoft-Windows-PnpCustomizationsWinPE', P));
  }
  const setup = [...disk.lines,
    '<ImageInstall>', '  <OSImage>', '    <InstallFrom>', '      <MetaData wcm:action="add">',
    `        ${tag('Key', imageKey[0])}`, `        ${tag('Value', imageKey[1])}`, '      </MetaData>', '    </InstallFrom>',
    '    <InstallTo>', '      <DiskID>0</DiskID>', `      <PartitionID>${disk.windowsPartition}</PartitionID>`, '    </InstallTo>',
    '    <WillShowUI>OnError</WillShowUI>', '  </OSImage>', '</ImageInstall>',
    '<UserData>', '  <AcceptEula>true</AcceptEula>'];
  // No key → none is written: Setup takes the edition from /IMAGE/NAME; retail multi-edition ISOs may still ask for one.
  if (s.productKey) setup.push('  <ProductKey>', `    ${tag('Key', s.productKey)}`, '    <WillShowUI>OnError</WillShowUI>', '  </ProductKey>');
  setup.push('</UserData>');
  if (s.bypassChecks) {
    // Windows 11 Setup refuses VMs without TPM 2.0 / Secure Boot / 4 GB; these LabConfig values skip those checks.
    setup.push(...runSync('RunSynchronous', 'RunSynchronousCommand',
      ['BypassTPMCheck', 'BypassSecureBootCheck', 'BypassRAMCheck', 'BypassCPUCheck'].map((v) => `reg.exe add "${REG_LAB}" /v ${v} /t REG_DWORD /d 1 /f`)));
  }
  pe.push(...comp('Microsoft-Windows-Setup', setup));

  /* specialize: name, time zone, allow a local account without network */
  const spec = [];
  spec.push(...comp('Microsoft-Windows-Shell-Setup', [tag('ComputerName', s.computerName), tag('TimeZone', s.timezone)]));
  spec.push(...comp('Microsoft-Windows-Deployment', runSync('RunSynchronous', 'RunSynchronousCommand', [
    'reg.exe add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\OOBE" /v BypassNRO /t REG_DWORD /d 1 /f',
    'net.exe accounts /maxpwage:UNLIMITED',
  ])));

  /* oobeSystem: local administrator account, no Microsoft account, privacy questions answered, first logon commands */
  // SECURITY: Setup copies the answer file to C:\Windows\Panther (and Panther\Unattend). It contains the user's password
  // in plain text, so the copies are deleted first thing – before the guest tools, whose agent tells Hostwerk "done"
  // (Hostwerk deletes them through the agent as well, see PANTHER_CLEANUP).
  const first = ['cmd.exe /c del /q /f "%WINDIR%\\Panther\\unattend.xml" "%WINDIR%\\Panther\\Unattend\\*.xml" "%WINDIR%\\System32\\Sysprep\\unattend.xml"'];
  if (s.autoLogon) {
    // AutoLogon leaves the password in the Winlogon key (DefaultPassword) in plain text – remove it and switch AutoLogon off.
    first.push('reg.exe delete "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" /v DefaultPassword /f',
      'reg.exe add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" /v AutoAdminLogon /t REG_SZ /d 0 /f');
  }
  if (s.drivers) first.push(INSTALL_TOOLS); // last: its guest agent reports the installation as finished
  const oobe = [
    '<OOBE>', '  <HideEULAPage>true</HideEULAPage>', '  <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>',
    '  <HideOnlineAccountScreens>true</HideOnlineAccountScreens>', '  <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>',
    '  <ProtectYourPC>3</ProtectYourPC>', '</OOBE>',
    '<UserAccounts>', '  <LocalAccounts>', '    <LocalAccount wcm:action="add">',
    `      ${tag('Name', s.user)}`, `      ${tag('DisplayName', s.user)}`, '      <Group>Administrators</Group>',
    ...password.map((l) => `      ${l}`), '    </LocalAccount>', '  </LocalAccounts>', '</UserAccounts>',
  ];
  if (s.autoLogon) {
    oobe.push('<AutoLogon>', '  <Enabled>true</Enabled>', '  <LogonCount>1</LogonCount>', `  ${tag('Username', s.user)}`,
      ...password.map((l) => `  ${l}`), '</AutoLogon>');
  }
  oobe.push('<FirstLogonCommands>');
  first.forEach((c, i) => oobe.push('  <SynchronousCommand wcm:action="add">', `    <Order>${i + 1}</Order>`, `    ${tag('CommandLine', c)}`,
    '    <RequiresUserInput>false</RequiresUserInput>', '  </SynchronousCommand>'));
  oobe.push('</FirstLogonCommands>');
  const oobeComps = [
    ...comp('Microsoft-Windows-International-Core', [tag('InputLocale', kbd), tag('SystemLocale', s.locale), tag('UILanguage', s.language), tag('UserLocale', s.locale)]),
    ...comp('Microsoft-Windows-Shell-Setup', oobe),
  ];

  const pass = (name, lines) => [`  <settings pass="${name}">`, ...lines, '  </settings>'];
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- Generated by Hostwerk. Contains a password in plain text – keep it private. -->',
    '<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    ...pass('windowsPE', pe),
    ...pass('specialize', spec),
    ...pass('oobeSystem', oobeComps),
    '</unattend>',
    '',
  ].join('\r\n');
}

/** The answer file on a small CD (Windows Setup scans the root of every CD/removable drive for autounattend.xml). */
function unattendIso(opts) {
  return buildIso({ volume: 'UNATTEND', files: { 'autounattend.xml': unattendXml(opts) } });
}

/* ---------------- virtio-win ---------------- */

const VIRTIO_BASE = 'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/';
/*
 * virtio-win (Red Hat / Fedora): storage, network, balloon drivers and the QEMU guest agent for Windows guests.
 *
 * CHECKSUM SITUATION (checked 2026-11): fedorapeople.org publishes NO sha256 (or any) checksum for the ISO. Each
 * archive-virtio/virtio-win-<ver>-<rel>/ folder has a file "CHECKSUM", but it lists only MD5 sums of the RPMs, and the
 * yum repo has gpgcheck=0 (unsigned). So the ISO download cannot be verified – resolveVirtioWin() returns hash: null
 * unless a future CHECKSUM file lists the ISO with a sha256 sum. Also: stable-virtio/virtio-win.iso answers with a
 * 301 redirect to an http:// (not https) URL – resolveVirtioWin() therefore returns the versioned https URL directly.
 */
const VIRTIO_WIN = {
  id: 'virtio-win', kind: 'iso', label: 'virtio-win drivers for Windows', family: 'virtio', osType: 'windows', sizeMb: 850,
  url: `${VIRTIO_BASE}stable-virtio/virtio-win.iso`, page: 'https://github.com/virtio-win/virtio-win-pkg-scripts', resolver: 'virtio-win', algo: 'sha256', checksum: false,
};

// Matches archive folders ("virtio-win-0.1.302-1/"), the listing title and RPM names ("virtio-win-0.1.302-1.noarch.rpm")
const VDIR_RE = /virtio-win-(\d+)\.(\d+)\.(\d+)-(\d+)/g;
const vcmp = (a, b) => { for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
function pickVirtioDir(html) {
  const found = [...String(html || '').matchAll(VDIR_RE)].map((m) => m.slice(1, 5).map(Number));
  found.sort(vcmp);
  const v = found.pop();
  return v ? { dir: `virtio-win-${v[0]}.${v[1]}.${v[2]}-${v[3]}`, version: `${v[0]}.${v[1]}.${v[2]}` } : null;
}

/**
 * Finds the current stable virtio-win release → { url, file, version, hash, algo }. The "stable-virtio/" listing is a
 * symlink into archive-virtio/; when the fetched page names its archive folder that one is used, otherwise the newest
 * folder in archive-virtio/. hash is null when no sha256 is published (the usual case – see above).
 */
async function resolveVirtioWin({ fetchText }) {
  let picked = null;
  try { picked = pickVirtioDir(await fetchText(`${VIRTIO_BASE}stable-virtio/`)); } catch { picked = null; }
  if (!picked) picked = pickVirtioDir(await fetchText(`${VIRTIO_BASE}archive-virtio/?C=M;O=D`));
  if (!picked) throw new Error('virtio-win release list could not be read.');
  const file = `virtio-win-${picked.version}.iso`;
  const base = `${VIRTIO_BASE}archive-virtio/${picked.dir}/`;
  let hash = null;
  try {
    const sums = parseSums(await fetchText(`${base}CHECKSUM`));
    const h = sums.get(file) || sums.get('virtio-win.iso');
    if (h && h.length === 64) hash = h;
  } catch { hash = null; }
  if (!hash && PINNED_SHA256[picked.version]) hash = PINNED_SHA256[picked.version];
  return { url: base + file, file, version: picked.version, hash, algo: hash ? 'sha256' : null, pinned: !!PINNED_SHA256[picked.version] };
}

/*
 * SHA-256 of virtio-win ISOs, held fixed per version (the project publishes none). Taken from the first download over
 * https of fedorapeople.org; every later download of the same version must match exactly. Versions not listed here are
 * pinned on this PC on their first download (manager: <vms>/.pins.json).
 */
const PINNED_SHA256 = {
  '0.1.302': '303f7ae40dad495d6ae474fdc571df58958a4dbc5c37a522d80f9a203867949d', // 877,373,440 bytes, fetched 2026-11-16
};

/** PowerShell for the guest agent: deletes Setup's copies of the answer file and prints every one that is still there. */
const PANTHER_CLEANUP = "$f = @(\"$env:WINDIR\\Panther\\unattend.xml\", \"$env:WINDIR\\Panther\\Unattend\\unattend.xml\", \"$env:WINDIR\\Panther\\Unattend\\autounattend.xml\", \"$env:WINDIR\\System32\\Sysprep\\unattend.xml\"); "
  + '$f | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue }; $f | Where-Object { Test-Path -LiteralPath $_ }';

module.exports = { unattendXml, unattendIso, cleanUnattend, xmlEscape, driverPaths, LANGUAGES, VIRTIO_WIN, resolveVirtioWin, pickVirtioDir, PINNED_SHA256, PANTHER_CLEANUP };
