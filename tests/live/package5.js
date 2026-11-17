'use strict';
/*
 * Real-life test for roadmap package 5 through a real Hostwerk (port 7866): two Debian cloud VMs from app templates
 * (#9: Nginx – the forwarded web port answers on this PC; Docker – `docker run hello-world` works in the guest) with own
 * start commands and a bash script that leave marker files; Ask AI about the screen (#20: the text context that would be
 * sent, a clear refusal while the AI is off, the AI tools registered through host.aiExtend); Hyper-V detection (#21:
 * quietly "not available" on Windows Home); an ARM VM without an OS (#22: qemu-system-aarch64 through Hostwerk, UEFI
 * output on the serial console and a screenshot). Debian image from the cache – this test never downloads an image:
 * downloads are switched off in the manager and the checksum list is answered with the cached image's hash.
 *
 *   node tests/live/package5.js <work folder with vms/.images>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXT = path.join(__dirname, '..', '..');
const HW = process.env.HW_CORE || path.join(EXT, '..', '..', 'hostwerk');
const WORK = path.resolve(process.argv[2]);
const OUT = path.join(WORK, 'report-p5');
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
  process.env.APPDATA = path.join(WORK, 'appdata-p5'); process.env.LOCALAPPDATA = path.join(WORK, 'localappdata-p5');
  process.env.HW_VMS_DIR = path.join(WORK, 'vms');
  const cached = JSON.parse(fs.readFileSync(path.join(WORK, 'vms', '.images', 'debian-12-genericcloud-amd64.qcow2.json'), 'utf8'));

  const { createServer } = require(path.join(HW, 'server', 'index'));
  const jobs = require(path.join(HW, 'server', 'core', 'jobs'));
  const server = await createServer({ baseDir: path.join(WORK, 'hw-p5'), port: 7866 });
  const H = { 'x-hostwerk-token': server.token, 'Content-Type': 'application/json' };
  const raw = (method, p, body) => fetch(`http://127.0.0.1:${server.port}/api${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const api = async (method, p, body) => {
    const res = await raw(method, p, body);
    const j = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`${method} ${p} → ${res.status}: ${(j && j.error) || ''}`), { status: res.status, body: j });
    return j;
  };
  const waitJob = async (jid) => { for (;;) { const j = jobs.listJobs().find((x) => x.id === jid); if (j && j.state === 'done') return j; if (j && j.state === 'error') throw new Error(j.error); await sleep(1000); } };
  const vm = (vid) => api('GET', `/vms/${vid}`);
  const exec = (vid, command, timeoutMs = 60000) => api('POST', `/vms/${vid}/guest/exec`, { command, timeoutMs });
  const waitFor = async (what, fn, ms, every = 3000) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { if (e.fatal) throw e; last = e.message; } await sleep(every); } throw new Error(`${what}: timeout (${typeof last === 'string' ? last : 'no answer'})`); };
  const waitAgent = (vid) => waitFor(`agent ${vid}`, async () => { const v = await vm(vid); return v.status.agent && v.status.agent.ok ? v.status.agent : null; }, 8 * 60000);
  const N = 'p5-nginx'; const D = 'p5-docker'; const R = 'p5-arm';
  const ids = [N, D, R];

  let ext = null;
  try {
    await step('Hostwerk test instance with the extension (port 7866)', async () => { ext = server.ctx.extMarket.installFromDir(EXT, 'live-p5', { trusted: true }); await sleep(1500); return ext.dir; });
    for (const v of (await api('GET', '/vms')).vms) if (ids.includes(v.id)) { await api('POST', `/vms/${v.id}/poweroff`).catch(() => {}); await sleep(2000); await api('DELETE', `/vms/${v.id}`); }
    const m = require(path.join(ext.dir, 'server', 'index')).manager; // the running instance (Hostwerk loads the installed copy)
    // No downloads in this test: the checksum list answers with the cached image's hash, a download would fail loudly
    const realFetch = m.fetchText;
    m.fetchText = async (url) => (/bookworm\/latest\/SHA512SUMS$/.test(url) ? `${cached.hash}  debian-12-genericcloud-amd64.qcow2\n` : realFetch(url));
    m.downloadFile = async (url) => { throw new Error(`download refused in this test: ${url}`); };
    const pw = `Hw-${crypto.randomBytes(5).toString('hex')}`;

    await step('#21 Hyper-V detection: quietly “not available” on this PC (Windows 11 Home)', async () => {
      const s = Date.now();
      const st = await api('GET', '/vms/hyperv?fresh=1');
      const ms = Date.now() - s;
      must(st.available === false && st.reason === 'no-module' && st.vms.length === 0, JSON.stringify(st));
      const list = await api('GET', '/vms');
      must(list.hyperv && list.hyperv.available === false, JSON.stringify(list.hyperv));
      const r = await raw('POST', '/vms/hyperv/0e1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9/start');
      must(r.status === 404, `action → ${r.status}`);
      return `reason ${st.reason}, ${ms} ms (PowerShell, read-only), list field available=false, start → 404 “${(await r.json()).error}”`;
    });

    await step('#20 AI tools registered through host.aiExtend (risk classes, describe)', async () => {
      const aiext = require(path.join(HW, 'server', 'core', 'aiext'));
      const got = [];
      aiext.addTools({ add: (name, group, d, props, req, run, opts) => got.push({ name, group, risk: opts && opts.risk, describe: opts && typeof opts.describe }), S: (d) => ({ type: 'string', description: d }), L: (de) => de, clip: (x) => x });
      const mine = got.filter((t) => /^vm_/.test(t.name));
      must(mine.length === 7, mine.map((t) => t.name).join(','));
      must(mine.filter((t) => t.risk === 'read').length === 3 && mine.find((t) => t.name === 'vm_start').risk === 'change' && typeof mine.find((t) => t.name === 'vm_stop').risk === 'function', JSON.stringify(mine));
      must(mine.filter((t) => t.risk !== 'read').every((t) => t.describe === 'function'), 'describe missing');
      const src = aiext.contextSources('de').find((x) => x.kind === 'vm');
      must(src && src.owner === 'vms', JSON.stringify(aiext.contextSources('de')));
      return `${mine.map((t) => `${t.name} (${typeof t.risk === 'function' ? 'change/system' : t.risk})`).join(', ')}; @ source “${src.label}”`;
    });

    const created = await step('#9 Two app VMs from templates: Nginx (with own commands + bash script) and Docker host', async () => {
      const [rn, rd] = await Promise.all([
        api('POST', '/vms', { source: 'cloud', image: 'debian-12', name: 'P5 Nginx', user: 'hwtest', password: pw, diskGb: 6, memoryMb: 1024, app: 'nginx', startCommands: '# marker from a command\necho "p5-cmd $(hostname)" > /root/p5-cmd-marker', startScript: 'set -e\necho "p5-script ü $(id -un)" > /root/p5-script-marker\n', start: true }),
        api('POST', '/vms', { source: 'cloud', image: 'debian-12', name: 'P5 Docker', user: 'hwtest', password: pw, diskGb: 10, memoryMb: 2048, app: 'docker', start: true }),
      ]);
      await Promise.all([waitJob(rn.job), waitJob(rd.job)]);
      const [an, ad] = await Promise.all([waitAgent(N), waitAgent(D)]);
      const v = await vm(N);
      return `${an.os} / ${ad.os}; Nginx forwards ${v.net.forwards.map((f) => `${f.host}→${f.guest}`).join(', ')}; button “${v.appInfo.open.label}” → ${v.appInfo.open.url}`;
    });
    if (created) {
      await step('#9 App setup finished in both guests (marker app-ready, read through the guest agent)', async () => {
        const s = Date.now();
        const [sn, sd] = await Promise.all([N, D].map((vid) => waitFor(`app ${vid}`, async () => { const r = await api('GET', `/vms/${vid}/app`); if (r.app === 'failed') throw Object.assign(new Error(`setup failed: ${r.log.slice(-400)}`), { fatal: true }); return r.app === 'ok' ? r : null; }, 12 * 60000, 10000)));
        return `nginx app=${sn.app} script=${sn.script}; docker app=${sd.app}; ${(Date.now() - s) / 1000 | 0} s after the agent answered`;
      });
      await step('#9 Nginx: the forwarded web port answers from this PC', async () => {
        const v = await vm(N);
        const res = await fetch(v.appInfo.open.url);
        const html = await res.text();
        must(res.status === 200 && /Nginx on p5-nginx works/.test(html), `${res.status} ${html.slice(0, 200)}`);
        return `GET ${v.appInfo.open.url} → ${res.status}, “${html.match(/<h1>(.*?)<\/h1>/)[1]}”`;
      });
      await step('#9 Docker host: docker runs hello-world, user is in the group docker', async () => {
        const r = await exec(D, 'docker run --rm hello-world 2>&1 | grep -m1 "Hello from Docker"; id -nG hwtest; docker --version', 240000);
        must(r.code === 0 && /Hello from Docker!/.test(r.out) && /\bdocker\b/.test(r.out.split('\n').find((l) => /hwtest/.test(l)) || r.out), r.out + r.err);
        return r.out.split('\n').filter((l) => /Hello from Docker|Docker version|docker/.test(l)).slice(0, 3).map((l) => l.trim()).join(' · ');
      });
      await step('#9 Own start commands and bash script ran once and left their markers', async () => {
        const r = await exec(N, 'cat /root/p5-cmd-marker /root/p5-script-marker; ls /var/lib/hostwerk; stat -c %a /var/lib/hostwerk/start-script.sh');
        must(r.code === 0 && /p5-cmd p5-nginx/.test(r.out) && /p5-script ü root/.test(r.out) && /start-script-done/.test(r.out) && /\n700\n?$/.test(r.out.trim() + '\n'), r.out + r.err);
        const st = await api('GET', `/vms/${N}/app`);
        must(st.script === 'ok', JSON.stringify(st));
        return r.out.trim().split('\n').join(' · ');
      });
      await step('#20 Ask AI about the screen: context that would be sent (text only)', async () => {
        await sleep(1000);
        const ctx = await api('GET', `/vms/${N}/ai/context`);
        must(ctx.image === false && /Virtual machine “P5 Nginx”/.test(ctx.text) && /Guest agent: connected/.test(ctx.text) && ctx.parts.serialLines > 0, ctx.text);
        must(!ctx.text.includes(pw), 'password in the context');
        fs.writeFileSync(path.join(OUT, 'ai-context-nginx.txt'), ctx.text);
        const png = await raw('GET', `/vms/${N}/screen`);
        const buf = Buffer.from(await png.arrayBuffer());
        must(png.status === 200 && buf.slice(1, 4).toString() === 'PNG', `screen ${png.status}`);
        return `${ctx.text.length} characters, ${ctx.parts.serialLines} serial lines, agent=${ctx.parts.agent}, image=false; first line “${ctx.text.split('\n')[0]}”; screen PNG ${buf.length} bytes stays on the PC (saved to report-p5/ai-context-nginx.txt)`;
      });
      await step('#20 With the AI off: clear refusal, nothing sent', async () => {
        // The test instance may find a local AI by itself – switch it off in memory for this instance only (its own
        // settings in the work folder), and back afterwards
        const aiCfg = server.ctx.settings.get().ai || {};
        const before = { ready: (await api('GET', '/ai/quick').catch(() => ({}))).ready, disabled: aiCfg.disabled };
        aiCfg.disabled = true;
        let q; let r; let j;
        try {
          q = await api('GET', '/ai/quick').catch((e) => ({ ready: null, error: e.message }));
          r = await raw('POST', `/vms/${N}/ai/explain`, { question: 'What does the screen show?' });
          j = await r.json();
        } finally { aiCfg.disabled = before.disabled; }
        must(q.ready === false, `AI is ready in the test instance (${JSON.stringify(q)}) – cannot check the refusal`);
        must(r.status === 409 && j.code === 'AI_OFF', `${r.status} ${JSON.stringify(j)}`);
        return `AI of the test instance was ready=${before.ready}, switched off → /api/ai/quick ready=${q.ready}; POST /vms/${N}/ai/explain → ${r.status} “${j.error}”`;
      });
    }

    await step('#22 ARM VM without an OS: qemu-system-aarch64 through Hostwerk, UEFI on the serial console and screen', async () => {
      const eng = await api('GET', '/vms/engines');
      must(eng.qemu.aarch64 && eng.qemu.aarch64.ok, JSON.stringify(eng.qemu.aarch64));
      const r = await api('POST', '/vms', { source: 'empty', name: 'P5 ARM', osType: 'other', arch: 'aarch64', memoryMb: 512, cpus: 2, diskGb: 1, start: true });
      await waitJob(r.job);
      const v = await vm(R);
      must(v.arch === 'aarch64' && v.status.accel === 'tcg', JSON.stringify({ arch: v.arch, accel: v.status.accel }));
      let text = '';
      await waitFor('UEFI output', async () => { const s = await api('GET', `/vms/${R}/serial`); text = s.text; return /UEFI firmware|Shell>|BdsDxe/.test(s.text); }, 120000, 2000);
      // eslint-disable-next-line no-control-regex
      const clean = text.replace(/\x1b\[[0-9;?=]*[A-Za-z]/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      fs.writeFileSync(path.join(OUT, 'arm-serial.txt'), clean.join('\n'));
      await sleep(4000);
      const png = await raw('GET', `/vms/${R}/screen`);
      const buf = Buffer.from(await png.arrayBuffer());
      must(png.status === 200 && buf.slice(1, 4).toString() === 'PNG', `screen ${png.status}`);
      fs.writeFileSync(path.join(OUT, 'arm-screen.png'), buf);
      const w = buf.readUInt32BE(16); const h = buf.readUInt32BE(20);
      const proc = require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${v.status.pid}").CommandLine`], { encoding: 'utf8' }).trim();
      must(/qemu-system-aarch64/.test(proc) && /virt,gic-version=max/.test(proc), proc.slice(0, 200));
      const ctx = await api('GET', `/vms/${R}/ai/context`);
      return `${clean.find((l) => /UEFI firmware/.test(l)) || clean[0]} · ${clean.filter((l) => /BdsDxe|Shell>|UEFI Interactive/.test(l)).slice(0, 2).join(' · ')}; screen ${w}×${h} PNG; process qemu-system-aarch64 -machine virt, accel tcg; AI context says “${ctx.text.split('\n')[0]}”`;
    });
  } finally {
    for (const vid of ids) { try { await api('POST', `/vms/${vid}/poweroff`); } catch { /* egal */ } }
    await sleep(4000);
    for (const vid of ids) { try { await api('DELETE', `/vms/${vid}`); } catch { /* egal */ } }
    const left = (await api('GET', '/vms').catch(() => ({ vms: [] }))).vms.filter((v) => ids.includes(v.id)).map((v) => v.id);
    results.push({ name: 'Clean-up: test VMs powered off and deleted', ok: !left.length, ms: 0, detail: left.length ? `left: ${left}` : ids.join(', ') });
    const pass = results.filter((r) => r.ok).length;
    fs.writeFileSync(path.join(OUT, 'report.md'), ['# Package 5 – real-life test', '', `${new Date().toISOString()} · ${pass}/${results.length} passed`, '', '| | Step | Time | Result |', '|---|---|---|---|', ...results.map((r) => `| ${r.ok ? '✓' : '✗'} | ${r.name} | ${(r.ms / 1000).toFixed(1)} s | ${r.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} |`)].join('\n'));
    log(`${pass}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
})().catch((e) => { console.error(e); process.exit(2); });
