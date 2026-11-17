'use strict';
/*
 * Real-life test for roadmap package 4 through a real Hostwerk (port 7865): two Debian cloud VMs in an internal network
 * (#7: static address from cloud-init for A, set through the guest agent for B, ping both ways, switch on 127.0.0.1
 * only), B with an encrypted disk (#15: boots, qemu-img shows "encrypted", no key file left, key not in vm.json),
 * shared folders PC → VM over WebDAV (#13: file from the PC read in the guest, file from the guest arrives on the PC,
 * read-only share refuses writes), TAP detection and a refused bridge start without adapter (#14, read-only), and
 * Hostwerk's own move/copy package (#16: export of the switched-off VM through Hostwerk's transfer service, import as
 * a copy, test run, the copy boots with the data of the original). Debian image from the cache – no download.
 *
 *   node tests/live/package4.js <work folder with vms/.images>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXT = path.join(__dirname, '..', '..');
const HW = process.env.HW_CORE || path.join(EXT, '..', '..', 'hostwerk');
const WORK = path.resolve(process.argv[2]);
const OUT = path.join(WORK, 'report-p4');
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
  process.env.APPDATA = path.join(WORK, 'appdata-p4'); process.env.LOCALAPPDATA = path.join(WORK, 'localappdata-p4');
  process.env.HW_VMS_DIR = path.join(WORK, 'vms');
  // No download: the cached Debian image must still be the current one (otherwise the test would fetch ~350 MB)
  const cached = JSON.parse(fs.readFileSync(path.join(WORK, 'vms', '.images', 'debian-12-genericcloud-amd64.qcow2.json'), 'utf8'));
  const catalog = require(path.join(EXT, 'server', 'catalog'));
  const cur = await catalog.resolve(catalog.get('debian-12'), { fetchText: async (u) => (await fetch(u)).text() });
  if (cur.hash !== cached.hash) { console.error('The cached Debian image is outdated – refusing to download a new one.'); process.exit(3); }

  const { createServer } = require(path.join(HW, 'server', 'index'));
  const jobs = require(path.join(HW, 'server', 'core', 'jobs'));
  const server = await createServer({ baseDir: path.join(WORK, 'hw-p4'), port: 7865 });
  const H = { 'x-hostwerk-token': server.token, 'Content-Type': 'application/json' };
  const api = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`${method} ${p} → ${res.status}: ${(j && j.error) || ''}`), { status: res.status });
    return j;
  };
  const waitJob = async (jid) => { for (;;) { const j = jobs.listJobs().find((x) => x.id === jid); if (j && j.state === 'done') return j; if (j && j.state === 'error') throw new Error(j.error); await sleep(1000); } };
  const vm = (vid) => api('GET', `/vms/${vid}`);
  const exec = (vid, command, timeoutMs = 60000) => api('POST', `/vms/${vid}/guest/exec`, { command, timeoutMs });
  const waitFor = async (what, fn, ms) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(3000); } throw new Error(`${what}: timeout (${typeof last === 'string' ? last : 'no answer'})`); };
  const waitAgent = (vid) => waitFor(`agent ${vid}`, async () => { const v = await vm(vid); return v.status.agent && v.status.agent.ok ? v.status.agent : null; }, 8 * 60000);
  const waitStopped = (vid) => waitFor(`stopped ${vid}`, async () => (await vm(vid)).status.state === 'stopped', 150000);
  const A = 'p4-a'; const B = 'p4-b';
  const ids = [A, B, 'p4-bridge', 'p4-b-2'];
  const qimg = path.join(process.env.HW_QEMU_DIR || 'C:\\Program Files\\qemu', 'qemu-img.exe');
  const run = (cmd, args) => new Promise((ok) => require('child_process').execFile(cmd, args, { windowsHide: true }, (e, so, se) => ok({ code: e ? e.code || 1 : 0, out: String(so), err: String(se) })));

  let ext = null;
  try {
    await step('Hostwerk test instance with the extension (port 7865)', async () => { ext = server.ctx.extMarket.installFromDir(EXT, 'live-p4', { trusted: true }); await sleep(1500); return ext.dir; });
    for (const v of (await api('GET', '/vms')).vms) if (ids.includes(v.id)) { await api('POST', `/vms/${v.id}/poweroff`).catch(() => {}); await sleep(2000); await api('DELETE', `/vms/${v.id}`); }
    const m = require(path.join(ext.dir, 'server', 'index')).manager; // the running instance (Hostwerk loads the installed copy)
    const pw = `Hw-${crypto.randomBytes(5).toString('hex')}`;
    let net = null;
    await step('#7 Internal network “Labor” created', async () => {
      for (const n of (await api('GET', '/vms/networks')).networks) await api('DELETE', `/vms/networks/${n.id}`).catch(() => {});
      net = await api('POST', '/vms/networks', { name: 'Labor' });
      return `${net.id}, 10.10.${net.n}.0/24`;
    });
    const ipA = `10.10.${net.n}.10/24`; const ipB = `10.10.${net.n}.11/24`;
    const created = await step('Two Debian VMs: A in the network with a static address (cloud-init), B with an encrypted disk', async () => {
      const [ra, rb] = await Promise.all([
        api('POST', '/vms', { source: 'cloud', image: 'debian-12', name: 'P4 A', user: 'hwtest', password: pw, diskGb: 6, memoryMb: 1024, nets: [{ net: net.id, ip: ipA }], start: true }),
        api('POST', '/vms', { source: 'cloud', image: 'debian-12', name: 'P4 B', user: 'hwtest', password: pw, diskGb: 6, memoryMb: 1024, encrypt: true, start: true }),
      ]);
      await Promise.all([waitJob(ra.job), waitJob(rb.job)]);
      const [aa, ab] = await Promise.all([waitAgent(A), waitAgent(B)]);
      return `${aa.os} / ${ab.os}`;
    });
    if (created) {
      await step('#15 B boots from the encrypted disk: qemu-img says encrypted, no key file left, key not in vm.json', async () => {
        const dir = path.join(WORK, 'vms', B);
        const info = JSON.parse((await run(qimg, ['info', '-U', '--output=json', path.join(dir, 'disk0.qcow2')])).out);
        must(info.encrypted === true && info['format-specific'].data.encrypt.format === 'luks', JSON.stringify(info).slice(0, 200));
        const left = fs.readdirSync(dir).filter((f) => f.startsWith('.hwkey-'));
        must(!left.length, `key files left: ${left}`);
        const key = (await api('GET', `/vms/${B}/disk-key`)).key;
        const json = fs.readFileSync(path.join(dir, 'vm.json'), 'utf8');
        must(key.length === 64 && !json.includes(key) && /"key": "enc:/.test(json), 'key in vm.json?');
        const r = await exec(B, 'cat /proc/cmdline; findmnt -no SOURCE /');
        return `qemu-img: encrypted=yes, luks ${info['format-specific'].data.encrypt['cipher-alg']}-${info['format-specific'].data.encrypt['cipher-mode']}; guest root ${r.out.trim().split('\n').pop()}; vm.json holds only "enc:…"`;
      });
      await step('#7 A: static address on the internal NIC from cloud-init network config, NAT still works', async () => {
        const r = await exec(A, 'ip -4 -o addr show; ip route | grep default; getent hosts deb.debian.org | head -1');
        must(r.out.includes(ipA.split('/')[0]) && /default via 10\.0\.2\.2/.test(r.out), r.out);
        return r.out.split('\n').filter((l) => /hwin0|default/.test(l)).map((l) => l.replace(/\s+/g, ' ').slice(0, 70)).join(' · ');
      });
      await step('#7 B joins the network later (VM off → member → started): address set by the guest agent', async () => {
        await api('POST', `/vms/${B}/stop`);
        await waitStopped(B);
        await api('PUT', `/vms/${B}`, { nets: [{ net: net.id, ip: ipB }] });
        await api('POST', `/vms/${B}/start`);
        await waitAgent(B);
        const g = await waitFor('guest setup', async () => { const v = await vm(B); return v.guestSetup && v.guestSetup.nets.length ? v.guestSetup : null; }, 120000);
        must(g.nets[0].ok, JSON.stringify(g.nets));
        const r = await exec(B, `ip -4 -o addr show | grep ${ipB.split('/')[0]}`);
        return `${g.nets[0].iface}: ${r.out.trim().replace(/\s+/g, ' ').slice(0, 60)}`;
      });
      await step('#7 Ping between the VMs over the internal network (both ways)', async () => {
        const ab = await exec(A, `ping -c 3 -W 2 ${ipB.split('/')[0]}`, 30000);
        const ba = await exec(B, `ping -c 3 -W 2 ${ipA.split('/')[0]}`, 30000);
        must(ab.code === 0 && ba.code === 0, `${ab.out}\n${ba.out}`);
        const stat = (o) => (o.match(/(\d+) received.*\n.*= ([\d.]+)\/([\d.]+)/) || []).slice(1, 3).join(' received, min ');
        return `A→B ${stat(ab.out)} ms · B→A ${stat(ba.out)} ms`;
      });
      await step('#7 The switch listens on 127.0.0.1 only and counts frames; NICs are members', async () => {
        const sw = m.switches.nets.get(net.id);
        must(sw && sw.sock.address().address === '127.0.0.1', JSON.stringify(sw && sw.sock.address()));
        const n = (await api('GET', '/vms/networks')).networks.find((x) => x.id === net.id);
        return `udp 127.0.0.1:${sw.port}, ${sw.members.size} NICs, ${sw.stats.frames} frames forwarded, ${sw.stats.dropped} dropped; members ${n.members.map((x) => `${x.name} ${x.ip}`).join(', ')}`;
      });
      const rw = path.join(WORK, 'share-rw'); const ro = path.join(WORK, 'share-ro');
      fs.rmSync(rw, { recursive: true, force: true }); fs.rmSync(ro, { recursive: true, force: true });
      fs.mkdirSync(rw, { recursive: true }); fs.mkdirSync(ro, { recursive: true });
      const marker = `vom PC ${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(path.join(rw, 'hallo vom PC.txt'), marker);
      fs.writeFileSync(path.join(ro, 'nur-lesen.txt'), 'ro');
      await step('#13 Shared folders added while A runs; mounted in the guest (davfs2 through the guest agent)', async () => {
        const d = await api('PUT', `/vms/${A}`, { shares: [{ name: 'Projekte', path: rw, readOnly: false }, { name: 'Nur lesen', path: ro, readOnly: true }] });
        const r0 = await api('POST', `/vms/${A}/shares/share0/mount`);
        const r1 = await api('POST', `/vms/${A}/shares/share1/mount`);
        return `${d.shares[0].url.replace(/[a-f0-9]{32}/, '<token>')} → ${r0.mount}; read-only → ${r1.mount}`;
      });
      await step('#13 A file written on the PC appears in the guest', async () => {
        const r = await exec(A, "cat '/mnt/hostwerk/projekte/hallo vom PC.txt'");
        must(r.out.trim() === marker, `${r.out} ${r.err}`);
        return `"${r.out.trim()}"`;
      });
      await step('#13 A file written in the guest arrives on the PC; the read-only share refuses writing', async () => {
        const text = `aus der VM ${crypto.randomBytes(4).toString('hex')}`;
        const w = await exec(A, `echo '${text}' > /mnt/hostwerk/projekte/aus-der-vm.txt && sync`);
        must(w.code === 0, w.err);
        const got = await waitFor('file on the PC', async () => { const f = path.join(rw, 'aus-der-vm.txt'); return fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim() === text ? text : null; }, 90000);
        const r = await exec(A, 'echo x > /mnt/hostwerk/nur-lesen/neu.txt && echo WROTE || echo REFUSED; ls /mnt/hostwerk/nur-lesen');
        must(/REFUSED/.test(r.out) && !fs.existsSync(path.join(ro, 'neu.txt')), r.out + r.err);
        return `PC got "${got}"; read-only: ${r.out.trim().split('\n')[0]} (${r.out.trim().split('\n').slice(1).join(', ')} visible)`;
      });
      await step('#13 Without a running VM nothing is served (token of A after A stopped)', async () => {
        const v = await vm(A);
        const url = v.shares[0].url.replace('10.0.2.2', '127.0.0.1');
        const on = await fetch(`${url}hallo%20vom%20PC.txt`);
        await api('POST', `/vms/${A}/stop`);
        await waitStopped(A);
        const off = await fetch(`${url}hallo%20vom%20PC.txt`);
        must(on.status === 200 && off.status === 404, `${on.status}/${off.status}`);
        return `running → ${on.status}, stopped → ${off.status}`;
      });
      await step('#14 TAP detection (read-only) and a refused bridge start without adapter', async () => {
        const t = await api('GET', '/vms/taps');
        const r = await api('POST', '/vms', { source: 'empty', name: 'P4 Bridge', diskGb: 1, memoryMb: 256, net: { mode: 'bridge', tap: 'Hostwerk TAP Test' } });
        await waitJob(r.job);
        const e = await api('POST', '/vms/p4-bridge/start').then(() => null).catch((x) => x);
        must(e && e.status === 409 && /TAP adapter|TAP-Adapter/.test(e.message), e ? e.message : 'started?!');
        return `${t.taps.length} TAP adapter(s) on this PC; start → ${e.status}: ${e.message.split(': ').slice(1).join(': ').slice(0, 110)}`;
      });
      await step('#16 Hostwerk lists the VM for moving and refuses it while it runs', async () => {
        const items = server.ctx.transfer.items().filter((x) => x.kind === 'vm');
        must(items.some((x) => x.id === B), JSON.stringify(items));
        const e = await server.ctx.transfer.exportJob({ kind: 'vm', id: B }).promise.then(() => null).catch((x) => x);
        must(e && /Shut the VM down first|herunter/i.test(e.message), e ? e.message : 'packed a running VM!');
        return `${items.length} VMs offered; running B → “${e.message}”`;
      });
      await step('#16 Move package of the switched-off encrypted B through Hostwerk’s transfer service, imported as a copy with test run', async () => {
        await exec(B, `echo ${marker} > /root/p4-marker && sync`);
        await api('POST', `/vms/${B}/stop`);
        await waitStopped(B);
        const ex = await server.ctx.transfer.exportJob({ kind: 'vm', id: B }).promise;
        const pkg = server.ctx.transfer.packages.get(ex.token).file;
        const list = (await run('tar', ['-tf', pkg])).out.split(/\r?\n/).filter(Boolean);
        must(!list.some((f) => /vm\.json$|\.hwkey-|qemu\.pid/.test(f)), list.join(','));
        const imp = await server.ctx.transfer.importJob(pkg, { test: true }).promise;
        must(imp.tested === true && imp.id === 'p4-b-2', JSON.stringify(imp));
        return `package ${(ex.size / 1048576).toFixed(0)} MB (${list.filter((f) => !f.endsWith('/')).map((f) => f.replace(/^\.\//, '')).join(', ')}); imported as ${imp.id}, test run ok`;
      });
      await step('#16 The copy boots, still encrypted, in the network, with the data of the original', async () => {
        const v = await vm('p4-b-2');
        // a copy on the same PC: same network, but the address stays with the original (dropped with a note)
        must(v.encryption && !v.encryption.locked && v.nets[0].net === net.id && v.nets[0].ip === null && v.autostart === false && v.movedFrom, JSON.stringify({ e: v.encryption && v.encryption.locked, n: v.nets, m: v.movedFrom }));
        await api('POST', '/vms/p4-b-2/start');
        await waitAgent('p4-b-2');
        const r = await exec('p4-b-2', 'cat /root/p4-marker');
        must(r.out.trim() === marker, r.out);
        const info = JSON.parse((await run(qimg, ['info', '-U', '--output=json', path.join(WORK, 'vms', 'p4-b-2', 'disk0.qcow2')])).out);
        must(info.encrypted === true, 'not encrypted');
        return `marker "${r.out.trim()}" found; disk encrypted=${info.encrypted}; network ${v.nets[0].net} kept, address left to the original; moved from ${v.movedFrom}`;
      });
    }
  } finally {
    for (const vid of ids) { try { await api('POST', `/vms/${vid}/poweroff`); } catch { /* egal */ } }
    await sleep(3000);
    for (const vid of ids) { try { await api('DELETE', `/vms/${vid}`); } catch { /* egal */ } }
    try { for (const n of (await api('GET', '/vms/networks')).networks) await api('DELETE', `/vms/networks/${n.id}`); } catch { /* egal */ }
    const pass = results.filter((r) => r.ok).length;
    fs.writeFileSync(path.join(OUT, 'report.md'), ['# Package 4 – real-life test', '', `${new Date().toISOString()} · ${pass}/${results.length} passed`, '', '| | Step | Time | Result |', '|---|---|---|---|', ...results.map((r) => `| ${r.ok ? '✓' : '✗'} | ${r.name} | ${(r.ms / 1000).toFixed(1)} s | ${r.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} |`)].join('\n'));
    log(`${pass}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
})().catch((e) => { console.error(e); process.exit(2); });
