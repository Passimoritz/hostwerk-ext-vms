'use strict';
/*
 * Real-life test for #22 with a real ARM guest through a real Hostwerk (port 7867): Hostwerk downloads the official
 * Debian 12 ARM64 cloud image itself (checked against Debian's SHA512SUMS), creates the VM with cloud-init, boots it
 * emulated (qemu-system-aarch64, virt, TCG) – then: guest agent answers, SSH through the forwarded port, uname -m is
 * aarch64, cloud-init done, a package installs, a snapshot is taken, shut down cleanly.
 *
 *   node tests/live/arm.js <work folder> [--keep]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXT = path.join(__dirname, '..', '..');
const HW = process.env.HW_CORE || path.join(EXT, '..', '..', 'hostwerk');
const WORK = path.resolve(process.argv[2]);
const KEEP = process.argv.includes('--keep');
const OUT = path.join(WORK, 'report-arm');
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
  process.env.APPDATA = path.join(WORK, 'appdata-arm'); process.env.LOCALAPPDATA = path.join(WORK, 'localappdata-arm');
  process.env.HW_VMS_DIR = path.join(WORK, 'vms');

  const { createServer } = require(path.join(HW, 'server', 'index'));
  const jobs = require(path.join(HW, 'server', 'core', 'jobs'));
  const { Client } = require(path.join(HW, 'node_modules', 'ssh2'));
  const server = await createServer({ baseDir: path.join(WORK, 'hw-arm'), port: 7867 });
  const H = { 'x-hostwerk-token': server.token, 'Content-Type': 'application/json' };
  const raw = (method, p, body) => fetch(`http://127.0.0.1:${server.port}/api${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const api = async (method, p, body) => {
    const res = await raw(method, p, body);
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${(j && j.error) || ''}`);
    return j;
  };
  const waitJob = async (jid) => { let last = ''; for (;;) { const j = jobs.listJobs().find((x) => x.id === jid); if (j && j.text !== last) { last = j.text; log('   job:', j.progress, '%', j.text); } if (j && j.state === 'done') return j; if (j && (j.state === 'error' || j.state === 'cancelled')) throw new Error(`${j.error} ${j.detail || ''}`); await sleep(5000); } };
  const vm = (vid) => api('GET', `/vms/${vid}`);
  const waitFor = async (what, fn, ms, every = 5000) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(every); } throw new Error(`${what}: timeout (${typeof last === 'string' ? last : 'no answer'})`); };
  const ssh = (port, user, password, cmd, ms = 300000) => new Promise((resolve, reject) => {
    const c = new Client(); let out = '';
    const timer = setTimeout(() => { c.end(); reject(new Error(`ssh timeout: ${cmd.slice(0, 60)}`)); }, ms);
    c.on('ready', () => c.exec(cmd, (err, st) => { if (err) { clearTimeout(timer); c.end(); reject(err); return; } st.on('data', (d) => { out += d; }).stderr.on('data', (d) => { out += d; }); st.on('close', () => { clearTimeout(timer); c.end(); resolve(out.trim()); }); }));
    c.on('error', (e) => { clearTimeout(timer); reject(e); });
    c.connect({ host: '127.0.0.1', port, username: user, password, readyTimeout: 60000, hostVerifier: () => true });
  });
  const shot = async (vid, f) => { try { const r = await raw('GET', `/vms/${vid}/screen`); if (r.status === 200) fs.writeFileSync(path.join(OUT, f), Buffer.from(await r.arrayBuffer())); } catch { /* not running */ } };
  const id = 'arm-debian';
  const pw = `Hw-${crypto.randomBytes(5).toString('hex')}`;
  let port = 0;

  try {
    await step('Hostwerk test instance with the extension (port 7867)', async () => { server.ctx.extMarket.installFromDir(EXT, 'live-arm', { trusted: true }); await sleep(1500); const eng = await api('GET', '/vms/engines'); must(eng.qemu.aarch64 && eng.qemu.aarch64.ok, JSON.stringify(eng.qemu.aarch64)); return 'qemu-system-aarch64 found'; });
    if ((await api('GET', '/vms')).vms.some((v) => v.id === id)) { await api('POST', `/vms/${id}/poweroff`).catch(() => {}); await sleep(3000); await api('DELETE', `/vms/${id}`); }

    const ok = await step('Download Debian 12 ARM64 (official, SHA512 checked) and create the VM', async () => {
      const r = await api('POST', '/vms', { source: 'cloud', image: 'debian-12-arm64', name: 'ARM Debian', user: 'hwtest', password: pw, diskGb: 8, memoryMb: 2048, cpus: 4, keyboard: 'de', start: true });
      await waitJob(r.job);
      const v = await vm(id);
      must(v.arch === 'aarch64' && v.status.state === 'running' && v.status.accel === 'tcg', JSON.stringify({ arch: v.arch, s: v.status.state, a: v.status.accel }));
      const img = path.join(WORK, 'vms', '.images', 'debian-12-genericcloud-arm64.qcow2');
      const m = fs.existsSync(`${img}.json`) ? JSON.parse(fs.readFileSync(`${img}.json`, 'utf8')) : {};
      port = v.ssh && v.ssh.port;
      return `image ${fs.existsSync(img) ? (fs.statSync(img).size / 2 ** 20).toFixed(0) : '?'} MiB, ${m.algo || '?'} ${String(m.hash || '').slice(0, 16)}…; arch ${v.arch}, accel ${v.status.accel}, SSH port ${port}`;
    });
    if (ok) {
      await step('ARM guest boots (emulated) – Linux kernel on the serial console', async () => {
        const s = await waitFor('kernel', async () => { const t = (await api('GET', `/vms/${id}/serial`)).text; return /Linux version|login:/.test(t) ? t : null; }, 25 * 60000);
        // eslint-disable-next-line no-control-regex
        const lines = s.replace(/\x1b\[[0-9;?=]*[A-Za-z]/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        fs.writeFileSync(path.join(OUT, 'arm-serial.txt'), lines.join('\n'));
        return (lines.find((l) => /Linux version/.test(l)) || lines.pop()).slice(0, 140);
      });
      await step('Guest agent answers', async () => {
        const a = await waitFor('agent', async () => { const v = await vm(id); return v.status.agent && v.status.agent.ok ? v.status.agent : null; }, 30 * 60000, 10000);
        await shot(id, 'arm-screen.png');
        return `${a.os || ''} ${(a.addresses || []).map((x) => x.ip).join(', ')}`;
      });
      await step('SSH through the forwarded port: aarch64, cloud-init done, user hwtest', async () => {
        await waitFor('SSH', () => ssh(port, 'hwtest', pw, 'echo ok', 120000), 15 * 60000, 10000);
        await waitFor('cloud-init', async () => { const o = await ssh(port, 'hwtest', pw, 'sudo cloud-init status --wait 2>&1', 1200000); if (/done/.test(o)) return o; throw new Error(o.trim().split('\n').pop()); }, 30 * 60000, 10000);
        const o = await ssh(port, 'hwtest', pw, 'uname -m; . /etc/os-release; echo "$PRETTY_NAME"; id -un; nproc; free -m | awk \'/Mem/{print $2" MB"}\'; grep XKBLAYOUT /etc/default/keyboard');
        must(/^aarch64$/m.test(o) && /hwtest/.test(o), o);
        return o.replace(/\n/g, ' · ');
      });
      await step('Install a package in the ARM guest (apt, arm64 build)', async () => {
        const o = await ssh(port, 'hwtest', pw, 'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q cowsay >/dev/null 2>&1; dpkg --print-architecture; /usr/games/cowsay -f tux "ARM in Hostwerk" | head -n 3', 30 * 60000);
        must(/arm64/.test(o) && /ARM in Hostwerk/.test(o), o);
        return o.split('\n')[0];
      });
      await step('Snapshot of the running ARM VM', async () => {
        await api('POST', `/vms/${id}/snapshots`, { name: 'arm-ok' });
        const v = await vm(id);
        must((v.snapshots || []).some((s) => s.name === 'arm-ok'), JSON.stringify(v.snapshots));
        return 'arm-ok';
      });
      await step('Shut down cleanly through Hostwerk', async () => {
        await api('POST', `/vms/${id}/stop`);
        await waitFor('stopped', async () => (await vm(id)).status.state === 'stopped', 10 * 60000);
        return 'stopped';
      });
    }
  } finally {
    if (!KEEP) { try { await api('POST', `/vms/${id}/poweroff`); } catch { /* egal */ } await sleep(3000); try { await api('DELETE', `/vms/${id}`); } catch { /* egal */ } }
    const pass = results.filter((r) => r.ok).length;
    fs.writeFileSync(path.join(OUT, 'report.md'), ['# ARM guest – real-life test', '', `${new Date().toISOString()} · ${pass}/${results.length} passed`, '', '| | Step | Time | Result |', '|---|---|---|---|', ...results.map((r) => `| ${r.ok ? '✓' : '✗'} | ${r.name} | ${(r.ms / 60000).toFixed(1)} min | ${r.detail.replace(/\|/g, '/')} |`)].join('\n'));
    log(`${pass}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
})().catch((e) => { console.error(e); process.exit(2); });
