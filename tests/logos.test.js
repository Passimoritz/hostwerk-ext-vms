'use strict';
/* Logos of the systems (server/logos.js): candidates derived from what is known about a VM – no list to maintain. */
const test = require('node:test');
const assert = require('node:assert');
const L = require('../server/logos');
const { vmKind } = require('../server/kind');

// no project files in these tests: the file check never finds anything (a Windows path is "." on Linux = this repository)
const none = () => false;
const slugs = (vm, hint) => L.logoSources(vm, hint, none).map((s) => s.url.replace(`${L.ICONS}/`, '').replace(/\.svg$/, ''));

test('logos: system names become Simple Icons names, best guess first', () => {
  assert.equal(slugs({ osLabel: 'Debian 12 (Bookworm)' })[0], 'debian');
  assert.equal(slugs({ osLabel: 'Ubuntu Desktop 24.04 LTS' })[0], 'ubuntu');
  assert.ok(slugs({ osLabel: 'Kali Linux' }).includes('kalilinux'));
  assert.equal(slugs({ osLabel: 'Linux Mint 22' })[0], 'linuxmint'); // two words that belong together
  assert.ok(slugs(null, 'Mac OS X (64-bit)').includes('macos'));
  assert.ok(slugs({ cdrom: 'C:\\ISOs\\alpine-virt-3.24.4-x86_64.iso' }).includes('alpinelinux'));
  assert.equal(slugs({ cloud: { image: 'fedora-41' } })[0], 'fedora');
  // version numbers, architectures and filler words never become a name
  for (const s of slugs({ osLabel: 'Ubuntu Server 24.04 amd64 live ISO' })) assert.ok(!/\d|^(server|live|iso|amd)$/.test(s), s);
  assert.ok(slugs({ osLabel: 'Other system' }).every((s) => !['other', 'system'].includes(s)));
  assert.ok(L.logoCandidates('a b c d e f g h i j k l m n o p q r s').length <= 8);
});

test('logos: https only, coloured as a single-colour logo; Windows from microsoft.com', () => {
  const src = L.logoSources({ osLabel: 'Debian 12' });
  assert.ok(src.every((s) => /^https:\/\/cdn\.jsdelivr\.net\/npm\/simple-icons@v13\/icons\/[a-z]+\.svg$/.test(s.url) && s.color === true));
  assert.deepEqual(L.logoSources({ osType: 'windows', osLabel: 'Windows 11' }), [{ url: 'https://www.microsoft.com/windows' }]);
  assert.deepEqual(L.logoSources({ osLabel: '' }), []);
  assert.deepEqual(L.logoSources(null), []);
});

test('logos: an own system (self-built ISO) takes the logo of its project – before any Simple Icons guess', () => {
  const path = require('path');
  const proj = path.join(path.sep, 'p', 'my-os');
  const iso = path.join(proj, 'output', 'my-os-online-20261117.iso');
  const have = new Set([path.join(proj, 'assets', 'logo.svg')]);
  const src = L.logoSources({ osType: 'linux', cdrom: iso }, undefined, (f) => have.has(f));
  assert.deepEqual(src[0], { file: path.join(proj, 'assets', 'logo.svg') }); // build folder "output" → project above
  assert.ok(src.slice(1).every((s) => /^https:/.test(s.url)));
  assert.ok(!src.some((s) => /online/.test(s.url || '')), 'filler words of the file name are not tried');
  // a download folder is not a build folder: its parent is not searched, and only logo-like names count
  const dl = path.join(path.sep, 'u', 'Downloads', 'x.iso');
  assert.deepEqual(L.projectLogoFiles(dl, (f) => f === path.join(path.sep, 'u', 'logo.svg')), []);
  assert.deepEqual(L.projectLogoFiles(null), []);
});

test('logos: a self-built distribution – version folder below output, freedesktop icon deep in the project', () => {
  const path = require('path');
  const proj = path.join(path.sep, 'p', 'my-os');
  const iso = path.join(proj, 'output', 'v1.1.0-pre', 'my-os-20261118.iso');
  const apps = path.join(proj, 'system_files', 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps');
  const tree = {
    [proj]: [{ name: 'Justfile' }, { name: 'system_files', dir: true }, { name: 'installer', dir: true }, { name: 'node_modules', dir: true }, { name: 'output', dir: true }],
    [path.join(proj, 'system_files')]: [{ name: 'usr', dir: true }],
    [path.join(proj, 'system_files', 'usr')]: [{ name: 'share', dir: true }],
    [path.join(proj, 'system_files', 'usr', 'share')]: [{ name: 'icons', dir: true }],
    [path.join(proj, 'system_files', 'usr', 'share', 'icons')]: [{ name: 'hicolor', dir: true }],
    [path.join(proj, 'system_files', 'usr', 'share', 'icons', 'hicolor')]: [{ name: 'scalable', dir: true }],
    [path.join(proj, 'system_files', 'usr', 'share', 'icons', 'hicolor', 'scalable')]: [{ name: 'apps', dir: true }],
    [apps]: [{ name: 'my-control.svg' }, { name: 'my-logo.svg' }],
    [path.join(proj, 'installer')]: [{ name: 'webui-header-logo.png' }],
    [path.join(proj, 'node_modules')]: [{ name: 'logo.svg' }],
  };
  const exists = (f) => f === path.join(proj, 'Justfile');
  const readdir = (d) => tree[d] || [];
  const got = L.projectLogoFiles(iso, exists, readdir);
  assert.equal(got[0], path.join(apps, 'my-logo.svg')); // named after the project, SVG
  assert.ok(!got.some((f) => f.includes('node_modules')));
  assert.ok(got.indexOf(path.join(proj, 'installer', 'webui-header-logo.png')) > 0, 'a header picture only after it');
  // a folder with a README but no build folder below (Downloads) is never searched
  const dl = path.join(path.sep, 'u', 'Downloads');
  assert.deepEqual(L.projectLogoFiles(path.join(dl, 'x.iso'), (f) => f === path.join(dl, 'README.md'), () => [{ name: 'logo-of-something.svg' }]), []);
});

test('logos: the service kind "vm" hands them to Hostwerk (QEMU VMs by id, VirtualBox by hint)', () => {
  const vms = { web: { id: 'web', osLabel: 'Ubuntu 24.04 LTS' } };
  const k = vmKind({ get: (id) => { if (!vms[id]) throw new Error('unknown'); return vms[id]; } });
  assert.equal(typeof k.iconSources, 'function');
  assert.match(k.iconSources('web')[0].url, /\/ubuntu\.svg$/);
  assert.match(k.iconSources('vbox-0c4f5e2a-7b1d-4e3a-9c2f-1a2b3c4d5e6f', 'Debian (64-bit)')[0].url, /\/debian\.svg$/);
  assert.deepEqual(k.iconSources('gone'), []);
});
