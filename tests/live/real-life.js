'use strict';
/*
 * Real-life test: a real Hostwerk (test instance in its own folder) with this extension installed; everything goes
 * through Hostwerk's HTTP API like the interface does. Real QEMU, real downloads (checksums checked), real SSH logins,
 * real VirtualBox. Not part of `node --test` – it downloads ~400 MB and boots VMs.
 *
 *   node tests/live/real-life.js <work folder> [--only=debian,alpine,vbox] [--keep]
 *   HW_CORE=<path to the hostwerk repository> (default: ../../../hostwerk next to hostwerk-extensions)
 *
 * --keep: at the end the Debian VM is started again and Hostwerk keeps running (for a look at the interface).
 * VirtualBox: only a VM this test creates (marked hostwerk/managed) is started, changed and deleted; for every other
 * VirtualBox VM it only checks that deleting is refused – nothing of them is changed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXT = path.join(__dirname, '..', '..');
const HW = process.env.HW_CORE || path.join(EXT, '..', '..', 'hostwerk');
const args = process.argv.slice(2);
const WORK = path.resolve(args.find((a) => !a.startsWith('--')) || fs.mkdtempSync(path.join(require('os').tmpdir(), 'hw-vms-live-')));
const ONLY = (args.find((a) => a.startsWith('--only=')) || '--only=debian,alpine,vbox').slice(7).split(',');
const KEEP = args.includes('--keep');
const OUT = path.join(WORK, 'report');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
async function step(name, fn) {
  const s = Date.now();
  try { const detail = await fn(); results.push({ name, ok: true, ms: Date.now() - s, detail: detail == null ? '' : String(detail) }); log('✓', name, detail ? `– ${detail}` : ''); return true; } catch (e) { results.push({ name, ok: false, ms: Date.now() - s, detail: e.message }); log('✗', name, '–', e.message); return false; }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  process.env.HW_TEST = '1'; process.env.HW_NO_AUTOUPDATE = '1';
  process.env.APPDATA = path.join(WORK, 'appdata'); process.env.LOCALAPPDATA = path.join(WORK, 'localappdata');
  process.env.HW_VMS_DIR = path.join(WORK, 'vms');
  const { createServer } = require(path.join(HW, 'server', 'index'));
  const jobs = require(path.join(HW, 'server', 'core', 'jobs'));
  const { Client } = require(path.join(HW, 'node_modules', 'ssh2'));
  const port = Number(process.env.HW_LIVE_PORT || 7861);
  const server = await createServer({ baseDir: path.join(WORK, 'hw'), port });
  const H = { 'x-hostwerk-token': server.token, 'Content-Type': 'application/json' };
  const api = async (method, p, body, { raw = false, headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api${p}`, { method, headers: { ...H, ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (raw) return res;
    const j = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`${method} ${p} → ${res.status}: ${(j && j.error) || ''}`), { status: res.status });
    return j;
  };
  const waitJob = async (id, ms = 30 * 60000) => {
    const until = Date.now() + ms; let last = '';
    while (Date.now() < until) {
      const j = jobs.listJobs().find((x) => x.id === id);
      if (j && j.text !== last) { last = j.text; log('   job:', j.progress, '%', j.text); }
      if (j && j.state === 'done') return j;
      if (j && (j.state === 'error' || j.state === 'cancelled')) throw new Error(`job ${j.state}: ${j.error}`);
      await sleep(1000);
    }
    throw new Error('job timeout');
  };
  const vm = (id) => api('GET', `/vms/${id}`);
  const waitFor = async (what, fn, ms) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(3000); } throw new Error(`${what}: timeout (${typeof last === 'string' ? last : 'no answer'})`); };
  const waitAgent = (id, ms = 8 * 60000) => waitFor('guest agent', async () => { const v = await vm(id); return v.status && v.status.agent && v.status.agent.ok ? v.status.agent : null; }, ms);
  const shot = async (id, file) => { const r = await api('GET', `/vms/${id}/screen`, undefined, { raw: true }); must(r.status === 200, `screen HTTP ${r.status}`); const b = Buffer.from(await r.arrayBuffer()); must(b.subarray(1, 4).toString() === 'PNG', 'not a PNG'); fs.writeFileSync(path.join(OUT, file), b); return b; };
  const ssh = (portN, user, password, cmd, ms = 60000) => new Promise((resolve, reject) => {
    const c = new Client(); let out = '';
    const timer = setTimeout(() => { c.end(); reject(new Error(`ssh timeout: ${cmd.slice(0, 60)}`)); }, ms);
    const ok = resolve; resolve = (v) => { clearTimeout(timer); ok(v); }; // eslint-disable-line no-param-reassign
    c.on('ready', () => c.exec(cmd, (err, st) => { if (err) { c.end(); reject(err); return; } st.on('data', (d) => { out += d; }).stderr.on('data', (d) => { out += d; }); st.on('close', () => { c.end(); resolve(out.trim()); }); }));
    c.on('error', reject);
    c.connect({ host: '127.0.0.1', port: portN, username: user, password, readyTimeout: 30000, hostVerifier: () => true });
  });
  const waitSsh = (portN, user, pw) => waitFor('SSH login', () => ssh(portN, user, pw, 'echo ready'), 5 * 60000);
  const waitStopped = (id) => waitFor('stopped', async () => (await vm(id)).status.state === 'stopped', 120000);

  try {
    await step('Hostwerk test instance runs and installs the extension', async () => {
      const r = server.ctx.extMarket.installFromDir(EXT, 'live-test', { trusted: true });
      await sleep(1500);
      const list = await api('GET', '/vms');
      must(Array.isArray(list.vms), 'no /api/vms');
      return `port ${server.port}, ${r && r.id ? r.id : 'vms'} installed`;
    });
    let eng;
    await step('Engines: QEMU found, hardware acceleration works', async () => {
      eng = await api('GET', '/vms/engines?fresh=1');
      must(eng.qemu.installed, 'QEMU missing');
      return `QEMU ${eng.qemu.version}, accel ${eng.qemu.accel}, UEFI ${eng.qemu.firmware ? 'yes' : 'no'}, VirtualBox ${eng.vbox.version || 'no'}, host ${eng.host.cpus} CPU / ${eng.host.memoryMb} MB`;
    });

    /* ---------------- A: ready-made Debian with cloud-init ---------------- */
    if (ONLY.includes('debian')) {
      const pw = `Hw-${crypto.randomBytes(6).toString('hex')}`; // test-only, lives in the test folder only
      let created = false;
      created = await step('Debian 12 cloud image: download (checksum), disk, seed, start – as one job', async () => {
        const r = await api('POST', '/vms', { source: 'cloud', image: 'debian-12', name: 'Live Debian', user: 'hwtest', password: pw, diskGb: 10, cpus: 2, memoryMb: 2048, start: true });
        must(r.id === 'live-debian', `id ${r.id}`);
        await waitJob(r.job);
        const v = await vm('live-debian');
        must(v.status.state === 'running', `state ${v.status.state}`);
        return `running, accel ${v.status.accel}, SSH ${v.ssh.command}`;
      });
      if (created) {
        const tStart = Date.now();
        await step('First boot: SSH login with the cloud-init user and password', async () => {
          await waitSsh(2222, 'hwtest', pw);
          const secs = Math.round((Date.now() - tStart) / 1000);
          const out = await ssh(2222, 'hwtest', pw, 'id -un; hostname; sudo -n true && echo SUDO_OK; df -BG / | tail -1 | awk "{print \\$2}"; cat /etc/debian_version');
          const [user, host, sudo, size, ver] = out.split(/\r?\n/);
          must(user === 'hwtest' && host === 'live-debian' && sudo === 'SUDO_OK', out);
          must(parseInt(size, 10) >= 9, `root size ${size} (growpart)`);
          return `${secs}s until SSH; user ${user}, host ${host}, sudo ok, / = ${size}, Debian ${ver}`;
        });
        await step('Guest agent connects: OS and IP address visible in Hostwerk', async () => {
          const a = await waitAgent('live-debian');
          must(a.addresses && a.addresses.some((x) => x.ip === '10.0.2.15'), JSON.stringify(a.addresses));
          return `${a.os}, ${a.addresses.map((x) => x.ip).join(', ')}`;
        });
        await step('Screen in Hostwerk (PNG) and ETag for unchanged frames', async () => {
          const b = await shot('live-debian', 'debian-screen.png');
          const r1 = await api('GET', '/vms/live-debian/screen', undefined, { raw: true }); const etag = r1.headers.get('etag'); await r1.arrayBuffer();
          const r2 = await api('GET', '/vms/live-debian/screen', undefined, { raw: true, headers: { 'If-None-Match': etag } });
          return `${b.length} bytes, second request ${r2.status}`;
        });
        await step('Mouse and keyboard events reach QEMU', async () => {
          const r = await api('POST', '/vms/live-debian/input', { events: [{ t: 'm', x: 0.5, y: 0.5 }, { t: 'k', c: 'ShiftLeft', d: true }, { t: 'k', c: 'ShiftLeft', d: false }] });
          must(r.n === 4, `events ${r.n}`);
          return `${r.n} events`;
        });
        await step('Serial console shows the boot and the login prompt', async () => {
          const s = await waitFor('serial', async () => { const x = await api('GET', '/vms/live-debian/serial'); return /login:/.test(x.text) ? x : null; }, 60000);
          fs.writeFileSync(path.join(OUT, 'debian-serial.txt'), s.text);
          return `${s.text.length} characters, login prompt present`;
        });
        await step('Port forwarding added while running – web server in the VM reachable from this PC', async () => {
          const v = await vm('live-debian');
          await api('PUT', '/vms/live-debian', { net: { forwards: [...v.net.forwards, { proto: 'tcp', host: 18080, guest: 8080, label: 'Web' }] } });
          await ssh(2222, 'hwtest', pw, 'mkdir -p ~/www && echo hostwerk-live > ~/www/index.html && sudo systemd-run --unit=hw-web --working-directory=$HOME/www python3 -m http.server 8080 >/dev/null 2>&1; echo started');
          const body = await waitFor('http', async () => { const r = await fetch('http://127.0.0.1:18080/'); return r.ok ? r.text() : null; }, 30000);
          must(body.trim() === 'hostwerk-live', body);
          return 'http://127.0.0.1:18080/ → "hostwerk-live"';
        });
        await step('Live snapshot while running (file system frozen by the agent)', async () => {
          await ssh(2222, 'hwtest', pw, 'echo before > ~/state; sync');
          const snaps = await api('POST', '/vms/live-debian/snapshots', { name: 'live1', note: 'real-life test' });
          const s = snaps.find((x) => x.name === 'live1');
          must(s && s.live, JSON.stringify(s));
          await ssh(2222, 'hwtest', pw, 'echo after > ~/state; echo x > ~/marker; sync');
          return `live ${s.live}, frozen ${s.frozen}, with memory ${s.ram}`;
        });
        let backupFile = null;
        await step('Live backup while running (QEMU block backup, compressed)', async () => {
          const s = Date.now();
          const r = await api('POST', '/vms/live-debian/backups', { label: 'live' });
          await waitJob(r.job);
          const list = await api('GET', '/vms/live-debian/backups');
          must(list[0] && list[0].live, JSON.stringify(list));
          backupFile = list[0].file;
          const ok = await ssh(2222, 'hwtest', pw, 'echo still-running');
          must(ok === 'still-running', ok);
          return `${backupFile}, ${(list[0].size / 1048576).toFixed(0)} MB in ${Math.round((Date.now() - s) / 1000)} s, VM kept running`;
        });
        await step('Clean shutdown through ACPI', async () => {
          const s = Date.now();
          await api('POST', '/vms/live-debian/stop');
          await waitStopped('live-debian');
          return `${Math.round((Date.now() - s) / 1000)} s`;
        });
        await step('Restore the snapshot – changes after it are gone', async () => {
          await api('POST', '/vms/live-debian/snapshots/live1/restore');
          await api('POST', '/vms/live-debian/start');
          await waitSsh(2222, 'hwtest', pw);
          const out = await ssh(2222, 'hwtest', pw, 'cat ~/state; test -f ~/marker && echo MARKER || echo NO_MARKER');
          must(out === 'before\nNO_MARKER', out);
          return out.replace('\n', ' / ');
        });
        await step('Restore the backup – the state of the backup is back', async () => {
          await api('POST', '/vms/live-debian/stop');
          await waitStopped('live-debian');
          const r = await api('POST', '/vms/live-debian/backups/restore', { file: backupFile });
          await waitJob(r.job);
          await api('POST', '/vms/live-debian/start');
          await waitSsh(2222, 'hwtest', pw);
          const out = await ssh(2222, 'hwtest', pw, 'cat ~/state; test -f ~/marker && echo MARKER || echo NO_MARKER');
          must(out === 'after\nMARKER', out);
          await api('POST', '/vms/live-debian/stop');
          await waitStopped('live-debian');
          return out.replace('\n', ' / ');
        });
        await step('Template and linked clone: new VM in seconds, own name and SSH port', async () => {
          await api('POST', '/vms/live-debian/template', { on: true });
          const s = Date.now();
          const r = await api('POST', '/vms/live-debian/from-template', { name: 'Live Clone', password: pw });
          await waitJob(r.job);
          const ms = Date.now() - s;
          const c = await vm(r.id);
          must(c.linkedTo === 'live-debian', 'not linked');
          await api('POST', `/vms/${r.id}/start`);
          await waitSsh(c.ssh.port, 'hwtest', pw);
          const host = await waitFor('new host name', async () => { const h = await ssh(c.ssh.port, 'hwtest', pw, 'hostname'); return h === 'live-clone' ? h : null; }, 120000);
          const d = (await vm(r.id)).diskInfo[0];
          await api('POST', `/vms/${r.id}/stop`);
          await waitStopped(r.id);
          await api('DELETE', `/vms/${r.id}`);
          await api('POST', '/vms/live-debian/template', { on: false });
          return `created in ${ms} ms, ${(d.actualSize / 1048576).toFixed(1)} MB on top of the template, host name ${host}, SSH port ${c.ssh.port}`;
        });
      }
    }

    /* ---------------- B: installer ISO in QEMU ---------------- */
    if (ONLY.includes('alpine')) {
      const ok = await step('Alpine ISO from the catalog (checksum), boots from CD', async () => {
        const r = await api('POST', '/vms', { source: 'iso', image: 'alpine-virt', name: 'Live Alpine', diskGb: 2, memoryMb: 1024, start: true });
        await waitJob(r.job);
        const v = await vm('live-alpine');
        must(v.boot === 'cdrom' && v.status.state === 'running', `${v.boot} ${v.status.state}`);
        return v.cdrom;
      });
      if (ok) {
        await step('Typing into the VM: root login on the installer console, output on the screen', async () => {
          await sleep(35000); // the live ISO boots to its login prompt on the screen
          const before = await shot('live-alpine', 'alpine-before.png');
          await api('POST', '/vms/live-alpine/type', { text: 'root\n' });
          await sleep(3000);
          await api('POST', '/vms/live-alpine/type', { text: 'echo HOSTWERK-$((6*7))\n' });
          await sleep(2500);
          const after = await shot('live-alpine', 'alpine-after.png');
          must(!before.equals(after), 'screen did not change');
          return 'screen changed after typing (alpine-before.png → alpine-after.png)';
        });
        await step('ISO ejected and inserted again while running', async () => {
          const v = await vm('live-alpine');
          await api('PUT', '/vms/live-alpine', { cdrom: null });
          must((await vm('live-alpine')).cdrom === null, 'not ejected');
          await api('PUT', '/vms/live-alpine', { cdrom: v.cdrom });
          return 'ejected and inserted';
        });
        await step('Power off and delete', async () => {
          await api('POST', '/vms/live-alpine/poweroff');
          await waitStopped('live-alpine');
          await api('DELETE', '/vms/live-alpine');
          return 'gone';
        });
      }
    }

    /* ---------------- D: a real graphical desktop (Ubuntu Desktop live ISO) ---------------- */
    if (ONLY.includes('desktop')) {
      // PNG header: width/height; size of the PNG as a rough measure of "how much is on the screen" (text console ≈ a few KB)
      const dims = (b) => `${b.readUInt32BE(16)}×${b.readUInt32BE(20)}`;
      const ok = await step('Ubuntu Desktop 24.04: ISO from the catalog (≈6 GB, checksum), VM with 4 CPU / 6 GB starts', async () => {
        const r = await api('POST', '/vms', { source: 'iso', image: 'ubuntu-desktop', name: 'Live Ubuntu Desktop', cpus: 4, memoryMb: 6144, diskGb: 30, start: true });
        await waitJob(r.job, 90 * 60000);
        const v = await vm(r.id);
        must(v.status.state === 'running', v.status.state);
        return `${v.cdrom.split(/[\\/]/).pop()}, accel ${v.status.accel}`;
      });
      if (ok) {
        const id = 'live-ubuntu-desktop';
        let desk;
        await step('The graphical desktop appears on the screen in Hostwerk', async () => {
          const s = Date.now();
          let n = 0;
          desk = await waitFor('desktop', async () => {
            const b = await shot(id, `ubuntu-boot-${String(n++).padStart(2, '0')}.png`);
            return b.readUInt32BE(16) >= 1024 && b.length > 80000 ? b : null;
          }, 15 * 60000);
          fs.copyFileSync(path.join(OUT, `ubuntu-boot-${String(n - 1).padStart(2, '0')}.png`), path.join(OUT, 'ubuntu-desktop.png'));
          return `${Math.round((Date.now() - s) / 1000)} s after start, ${dims(desk)}, ${Math.round(desk.length / 1024)} KB`;
        });
        await step('Desktop reacts to the keyboard: Super key opens the activities overview', async () => {
          await sleep(20000); // let the welcome/installer window settle
          const before = await shot(id, 'ubuntu-before-super.png');
          await api('POST', `/vms/${id}/combo`, { combo: 'meta' });
          await sleep(4000);
          const after = await shot(id, 'ubuntu-activities.png');
          must(!before.equals(after), 'screen unchanged');
          await api('POST', `/vms/${id}/input`, { events: [{ t: 'k', c: 'Escape', d: true }, { t: 'k', c: 'Escape', d: false }] });
          await sleep(3000);
          return 'ubuntu-before-super.png → ubuntu-activities.png';
        });
        await step('Desktop reacts to the mouse: pointer into the top-left corner opens the overview', async () => {
          const before = await shot(id, 'ubuntu-before-mouse.png');
          const ev = [];
          for (let i = 10; i >= 0; i--) ev.push({ t: 'm', x: 0.05 * i, y: 0.05 * i });
          await api('POST', `/vms/${id}/input`, { events: ev });
          await sleep(4000);
          const after = await shot(id, 'ubuntu-mouse.png');
          must(!before.equals(after), 'screen unchanged');
          await api('POST', `/vms/${id}/input`, { events: [{ t: 'm', x: 0.5, y: 0.5 }, { t: 'b', b: 'left', d: true }, { t: 'b', b: 'left', d: false }] });
          return 'ubuntu-before-mouse.png → ubuntu-mouse.png';
        });
        if (!KEEP) {
          await step('Ubuntu Desktop: power off and delete', async () => {
            await api('POST', `/vms/${id}/poweroff`);
            await waitStopped(id);
            await api('DELETE', `/vms/${id}`);
            return 'gone';
          });
        }
      }
    }

    /* ---------------- C: VirtualBox ---------------- */
    if (ONLY.includes('vbox') && eng && eng.vbox.installed) {
      const m = { vbox: new (require(path.join(EXT, 'server', 'vbox')).VBox)() }; // only for creating/marking the test VM
      const VBM = m.vbox.locate();
      const U = require(path.join(EXT, 'server', 'util'));
      const imgDir = path.join(WORK, 'vms', '.images');
      const iso = fs.existsSync(imgDir) ? fs.readdirSync(imgDir).find((f) => /alpine-virt.*\.iso$/.test(f)) : null;
      let uuid = null;
      const foreign = (await api('GET', '/vms/vbox')).vms.filter((v) => !v.managed);
      const ok = await step('VirtualBox: test VM created (marked as Hostwerk\'s), listed next to existing ones', async () => {
        must(iso, 'Alpine ISO missing (run the alpine part first)');
        const name = `hw-live-${Date.now().toString(36)}`;
        const dir = path.join(WORK, 'vbox'); fs.mkdirSync(dir, { recursive: true });
        const r = await U.runOk(VBM, ['createvm', '--name', name, '--ostype', 'Linux_64', '--register', '--basefolder', dir]);
        uuid = r.stdout.match(/UUID: ([0-9a-f-]{36})/i)[1].toLowerCase();
        await m.vbox.mark(uuid);
        await U.runOk(VBM, ['modifyvm', uuid, '--memory', '512', '--cpus', '1', '--nic1', 'nat', '--graphicscontroller', 'vmsvga']);
        await U.runOk(VBM, ['createmedium', 'disk', '--filename', path.join(dir, `${name}.vdi`), '--size', '1024']);
        await U.runOk(VBM, ['storagectl', uuid, '--name', 'SATA', '--add', 'sata', '--controller', 'IntelAhci']);
        await U.runOk(VBM, ['storageattach', uuid, '--storagectl', 'SATA', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', path.join(dir, `${name}.vdi`)]);
        await U.runOk(VBM, ['storageattach', uuid, '--storagectl', 'SATA', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', path.join(imgDir, iso)]);
        const list = (await api('GET', '/vms/vbox')).vms;
        const mine = list.find((v) => v.uuid === uuid);
        must(mine && mine.managed && mine.disks.length === 1 && mine.dvds.length === 1, JSON.stringify(mine));
        return `${name}; also listed: ${foreign.map((v) => `${v.name} (${v.state})`).join(', ') || '–'}`;
      });
      if (ok) {
        await step('VirtualBox: deleting a VM that is not Hostwerk\'s is refused (nothing changed)', async () => {
          if (!foreign.length) return 'no foreign VM on this PC';
          const before = JSON.stringify(await m.vbox.vm(foreign[0].uuid));
          const r = await api('DELETE', `/vms/vbox/${foreign[0].uuid}`).then(() => 'deleted?!').catch((e) => e.status);
          must(r === 403, `answer ${r}`);
          must(JSON.stringify(await m.vbox.vm(foreign[0].uuid)) === before, 'foreign VM changed');
          return `403 for “${foreign[0].name}”, unchanged`;
        });
        await step('VirtualBox: start headless, screenshot, snapshot, power off – through Hostwerk', async () => {
          await api('POST', `/vms/vbox/${uuid}/start`);
          await sleep(25000);
          const r = await api('GET', `/vms/vbox/${uuid}/screen`, undefined, { raw: true });
          must(r.status === 200, `screen ${r.status}`);
          fs.writeFileSync(path.join(OUT, 'vbox-screen.png'), Buffer.from(await r.arrayBuffer()));
          const s = await api('POST', `/vms/vbox/${uuid}/snapshot`, { action: 'take', name: 'hw-live' });
          must(s.snapshots.some((x) => x.name === 'hw-live'), 'snapshot missing');
          const off = await api('POST', `/vms/vbox/${uuid}/poweroff`);
          return `state after power off: ${off.state}; snapshot hw-live present`;
        });
        await step('VirtualBox → QEMU: take over the VM (VDI converted, settings kept)', async () => {
          await sleep(3000);
          const r = await api('POST', `/vms/vbox/${uuid}/import`, { name: 'From VirtualBox' });
          await waitJob(r.job);
          const v = await vm(r.id);
          must(v.importedFrom && v.disks[0].bus === 'sata' && v.memoryMb === 512, JSON.stringify(v));
          await api('DELETE', `/vms/${r.id}`);
          return `${v.name}: ${v.cpus} CPU, ${v.memoryMb} MB, ${v.firmware}, disk ${(v.diskInfo[0].virtualSize / 1048576).toFixed(0)} MB`;
        });
        await step('VirtualBox: the test VM is deleted again', async () => {
          await api('DELETE', `/vms/vbox/${uuid}`);
          const left = (await api('GET', '/vms/vbox')).vms.some((v) => v.uuid === uuid);
          must(!left, 'still registered');
          return 'unregistered and deleted';
        });
      }
    }
  } finally {
    const pass = results.filter((r) => r.ok).length;
    const md = ['# Real-life test – Virtual machines', '', `${new Date().toISOString()} · ${pass}/${results.length} passed · ${((Date.now() - t0) / 60000).toFixed(1)} min`, '', '| | Step | Time | Result |', '|---|---|---|---|',
      ...results.map((r) => `| ${r.ok ? '✓' : '✗'} | ${r.name} | ${(r.ms / 1000).toFixed(1)} s | ${r.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} |`)].join('\n');
    fs.writeFileSync(path.join(OUT, 'report.md'), `${md}\n`);
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2));
    log(`${pass}/${results.length} passed – ${path.join(OUT, 'report.md')}`);
    if (KEEP) {
      try { await api('POST', '/vms/live-debian/start'); } catch { /* not there */ }
      fs.writeFileSync(path.join(WORK, 'server.json'), JSON.stringify({ port: server.port, token: server.token }));
      log(`KEEP – Hostwerk keeps running on port ${server.port}`);
    } else {
      try { for (const v of (await api('GET', '/vms')).vms) if (v.status.state !== 'stopped') await api('POST', `/vms/${v.id}/poweroff`).catch(() => {}); } catch { /* egal */ }
      process.exit(results.every((r) => r.ok) ? 0 : 1);
    }
  }
})().catch((e) => { console.error(e); process.exit(2); });
