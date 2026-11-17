'use strict';
/*
 * Real-life test for roadmap package 1 (and the fixes from the first runs): a real Hostwerk test instance with this
 * extension, real QEMU (WHPX), a Debian cloud VM with German keyboard. Images come from the cache of an earlier run.
 *
 *   node tests/live/package1.js <work folder with vms/.images> [--desktop]
 *
 * Checks: German keyboard set by cloud-init and typed on the console (SSH reads the result back) · guest disks,
 * command, disk-full warning · system update with a snapshot first · automatic snapshots with retention · limits live
 * (disk speed measured in the guest, CPU share and priority on the QEMU process) · free blocks + compact disk ·
 * attach an existing disk (seen in the guest) · port forwarding to a web server in the VM · with --desktop: the mouse
 * moves in Ubuntu's GNOME desktop.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const EXT = path.join(__dirname, '..', '..');
const HW = process.env.HW_CORE || path.join(EXT, '..', '..', 'hostwerk');
const WORK = path.resolve(process.argv[2]);
const DESKTOP = process.argv.includes('--desktop');
const OUT = path.join(WORK, 'report-p1');
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

(async () => {
  process.env.HW_TEST = '1'; process.env.HW_NO_AUTOUPDATE = '1';
  process.env.APPDATA = path.join(WORK, 'appdata-p1'); process.env.LOCALAPPDATA = path.join(WORK, 'localappdata-p1');
  process.env.HW_VMS_DIR = path.join(WORK, 'vms');
  const { createServer } = require(path.join(HW, 'server', 'index'));
  const jobs = require(path.join(HW, 'server', 'core', 'jobs'));
  const events = require(path.join(HW, 'server', 'core', 'events'));
  const { Client } = require(path.join(HW, 'node_modules', 'ssh2'));
  const server = await createServer({ baseDir: path.join(WORK, 'hw-p1'), port: 7862 });
  const toasts = [];
  (events.bus || events).on('broadcast', (m) => { if (m && m.type === 'toast') toasts.push(m.text); });
  const H = { 'x-hostwerk-token': server.token, 'Content-Type': 'application/json' };
  const api = async (method, p, body, { raw = false } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api${p}`, { method, headers: H, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (raw) return res;
    const j = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`${method} ${p} → ${res.status}: ${(j && j.error) || ''}`), { status: res.status });
    return j;
  };
  const waitJob = async (id, ms = 30 * 60000) => { const until = Date.now() + ms; while (Date.now() < until) { const j = jobs.listJobs().find((x) => x.id === id); if (j && j.state === 'done') return j; if (j && (j.state === 'error' || j.state === 'cancelled')) throw new Error(`job ${j.state}: ${j.error} ${j.detail || ''}`); await sleep(1000); } throw new Error('job timeout'); };
  const vm = (id) => api('GET', `/vms/${id}`);
  const waitFor = async (what, fn, ms) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(3000); } throw new Error(`${what}: timeout (${typeof last === 'string' ? last : 'no answer'})`); };
  const ssh = (port, user, password, cmd, ms = 120000) => new Promise((resolve, reject) => {
    const c = new Client(); let out = '';
    const timer = setTimeout(() => { c.end(); reject(new Error(`ssh timeout: ${cmd.slice(0, 60)}`)); }, ms);
    c.on('ready', () => c.exec(cmd, (err, st) => { if (err) { clearTimeout(timer); c.end(); reject(err); return; } st.on('data', (d) => { out += d; }).stderr.on('data', (d) => { out += d; }); st.on('close', () => { clearTimeout(timer); c.end(); resolve(out.trim()); }); }));
    c.on('error', (e) => { clearTimeout(timer); reject(e); });
    c.connect({ host: '127.0.0.1', port, username: user, password, readyTimeout: 30000, hostVerifier: () => true });
  });
  const waitStopped = (id) => waitFor('stopped', async () => (await vm(id)).status.state === 'stopped', 120000);
  const pw = `Hw-${crypto.randomBytes(5).toString('hex')}`;
  let port = 2222;

  try {
    await step('Hostwerk test instance with the extension', async () => { server.ctx.extMarket.installFromDir(EXT, 'live-p1', { trusted: true }); await sleep(1500); return (await api('GET', '/vms')).vms.map((v) => v.id).join(', ') || 'no VMs'; });
    for (const old of (await api('GET', '/vms')).vms.filter((v) => v.id.startsWith('p1-'))) await api('DELETE', `/vms/${old.id}`).catch(() => {});

    const ok = await step('Debian VM with German keyboard (cloud image from the cache)', async () => {
      const r = await api('POST', '/vms', { source: 'cloud', image: 'debian-12', name: 'P1 Debian', user: 'hwtest', password: pw, diskGb: 10, keyboard: 'de', start: true });
      await waitJob(r.job);
      const v = await vm('p1-debian');
      port = v.ssh.port;
      await waitFor('SSH', () => ssh(port, 'hwtest', pw, 'echo ok'), 5 * 60000);
      await waitFor('cloud-init', async () => { const o = await ssh(port, 'hwtest', pw, 'sudo cloud-init status --wait 2>&1', 300000); if (/done/.test(o)) return o; throw new Error(o.trim().split('\n').pop()); }, 8 * 60000); // root only on Debian
      const kb = await ssh(port, 'hwtest', pw, 'grep -h XKBLAYOUT /etc/default/keyboard 2>/dev/null; localectl status 2>/dev/null | grep -i "layout"');
      must(/de/.test(kb), `keyboard in the guest: ${kb}`);
      return `keyboard in the guest: ${kb.replace(/\s+/g, ' ')}`;
    });
    if (ok) {
      await step('#4 Typing German text on the console – SSH reads back exactly what was typed', async () => {
        const text = 'zy ZY @€{}[]|~ äöüß ÄÖÜ "§$%&/()=?#\'<>;:_-';
        await api('POST', '/vms/p1-debian/type', { text: 'hwtest\n' });
        await sleep(2500);
        await api('POST', '/vms/p1-debian/type', { text: `${pw}\n` });
        await sleep(4000);
        await api('POST', '/vms/p1-debian/type', { text: 'cat > /tmp/kb.txt\n' });
        await sleep(1000);
        await api('POST', '/vms/p1-debian/type', { text: `${text}\n` });
        await sleep(1500);
        await api('POST', '/vms/p1-debian/input', { events: [{ t: 'k', c: 'ControlLeft', d: true }, { t: 'k', c: 'KeyD', d: true }, { t: 'k', c: 'KeyD', d: false }, { t: 'k', c: 'ControlLeft', d: false }] });
        await sleep(1500);
        const got = await ssh(port, 'hwtest', pw, 'cat /tmp/kb.txt');
        fs.writeFileSync(path.join(OUT, 'typed.txt'), got);
        const shot = await api('GET', '/vms/p1-debian/screen', undefined, { raw: true });
        fs.writeFileSync(path.join(OUT, 'typed-screen.png'), Buffer.from(await shot.arrayBuffer()));
        must(got === text, `typed ${JSON.stringify(text)} – got ${JSON.stringify(got)}`);
        return `${text.length} characters identical`;
      });
      await step('#11 Guest view: disks and a command through the agent', async () => {
        const a = await waitFor('agent', async () => { const v = await vm('p1-debian'); return v.status.agent && v.status.agent.ok && v.status.agent.fs && v.status.agent.fs.length ? v.status.agent : null; }, 5 * 60000);
        const root = a.fs.find((f) => f.mount === '/');
        must(root && root.total > 9e9, JSON.stringify(a.fs));
        const r = await api('POST', '/vms/p1-debian/guest/exec', { command: 'uname -sr; id -un' });
        must(r.code === 0 && /Linux/.test(r.out) && /root/.test(r.out), JSON.stringify(r));
        return `/ ${(root.used / 2 ** 30).toFixed(1)} of ${(root.total / 2 ** 30).toFixed(1)} GB (${root.pct} %); exec: ${r.out.trim().replace(/\n/g, ' / ')}`;
      });
      await step('#11 Disk-full warning when / reaches 90 %', async () => {
        const before = toasts.length;
        await api('POST', '/vms/p1-debian/guest/exec', { command: 'fallocate -l $(( $(df --output=avail -B1 / | tail -1) - 300*1024*1024 )) /var/tmp/hw-fill && df -h / | tail -1' });
        const msg = await waitFor('warning', async () => toasts.slice(before).find((t) => /full|voll/.test(t)), 120000);
        await api('POST', '/vms/p1-debian/guest/exec', { command: 'rm -f /var/tmp/hw-fill; sync' });
        return msg;
      });
      await step('#11 System update with a snapshot first (apt full-upgrade in the guest)', async () => {
        const r = await api('POST', '/vms/p1-debian/guest/update');
        const j = await waitJob(r.job, 45 * 60000);
        const v = await vm('p1-debian');
        const pre = v.snapshots.find((s) => s.name.startsWith('pre-update-'));
        must(pre && pre.auto && pre.live, JSON.stringify(v.snapshots));
        return `job ${Math.round((j.endedAt - j.startedAt) / 1000)} s, snapshot ${pre.name} (frozen: ${pre.frozen})`;
      });
      await step('#8 Automatic snapshots: retention keeps the newest 2, hand-made stays', async () => {
        await api('POST', '/vms/p1-debian/snapshots', { name: 'mine' });
        await api('PUT', '/vms/p1-debian', { autoSnap: { every: 'hourly', keep: 2, beforeUpdate: true } });
        for (let i = 0; i < 3; i++) { await api('POST', '/vms/p1-debian/snapshots/auto-run'); await sleep(1200); }
        const v = await vm('p1-debian');
        const autos = v.snapshots.filter((s) => s.auto).map((s) => s.name);
        must(autos.length === 2 && v.snapshots.some((s) => s.name === 'mine'), JSON.stringify(v.snapshots.map((s) => s.name)));
        return `kept: ${autos.join(', ')} + mine`;
      });
      await step('#17 Limits live: disk speed measured in the guest, CPU share and priority on the process', async () => {
        const speed = async () => { const o = await ssh(port, 'hwtest', pw, 'sudo dd if=/dev/zero of=/var/tmp/dd bs=1M count=120 oflag=direct 2>&1 | tail -1; sudo rm -f /var/tmp/dd'); const m = o.match(/([\d.,]+) ([MG])B\/s/); return m ? parseFloat(m[1].replace(',', '.')) * (m[2] === 'G' ? 1024 : 1) : NaN; };
        const free = await speed();
        await api('PUT', '/vms/p1-debian', { limits: { iops: 0, mbps: 15, cpuShare: 50, priority: 'low' } });
        const limited = await speed();
        const pid = Number(fs.readFileSync(path.join(WORK, 'vms', 'p1-debian', 'qemu.pid'), 'utf8').trim());
        const ps = execFileSync('powershell.exe', ['-NoProfile', '-Command', `$p = Get-Process -Id ${pid}; "$($p.PriorityClass) $($p.ProcessorAffinity)"`], { encoding: 'utf8' }).trim();
        await api('PUT', '/vms/p1-debian', { limits: { iops: 0, mbps: 0, cpuShare: 100, priority: 'normal' } });
        must(limited < 20 && limited < free, `without ${free} MB/s, with limit ${limited} MB/s`);
        must(/^BelowNormal /.test(ps), ps);
        return `write speed ${free} → ${limited} MB/s (limit 15); process: ${ps}`;
      });
      await step('Port forwarding added while running – web server in the VM (fixed test step)', async () => {
        const v = await vm('p1-debian');
        await api('PUT', '/vms/p1-debian', { net: { forwards: [...v.net.forwards, { proto: 'tcp', host: 18081, guest: 8080, label: 'Web' }] } });
        await ssh(port, 'hwtest', pw, 'mkdir -p ~/www && echo hostwerk-p1 > ~/www/index.html && sudo systemd-run --unit=hw-web --working-directory=$HOME/www python3 -m http.server 8080 >/dev/null 2>&1; echo started');
        const body = await waitFor('http', async () => { const r = await fetch('http://127.0.0.1:18081/'); return r.ok ? r.text() : null; }, 30000);
        must(body.trim() === 'hostwerk-p1', body);
        return 'http://127.0.0.1:18081/ → "hostwerk-p1"';
      });
      await step('#10 Free blocks in the guest, shut down, compact the disk', async () => {
        await api('POST', '/vms/p1-debian/guest/exec', { command: 'dd if=/dev/urandom of=/var/tmp/big bs=1M count=1500 status=none; sync; rm -f /var/tmp/big; sync', timeoutMs: 300000 });
        const trim = await api('POST', '/vms/p1-debian/guest/trim');
        await api('POST', '/vms/p1-debian/stop');
        await waitStopped('p1-debian');
        for (const s of (await vm('p1-debian')).snapshots) await api('DELETE', `/vms/p1-debian/snapshots/${encodeURIComponent(s.name)}`);
        const r = await api('POST', '/vms/p1-debian/disks/disk0/compact');
        const j = await waitJob(r.job);
        return `fstrim: ${trim.out.split('\n').pop()}; disk ${(j.result.before / 2 ** 20).toFixed(0)} → ${(j.result.after / 2 ** 20).toFixed(0)} MB`;
      });
      await step('#10 Attach an existing disk (copy) – the guest sees it', async () => {
        const src = path.join(WORK, 'extra.vmdk');
        if (!fs.existsSync(src)) execFileSync('C:\\Program Files\\qemu\\qemu-img.exe', ['create', '-f', 'vmdk', src, '1G']);
        const r = await api('POST', '/vms/p1-debian/disks', { file: src });
        await waitJob(r.job);
        await api('POST', '/vms/p1-debian/start');
        await waitFor('SSH', () => ssh(port, 'hwtest', pw, 'echo ok'), 5 * 60000);
        const lsblk = await ssh(port, 'hwtest', pw, 'lsblk -dno NAME,SIZE | grep -v "^sr"');
        must(/\b1G\b/.test(lsblk), lsblk);
        return lsblk.replace(/\n/g, ' · ');
      });
      await step('Clean up the Debian VM', async () => { await api('POST', '/vms/p1-debian/poweroff'); await waitStopped('p1-debian'); await api('DELETE', '/vms/p1-debian'); return 'gone'; });
    }

    if (DESKTOP) {
      const id = 'live-ubuntu-desktop';
      await step('Ubuntu desktop: the mouse moves now (fix: events go to the USB tablet)', async () => {
        await api('POST', `/vms/${id}/start`);
        await waitFor('desktop', async () => { const r = await api('GET', `/vms/${id}/screen`, undefined, { raw: true }); const b = Buffer.from(await r.arrayBuffer()); return b.length > 80000 ? b : null; }, 10 * 60000);
        await sleep(20000);
        const shot = async (f) => { const r = await api('GET', `/vms/${id}/screen`, undefined, { raw: true }); const b = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(path.join(OUT, f), b); return b; };
        await api('POST', `/vms/${id}/input`, { events: [{ t: 'm', x: 0.8, y: 0.85 }] });
        await sleep(1500);
        const a = await shot('mouse-a.png');
        await api('POST', `/vms/${id}/input`, { events: [{ t: 'm', x: 0.3, y: 0.4 }] });
        await sleep(1500);
        const b = await shot('mouse-b.png');
        must(!a.equals(b), 'pointer did not move');
        const ev = []; for (let i = 10; i >= 0; i--) ev.push({ t: 'm', x: 0.03 * i, y: 0.03 * i });
        await api('POST', `/vms/${id}/input`, { events: ev });
        await sleep(4000);
        await shot('mouse-corner.png');
        await api('POST', `/vms/${id}/poweroff`);
        return 'pointer moved (mouse-a.png → mouse-b.png), hot corner: mouse-corner.png';
      });
    }
  } finally {
    const pass = results.filter((r) => r.ok).length;
    fs.writeFileSync(path.join(OUT, 'report.md'), ['# Package 1 – real-life test', '', `${new Date().toISOString()} · ${pass}/${results.length} passed`, '', '| | Step | Time | Result |', '|---|---|---|---|', ...results.map((r) => `| ${r.ok ? '✓' : '✗'} | ${r.name} | ${(r.ms / 1000).toFixed(1)} s | ${r.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} |`)].join('\n'));
    log(`${pass}/${results.length} passed`);
    try { for (const v of (await api('GET', '/vms')).vms) if (v.status.state !== 'stopped') await api('POST', `/vms/${v.id}/poweroff`).catch(() => {}); } catch { /* egal */ }
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
})().catch((e) => { console.error(e); process.exit(2); });
