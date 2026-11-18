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
 * the ISO/disk and – going up through build and version folders (output, build, dist, v1.1.0-pre, 20261118 …) – in the
 * project folder above. Only logo-like names, so a random picture in a download folder is never taken. In a real
 * project folder (a git repository, or README/Justfile … above the build folder) also deeper, e.g. the freedesktop icon of a Linux distribution
 * (system_files/usr/share/icons/hicolor/scalable/apps/<name>-logo.svg): a bounded search for "*logo*.svg|png",
 * the one named after the project first.
 */
const fs = require('fs');
const LOGO_FILES = ['logo.svg', 'logo.png', 'icon.svg', 'icon.png', 'favicon.svg', 'favicon.png', 'favicon.ico',
  'assets/logo.svg', 'assets/logo.png', 'branding/logo.svg', 'branding/logo.png', 'docs/logo.svg', 'docs/logo.png', 'images/logo.svg', 'images/logo.png'];
const BUILD_DIRS = /^(output|out|build|builds|dist|release|releases|iso|isos|images|artifacts|target)$/i;
const VERSION_DIR = /^v?\d+([._-]\d+)*([._-][a-z0-9]+)*$/i; // v1.1.0-pre, 1.2, 20261118
const MARKERS = ['.git', 'README.md', 'readme.md', 'package.json', 'Justfile', 'justfile', 'Makefile', 'Containerfile', 'Dockerfile', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'CMakeLists.txt', 'flake.nix'];
const SKIP_DIRS = /^(node_modules|vendor|venv|__pycache__|output|out|build|builds|dist|target|releases?|artifacts|isos?|tmp|temp)$/i;
const SCAN = { depth: 8, dirs: 3000 };

function realReaddir(d) {
  try { return fs.readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() })); } catch { return []; }
}

/** Bounded search for logo pictures in a project folder; best first. readdir(d) → [{ name, dir }] */
function scanLogos(root, readdir = realReaddir) {
  const slug = (path.basename(root).toLowerCase().match(/[a-z0-9]+/) || [''])[0];
  const found = [];
  const queue = [[root, 0]];
  let seen = 0;
  while (queue.length && seen < SCAN.dirs) {
    const [d, depth] = queue.shift(); seen++;
    for (const e of readdir(d)) {
      if (e.dir) { if (depth < SCAN.depth && !SKIP_DIRS.test(e.name) && !e.name.startsWith('.')) queue.push([path.join(d, e.name), depth + 1]); continue; }
      const m = /^(.*logo.*)\.(svg|png)$/i.exec(e.name);
      if (!m) continue;
      const base = m[1].toLowerCase();
      let score = m[2].toLowerCase() === 'svg' ? 3 : 0;
      if (base === 'logo' || (slug && [`${slug}-logo`, `${slug}_logo`, `${slug}logo`, `logo-${slug}`].includes(base))) score += 4;
      else if (slug && base.includes(slug)) score += 2;
      if (/header|banner|dark|white|black|mono|text|word|small|tiny|symbolic/.test(base)) score -= 3;
      if (/(^|[\/])(256x256|512x512)([\/]|$)/.test(d)) score += 1;
      found.push({ f: path.join(d, e.name), score, depth });
    }
  }
  return found.sort((a, b) => b.score - a.score || a.depth - b.depth).slice(0, 3).map((x) => x.f);
}

/** exists/readdir only for tests – a fake exists without readdir never searches deeper. */
function projectLogoFiles(file, exists = fs.existsSync, readdir = exists === fs.existsSync ? realReaddir : () => []) {
  if (!file) return [];
  const dirs = [path.dirname(String(file))];
  const last = () => dirs[dirs.length - 1];
  for (let i = 0; i < 3 && (BUILD_DIRS.test(path.basename(last())) || VERSION_DIR.test(path.basename(last()))); i++) {
    const up = path.dirname(last());
    if (up === last()) break;
    dirs.push(up);
  }
  const out = [];
  for (const d of dirs) for (const n of LOGO_FILES) { const f = path.join(d, n); if (exists(f) && !out.includes(f)) out.push(f); }
  // deeper only in a real project folder: above a build folder (output/…) with a README, Justfile …, or a git repository –
  // never in Downloads or a whole drive
  const root = last();
  const project = exists(path.join(root, '.git')) || (dirs.length > 1 && MARKERS.some((n) => exists(path.join(root, n))));
  if (project) for (const f of scanLogos(root, readdir)) if (!out.includes(f)) out.push(f);
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

module.exports = { logoCandidates, logoSources, projectLogoFiles, scanLogos, systemText, ICONS };
