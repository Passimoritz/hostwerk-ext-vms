'use strict';
/*
 * Real-life test of 3D (#18) through a real Hostwerk (port 7870), Windows only: a Debian 12 cloud VM with graphics
 * "3D" and the screen in its own window.
 *  1. QEMU gets virtio-vga-gl and sdl,gl=on, no VNC; the PNG screen answers 409 with a clear message (QEMU itself
 *     says "no surface").
 *  2. The cloud kernel has no virtio-gpu driver → Hostwerk's health check shows the hint for this VM.
 *  3. Standard kernel installed in the guest, VM restarted → virgl active, the guest renders through this PC's
 *     graphics card (renderer "virgl (…)"), glmark2 off-screen gives frames per second, the hint is gone.
 *  4. A picture of QEMU's own window (PrintWindow) with the console.
 * Debian image from the cache (no image download); the packages come from the internet in the guest.
 *
 *   node tests/live/gl.js <work folder with vms/.images>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const EXT = path.join(__dirname, '..', '..');
const HW = process.env.HW_CORE || path.join(EXT, '..', '..', 'hostwerk');
const WORK = path.resolve(process.argv[2]);
const OUT = path.join(WORK, 'report-gl');
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
const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' }).trim();

/** Picture of QEMU's window whose title names the VM (PrintWindow, also when it is covered). */
function windowShot(vmName, file) {
  return ps(`Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class HwW { [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f); }
"@
$p = Get-Process qemu-system-* | Where-Object { $_.MainWindowTitle -like '*${vmName.replace(/'/g, "''")}*' } | Select-Object -First 1
if (-not $p) { throw 'no QEMU window titled ${vmName.replace(/'/g, "''")}' }
$h = $p.MainWindowHandle
$r = New-Object HwW+R; [HwW]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Ri - $r.L; $hh = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $hh; $g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc(); [HwW]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc)
$bmp.Save('${file.replace(/'/g, "''")}'); "$($p.MainWindowTitle)|$w|$hh"`);
}

(async () => {
  if (process.platform !== 'win32') { console.log('Windows only (PrintWindow, WHPX).'); process.exit(0); }
  process.env.HW_TEST = '1'; process.env.HW_NO_AUTOUPDATE = '1';
  process.env.APPDATA = path.join(WORK, 'appdata-gl'); process.env.LOCALAPPDATA = path.join(WORK, 'localappdata-gl');
  process.env.HW_VMS_DIR = path.join(WORK, 'vms');
  const cached = JSON.parse(fs.readFileSync(path.join(WORK, 'vms', '.images', 'debian-12-genericcloud-amd64.qcow2.json'), 'utf8'));

  const { createServer } = require(path.join(HW, 'server', 'index'));
  const jobs = require(path.join(HW, 'server', 'core', 'jobs'));
  const contrib = require(path.join(HW, 'server', 'core', 'contrib'));
  const server = await createServer({ baseDir: path.join(WORK, 'hw-gl'), port: 7870 });
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
  const waitAgent = (vid, ms = 8 * 60000) => waitFor(`agent ${vid}`, async () => { const v = await vm(vid); return v.status.state === 'running' && v.status.agent && v.status.agent.ok ? v.status.agent : null; }, ms);
  const health = async () => { const out = []; for (const c of contrib.list('health')) out.push(...((await c.run()) || [])); return out; };
  const cmdline = (pid) => ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`);
  const G = 'gl-3d';

  try {
    let ext;
    await step('Hostwerk test instance with the extension (port 7870)', async () => { ext = server.ctx.extMarket.installFromDir(EXT, 'live-gl', { trusted: true }); await sleep(1500); return ext.dir; });
    for (const v of (await api('GET', '/vms')).vms) if (v.id === G) { await api('POST', `/vms/${G}/poweroff`).catch(() => {}); await sleep(2000); await api('DELETE', `/vms/${G}`); }
    const m = require(path.join(ext.dir, 'server', 'index')).manager;
    const realFetch = m.fetchText;
    m.fetchText = async (url) => (/bookworm\/latest\/SHA512SUMS$/.test(url) ? `${cached.hash}  debian-12-genericcloud-amd64.qcow2\n` : realFetch(url));
    m.downloadFile = async (url) => { throw new Error(`download refused in this test: ${url}`); };
    const pw = `Hw-${crypto.randomBytes(6).toString('hex')}`;

    const made = await step('3D VM (Debian 12, graphics 3D, own window): QEMU gets virtio-vga-gl with OpenGL, no VNC', async () => {
      const r = await api('POST', '/vms', { source: 'cloud', image: 'debian-12', name: 'GL 3D', user: 'hwtest', password: pw, diskGb: 8, memoryMb: 2048, vga: 'virtio-gl', display: 'window', start: true });
      await waitJob(r.job);
      const ag = await waitAgent(G);
      const v = await vm(G);
      const cl = cmdline(v.status.pid);
      must(/-device virtio-vga-gl/.test(cl) && /-display sdl,gl=on/.test(cl) && !/-vnc/.test(cl), cl.slice(0, 300));
      must(v.status.ports.vnc == null, `vnc port ${v.status.ports.vnc}`);
      return `${ag.os}, kernel ${ag.kernel}; -device virtio-vga-gl -display sdl,gl=on, no -vnc`;
    });
    if (!made) return;

    await step('PNG screen of the 3D VM: clear 409 instead of QEMU’s “no surface”', async () => {
      const r = await raw('GET', `/vms/${G}/screen`);
      const j = await r.json();
      must(r.status === 409 && /eigenen Fenster|own window/.test(j.error), `${r.status} ${JSON.stringify(j)}`);
      return `${r.status} “${j.error}”`;
    });

    await step('Cloud kernel without a 3D driver: no /dev/dri in the guest, health check names the VM', async () => {
      const r = await exec(G, 'uname -r; ls /dev/dri 2>&1; modinfo virtio_gpu 2>&1 | head -1');
      must(/cloud-amd64/.test(r.out) && /No such file|not found/.test(r.out), r.out);
      const hints = (await health()).filter((h) => /GL 3D/.test(h.text));
      must(hints.length === 1 && hints[0].fix === `#/vms/${G}`, JSON.stringify(await health()));
      return `${r.out.trim().split('\n').join(' · ')}; health: “${hints[0].text}”`;
    });

    await step('Standard kernel installed in the guest (the step the hint names), VM restarted', async () => {
      const inst = await exec(G, 'nohup sh -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -q && apt-get install -y -q linux-image-amd64 mesa-utils mesa-utils-bin glmark2-es2-drm && apt-get remove -y -q \'linux-image-*cloud*\' && touch /root/gl-done || touch /root/gl-failed" >/root/gl-install.log 2>&1 & echo started');
      must(/started/.test(inst.out), inst.out + inst.err);
      await waitFor('package install', async () => { const r = await exec(G, 'ls /root/gl-done /root/gl-failed 2>/dev/null; true'); if (/gl-failed/.test(r.out)) throw Object.assign(new Error((await exec(G, 'tail -n 20 /root/gl-install.log')).out), { fatal: true }); return /gl-done/.test(r.out); }, 15 * 60000, 10000);
      await api('POST', `/vms/${G}/restart`);
      await sleep(5000);
      const ag = await waitAgent(G, 5 * 60000);
      must(!/cloud/.test(ag.kernel || ''), `kernel ${ag.kernel}`);
      return `kernel now ${ag.kernel}`;
    });

    await step('virgl active: the guest renders through this PC’s graphics card', async () => {
      const r = await exec(G, 'dmesg | grep "features:" | head -1; ls /dev/dri; glmark2-es2-drm --off-screen -b build:duration=1 2>&1 | grep GL_RENDERER');
      must(/\+virgl/.test(r.out) && /renderD128/.test(r.out) && /GL_RENDERER:\s*virgl \(/.test(r.out), r.out);
      return r.out.trim().split('\n').map((l) => l.replace(/^\[[ \d.]+\] /, '').trim()).join(' · ');
    });

    await step('glmark2 (off-screen, OpenGL ES 2) – frames per second through virgl', async () => {
      const r = await exec(G, 'timeout 90 glmark2-es2-drm --off-screen -b build:duration=5 -b shading:shading=phong:duration=5 -b texture:duration=5 -b refract:duration=5 2>&1 | grep -E "GL_RENDERER|\\] |Score"', 120000);
      const score = Number((r.out.match(/Score:\s*(\d+)/) || [])[1]);
      must(score > 20 && /virgl/.test(r.out), r.out);
      fs.writeFileSync(path.join(OUT, 'glmark2.txt'), r.out);
      return `${r.out.split('\n').filter((l) => /\] /.test(l)).map((l) => l.trim().replace(/ FrameTime.*$/, '')).join(' · ')}; score ${score}`;
    });

    await step('Health hint gone after the switch to the standard kernel', async () => {
      await sleep(31000); // agent info is refreshed every 30 s
      const hints = (await health()).filter((h) => /GL 3D/.test(h.text));
      must(!hints.length, JSON.stringify(hints));
      return 'no hint for “GL 3D”';
    });

    await step('Picture of QEMU’s own OpenGL window (console of the guest)', async () => {
      const file = path.join(OUT, 'gl-window.png');
      const [title, w, h] = windowShot('GL 3D', file).split('|');
      const size = fs.statSync(file).size;
      must(Number(w) > 600 && Number(h) > 400 && size > 3000, `${title} ${w}×${h} ${size} bytes`);
      return `“${title}” ${w}×${h}, ${size} bytes → report-gl/gl-window.png`;
    });
  } finally {
    try { await api('POST', `/vms/${G}/poweroff`); } catch { /* egal */ }
    await sleep(3000);
    try { await api('DELETE', `/vms/${G}`); } catch { /* egal */ }
    const left = (await api('GET', '/vms').catch(() => ({ vms: [] }))).vms.filter((v) => v.id === G).length;
    results.push({ name: 'Clean-up: test VM powered off and deleted', ok: !left, ms: 0, detail: left ? 'left' : G });
    const pass = results.filter((r) => r.ok).length;
    fs.writeFileSync(path.join(OUT, 'report.md'), ['# 3D (virgl) – real-life test', '', `${new Date().toISOString()} · ${pass}/${results.length} passed`, '', '| | Step | Time | Result |', '|---|---|---|---|', ...results.map((r) => `| ${r.ok ? '✓' : '✗'} | ${r.name} | ${(r.ms / 1000).toFixed(1)} s | ${r.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} |`)].join('\n'));
    log(`${pass}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
})().catch((e) => { console.error(e); process.exit(2); });
