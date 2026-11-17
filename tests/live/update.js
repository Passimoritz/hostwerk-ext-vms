'use strict';
/*
 * Real-life test of 1.0.3 through a real Hostwerk (port 7871): an update of the extension does not stop running VMs.
 *  1. A Debian VM runs (QEMU, guest agent).
 *  2. The extension is installed again over itself while the VM runs – exactly what Hostwerk does for an update
 *     (the old instance is switched off, the new one started).
 *  3. Same QEMU process, the guest did not restart (uptime goes on), agent, screen, commands in the VM and VNC work.
 *  4. Hostwerk quits (its real close sequence): the VM is shut down cleanly by Hostwerk, not left running.
 *
 *   node tests/live/update.js <work folder with vms/> [vm id, default live-debian]
 */
const fs = require('fs');
const path = require('path');
const net = require('net');

const EXT = path.join(__dirname, '..', '..');
const HW = process.env.HW_CORE || path.join(EXT, '..', '..', 'hostwerk');
const WORK = path.resolve(process.argv[2]);
const VM = process.argv[3] || 'live-debian';
const OUT = path.join(WORK, 'report-update');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
async function step(name, fn) {
  const s = Date.now();
  try { const d = await fn(); results.push({ name, ok: true, ms: Date.now() - s, detail: d == null ? '' : String(d) }); log('✓', name, d ? `– ${d}` : ''); return true; } catch (e) { results.push({ name, ok: false, ms: Date.now() - s, detail: e.message }); log('✗', name, '–', e.message); return false; }
}
const must = (c, m) => { if (!c) throw new Error(m); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

(async () => {
  process.env.HW_TEST = '1'; process.env.HW_NO_AUTOUPDATE = '1';
  process.env.APPDATA = path.join(WORK, 'appdata-upd'); process.env.LOCALAPPDATA = path.join(WORK, 'localappdata-upd');
  process.env.HW_VMS_DIR = path.join(WORK, 'vms');
  const { createServer } = require(path.join(HW, 'server', 'index'));
  const server = await createServer({ baseDir: path.join(WORK, 'hw-upd'), port: 7871 });
  const H = { 'x-hostwerk-token': server.token, 'Content-Type': 'application/json' };
  const raw = (method, p, body) => fetch(`http://127.0.0.1:${server.port}/api${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const api = async (method, p, body) => {
    const res = await raw(method, p, body);
    const j = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`${method} ${p} → ${res.status}: ${(j && j.error) || ''}`), { status: res.status });
    return j;
  };
  const vm = () => api('GET', `/vms/${VM}`);
  const exec = (command, timeoutMs = 30000) => api('POST', `/vms/${VM}/guest/exec`, { command, timeoutMs });
  const waitFor = async (what, fn, ms, every = 2000) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(every); } throw new Error(`${what}: timeout (${typeof last === 'string' ? last : 'no answer'})`); };
  const uptime = async () => parseFloat((await exec('cut -d" " -f1 /proc/uptime')).out);
  let pid = null; let ports = null; let quitDone = false;

  try {
    await step('Hostwerk test instance with the extension (port 7871)', async () => { const e = server.ctx.extMarket.installFromDir(EXT, 'live-upd', { trusted: true }); await sleep(1500); return `${e.dir} · ${require(path.join(EXT, 'manifest.json')).version}`; });

    const up = await step(`VM “${VM}” runs, guest agent answers`, async () => {
      const v0 = await vm();
      if (v0.status.state !== 'running') await api('POST', `/vms/${VM}/start`);
      const v = await waitFor('agent', async () => { const x = await vm(); return x.status.state === 'running' && x.status.agent && x.status.agent.ok ? x : null; }, 5 * 60000);
      pid = v.status.pid; ports = v.status.ports;
      must(fs.existsSync(path.join(WORK, 'vms', VM, 'run.json')), 'run.json missing');
      return `QEMU pid ${pid}, ports ${JSON.stringify(ports)}, ${v.status.agent.os}`;
    });
    if (!up) return;

    let before = 0;
    await step('Update of the extension while the VM runs (installed again over itself, like a catalog update)', async () => {
      before = await uptime();
      const s = Date.now();
      server.ctx.extMarket.installFromDir(EXT, 'live-upd', { trusted: true });
      // the new instance takes the VM over
      const v = await waitFor('takeover', async () => { const x = await vm(); return x.status.state === 'running' && x.status.ports && x.status.agent && x.status.agent.ok ? x : null; }, 60000, 1000);
      return `taken over after ${((Date.now() - s) / 1000).toFixed(1)} s; state ${v.status.state}`;
    });

    await step('Same QEMU process, same ports, the guest did not restart', async () => {
      const v = await vm();
      must(v.status.pid === pid && alive(pid), `pid ${v.status.pid} (before ${pid})`);
      must(JSON.stringify(v.status.ports) === JSON.stringify(ports), `ports ${JSON.stringify(v.status.ports)}`);
      const after = await uptime();
      must(after > before, `uptime ${after} ≤ ${before}`);
      return `pid ${pid} still running, guest uptime ${before.toFixed(0)} s → ${after.toFixed(0)} s`;
    });

    await step('After the takeover: screen, commands in the VM, pause/resume and VNC work', async () => {
      const png = await raw('GET', `/vms/${VM}/screen`);
      const buf = Buffer.from(await png.arrayBuffer());
      must(png.status === 200 && buf.slice(1, 4).toString() === 'PNG', `screen ${png.status}`);
      fs.writeFileSync(path.join(OUT, 'after-update.png'), buf);
      const r = await exec('echo hostwerk-$((40+2))');
      must(/hostwerk-42/.test(r.out), r.out + r.err);
      await api('POST', `/vms/${VM}/pause`); must((await vm()).status.state === 'paused', 'not paused');
      await api('POST', `/vms/${VM}/resume`); must((await vm()).status.state === 'running', 'not resumed');
      const banner = await new Promise((resolve, reject) => { const s = net.connect(ports.vnc, '127.0.0.1'); s.once('data', (d) => { resolve(d.toString().trim()); s.destroy(); }); s.once('error', reject); setTimeout(() => reject(new Error('VNC silent')), 5000); });
      must(/^RFB /.test(banner), banner);
      return `screen PNG ${buf.length} bytes, exec “${r.out.trim()}”, pause/resume, VNC “${banner}”`;
    });

    await step('Hostwerk quits: the VM is shut down cleanly by Hostwerk (not left running)', async () => {
      const serialLog = path.join(WORK, 'vms', VM, 'serial.log');
      const sizeBefore = fs.existsSync(serialLog) ? fs.statSync(serialLog).size : 0;
      const s = Date.now();
      await server.close();
      quitDone = true;
      await waitFor('QEMU ended', async () => !alive(pid), 60000, 500);
      const tail = fs.existsSync(serialLog) ? fs.readFileSync(serialLog).slice(sizeBefore).toString('utf8') : '';
      const clean = /reboot: Power down|Powering off|System halted|Reached target.*Power-Off/i.test(tail);
      must(clean, `no clean power-down in the serial log: …${tail.slice(-300)}`);
      must(!fs.existsSync(path.join(WORK, 'vms', VM, 'run.json')), 'run.json left behind');
      return `QEMU ended ${((Date.now() - s) / 1000).toFixed(1)} s after quit, serial log: “${(tail.match(/reboot: Power down|Powering off|System halted|Reached target.*Power-Off.*/i) || [''])[0].trim()}”`;
    });
  } finally {
    if (!quitDone) { try { await api('POST', `/vms/${VM}/stop`); } catch { /* egal */ } await server.close().catch(() => {}); }
    if (pid && alive(pid)) { try { process.kill(pid); } catch { /* egal */ } }
    const pass = results.filter((r) => r.ok).length;
    fs.writeFileSync(path.join(OUT, 'report.md'), ['# Update keeps VMs running – real-life test', '', `${new Date().toISOString()} · ${pass}/${results.length} passed`, '', '| | Step | Time | Result |', '|---|---|---|---|', ...results.map((r) => `| ${r.ok ? '✓' : '✗'} | ${r.name} | ${(r.ms / 1000).toFixed(1)} s | ${r.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} |`)].join('\n'));
    log(`${pass}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
})().catch((e) => { console.error(e); process.exit(2); });
