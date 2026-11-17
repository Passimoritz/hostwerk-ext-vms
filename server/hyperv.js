'use strict';
/*
 * Hyper-V VMs in the list (#21) – read-only listing through PowerShell's Hyper-V module (Get-VM), plus start, shut down,
 * turn off and checkpoint (Start-VM, Stop-VM, Checkpoint-VM) when the module is there. Windows Home has no Hyper-V: the
 * detection then quietly reports "not available" (no error, no prompt). Get-VM needs administrator rights or membership
 * in the group "Hyper-V Administrators" – without them Hostwerk says so instead of listing.
 *
 *   const hv = new HyperV({ run, platform })
 *   await hv.detect() → { available: false, reason: 'not-windows'|'no-module' } | { available: true, access: true|false, error }
 *   await hv.list()   → [{ id, name, state, cpus, memoryMb, generation, uptimeS, status, version, notes }]
 *   await hv.action(id, 'start'|'stop'|'turnoff'|'checkpoint', { name })
 */
const U = require('./util');

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKPOINT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/;
/** Hyper-V's VMState numbers (Microsoft.HyperV.PowerShell.VMState) → the states Hostwerk shows */
const STATES = { 1: 'other', 2: 'running', 3: 'stopped', 4: 'stopping', 6: 'saved', 9: 'paused', 10: 'starting', 11: 'starting', 32773: 'stopping', 32776: 'stopping', 32777: 'starting', 32779: 'stopping' };
const NAMED = { running: 'running', off: 'stopped', stopping: 'stopping', saved: 'saved', paused: 'paused', starting: 'starting', reset: 'starting', saving: 'stopping', pausing: 'stopping', resuming: 'starting', other: 'other', fastsaved: 'saved', fastsaving: 'stopping' };

function stateOf(v) {
  if (typeof v === 'number') return STATES[v] || 'other';
  const s = String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  return NAMED[s] || 'other';
}

/** PowerShell's ConvertTo-Json output of Get-VM (one object or a list, possibly empty) → plain list for the interface. */
function parseVms(json) {
  const text = String(json || '').replace(/^﻿/, '').trim();
  if (!text) return [];
  let list;
  try { list = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(list)) list = [list];
  return list.filter((v) => v && v.Name && GUID_RE.test(String(v.Id || v.VMId || ''))).map((v) => {
    const mem = Number(v.MemoryAssigned) || Number(v.MemoryStartup) || 0;
    const up = v.Uptime && typeof v.Uptime === 'object' ? Number(v.Uptime.TotalSeconds) || 0 : typeof v.Uptime === 'string' ? secondsOf(v.Uptime) : Number(v.Uptime) || 0;
    return {
      id: String(v.Id || v.VMId).toLowerCase(),
      name: String(v.Name).slice(0, 100),
      state: stateOf(v.State),
      cpus: Number(v.ProcessorCount) || null,
      memoryMb: mem ? Math.round(mem > 1e6 ? mem / 1048576 : mem) : null,
      generation: Number(v.Generation) || null,
      uptimeS: Math.round(up),
      status: v.Status ? String(v.Status).slice(0, 120) : null,
      version: v.Version ? String(v.Version) : null,
      notes: v.Notes ? String(v.Notes).slice(0, 300) : null,
      checkpoints: Number(v.Checkpoints) || 0,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
/** "01:02:03.45" or "1.02:03:04" (TimeSpan as text) → seconds */
function secondsOf(t) {
  const m = String(t).match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)/);
  return m ? (Number(m[1] || 0) * 86400) + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]) : 0;
}

/** The script that lists: first whether the module exists at all (quietly), then Get-VM – or why it failed. */
const LIST_PS = [
  '$ErrorActionPreference = "Stop"',
  'if (-not (Get-Module -ListAvailable -Name Hyper-V)) { "HWHV:NOMODULE"; exit 0 }',
  'try { Import-Module Hyper-V -ErrorAction Stop | Out-Null } catch { "HWHV:NOMODULE"; exit 0 }',
  'try {',
  '  $vms = @(Get-VM -ErrorAction Stop | Select-Object Name, @{n="Id";e={$_.Id.ToString()}}, @{n="State";e={$_.State.ToString()}}, ProcessorCount, MemoryAssigned, MemoryStartup, Generation, @{n="Uptime";e={[int]$_.Uptime.TotalSeconds}}, Status, Version, Notes, @{n="Checkpoints";e={@(Get-VMSnapshot -VM $_ -ErrorAction SilentlyContinue).Count}})',
  '  "HWHV:OK"; ConvertTo-Json -InputObject $vms -Compress -Depth 3',
  '} catch { "HWHV:DENIED"; $_.Exception.Message }',
].join('\n');

/** Output of LIST_PS → { available, access, vms, error } */
function parseListOutput(stdout) {
  const text = String(stdout || '').replace(/^﻿/, '');
  if (/HWHV:NOMODULE/.test(text)) return { available: false, reason: 'no-module', vms: [] };
  const ok = text.indexOf('HWHV:OK');
  if (ok >= 0) return { available: true, access: true, vms: parseVms(text.slice(ok + 7)) };
  const d = text.indexOf('HWHV:DENIED');
  if (d >= 0) {
    const msg = text.slice(d + 11).trim().split(/\r?\n/)[0] || '';
    return { available: true, access: false, vms: [], error: msg.slice(0, 300), admin: /permission|berechtigung|zugriff|access|administrator|authoriz/i.test(msg) };
  }
  return { available: false, reason: 'no-answer', vms: [] };
}

function actionScript(id, action, name) {
  if (!GUID_RE.test(String(id || ''))) throw U.fail(400, 'Invalid Hyper-V VM id.');
  const vm = `(Get-VM -Id '${String(id).toLowerCase()}' -ErrorAction Stop)`;
  if (action === 'start') return `Start-VM -VM ${vm} -ErrorAction Stop`;
  if (action === 'stop') return `Stop-VM -VM ${vm} -Force -ErrorAction Stop`; // -Force: no prompt; shuts down through the integration services
  if (action === 'turnoff') return `Stop-VM -VM ${vm} -TurnOff -Force -ErrorAction Stop`;
  if (action === 'checkpoint') {
    const n = String(name || '').trim();
    if (!CHECKPOINT_RE.test(n)) throw U.fail(400, 'Checkpoint name: letters, digits, space, "." "_" "-", up to 48 characters.');
    return `Checkpoint-VM -VM ${vm} -SnapshotName '${n}' -ErrorAction Stop`;
  }
  throw U.fail(400, 'Unknown action.');
}

class HyperV {
  constructor({ run = U.run, platform = process.platform, ttl = 10000 } = {}) {
    this.runFn = run; this.platform = platform; this.ttl = ttl;
    this.cache = null; // { at, result }
    this.missing = false; // module not there – asked once per Hostwerk start (or with fresh)
  }
  async ps(script, timeout = 30000) {
    return this.runFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout });
  }
  /** Everything at once (cached a few seconds): { available, access, vms, reason, error } */
  async state({ fresh = false } = {}) {
    if (this.platform !== 'win32') return { available: false, reason: 'not-windows', vms: [] };
    if (this.missing && !fresh) return { available: false, reason: 'no-module', vms: [] };
    if (!fresh && this.cache && Date.now() - this.cache.at < this.ttl) return this.cache.result;
    let result;
    try {
      const r = await this.ps(LIST_PS);
      result = parseListOutput(r.stdout);
    } catch { result = { available: false, reason: 'no-answer', vms: [] }; }
    this.missing = !result.available && result.reason === 'no-module';
    this.cache = { at: Date.now(), result };
    return result;
  }
  async detect(o) { const s = await this.state(o); const { vms, ...rest } = s; return { ...rest, count: (vms || []).length }; }
  async list(o) { return (await this.state(o)).vms || []; }
  async action(id, action, { name } = {}) {
    const st = await this.state();
    if (!st.available) throw U.fail(404, 'Hyper-V is not available on this PC.');
    const script = actionScript(id, action, name);
    const r = await this.ps(`$ErrorActionPreference = "Stop"; Import-Module Hyper-V; ${script}`, 120000);
    this.cache = null;
    if (r.code !== 0) {
      const msg = String(r.stderr || r.stdout || '').trim().split(/\r?\n/).filter((l) => l && !/^\s*(At line|In Zeile|\+|CategoryInfo|FullyQualifiedErrorId)/i.test(l))[0] || `code ${r.code}`;
      if (/permission|berechtigung|zugriff verweigert|access.*denied|authoriz|administrator/i.test(msg)) throw U.fail(403, 'Hyper-V needs administrator rights – start Hostwerk as administrator or join the group “Hyper-V Administrators”.');
      throw U.fail(500, 'Hyper-V: {error}', { error: msg.slice(0, 300) });
    }
    return { ok: true };
  }
}

module.exports = { HyperV, parseVms, parseListOutput, stateOf, actionScript, LIST_PS, GUID_RE };
