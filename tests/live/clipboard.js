'use strict';
/*
 * Real-life test for the clipboard (#6) with a Windows guest through a real Hostwerk (port 7868): the installed
 * Windows VM of the package-2 test is started, a user signs in (password set through the guest agent, typed on the
 * lock screen), and text goes both ways through QEMU's VNC with the extended clipboard – the same protocol noVNC in
 * Hostwerk's screen uses: QEMU vdagent ↔ spice-vdagent in Windows ↔ the user's clipboard.
 *
 *   node tests/live/clipboard.js <work folder of package2> [vm id, default p2-windows]
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');

const EXT = path.join(__dirname, '..', '..');
const HW = process.env.HW_CORE || path.join(EXT, '..', '..', 'hostwerk');
const WORK = path.resolve(process.argv[2]);
const ID = process.argv[3] || 'p2-windows';
const OUT = path.join(WORK, 'report-clip');
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

/* ---- minimal RFB client with the extended clipboard (pseudo-encoding 0xC0A1E5CE), as noVNC does it ---- */
const EXT_CLIP = 0xC0A1E5CE | 0;
const CAPS = 0x01000000; const REQUEST = 0x02000000; const PEEK = 0x04000000; const NOTIFY = 0x08000000; const PROVIDE = 0x10000000; const TEXT = 1;
function rfb(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0); let stage = 'version'; const ev = { serverCaps: 0, onText: null, onRequest: null };
    const need = (n) => buf.length >= n;
    const take = (n) => { const b = buf.subarray(0, n); buf = buf.subarray(n); return b; };
    const sendCut = (flags, payload) => { const h = Buffer.alloc(12); h[0] = 6; h.writeInt32BE(-(4 + payload.length), 4); h.writeUInt32BE(flags >>> 0, 8); s.write(Buffer.concat([h, payload])); };
    const api = {
      ev,
      close: () => s.destroy(),
      notifyText: () => sendCut(NOTIFY | TEXT, Buffer.alloc(0)),
      provideText: (text) => { const t = Buffer.from(`${text}\0`, 'utf8'); const len = Buffer.alloc(4); len.writeUInt32BE(t.length); sendCut(PROVIDE | TEXT, zlib.deflateSync(Buffer.concat([len, t]))); },
      requestText: () => sendCut(REQUEST | TEXT, Buffer.alloc(0)),
    };
    s.on('error', reject);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 'version') { if (!need(12)) return; take(12); s.write('RFB 003.008\n'); stage = 'sec'; continue; }
        if (stage === 'sec') { if (!need(1)) return; const n = buf[0]; if (!need(1 + n)) return; const types = [...take(1 + n).subarray(1)]; if (!types.includes(1)) return reject(new Error(`VNC wants a password (types ${types})`)); s.write(Buffer.from([1])); stage = 'secres'; continue; }
        if (stage === 'secres') { if (!need(4)) return; if (take(4).readUInt32BE(0) !== 0) return reject(new Error('VNC security failed')); s.write(Buffer.from([1])); stage = 'init'; continue; }
        if (stage === 'init') {
          if (!need(24)) return; const nl = buf.readUInt32BE(20); if (!need(24 + nl)) return; take(24 + nl);
          const enc = Buffer.alloc(4 + 8); enc[0] = 2; enc.writeUInt16BE(2, 2); enc.writeInt32BE(0, 4); enc.writeInt32BE(EXT_CLIP, 8); s.write(enc);
          // our capabilities: text, all actions, up to 1 MB
          const caps = Buffer.alloc(4); caps.writeUInt32BE(1 << 20); sendCut(CAPS | REQUEST | PEEK | NOTIFY | PROVIDE | TEXT, caps);
          stage = 'msg'; resolve(api); continue;
        }
        // server messages: only cut text (3) and bell (2) arrive – we never ask for screen updates
        if (!need(1)) return;
        if (buf[0] === 2) { take(1); continue; }
        if (buf[0] !== 3) { log(`   (VNC message type ${buf[0]} ignored)`); buf = Buffer.alloc(0); return; }
        if (!need(8)) return;
        const len = buf.readInt32BE(4); const abs = Math.abs(len);
        if (!need(8 + abs)) return;
        const m = take(8 + abs).subarray(8);
        if (len >= 0) { if (ev.onText) ev.onText(m.toString('latin1'), 'legacy'); continue; }
        const flags = m.readUInt32BE(0) >>> 0; const body = m.subarray(4);
        if (process.env.CLIP_DEBUG) log(`   VNC clipboard from QEMU: flags 0x${flags.toString(16)}, ${body.length} bytes`);
        if (flags & CAPS) { ev.serverCaps = flags; continue; }
        if ((flags & NOTIFY) && (flags & TEXT)) { api.requestText(); continue; }
        if ((flags & REQUEST) && (flags & TEXT)) { if (ev.onRequest) ev.onRequest(); continue; }
        if ((flags & PROVIDE) && (flags & TEXT) && body.length) {
          const raw = zlib.inflateSync(body); const n = raw.readUInt32BE(0);
          if (ev.onText) ev.onText(raw.subarray(4, 4 + n).toString('utf8').replace(/\0+$/, ''), 'extended');
        }
      }
    });
  });
}

(async () => {
  process.env.HW_TEST = '1'; process.env.HW_NO_AUTOUPDATE = '1';
  process.env.APPDATA = path.join(WORK, 'appdata'); process.env.LOCALAPPDATA = path.join(WORK, 'localappdata');
  process.env.HW_VMS_DIR = path.join(WORK, 'vms');
  const { createServer } = require(path.join(HW, 'server', 'index'));
  const server = await createServer({ baseDir: path.join(WORK, 'hw-clip'), port: 7868 });
  const H = { 'x-hostwerk-token': server.token, 'Content-Type': 'application/json' };
  const raw = (method, p, body) => fetch(`http://127.0.0.1:${server.port}/api${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const api = async (method, p, body) => { const res = await raw(method, p, body); const j = await res.json().catch(() => null); if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${(j && j.error) || ''}`); return j; };
  const vm = () => api('GET', `/vms/${ID}`);
  const ps = async (command, timeoutMs = 60000) => { const r = await api('POST', `/vms/${ID}/guest/exec`, { command, timeoutMs }); return (r.out || '').trim(); };
  const waitFor = async (what, fn, ms, every = 3000) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(every); } throw new Error(`${what}: timeout (${typeof last === 'string' ? last : 'no answer'})`); };
  const shot = async (f) => { try { const r = await raw('GET', `/vms/${ID}/screen`); if (r.status === 200) fs.writeFileSync(path.join(OUT, f), Buffer.from(await r.arrayBuffer())); } catch { /* egal */ } };
  // runs PowerShell inside the signed-in user's session (the agent itself runs as SYSTEM in session 0, without the user's clipboard)
  const asUser = async (script) => {
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    await ps(`$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -STA -EncodedCommand ${b64}'; `
      + "$p = New-ScheduledTaskPrincipal -UserId 'hwtest' -LogonType Interactive; Register-ScheduledTask -TaskName hwclip -Action $a -Principal $p -Force | Out-Null; Start-ScheduledTask -TaskName hwclip; "
      + "$t = 0; while ((Get-ScheduledTask -TaskName hwclip).State -eq 'Running' -and $t -lt 40) { Start-Sleep -Milliseconds 250; $t++ }; Unregister-ScheduledTask -TaskName hwclip -Confirm:$false");
  };
  const pw = `Hw-${crypto.randomBytes(4).toString('hex')}!`;
  let c = null;

  try {
    await step('Hostwerk test instance (port 7868), start the installed Windows VM', async () => {
      server.ctx.extMarket.installFromDir(EXT, 'live-clip', { trusted: true }); await sleep(1500);
      const v0 = await vm();
      if (v0.status.state !== 'running') await api('POST', `/vms/${ID}/start`);
      const a = await waitFor('guest agent', async () => { const v = await vm(); return v.status.agent && v.status.agent.ok ? v.status.agent : null; }, 6 * 60000);
      return `${a.os}`;
    });
    await step('SPICE agent (spice-vdagent) runs in Windows', async () => {
      const o = await waitFor('vdagent service', async () => { const x = await ps("Get-Service | Where-Object { $_.Name -match 'spice|vdservice|vdagent' } | ForEach-Object { \"$($_.Name)=$($_.Status)\" }"); return /Running/.test(x) ? x : null; }, 3 * 60000, 10000);
      return o.replace(/\r?\n/g, ', ');
    });
    await step('User hwtest signs in (password set through the agent, typed on the lock screen)', async () => {
      await ps(`net user hwtest '${pw}' | Out-Null`);
      const logged = async () => /hwtest/i.test(await ps('(Get-CimInstance Win32_ComputerSystem).UserName'));
      if (!(await logged())) {
        await api('POST', `/vms/${ID}/type`, { text: ' ' }); await sleep(2500); // lift the lock-screen curtain
        await api('POST', `/vms/${ID}/type`, { text: `${pw}\n` });
        await waitFor('sign-in', logged, 90000);
      }
      await waitFor('explorer of hwtest', async () => /hwtest/i.test(await ps("(Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue).UserName -join ','")), 90000);
      await sleep(8000); // vdagent attaches to the new session
      await shot('clip-desktop.png');
      return 'signed in, explorer runs';
    });
    await step('VNC with extended clipboard (as noVNC): QEMU offers text', async () => {
      const v = await vm();
      must(v.status.ports && v.status.ports.vnc, 'no VNC port');
      c = await rfb(v.status.ports.vnc);
      await waitFor('server caps', async () => c.ev.serverCaps, 10000, 200);
      must(c.ev.serverCaps & TEXT, `caps 0x${c.ev.serverCaps.toString(16)}`);
      return `port ${v.status.ports.vnc}, server caps 0x${(c.ev.serverCaps >>> 0).toString(16)}`;
    });
    const fromGuest = `Aus Windows: Grüße ÄÖÜ ß € ${crypto.randomBytes(3).toString('hex')}`;
    await step('Windows → PC: text copied in Windows arrives at the VNC client', async () => {
      const got = [];
      c.ev.onText = (t, kind) => got.push([t, kind]);
      await asUser(`Set-Clipboard -Value '${fromGuest}'`);
      await waitFor('clipboard text from the guest', async () => got.find(([t]) => t === fromGuest), 20000, 300);
      return `“${fromGuest}” (${got.find(([t]) => t === fromGuest)[1]})`;
    });
    const fromHost = `Vom PC: Straße Ü € ${crypto.randomBytes(3).toString('hex')}`;
    await step('PC → Windows: text pasted in Hostwerk lands in the Windows clipboard', async () => {
      c.ev.onRequest = () => c.provideText(fromHost);
      c.notifyText();
      const file = 'C:\\Users\\Public\\hw-clip.txt';
      let seen = '';
      await waitFor('clipboard in the guest', async () => {
        await asUser(`Get-Clipboard -Raw | Set-Content -Encoding UTF8 -LiteralPath '${file}'`);
        const t = await ps(`Get-Content -Raw -Encoding UTF8 -LiteralPath '${file}' -ErrorAction SilentlyContinue`);
        seen = t;
        if (t.trim() === fromHost) return t.trim();
        throw new Error(`guest has ${JSON.stringify(t)} (${[...t].slice(-3).map((ch) => ch.codePointAt(0).toString(16)).join(' ')})`);
      }, 30000, 2000).catch((e) => { throw new Error(`${e.message}; last read ${JSON.stringify(seen)}`); });
      await ps(`Remove-Item -LiteralPath '${file}' -Force -ErrorAction SilentlyContinue`);
      return `“${fromHost}”`;
    });
  } finally {
    if (c) c.close();
    const pass = results.filter((r) => r.ok).length;
    fs.writeFileSync(path.join(OUT, 'report.md'), ['# Clipboard with Windows – real-life test', '', `${new Date().toISOString()} · ${pass}/${results.length} passed`, '', '| | Step | Time | Result |', '|---|---|---|---|', ...results.map((r) => `| ${r.ok ? '✓' : '✗'} | ${r.name} | ${(r.ms / 1000).toFixed(1)} s | ${r.detail.replace(/\|/g, '/')} |`)].join('\n'));
    log(`${pass}/${results.length} passed`);
    try { await api('POST', `/vms/${ID}/stop`); } catch { /* egal */ }
    await sleep(30000);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
})().catch((e) => { console.error(e); process.exit(2); });
