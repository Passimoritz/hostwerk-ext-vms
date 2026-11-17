'use strict';
/*
 * Operating systems to start from – only official download servers, and every file is checked against the checksum
 * the project publishes next to it. File names with point releases (Ubuntu 24.04.3, Debian 13.2 …) are looked up in the
 * checksum list itself, so nothing goes stale.
 *
 *   kind 'cloud' – ready-made disk image with cloud-init: user, password/SSH key and guest agent are set on first start
 *   kind 'iso'   – installer; the VM boots from it once
 *   kind 'manual'– no automatic download (licence), a link to the official page
 *
 *   resolve(entry, { fetchText }) → { url, file, hash, algo }
 */
const ENTRIES = [
  { id: 'debian-13', kind: 'cloud', label: 'Debian 13 (Trixie)', family: 'debian', user: 'debian', sizeMb: 350,
    url: 'https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2', sums: 'https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS', algo: 'sha512' },
  { id: 'debian-12', kind: 'cloud', label: 'Debian 12 (Bookworm)', family: 'debian', user: 'debian', sizeMb: 330,
    url: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2', sums: 'https://cloud.debian.org/images/cloud/bookworm/latest/SHA512SUMS', algo: 'sha512' },
  { id: 'ubuntu-24.04', kind: 'cloud', label: 'Ubuntu 24.04 LTS', family: 'ubuntu', user: 'ubuntu', sizeMb: 600,
    url: 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img', sums: 'https://cloud-images.ubuntu.com/noble/current/SHA256SUMS', algo: 'sha256' },
  { id: 'ubuntu-22.04', kind: 'cloud', label: 'Ubuntu 22.04 LTS', family: 'ubuntu', user: 'ubuntu', sizeMb: 650,
    url: 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img', sums: 'https://cloud-images.ubuntu.com/jammy/current/SHA256SUMS', algo: 'sha256' },
  { id: 'alma-9', kind: 'cloud', label: 'AlmaLinux 9', family: 'rhel', user: 'almalinux', sizeMb: 550,
    url: 'https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2', sums: 'https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/CHECKSUM', algo: 'sha256' },
  { id: 'fedora', kind: 'cloud', label: 'Fedora Cloud', family: 'fedora', user: 'fedora', sizeMb: 550, resolver: 'fedora', algo: 'sha256' },
  // ARM (#22): 64-bit ARM cloud images – run emulated (TCG) on an x86 PC, so slow; same checksum lists as above.
  // Raspberry Pi OS is not listed: its images are made for Raspberry Pi boards (no UEFI) and do not boot on QEMU "virt".
  { id: 'debian-12-arm64', kind: 'cloud', arch: 'aarch64', label: 'Debian 12 (Bookworm) · ARM64', family: 'debian', user: 'debian', sizeMb: 325,
    url: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-arm64.qcow2', sums: 'https://cloud.debian.org/images/cloud/bookworm/latest/SHA512SUMS', algo: 'sha512' },
  { id: 'debian-13-arm64', kind: 'cloud', arch: 'aarch64', label: 'Debian 13 (Trixie) · ARM64', family: 'debian', user: 'debian', sizeMb: 322,
    url: 'https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-arm64.qcow2', sums: 'https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS', algo: 'sha512' },
  { id: 'ubuntu-24.04-arm64', kind: 'cloud', arch: 'aarch64', label: 'Ubuntu 24.04 LTS · ARM64', family: 'ubuntu', user: 'ubuntu', sizeMb: 590,
    url: 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-arm64.img', sums: 'https://cloud-images.ubuntu.com/noble/current/SHA256SUMS', algo: 'sha256' },
  { id: 'alpine-virt', kind: 'iso', label: 'Alpine Linux (virt)', family: 'alpine', osType: 'linux', sizeMb: 65, resolver: 'alpine', algo: 'sha256' },
  { id: 'debian-netinst', kind: 'iso', label: 'Debian (network installer)', family: 'debian', osType: 'linux', sizeMb: 750,
    dir: 'https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/', match: /^debian-[\d.]+-amd64-netinst\.iso$/, algo: 'sha256' },
  { id: 'ubuntu-server', kind: 'iso', label: 'Ubuntu Server 24.04 LTS', family: 'ubuntu', osType: 'linux', sizeMb: 3100,
    dir: 'https://releases.ubuntu.com/noble/', match: /^ubuntu-24\.04(\.\d+)?-live-server-amd64\.iso$/, algo: 'sha256' },
  { id: 'ubuntu-desktop', kind: 'iso', label: 'Ubuntu Desktop 24.04 LTS', family: 'ubuntu', osType: 'linux', sizeMb: 6000,
    dir: 'https://releases.ubuntu.com/noble/', match: /^ubuntu-24\.04(\.\d+)?-desktop-amd64\.iso$/, algo: 'sha256' },
  { id: 'windows-11', kind: 'manual', label: 'Windows 11', family: 'windows', osType: 'windows', page: 'https://www.microsoft.com/software-download/windows11' },
  { id: 'windows-server', kind: 'manual', label: 'Windows Server (evaluation)', family: 'windows', osType: 'windows', page: 'https://www.microsoft.com/evalcenter' },
];

/** Every common checksum list: "hash  file", "hash *file", "SHA256 (file) = hash". → Map(file → hash) */
function parseSums(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    let m = line.match(/^([a-f0-9]{40,128})\s+\*?(\S+)\s*$/i);
    if (m) { out.set(m[2].replace(/^\.\//, ''), m[1].toLowerCase()); continue; }
    m = line.match(/^(?:SHA\d+|MD5)\s*\(([^)]+)\)\s*=\s*([a-f0-9]{32,128})\s*$/i);
    if (m) out.set(m[1].replace(/^\.\//, ''), m[2].toLowerCase());
  }
  return out;
}
const lengthOf = { sha256: 64, sha512: 128 };

/** Alpine's latest-releases.yaml: blocks "- title … flavor: alpine-virt … file: … sha256: …" */
function parseAlpineYaml(text, flavor = 'alpine-virt') {
  for (const block of String(text || '').split(/\n-\s+/)) {
    const get = (k) => { const m = block.match(new RegExp(`^\\s*${k}:\\s*"?([^"\\n]+)"?\\s*$`, 'm')); return m ? m[1].trim() : null; };
    if (get('flavor') === flavor && get('file') && get('sha256')) return { file: get('file'), hash: get('sha256').toLowerCase(), version: get('version') };
  }
  return null;
}

/** Fedora's releases.json: newest Cloud_Base qcow2 for x86_64. */
function pickFedora(list) {
  const items = (Array.isArray(list) ? list : []).filter((r) => r.arch === 'x86_64' && /cloud/i.test(r.variant || '') && /Cloud_Base/i.test(r.subvariant || '') && /\.qcow2$/.test(r.link || '') && r.sha256);
  items.sort((a, b) => Number(b.version) - Number(a.version) || 0);
  const r = items.find((x) => /^\d+$/.test(String(x.version)));
  return r ? { url: r.link, file: r.link.split('/').pop(), hash: String(r.sha256).toLowerCase(), version: r.version } : null;
}

async function resolve(entry, { fetchText }) {
  if (!entry || entry.kind === 'manual') throw Object.assign(new Error('This system cannot be downloaded automatically.'), { status: 400 });
  if (entry.resolver === 'alpine') {
    const base = 'https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86_64/';
    const r = parseAlpineYaml(await fetchText(`${base}latest-releases.yaml`));
    if (!r) throw new Error('Alpine release list could not be read.');
    return { url: base + r.file, file: r.file, hash: r.hash, algo: 'sha256', version: r.version };
  }
  if (entry.resolver === 'fedora') {
    const r = pickFedora(JSON.parse(await fetchText('https://fedoraproject.org/releases.json')));
    if (!r) throw new Error('Fedora release list could not be read.');
    return { ...r, algo: 'sha256' };
  }
  if (entry.dir) {
    const sums = parseSums(await fetchText(`${entry.dir}SHA256SUMS`));
    const file = [...sums.keys()].filter((f) => entry.match.test(f)).sort().pop();
    if (!file) throw new Error(`No matching file in the checksum list of ${entry.label}.`);
    return { url: entry.dir + file, file, hash: sums.get(file), algo: entry.algo };
  }
  const file = entry.url.split('/').pop();
  const sums = parseSums(await fetchText(entry.sums));
  const hash = sums.get(file);
  if (!hash || hash.length !== lengthOf[entry.algo]) throw new Error(`Checksum for ${file} not found.`);
  return { url: entry.url, file, hash, algo: entry.algo };
}

function list() { return ENTRIES.map(({ match, ...e }) => ({ ...e, osType: e.osType || 'linux', arch: e.arch || 'x86_64' })); }
function get(id) { return ENTRIES.find((e) => e.id === id) || null; }

module.exports = { ENTRIES, list, get, resolve, parseSums, parseAlpineYaml, pickFedora };
