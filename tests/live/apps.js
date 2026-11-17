'use strict';
/*
 * Real-life test of the four app templates not covered by package5.js – WordPress, Nextcloud, Gitea, Uptime Kuma –
 * through a real Hostwerk (port 7869). Two at a time (RAM): each VM from the Debian 12 cloud image, setup finished
 * (marker app-ready), the "Open …" address answers from this PC, the app really works (WordPress and Nextcloud are
 * installed through their own installers and used), and after a restart of the VM the app is back with its data.
 * The Debian image comes from the cache (no image download); the packages and containers come from the internet in
 * the guest.
 *
 *   node tests/live/apps.js <work folder with vms/.images> [--only=wordpress,gitea]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXT = path.join(__dirname, '..', '..');
const HW = process.env.HW_CORE || path.join(EXT, '..', '..', 'hostwerk');
const WORK = path.resolve(process.argv[2]);
const ONLY = ((process.argv.find((a) => a.startsWith('--only=')) || '').slice(7) || 'wordpress,gitea,nextcloud,uptime-kuma').split(',');
const OUT = path.join(WORK, 'report-apps');
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
const form = (o) => new URLSearchParams(o).toString();

(async () => {
  process.env.HW_TEST = '1'; process.env.HW_NO_AUTOUPDATE = '1';
  process.env.APPDATA = path.join(WORK, 'appdata-apps'); process.env.LOCALAPPDATA = path.join(WORK, 'localappdata-apps');
  process.env.HW_VMS_DIR = path.join(WORK, 'vms');
  const cached = JSON.parse(fs.readFileSync(path.join(WORK, 'vms', '.images', 'debian-12-genericcloud-amd64.qcow2.json'), 'utf8'));

  const { createServer } = require(path.join(HW, 'server', 'index'));
  const jobs = require(path.join(HW, 'server', 'core', 'jobs'));
  const server = await createServer({ baseDir: path.join(WORK, 'hw-apps'), port: 7869 });
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
  const get = async (url, opts = {}) => { const r = await fetch(url, { redirect: 'follow', ...opts }); return { status: r.status, url: r.url, text: await r.text(), headers: r.headers }; };
  const pw = `Hw-${crypto.randomBytes(6).toString('hex')}`;
  const appPw = `Hw-App-${crypto.randomBytes(6).toString('hex')}`;

  /* What “works” means per app: first(url) right after the setup, again(url) after the VM restarted. */
  const APPS = {
    wordpress: {
      name: 'Apps WordPress', memoryMb: 2048, diskGb: 10, ready: 'setup wizard, install, log in',
      async first(url, vid) {
        const a = await get(url);
        must(a.status === 200 && /wp-admin\/install\.php/.test(a.url) && /WordPress/.test(a.text), `${a.status} ${a.url} ${a.text.slice(0, 200)}`);
        const r = await get(`${url}wp-admin/install.php?step=2`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ weblog_title: 'Hostwerk Live Blog', user_name: 'hwadmin', admin_password: appPw, admin_password2: appPw, pw_weak: 'on', admin_email: 'admin@example.invalid', blog_public: '0', language: '' }) });
        must(r.status === 200 && /wp-login\.php/.test(r.text), `install ${r.status} ${r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)}`);
        const home = await get(url);
        must(home.status === 200 && /Hostwerk Live Blog/.test(home.text), `home ${home.status} ${home.text.slice(0, 200)}`);
        const login = await fetch(`${url}wp-login.php`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'wordpress_test_cookie=WP%20Cookie%20check' }, body: form({ log: 'hwadmin', pwd: appPw, testcookie: '1', 'wp-submit': 'Log In', redirect_to: `${url}wp-admin/` }) });
        const cookies = (login.headers.getSetCookie ? login.headers.getSetCookie() : []).filter((c) => /wordpress_logged_in/.test(c));
        must(login.status === 302 && cookies.length, `login ${login.status} ${login.headers.get('location')}`);
        const db = await exec(vid, 'mysql -N -e "SELECT option_value FROM wordpress.wp_options WHERE option_name=\'blogname\'"');
        return `wizard at ${a.url.replace(url, '/')}; installed through the wizard; start page shows “Hostwerk Live Blog”; login hwadmin → 302 with session cookie; MariaDB blogname: ${db.out.trim()}`;
      },
      async again(url) {
        const home = await get(url);
        must(home.status === 200 && /Hostwerk Live Blog/.test(home.text), `${home.status} ${home.text.slice(0, 200)}`);
        return 'start page with “Hostwerk Live Blog” (data in MariaDB kept)';
      },
    },
    nextcloud: {
      name: 'Apps Nextcloud', memoryMb: 2048, diskGb: 12, ready: 'install, WebDAV upload and download',
      async first(url, vid) {
        const s0 = JSON.parse((await get(`${url}status.php`)).text);
        must(s0.installed === false && /Nextcloud/.test(s0.productname), JSON.stringify(s0));
        const page = await get(url);
        must(page.status === 200 && /Nextcloud/.test(page.text), `${page.status}`);
        const inst = await exec(vid, `docker exec -u www-data nextcloud php occ maintenance:install --database sqlite --admin-user hwadmin --admin-pass '${appPw}' 2>&1 | tail -n 2`, 600000);
        must(inst.code === 0 && /installed/i.test(inst.out), inst.out + inst.err);
        const s1 = JSON.parse((await get(`${url}status.php`)).text);
        must(s1.installed === true, JSON.stringify(s1));
        const auth = { Authorization: `Basic ${Buffer.from(`hwadmin:${appPw}`).toString('base64')}` };
        const body = `Hostwerk ${new Date().toISOString()} ä ö ü`;
        const put = await fetch(`${url}remote.php/dav/files/hwadmin/hostwerk-test.txt`, { method: 'PUT', headers: auth, body });
        must(put.status === 201 || put.status === 204, `PUT ${put.status}`);
        const back = await get(`${url}remote.php/dav/files/hwadmin/hostwerk-test.txt`, { headers: auth });
        must(back.status === 200 && back.text === body, `GET ${back.status} ${back.text}`);
        this.body = body;
        return `${s1.productname} ${s1.versionstring}, status.php installed false → true after occ maintenance:install; WebDAV PUT ${put.status}, GET returns the file unchanged (umlauts included)`;
      },
      async again(url) {
        const auth = { Authorization: `Basic ${Buffer.from(`hwadmin:${appPw}`).toString('base64')}` };
        const back = await get(`${url}remote.php/dav/files/hwadmin/hostwerk-test.txt`, { headers: auth });
        must(back.status === 200 && back.text === this.body, `GET ${back.status} ${back.text.slice(0, 200)}`);
        return 'container back, the uploaded file is still there';
      },
    },
    gitea: {
      name: 'Apps Gitea', memoryMb: 1024, diskGb: 10, ready: 'installation page',
      async first(url, vid) {
        const a = await get(url);
        must(a.status === 200 && /Gitea/.test(a.text) && /(Installation|Initial Configuration|install)/i.test(a.text), `${a.status} ${a.text.slice(0, 200)}`);
        const v = await exec(vid, 'docker exec gitea gitea --version');
        return `GET / → 200 installation page; ${v.out.trim().split(' built')[0]}`;
      },
      async again(url) {
        const a = await get(url);
        must(a.status === 200 && /Gitea/.test(a.text), `${a.status}`);
        return 'container back, page answers';
      },
    },
    'uptime-kuma': {
      name: 'Apps Uptime Kuma', memoryMb: 1024, diskGb: 10, ready: 'first-run setup page',
      async first(url, vid) {
        const a = await get(url);
        must(a.status === 200 && /Uptime Kuma/.test(a.text), `${a.status} ${a.url} ${a.text.slice(0, 200)}`);
        const v = await exec(vid, 'docker inspect -f "{{.Config.Image}} {{.State.Health.Status}}" uptime-kuma');
        return `GET / → 200 “Uptime Kuma” (${a.url.replace(url, '/')}); ${v.out.trim()}`;
      },
      async again(url) {
        const a = await get(url);
        must(a.status === 200 && /Uptime Kuma/.test(a.text), `${a.status}`);
        return 'container back, page answers';
      },
    },
  };
  const idOf = (key) => APPS[key].name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const keys = ONLY.filter((k) => APPS[k]);
  const ids = keys.map(idOf);

  let ext = null;
  try {
    await step('Hostwerk test instance with the extension (port 7869)', async () => { ext = server.ctx.extMarket.installFromDir(EXT, 'live-apps', { trusted: true }); await sleep(1500); return ext.dir; });
    for (const v of (await api('GET', '/vms')).vms) if (ids.includes(v.id)) { await api('POST', `/vms/${v.id}/poweroff`).catch(() => {}); await sleep(2000); await api('DELETE', `/vms/${v.id}`); }
    const m = require(path.join(ext.dir, 'server', 'index')).manager;
    const realFetch = m.fetchText;
    m.fetchText = async (url) => (/bookworm\/latest\/SHA512SUMS$/.test(url) ? `${cached.hash}  debian-12-genericcloud-amd64.qcow2\n` : realFetch(url));
    m.downloadFile = async (url) => { throw new Error(`download refused in this test: ${url}`); };

    const pairs = [];
    for (let i = 0; i < keys.length; i += 2) pairs.push(keys.slice(i, i + 2));
    for (const pair of pairs) {
      const label = pair.map((k) => APPS[k].name.replace('Apps ', '')).join(' + ');
      const made = await step(`${label}: VMs from the app templates, started`, async () => {
        const rs = await Promise.all(pair.map((k) => api('POST', '/vms', { source: 'cloud', image: 'debian-12', name: APPS[k].name, user: 'hwtest', password: pw, diskGb: APPS[k].diskGb, memoryMb: APPS[k].memoryMb, app: k, start: true })));
        await Promise.all(rs.map((r) => waitJob(r.job)));
        const ag = await Promise.all(pair.map((k) => waitAgent(idOf(k))));
        const vs = await Promise.all(pair.map((k) => vm(idOf(k))));
        return vs.map((v, i) => `${v.name}: ${ag[i].os}, ${v.memoryMb} MB, forwards ${v.net.forwards.map((f) => `${f.host}→${f.guest}`).join(' ')}, button “${v.appInfo.open.label}” → ${v.appInfo.open.url}`).join(' · ');
      });
      if (!made) continue;
      await Promise.all(pair.map(async (k) => {
        const vid = idOf(k); const A = APPS[k]; const nm = A.name.replace('Apps ', '');
        const ok = await step(`${nm}: setup finished in the guest (marker app-ready)`, async () => {
          const s = Date.now();
          const st = await waitFor(`app ${vid}`, async () => { const r = await api('GET', `/vms/${vid}/app`); if (r.app === 'failed') throw Object.assign(new Error(`setup failed: ${r.log.slice(-600)}`), { fatal: true }); return r.app === 'ok' ? r : null; }, 25 * 60000, 10000);
          return `app=${st.app}, ${(Date.now() - s) / 1000 | 0} s after the agent answered`;
        });
        if (!ok) { const r = await api('GET', `/vms/${vid}/app`).catch(() => null); if (r) fs.writeFileSync(path.join(OUT, `${k}-setup.log`), String(r.log)); return; }
        const url = (await vm(vid)).appInfo.open.url;
        const works = await step(`${nm}: works through the “Open” address (${A.ready})`, () => A.first(url, vid));
        if (!works) return;
        await step(`${nm}: after a restart of the VM the app is back`, async () => {
          const s = Date.now();
          await api('POST', `/vms/${vid}/restart`);
          await sleep(5000);
          await waitAgent(vid, 5 * 60000);
          const d = await waitFor(`${nm} after restart`, () => A.again(url), 5 * 60000, 5000);
          const up = parseFloat((await exec(vid, 'cut -d" " -f1 /proc/uptime')).out);
          must(up < (Date.now() - s) / 1000, `guest uptime ${up} s – the VM did not restart`);
          return `${d}, ${(Date.now() - s) / 1000 | 0} s (guest uptime ${up | 0} s)`;
        });
      }));
      for (const k of pair) { try { await api('POST', `/vms/${idOf(k)}/poweroff`); } catch { /* egal */ } }
      await sleep(4000);
      for (const k of pair) { try { await api('DELETE', `/vms/${idOf(k)}`); } catch { /* egal */ } }
    }
  } finally {
    for (const vid of ids) { try { await api('POST', `/vms/${vid}/poweroff`); } catch { /* egal */ } }
    await sleep(3000);
    for (const vid of ids) { try { await api('DELETE', `/vms/${vid}`); } catch { /* egal */ } }
    const left = (await api('GET', '/vms').catch(() => ({ vms: [] }))).vms.filter((v) => ids.includes(v.id)).map((v) => v.id);
    results.push({ name: 'Clean-up: test VMs powered off and deleted', ok: !left.length, ms: 0, detail: left.length ? `left: ${left}` : ids.join(', ') });
    const pass = results.filter((r) => r.ok).length;
    fs.writeFileSync(path.join(OUT, 'report.md'), ['# App templates – real-life test', '', `${new Date().toISOString()} · ${pass}/${results.length} passed`, '', '| | Step | Time | Result |', '|---|---|---|---|', ...results.map((r) => `| ${r.ok ? '✓' : '✗'} | ${r.name} | ${(r.ms / 1000).toFixed(1)} s | ${r.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} |`)].join('\n'));
    log(`${pass}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
})().catch((e) => { console.error(e); process.exit(2); });
