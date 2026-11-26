'use strict';
/*
 * Files and users inside a running VM – everything through the guest agent (no network share, no SSH): the commands
 * that list a folder, make one or delete something, and what they print. Only text in, text out; runtime.js runs them
 * (tests/package6.test.js).
 *
 *   listCommand(windows, dir)       → the command; prints the real path, then one line per entry: type⇥size⇥mtime⇥name
 *   parseListing(out, windows)      → { path, parent, entries: [{ name, type: 'dir'|'file'|'link', size, mtime }], truncated }
 *   mkdirCommand / deleteCommand    → commands for a new folder / for removing a file or folder
 *   usersCommand(windows)           → prints the users a person signs in with, one per line
 *   passwordArgs(user, password)    → arguments of the agent's guest-set-user-password
 */
const U = require('./util');

const MAX_ENTRIES = 1000;
const TAB = '\t';
/** One argument for /bin/sh, in single quotes. */
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
/** One string for PowerShell, in single quotes. */
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

function checkPath(p, { empty = false } = {}) {
  const s = String(p ?? '').trim();
  if (!s && empty) return '';
  if (!s || s.length > 1000 || /[\0\r\n]/.test(s)) throw U.fail(400, 'Path in the VM: 1 to 1000 characters, in one line.');
  return s;
}
function checkName(n, windows) {
  const s = String(n ?? '').trim();
  if (!s || s.length > 200 || s === '.' || s === '..' || /[\0\r\n\\/]/.test(s) || (windows && /[<>:"|?*]/.test(s))) throw U.fail(400, 'Name: 1 to 200 characters, without / and \\.');
  return s;
}

const isDriveRoot = (p) => /^[A-Za-z]:[\\/]*$/.test(p);
const trimSep = (p, windows) => (windows ? (isDriveRoot(p) ? `${p.slice(0, 2)}\\` : p.replace(/[\\/]+$/, '')) : p === '/' ? '/' : p.replace(/\/+$/, ''));
function joinPath(dir, name, windows) {
  const d = trimSep(String(dir), windows);
  return windows ? `${d}${d.endsWith('\\') ? '' : '\\'}${name}` : `${d === '/' ? '' : d}/${name}`;
}
/** The folder above – null at the top (Linux "/", Windows the list of drives ""). */
function parentOf(p, windows) {
  if (windows) {
    if (!p) return null;
    if (isDriveRoot(p)) return '';
    const d = trimSep(p, true); const i = Math.max(d.lastIndexOf('\\'), d.lastIndexOf('/'));
    return i <= 2 ? `${d.slice(0, 2)}\\` : d.slice(0, i);
  }
  const d = trimSep(p, false);
  if (d === '/') return null;
  const i = d.lastIndexOf('/');
  return i <= 0 ? '/' : d.slice(0, i);
}

function listCommand(windows, dir) {
  if (windows) {
    // no folder: the drives of the VM
    if (!dir) return "''; Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -match '^[A-Za-z]:' } | ForEach-Object { 'd' + [char]9 + '0' + [char]9 + '0' + [char]9 + $_.Root }";
    return `$ErrorActionPreference = 'Stop'; $p = (Resolve-Path -LiteralPath ${psq(dir)}).ProviderPath; $p; Get-ChildItem -LiteralPath $p -Force | Select-Object -First ${MAX_ENTRIES + 1} | ForEach-Object { $(if ($_.PSIsContainer) { 'd' } else { 'f' }) + [char]9 + [int64]$_.Length + [char]9 + [int64]($_.LastWriteTimeUtc - [datetime]'1970-01-01').TotalSeconds + [char]9 + $_.Name }`;
  }
  // stat -c works with GNU coreutils and BusyBox (Alpine); globs that match nothing stay as they are and stat skips them
  return `cd -- ${shq(dir || '/')} && pwd -P && { stat -c '%F${TAB}%s${TAB}%Y${TAB}%n' -- .[!.]* ..?* * 2>/dev/null | head -n ${MAX_ENTRIES + 1}; true; }`;
}

function parseListing(out, windows) {
  const lines = String(out || '').split(/\r?\n/);
  const real = (lines.shift() || '').trim();
  const p = windows ? real : real || '/';
  const entries = [];
  for (const line of lines) {
    if (!line) continue;
    const [kind, size, mtime, ...rest] = line.split(TAB);
    const name = rest.join(TAB);
    if (!name || name === '.' || name === '..') continue;
    const type = windows ? (kind === 'd' ? 'dir' : 'file') : /directory/.test(kind) ? 'dir' : /symbolic link/.test(kind) ? 'link' : 'file';
    entries.push({ name: windows && !p ? name.replace(/[\\/]+$/, '\\') : name, type, size: type === 'dir' ? null : Number(size) || 0, mtime: Number(mtime) > 0 ? Number(mtime) * 1000 : null });
  }
  const truncated = entries.length > MAX_ENTRIES;
  entries.length = Math.min(entries.length, MAX_ENTRIES);
  entries.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { path: p, parent: parentOf(p, windows), sep: windows ? '\\' : '/', entries, truncated };
}

function mkdirCommand(windows, dir, name) {
  const parent = checkPath(dir);
  const target = joinPath(parent, checkName(name, windows), windows);
  // Linux: the agent works as root – the new folder gets the owner of the folder it is made in (the user's own home
  // stays the user's; verified with Debian 12: without it folder and uploads belonged to root)
  return windows ? `$ErrorActionPreference = 'Stop'; New-Item -ItemType Directory -Path ${psq(target)} | Out-Null` : `mkdir -- ${shq(target)} && chown "$(stat -c %u:%g -- ${shq(parent)})" -- ${shq(target)}`;
}

/** Folders nobody deletes by a slip of the mouse – the system would be gone. */
const KEEP_LINUX = new Set(['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp', '/usr', '/var']);
const KEEP_WINDOWS = /^[A-Za-z]:\\(windows|users|program files|program files \(x86\)|programdata)$/i;
function deleteCommand(windows, target) {
  const p = trimSep(checkPath(target), windows);
  if (windows ? isDriveRoot(p) || KEEP_WINDOWS.test(p.replace(/\//g, '\\')) : !p.startsWith('/') || KEEP_LINUX.has(p)) throw U.fail(400, 'This folder belongs to the system of the VM – it is not deleted from here.');
  return windows ? `$ErrorActionPreference = 'Stop'; Remove-Item -LiteralPath ${psq(p)} -Recurse -Force` : `rm -rf -- ${shq(p)}`;
}

const USER_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.$ -]{0,63}$/;
function usersCommand(windows) {
  if (windows) return 'Get-LocalUser | Where-Object { $_.Enabled } | ForEach-Object { $_.Name }';
  // root and the accounts of people (from 1000), without service accounts that cannot sign in
  return "getent passwd | awk -F: '($3 == 0 || ($3 >= 1000 && $3 < 60000)) && $7 !~ /(nologin|false)$/ { print $1 }'";
}
function parseUsers(out) {
  return [...new Set(String(out || '').split(/\r?\n/).map((x) => x.trim()).filter((x) => USER_RE.test(x)))].slice(0, 200);
}

function passwordArgs(user, password) {
  const u = String(user ?? '').trim();
  if (!USER_RE.test(u)) throw U.fail(400, 'User: letters, digits, ".", "_" or "-", up to 64 characters.');
  const p = String(password ?? '');
  if (p.length < 1 || p.length > 128 || /[\0\r\n]/.test(p)) throw U.fail(400, 'Password: 1 to 128 characters, in one line.');
  return { username: u, password: Buffer.from(p, 'utf8').toString('base64'), crypted: false };
}

/** File name of an upload: only the name, nothing that leaves the folder. */
function safeName(name) {
  return String(name || 'file').split(/[\\/]/).pop().replace(/[^\w.\-()äöüÄÖÜß ]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
}

module.exports = { MAX_ENTRIES, shq, psq, checkPath, checkName, joinPath, parentOf, listCommand, parseListing, mkdirCommand, deleteCommand, usersCommand, parseUsers, passwordArgs, safeName };
