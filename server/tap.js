'use strict';
/*
 * Network bridge (#14): the VM as its own device in the home network. On Windows QEMU needs a TAP adapter for that
 * (the OpenVPN "TAP-Windows6" driver, component id tap0901) – installing it needs administrator rights, so Hostwerk
 * never installs anything: it only looks (read-only, Get-NetAdapter) whether such an adapter exists and, when the
 * person picks one, starts QEMU with `-netdev tap,ifname=<adapter>`. Bridging the TAP adapter with the real network
 * card (Network Connections → select both → "Bridge Connections") is also done by the person, once, as administrator.
 */
const U = require('./util');

const TAP_NAME_RE = /^[^\u0000-\u001f"<>|*?]{1,64}$/;

/** PowerShell's JSON (one object or a list) → [{ name, description, status, mac }] of TAP adapters only. */
function parseAdapters(json) {
  let list;
  try { list = JSON.parse(String(json || '').trim() || '[]'); } catch { return []; }
  if (!Array.isArray(list)) list = [list];
  return list.filter((a) => a && a.Name && (/^(root\\)?tap0[89]0\d$/i.test(String(a.ComponentID || '')) || /TAP-Win(dows|32)/i.test(String(a.InterfaceDescription || ''))))
    .map((a) => ({ name: String(a.Name), description: String(a.InterfaceDescription || ''), status: String(a.Status || ''), mac: String(a.MacAddress || '').replace(/-/g, ':').toLowerCase() || null }));
}

/** TAP adapters on this PC (Windows only; elsewhere an empty list – Linux/macOS bridges are set up differently). */
async function listTaps({ run = U.run, platform = process.platform } = {}) {
  if (platform !== 'win32') return [];
  const ps = 'Get-NetAdapter -IncludeHidden | Select-Object Name, InterfaceDescription, Status, MacAddress, ComponentID | ConvertTo-Json -Compress';
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20000 });
  if (r.code !== 0) return [];
  return parseAdapters(r.stdout);
}

function checkTapName(name) {
  const n = String(name || '').trim();
  if (!TAP_NAME_RE.test(n)) throw U.fail(400, 'Choose a TAP adapter for the network bridge.');
  return n;
}

module.exports = { listTaps, parseAdapters, checkTapName };
