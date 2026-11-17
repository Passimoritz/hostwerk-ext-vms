'use strict';
/*
 * Logos of the systems in the VMs – without a list to maintain. Hostwerk's icon service (services/icons.js) asks the
 * service kind "vm" for image sources (iconSources), tries them in order, keeps the first image that loads under
 * data/icons and lets the user replace it like any other service picture.
 *
 * The candidates come from the words of what we know about the VM (system label, cloud image, ISO file name,
 * VirtualBox OS type): Simple Icons names its logos after the product – "debian", "ubuntu", "fedora" – and the Linux
 * distributions often with "linux" appended ("alpinelinux", "kalilinux", "rockylinux"); two words also run together
 * ("Linux Mint" → "linuxmint", "Mac OS X" → "macos"). Unknown names simply give no image (a 404 is the next try).
 * Windows is not in Simple Icons (Microsoft had it removed) – there the icon of microsoft.com is taken.
 */
const path = require('path');

const ICONS = 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons';
/** Words that never name a product on their own. */
const STOP = new Set(['linux', 'gnu', 'server', 'desktop', 'cloud', 'generic', 'genericcloud', 'nocloud', 'amd', 'arm', 'aarch', 'live', 'iso', 'img',
  'virt', 'netinst', 'online', 'offline', 'minimal', 'standard', 'dvd', 'bit', 'lts', 'edition', 'release', 'install', 'installer', 'image', 'disk', 'test', 'new', 'other',
  'the', 'and', 'for', 'with', 'mit', 'und', 'bios', 'uefi', 'efi', 'qemu', 'kvm', 'qcow', 'vdi', 'vmdk', 'vhd', 'vhdx', 'raw', 'ova', 'ovf', 'copy', 'clone', 'system', 'machine']);
const MAX = 8;

/** Simple Icons names for a text, best guess first. "Ubuntu Desktop 24.04" → ["ubuntu", "ubuntulinux", …] */
function logoCandidates(text) {
  const raw = String(text || '').toLowerCase().replace(/\([^)]*\)/g, ' ').split(/[^a-z]+/).filter((w) => w.length >= 2);
  const out = [];
  const add = (s) => { if (s && s.length >= 3 && !out.includes(s)) out.push(s); };
  raw.forEach((w, i) => {
    const next = raw[i + 1];
    if (!STOP.has(w) && w.length >= 3) { add(w); add(`${w}linux`); }
    if (next && !STOP.has(next)) add(`${w}${next}`); // two words that belong together ("linux mint", "mac os") – never "… desktop"
  });
  return out.slice(0, MAX);
}

/** Everything we know about a VM's system as one text. */
function systemText(vm) {
  if (!vm) return '';
  return [vm.osLabel, vm.cloud && vm.cloud.image, vm.cdrom ? path.basename(String(vm.cdrom)) : null, vm.importedFrom && vm.importedFrom.osType, vm.osType === 'windows' ? 'windows' : null].filter(Boolean).join(' ');
}

/*
 * Own systems (a self-built OS, a company image): the logo lives in the project that built the ISO. Looked for next to
 * the ISO/disk and – when that is a build folder (output, build, dist …) – in the project folder above it. Only
 * logo-like names, so a random picture in a download folder is never taken.
 */
const LOGO_FILES = ['logo.svg', 'logo.png', 'icon.svg', 'icon.png', 'favicon.svg', 'favicon.png', 'favicon.ico',
  'assets/logo.svg', 'assets/logo.png', 'branding/logo.svg', 'branding/logo.png', 'docs/logo.svg', 'docs/logo.png', 'images/logo.svg', 'images/logo.png'];
const BUILD_DIRS = /^(output|out|build|builds|dist|release|releases|iso|isos|images|artifacts|target)$/i;
function projectLogoFiles(file, exists = require('fs').existsSync) {
  if (!file) return [];
  const dir = path.dirname(String(file));
  const dirs = [dir];
  if (BUILD_DIRS.test(path.basename(dir))) dirs.push(path.dirname(dir));
  const out = [];
  for (const d of dirs) for (const n of LOGO_FILES) { const f = path.join(d, n); if (exists(f)) out.push(f); }
  return out;
}

/**
 * Image sources for Hostwerk's icon service: [{ file }] (logo of the own project) first, then [{ url, color }]
 * (https only). hint: text from the page (e.g. a VirtualBox OS type).
 */
function logoSources(vm, hint, exists) {
  const own = vm ? projectLogoFiles(vm.cdrom, exists).map((file) => ({ file })) : [];
  const text = `${systemText(vm)} ${hint || ''}`.trim();
  if (!text) return own;
  if (/\bwin(dows)?\b|windows/i.test(text) && !/\b(wine|winamp)\b/i.test(text)) return [...own, { url: 'https://www.microsoft.com/windows' }];
  return [...own, ...logoCandidates(text).map((slug) => ({ url: `${ICONS}/${slug}.svg`, color: true }))];
}

module.exports = { logoCandidates, logoSources, projectLogoFiles, systemText, ICONS };
