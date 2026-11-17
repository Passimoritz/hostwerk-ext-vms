'use strict';
/*
 * cloud-init NoCloud seed for ready-made Linux VMs: user (with sudo), password and/or SSH keys, host name, time zone,
 * guest agent. Every value is written as a JSON string – JSON is valid YAML, so no value can break the file
 * (tests/cloudinit.test.js).
 *
 *   seedFiles({ hostname, user, password, sshKeys, timezone, packages, instanceId, app, startCommands, startScript })
 *     → { 'meta-data', 'user-data' }
 *
 * App templates and own start scripts (#9, server/apps.js): the app's packages join the package list, its setup script
 * and the person's bash script are written base64 with write_files and run once in runcmd (after the packages are
 * installed); own commands become one runcmd entry each – ["sh", "-c", <command>] as an escaped YAML string.
 */
const crypto = require('crypto');
const { fail } = require('./util');
const A = require('./apps');

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const KEY_RE = /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]{20,}( [^\r\n]{0,200})?$/;
const TZ_RE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/;
const PKG_RE = /^[a-z0-9][a-z0-9.+-]{0,63}$/;
const RESERVED_USERS = new Set(['root', 'daemon', 'bin', 'sys', 'nobody', 'admin']);

const q = (v) => JSON.stringify(String(v));

function hostnameFrom(name) {
  const h = String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '');
  return h || 'vm';
}

function cleanSeed(o) {
  const hostname = hostnameFrom(o.hostname);
  if (!HOST_RE.test(hostname)) throw fail(400, 'Host name: letters, digits and "-".');
  const user = String(o.user || '').trim();
  if (!USER_RE.test(user) || RESERVED_USERS.has(user)) throw fail(400, 'User name: lowercase letters, digits, "_" or "-", starting with a letter – not root or admin.');
  const password = o.password == null ? '' : String(o.password);
  if (password && (password.length < 6 || password.length > 128 || /[\r\n]/.test(password))) throw fail(400, 'Password: 6 to 128 characters.');
  const sshKeys = (Array.isArray(o.sshKeys) ? o.sshKeys : String(o.sshKeys || '').split(/\r?\n/)).map((k) => String(k).trim()).filter(Boolean);
  for (const k of sshKeys) if (!KEY_RE.test(k)) throw fail(400, 'This does not look like a public SSH key (ssh-ed25519 …, ssh-rsa …).');
  if (!password && !sshKeys.length) throw fail(400, 'Set a password or an SSH key – otherwise nobody can sign in.');
  const timezone = o.timezone && TZ_RE.test(o.timezone) ? o.timezone : null;
  const app = o.app ? A.get(String(o.app)) : null;
  if (o.app && !app) throw fail(400, 'Unknown app template.');
  const start = A.cleanStartScript({ commands: o.startCommands, script: o.startScript });
  const packages = [...new Set(['qemu-guest-agent', ...(Array.isArray(o.packages) ? o.packages : []), ...(app ? app.packages : [])])].map(String);
  for (const p of packages) if (!PKG_RE.test(p)) throw fail(400, 'Invalid package name: {name}', { name: p });
  return { hostname, user, password, sshKeys: sshKeys.slice(0, 20), timezone, keyboard: o.keyboard === 'de' ? 'de' : null, packages: packages.slice(0, 40), instanceId: o.instanceId || `hw-${crypto.randomBytes(6).toString('hex')}`, app, startCommands: start.commands, startScript: start.script };
}

function seedFiles(input) {
  const s = cleanSeed(input || {});
  const meta = `instance-id: ${q(s.instanceId)}\nlocal-hostname: ${q(s.hostname)}\n`;
  const L = ['#cloud-config', `hostname: ${q(s.hostname)}`, 'manage_etc_hosts: true', 'users:', `  - name: ${q(s.user)}`,
    '    sudo: "ALL=(ALL) NOPASSWD:ALL"', '    shell: "/bin/bash"', `    lock_passwd: ${s.password ? 'false' : 'true'}`];
  if (s.sshKeys.length) { L.push('    ssh_authorized_keys:'); for (const k of s.sshKeys) L.push(`      - ${q(k)}`); }
  if (s.password) {
    L.push('chpasswd:', '  expire: false', '  users:', `    - name: ${q(s.user)}`, `      password: ${q(s.password)}`, '      type: "text"');
    L.push('ssh_pwauth: true');
  } else L.push('ssh_pwauth: false');
  if (s.timezone) L.push(`timezone: ${q(s.timezone)}`);
  // German keyboard – not with cloud-init's "keyboard" module: it fails on Debian's cloud image (no keymaps installed)
  // and marks the whole cloud-init run as failed. Instead: the Debian/Ubuntu settings file, console-setup for the text
  // console, localectl elsewhere – each step may fail on its own (see runcmd below).
  const files = [];
  // App template and own script (#9): base64 (any character survives), only root may read and run them
  const b64 = (p, text) => files.push(`  - path: ${q(p)}`, '    encoding: "b64"', `    content: ${q(Buffer.from(text, 'utf8').toString('base64'))}`, '    owner: "root:root"', '    permissions: "0700"');
  if (s.app) b64(`${A.STATE_DIR}/app.sh`, A.appScript(s.app, s.user));
  if (s.startScript) b64(`${A.STATE_DIR}/start-script.sh`, s.startScript);
  if (s.keyboard === 'de') files.push('  - path: "/etc/default/keyboard"', '    content: "XKBMODEL=\\"pc105\\"\\nXKBLAYOUT=\\"de\\"\\nXKBVARIANT=\\"\\"\\nXKBOPTIONS=\\"\\"\\nBACKSPACE=\\"guess\\"\\n"');
  if (files.length) L.push('write_files:', ...files);
  L.push('growpart:', '  mode: "auto"', '  devices: ["/"]', 'resize_rootfs: true');
  L.push('packages:'); for (const p of s.packages) L.push(`  - ${q(p)}`);
  // The agent is started right away – Hostwerk then sees IP addresses, can shut down cleanly and freeze for snapshots
  L.push('runcmd:', '  - ["systemctl", "enable", "--now", "qemu-guest-agent"]');
  if (s.keyboard === 'de') {
    L.push('  - ["sh", "-c", "if [ -f /etc/debian_version ]; then DEBIAN_FRONTEND=noninteractive apt-get install -y -q console-setup kbd >/dev/null 2>&1; setupcon --force --save >/dev/null 2>&1; fi; true"]');
    L.push('  - ["sh", "-c", "command -v localectl >/dev/null && { localectl set-keymap de >/dev/null 2>&1; localectl set-x11-keymap de pc105 >/dev/null 2>&1; }; true"]');
  }
  // App setup, then own commands, then own script – each logs and leaves a marker Hostwerk reads through the agent
  const d = A.STATE_DIR;
  if (s.app) L.push(`  - ["sh", "-c", ${q(`bash ${d}/app.sh >>/var/log/hostwerk-app.log 2>&1 && touch ${d}/app-ready || touch ${d}/app-failed`)}]`);
  for (const c of s.startCommands) L.push(`  - ["sh", "-c", ${A.yq(c)}]`);
  if (s.startScript) L.push(`  - ["sh", "-c", ${q(`${d}/start-script.sh >>/var/log/hostwerk-start-script.log 2>&1 && touch ${d}/start-script-done || touch ${d}/start-script-failed`)}]`);
  L.push('final_message: "Hostwerk: cloud-init finished after $UPTIME seconds"');
  const out = { 'meta-data': meta, 'user-data': `${L.join('\n')}\n` };
  const net = networkConfig(input && input.network);
  if (net) out['network-config'] = net;
  return out;
}

/**
 * Static addresses in internal networks (#7) for new ready-made Linux VMs: cloud-init network config v2. As soon as a
 * network config exists cloud-init configures only what is in it – so the normal NIC (DHCP from QEMU's NAT) is listed
 * too. NICs are found by their MAC and get fixed names (hwnat, hwin0, hwin1).
 *   network: { mac: '<MAC of the NAT NIC>' | null, internal: [{ mac, ip: '10.10.1.5/24' }] }
 */
function networkConfig(n) {
  const list = (n && Array.isArray(n.internal) ? n.internal : []).filter((x) => x && x.ip);
  if (!list.length) return null;
  const mac = (m) => { if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(String(m))) throw fail(400, 'Invalid MAC address.'); return q(m); };
  const L = ['version: 2', 'ethernets:'];
  if (n.mac) L.push('  hwnat:', `    match: { macaddress: ${mac(n.mac)} }`, '    set-name: "hwnat"', '    dhcp4: true');
  list.forEach((x, i) => L.push(`  hwin${i}:`, `    match: { macaddress: ${mac(x.mac)} }`, `    set-name: "hwin${i}"`, `    addresses: [${q(x.ip)}]`));
  return `${L.join('\n')}\n`;
}

module.exports = { seedFiles, cleanSeed, hostnameFrom, networkConfig, KEY_RE };
