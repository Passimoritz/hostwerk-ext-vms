'use strict';
/*
 * Real-life test for roadmap package 3 through a real Hostwerk: VNC over Hostwerk's WebSocket (RFB handshake up to the
 * screen size; refused without login), files into and out of the VM through the guest agent (checksum compared), sound
 * card in the guest, 3D (virgl) in QEMU's own window. Debian cloud image from the cache.
 *
 *   node tests/live/package3.js <work folder with vms/.images>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXT = path.join(__dirname, '..', '..');
const HW = process.env.HW_CORE || path.join(EXT, '..', '..', 'hostwerk');
const WORK = path.resolve(process.argv[2]);
const OUT = path.join(WORK, 'report-p3');
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
  process.env.APPDATA = path.join(WORK, 'appdata-p3'); process.env.LOCALAPPDATA = path.join(WORK, 'localappdata-p3');
  process.env.HW_VMS_DIR = path.join(WORK, 'vms');
  const { createServer } = require(path.join(HW, 'server', 'index'));
  const jobs = require(path.join(HW, 'server', 'core', 'jobs'));
  const WebSocket = require(path.join(HW, 'node_modules', 'ws'));
  const server = await createServer({ baseDir: path.join(WORK, 'hw-p3'), port: 7864 });
  const H = { 'x-hostwerk-token': server.token, 'Content-Type': 'application/json' };
  const api = async (method, p, body, { raw = false, headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api${p}`, { method, headers: { ...H, ...headers }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    if (raw) return res;
    const j = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`${method} ${p} → ${res.status}: ${(j && j.error) || ''}`), { status: res.status });
    return j;
  };
  const waitJob = async (jid) => { for (;;) { const j = jobs.listJobs().find((x) => x.id === jid); if (j && j.state === 'done') return j; if (j && j.state === 'error') throw new Error(j.error); await sleep(1000); } };
  const vm = (vid) => api('GET', `/vms/${vid}`);
  const waitFor = async (what, fn, ms) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(3000); } throw new Error(`${what}: timeout (${typeof last === 'string' ? last : 'no answer'})`); };
  const id = 'p3-debian';

  /** Minimal RFB client over Hostwerk's WebSocket: version, security "None", ClientInit → ServerInit (size, name). */
  const rfb = (headers) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/vms/${id}/vnc`, ['binary'], { headers });
    let buf = Buffer.alloc(0); let stage = 0; const out = {};
    const t = setTimeout(() => { ws.terminate(); reject(new Error('RFB timeout')); }, 15000);
    ws.on('unexpected-response', (req, res) => { clearTimeout(t); reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
    ws.on('close', () => { if (stage < 4) { clearTimeout(t); reject(new Error(`closed in stage ${stage}`)); } });
    ws.on('message', (d) => {
      try {
        buf = Buffer.concat([buf, d]);
        if (stage === 0 && buf.length >= 12) { out.version = buf.subarray(0, 12).toString().trim(); buf = buf.subarray(12); ws.send(Buffer.from('RFB 003.008\n')); stage = 1; }
        if (stage === 1 && buf.length >= 1 && buf.length >= 1 + buf[0]) { const types = [...buf.subarray(1, 1 + buf[0])]; out.security = types; buf = buf.subarray(1 + buf[0]); must(types.includes(1), `security ${types}`); ws.send(Buffer.from([1])); stage = 2; }
        if (stage === 2 && buf.length >= 4) { must(buf.readUInt32BE(0) === 0, 'security failed'); buf = buf.subarray(4); ws.send(Buffer.from([1])); stage = 3; }
        if (stage === 3 && buf.length >= 24 && buf.length >= 24 + buf.readUInt32BE(20)) { out.width = buf.readUInt16BE(0); out.height = buf.readUInt16BE(2); out.name = buf.subarray(24, 24 + buf.readUInt32BE(20)).toString(); stage = 4; clearTimeout(t); ws.close(); resolve(out); }
      } catch (e) { clearTimeout(t); ws.terminate(); reject(e); }
    });
  });

  try {
    await step('Hostwerk test instance with the extension', async () => { server.ctx.extMarket.installFromDir(EXT, 'live-p3', { trusted: true }); await sleep(1500); return 'ok'; });
    for (const v of (await api('GET', '/vms')).vms) if (v.id === id) { await api('POST', `/vms/${id}/poweroff`).catch(() => {}); await sleep(2000); await api('DELETE', `/vms/${id}`); }
    const pw = `Hw-${crypto.randomBytes(5).toString('hex')}`;
    const ok = await step('Debian VM with sound (cloud image from the cache), guest agent up', async () => {
      const r = await api('POST', '/vms', { source: 'cloud', image: 'debian-12', name: 'P3 Debian', user: 'hwtest', password: pw, diskGb: 10, sound: true, start: true });
      await waitJob(r.job);
      const a = await waitFor('agent', async () => { const v = await vm(id); return v.status.agent && v.status.agent.ok ? v.status.agent : null; }, 8 * 60000);
      return a.os;
    });
    if (ok) {
      await step('#1 VNC through Hostwerk: WebSocket /ws/vms/<id>/vnc, RFB handshake up to the screen size', async () => {
        const v = await vm(id);
        must(v.status.ports && v.status.ports.vnc >= 5900, JSON.stringify(v.status.ports));
        const r = await rfb({ 'x-hostwerk-token': server.token, Origin: `http://127.0.0.1:${server.port}` });
        must(/^RFB 003\.00\d$/.test(r.version) && r.width > 0 && r.height > 0, JSON.stringify(r));
        return `${r.version}, ${r.width}×${r.height}, "${r.name}", port ${v.status.ports.vnc}`;
      });
      await step('#1 VNC without login is refused', async () => {
        const e = await rfb({ Origin: `http://127.0.0.1:${server.port}` }).then(() => null).catch((x) => x);
        must(e, 'connected without login!');
        return e.message;
      });
      await step('#5 File into the VM (drag & drop route) and back out – identical', async () => {
        const data = crypto.randomBytes(3 * 1048576 + 123);
        const up = await api('POST', `/vms/${id}/guest/upload?name=${encodeURIComponent('Bericht äö.bin')}`, data, { headers: { 'Content-Type': 'application/octet-stream' } });
        must(up.bytes === data.length && up.path.startsWith('/home/hwtest/'), JSON.stringify(up));
        const owner = await api('POST', `/vms/${id}/guest/exec`, { command: `stat -c %U '${up.path}'; sha256sum '${up.path}' | cut -c1-64` });
        const back = await api('GET', `/vms/${id}/guest/download?path=${encodeURIComponent(up.path)}`, undefined, { raw: true });
        const got = Buffer.from(await back.arrayBuffer());
        const sha = crypto.createHash('sha256').update(data).digest('hex');
        must(got.equals(data), `download differs (${got.length} bytes)`);
        must(owner.out.includes('hwtest') && owner.out.includes(sha), owner.out);
        const missing = await api('GET', `/vms/${id}/guest/download?path=/nope/x`, undefined, { raw: true });
        must(missing.status === 404, `missing file → ${missing.status}`);
        return `${(data.length / 1048576).toFixed(1)} MB → ${up.path} (owner hwtest, sha256 equal in the guest) and back; missing file → 404`;
      });
      await step('#19 Sound card in the guest (plays on this PC)', async () => {
        // Debian's cloud kernel has no sound drivers – check the device on the PCI bus (class 0x0403 = HD audio)
        const r = await api('POST', `/vms/${id}/guest/exec`, { command: 'for d in /sys/bus/pci/devices/*; do c=$(cat $d/class); case $c in 0x0403*) echo "$(basename $d) $c $(cat $d/vendor):$(cat $d/device)";; esac; done' });
        must(/0x0403/.test(r.out), r.out || r.err || 'no audio device on the PCI bus');
        return `HD audio controller in the guest: ${r.out.trim()}`;
      });
      await step('#18 3D (experimental): virtio-vga-gl in its own window – virgl in the guest', async () => {
        await api('POST', `/vms/${id}/stop`);
        await waitFor('stopped', async () => (await vm(id)).status.state === 'stopped', 120000);
        await api('PUT', `/vms/${id}`, { vga: 'virtio-gl', display: 'window' });
        await api('POST', `/vms/${id}/start`);
        await waitFor('agent', async () => { const v = await vm(id); return v.status.agent && v.status.agent.ok; }, 5 * 60000);
        const r = await api('POST', `/vms/${id}/guest/exec`, { command: 'dmesg | grep -iE "virgl|virtio_gpu|virtio-gpu" | tail -3' });
        must(/virgl/i.test(r.out), r.out || 'no virgl line');
        return r.out.trim().replace(/\n/g, ' · ');
      });
    }
  } finally {
    try { await api('POST', `/vms/${id}/poweroff`); await sleep(3000); await api('DELETE', `/vms/${id}`); } catch { /* egal */ }
    const pass = results.filter((r) => r.ok).length;
    fs.writeFileSync(path.join(OUT, 'report.md'), ['# Package 3 – real-life test', '', `${new Date().toISOString()} · ${pass}/${results.length} passed`, '', '| | Step | Time | Result |', '|---|---|---|---|', ...results.map((r) => `| ${r.ok ? '✓' : '✗'} | ${r.name} | ${(r.ms / 1000).toFixed(1)} s | ${r.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} |`)].join('\n'));
    log(`${pass}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
})().catch((e) => { console.error(e); process.exit(2); });
