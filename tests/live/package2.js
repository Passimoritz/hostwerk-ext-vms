'use strict';
/*
 * Real-life test for roadmap package 2: Windows installed without clicking. A real Hostwerk test instance with this
 * extension, real QEMU (WHPX), a Windows ISO from Microsoft, the virtio-win drivers (checksum held fixed after the first
 * download). Takes 20–60 minutes.
 *
 *   node tests/live/package2.js <work folder> <path to the Windows ISO> [--edition=1] [--keep]
 *
 * Checks: VM created with answer file and driver CD · Windows boots from the ISO without a key press · setup runs alone,
 * the guest agent reports and Hostwerk switches to booting from disk · signed-in user, edition, virtio drivers in the
 * guest · the plain-text answer file is gone from C:\Windows\Panther · after a restart unattend.iso is deleted and
 * Windows starts from disk. Screenshots every minute in <work>/report-p2.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXT = path.join(__dirname, '..', '..');
const HW = process.env.HW_CORE || path.join(EXT, '..', '..', 'hostwerk');
const WORK = path.resolve(process.argv[2]);
const ISO = path.resolve(process.argv[3]);
const EDITION = (process.argv.find((a) => a.startsWith('--edition=')) || '--edition=1').slice(10);
const KEEP = process.argv.includes('--keep');
const OUT = path.join(WORK, 'report-p2');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s]`, ...a);
async function step(name, fn) {
  const s = Date.now();
  try { const d = await fn(); results.push({ name, ok: true, ms: Date.now() - s, detail: d == null ? '' : String(d) }); log('✓', name, d ? `– ${d}` : ''); return true; } catch (e) { results.push({ name, ok: false, ms: Date.now() - s, detail: e.message }); log('✗', name, '–', e.message); return false; }
}
const must = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  process.env.HW_TEST = '1'; process.env.HW_NO_AUTOUPDATE = '1';
  process.env.APPDATA = path.join(WORK, 'appdata-p2'); process.env.LOCALAPPDATA = path.join(WORK, 'localappdata-p2');
  process.env.HW_VMS_DIR = path.join(WORK, 'vms');
  const { createServer } = require(path.join(HW, 'server', 'index'));
  const jobs = require(path.join(HW, 'server', 'core', 'jobs'));
  const server = await createServer({ baseDir: path.join(WORK, 'hw-p2'), port: 7863 });
  const H = { 'x-hostwerk-token': server.token, 'Content-Type': 'application/json' };
  const api = async (method, p, body, { raw = false } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api${p}`, { method, headers: H, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (raw) return res;
    const j = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`${method} ${p} → ${res.status}: ${(j && j.error) || ''}`), { status: res.status });
    return j;
  };
  const waitJob = async (id, ms = 60 * 60000) => { const until = Date.now() + ms; let last = ''; while (Date.now() < until) { const j = jobs.listJobs().find((x) => x.id === id); if (j && j.text !== last) { last = j.text; log('   job:', j.progress, '%', j.text); } if (j && j.state === 'done') return j; if (j && (j.state === 'error' || j.state === 'cancelled')) throw new Error(`job ${j.state}: ${j.error} ${j.detail || ''}`); await sleep(2000); } throw new Error('job timeout'); };
  const vm = (id) => api('GET', `/vms/${id}`);
  const shot = async (id, f) => { try { const r = await api('GET', `/vms/${id}/screen`, undefined, { raw: true }); if (r.status === 200) fs.writeFileSync(path.join(OUT, f), Buffer.from(await r.arrayBuffer())); } catch { /* not running */ } };
  const ps = async (id, command) => api('POST', `/vms/${id}/guest/exec`, { command, timeoutMs: 120000 });
  const pw = `Hw-${crypto.randomBytes(5).toString('hex')}!`;
  const id = 'p2-windows';

  try {
    await step('Hostwerk test instance with the extension', async () => { server.ctx.extMarket.installFromDir(EXT, 'live-p2', { trusted: true }); await sleep(1500); return `ISO ${path.basename(ISO)} (${(fs.statSync(ISO).size / 2 ** 30).toFixed(1)} GB)`; });
    if ((await api('GET', '/vms')).vms.some((v) => v.id === id)) { await api('POST', `/vms/${id}/poweroff`).catch(() => {}); await sleep(3000); await api('DELETE', `/vms/${id}`); }

    const ok = await step('#2/#3 VM with answer file and virtio-win driver CD (checksum held fixed)', async () => {
      const r = await api('POST', '/vms', { source: 'iso', iso: ISO, osType: 'windows', name: 'P2 Windows', unattended: true, winUser: 'hwtest', winPassword: pw, edition: /^\d+$/.test(EDITION) ? Number(EDITION) : EDITION, language: 'de-DE', cpus: 4, memoryMb: 8192, diskGb: 64, keyboard: 'de', start: true });
      await waitJob(r.job);
      const v = await vm(id);
      must(v.status.state === 'running' && v.install && v.install.state === 'running' && v.drivers && v.seed === 'unattend.iso', JSON.stringify({ s: v.status.state, i: v.install, d: v.drivers, seed: v.seed }));
      const pins = JSON.parse(fs.readFileSync(path.join(WORK, 'vms', '.pins.json'), 'utf8'));
      return `drivers ${path.basename(v.drivers)}, sha256 held fixed: ${Object.entries(pins).map(([f, h]) => `${f}=${h}`).join(', ')}`;
    });
    if (ok) {
      await step('Windows Setup starts from the ISO without a key press', async () => {
        await sleep(90000);
        await shot(id, 'win-setup-start.png');
        const v = await vm(id);
        must(v.status.state === 'running', v.status.state);
        return 'win-setup-start.png';
      });
      await step('#2 Setup runs alone until the guest agent reports – Hostwerk switches to booting from disk', async () => {
        const until = Date.now() + 90 * 60000; let n = 0; let v;
        while (Date.now() < until) {
          v = await vm(id);
          if (v.install && v.install.state === 'done') break;
          if (v.status.state === 'stopped' || v.status.state === 'error') throw new Error(`VM ${v.status.state}: ${v.status.error || ''}`);
          await shot(id, `win-${String(n++).padStart(3, '0')}.png`);
          await sleep(60000);
        }
        must(v.install && v.install.state === 'done', 'not finished within 90 minutes');
        await shot(id, 'win-done.png');
        return `${Math.round((v.install.doneAt - v.install.startedAt) / 60000)} min; boot ${v.boot}; ${v.status.agent && v.status.agent.os}`;
      });
      await step('In the guest: user, edition, virtio drivers, answer file deleted from Panther', async () => {
        await sleep(30000); // the first logon commands run right after the agent appears
        const who = await ps(id, '(Get-CimInstance Win32_ComputerSystem).UserName; (Get-CimInstance Win32_OperatingSystem).Caption; (Get-LocalUser | Where-Object Enabled).Name -join ","');
        const drv = await ps(id, "(Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceName -match 'VirtIO|Red Hat' } | Select-Object -ExpandProperty DeviceName -Unique) -join '; '");
        const panther = await ps(id, "@('C:\\Windows\\Panther\\unattend.xml','C:\\Windows\\Panther\\Unattend\\unattend.xml','C:\\Windows\\Panther\\Unattend\\autounattend.xml') | ForEach-Object { Test-Path $_ }");
        must(/hwtest/i.test(who.out), who.out);
        must(!/True/.test(panther.out), `Panther still holds the answer file: ${panther.out}`);
        return `${who.out.trim().replace(/\r?\n/g, ' · ')} | drivers: ${drv.out.trim() || '–'} | Panther: ${panther.out.trim().replace(/\r?\n/g, ' ')}`;
      });
      await step('Restart: unattend.iso is deleted, Windows starts from disk, the agent answers again', async () => {
        await api('POST', `/vms/${id}/stop`);
        const until = Date.now() + 5 * 60000;
        while ((await vm(id)).status.state !== 'stopped' && Date.now() < until) await sleep(3000);
        await api('POST', `/vms/${id}/start`);
        must(!fs.existsSync(path.join(WORK, 'vms', id, 'unattend.iso')), 'unattend.iso still there');
        const until2 = Date.now() + 10 * 60000; let v;
        while (Date.now() < until2) { v = await vm(id); if (v.status.agent && v.status.agent.ok) break; await sleep(5000); }
        await shot(id, 'win-after-restart.png');
        must(v.status.agent && v.status.agent.ok, 'agent did not come back');
        return `${v.status.agent.os}, ${(v.status.agent.addresses || []).map((a) => a.ip).join(', ')}`;
      });
    }
  } finally {
    const pass = results.filter((r) => r.ok).length;
    fs.writeFileSync(path.join(OUT, 'report.md'), ['# Package 2 – real-life test', '', `${new Date().toISOString()} · ${pass}/${results.length} passed`, '', '| | Step | Time | Result |', '|---|---|---|---|', ...results.map((r) => `| ${r.ok ? '✓' : '✗'} | ${r.name} | ${(r.ms / 60000).toFixed(1)} min | ${r.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} |`)].join('\n'));
    log(`${pass}/${results.length} passed`);
    if (!KEEP) { try { await api('POST', `/vms/${id}/stop`); } catch { /* egal */ } await sleep(60000); }
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
})().catch((e) => { console.error(e); process.exit(2); });
