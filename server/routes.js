'use strict';
/*
 * API under /api/vms – same sign-in as Hostwerk (host.router). Long steps answer with { job } (Hostwerk's job list shows
 * progress); the screen answers with a PNG and an ETag, so the page only loads changed frames.
 */
const catalog = require('./catalog');
const U = require('./util');

function routes(router, m) {
  const h = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out === undefined ? { ok: true } : out);
    } catch (e) {
      if (!res.headersSent) res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 500).json({ error: e.message, code: e.code || null });
    }
  };
  const body = (req) => req.body || {};
  const job = (j) => ({ job: j.id, id: j.vmId || null });

  // ---- Everything at once (list page) ----
  router.get('/vms', h(async () => ({ vms: m.list(), vbox: await m.vboxList(), hyperv: await m.hypervState().catch(() => ({ available: false, vms: [] })), config: m.config() })));
  // App templates (#9) – ready app VMs on top of the cloud images
  router.get('/vms/apps', h(() => ({ items: require('./apps').list() })));
  // Hyper-V (#21): listing (quietly "not available" without the module), start/stop/checkpoint with admin rights
  router.get('/vms/hyperv', h((req) => m.hypervState({ fresh: req.query.fresh === '1' })));
  router.post('/vms/hyperv/:hid/:action', h((req) => m.hypervAction(req.params.hid, req.params.action, body(req))));
  router.get('/vms/engines', h((req) => m.engines({ fresh: req.query.fresh === '1' })));
  router.post('/vms/engines/install-qemu', h(() => job(m.installQemu())));
  router.get('/vms/catalog', h(() => ({ items: catalog.list(), cache: m.listImages() })));
  router.delete('/vms/images/:file', h((req) => { m.removeImage(req.params.file); return { cache: m.listImages() }; }));
  router.get('/vms/config', h(() => m.config()));
  router.put('/vms/config', h((req) => m.setConfig(body(req))));
  router.post('/vms/plan', h((req) => { const vm = m.plan(body(req)); return { vm, memory: require('./spec').memoryCheck(m.runningMemoryMb(), vm.memoryMb, m.hostRes.memoryMb) }; }));

  // ---- Internal networks (#7) and TAP adapters for the network bridge (#14) ----
  router.get('/vms/networks', h(() => ({ networks: m.networks() })));
  router.post('/vms/networks', h((req) => m.addNetwork(body(req))));
  router.put('/vms/networks/:net', h((req) => m.renameNetwork(req.params.net, body(req))));
  router.delete('/vms/networks/:net', h((req) => m.removeNetwork(req.params.net)));
  router.get('/vms/networks/:net/suggest', h((req) => ({ ip: m.suggestIp(req.params.net) })));
  router.get('/vms/taps', h(async () => ({ taps: await m.listTapsFn(), platform: m.platform })));

  // ---- VirtualBox ----
  router.get('/vms/vbox', h(async () => ({ vms: await m.vboxList({ fresh: true }) })));
  router.get('/vms/vbox/:uuid', h((req) => m.vbox.vm(req.params.uuid)));
  router.get('/vms/vbox/:uuid/screen', h(async (req, res) => { const png = await m.vbox.screenshot(req.params.uuid); res.set('Cache-Control', 'no-store').type('png').send(png); }));
  router.post('/vms/vbox/:uuid/import', h((req) => job(m.create({ ...body(req), source: 'vbox', uuid: req.params.uuid }))));
  router.delete('/vms/vbox/:uuid', h(async (req) => { await m.vbox.removeManaged(req.params.uuid); m.vboxCache.at = 0; return { ok: true }; }));
  router.post('/vms/vbox/:uuid/:action', h((req) => m.vboxAction(req.params.uuid, req.params.action, body(req))));

  // ---- Create ----
  router.post('/vms', h((req) => job(m.create(body(req)))));

  // ---- One VM ----
  router.get('/vms/:id', h((req) => m.detail(req.params.id)));
  router.put('/vms/:id', h((req) => m.update(req.params.id, body(req))));
  router.delete('/vms/:id', h((req) => m.remove(req.params.id)));
  router.post('/vms/:id/start', h((req) => m.start(req.params.id, { once: body(req).once || null })));
  router.post('/vms/:id/stop', h((req) => m.stop(req.params.id, { force: !!body(req).force })));
  router.post('/vms/:id/poweroff', h((req) => m.stop(req.params.id, { force: true })));
  // Hostwerk's service menu ("stop immediately", asks first) and Hostwerk.services(): kill = power off
  router.post('/vms/:id/kill', h((req) => m.stop(req.params.id, { force: true })));
  router.post('/vms/:id/restart', h((req) => m.restart(req.params.id)));
  // Shared folders (#13): mount now (Linux, through the guest agent) – Windows gets the command for its own session
  router.post('/vms/:id/shares/:share/mount', h((req) => m.mountShare(req.params.id, req.params.share)));
  // Encrypted disks (#15)
  router.post('/vms/:id/encrypt', h((req) => job(m.encryptDisks(req.params.id))));
  router.get('/vms/:id/disk-key', h((req) => m.diskKey(req.params.id)));
  router.post('/vms/:id/unlock', h((req) => m.unlock(req.params.id, body(req))));
  for (const a of ['pause', 'resume', 'reset', 'combo', 'type']) router.post(`/vms/:id/${a}`, h((req) => m.control(req.params.id, a, body(req))));
  router.post('/vms/:id/input', h(async (req) => ({ n: await m.rt(U.checkId(req.params.id)).input(body(req).events) })));
  router.get('/vms/:id/screen', h(async (req, res) => {
    const shot = await m.rt(m.get(req.params.id).id).screen();
    res.set('ETag', `"${shot.etag}"`).set('Cache-Control', 'no-store');
    if (req.headers['if-none-match'] === `"${shot.etag}"`) { res.status(304).end(); return; }
    res.type('png').send(shot.png);
  }));
  router.get('/vms/:id/serial', h((req) => m.rt(m.get(req.params.id).id).serialSince(req.query.since)));
  router.post('/vms/:id/serial', h((req) => { m.rt(m.get(req.params.id).id).serialWrite(body(req).data); return { ok: true }; }));
  // App template / start script state in the guest (#9), what the AI would get about the screen and its answer (#20)
  router.get('/vms/:id/app', h((req) => m.appStatus(req.params.id)));
  router.get('/vms/:id/ai/context', h((req) => m.screenContext(req.params.id)));
  router.post('/vms/:id/ai/explain', h((req) => m.aiExplain(req.params.id, { question: body(req).question, lang: body(req).lang })));
  router.get('/vms/:id/agent', h(async (req) => { const r = m.rt(m.get(req.params.id).id); await r.pollAgent(); return r.agentInfo; }));

  router.post('/vms/:id/disks', h((req) => (body(req).file ? job(m.attachDisk(req.params.id, body(req))) : m.addDisk(req.params.id, body(req)))));
  router.post('/vms/:id/disks/:disk/compact', h((req) => job(m.compactDisk(req.params.id, req.params.disk))));
  router.post('/vms/:id/guest/trim', h((req) => m.guestTrim(req.params.id)));
  router.get('/vms/:id/guest/fs', h((req) => m.guestFs(req.params.id)));
  router.post('/vms/:id/guest/exec', h((req) => m.guestExec(req.params.id, body(req).command, { timeout: Math.min(600000, Math.max(1000, Number(body(req).timeoutMs) || 60000)) })));
  // Files into the VM (drag & drop, #5): raw body, stored on the desktop/in the home folder of the VM's user
  router.post('/vms/:id/guest/upload', h(async (req) => {
    const vm = m.get(req.params.id);
    if (!m.isRunning(vm.id)) throw U.fail(409, 'The VM is not running.');
    const r = m.rt(vm.id);
    if (!r.agentInfo || !r.agentInfo.ok) throw U.fail(409, 'The guest agent is not connected – files go through it.');
    const target = await r.guestTarget(req.query.name);
    const bytes = await r.guestWriteFile(target.path, req);
    if (target.owner) await r.guestExec(`chown ${target.owner}: '${target.path.replace(/'/g, "'\\''")}'`, { timeout: 15000 }).catch(() => {});
    return { path: target.path, bytes };
  }));
  // A file out of the VM: streamed to the browser
  router.get('/vms/:id/guest/download', async (req, res) => {
    try {
      const vm = m.get(req.params.id);
      if (!m.isRunning(vm.id)) throw U.fail(409, 'The VM is not running.');
      const p = String(req.query.path || '');
      if (!p || p.length > 1000) throw U.fail(400, 'Path in the VM missing.');
      const name = p.split(/[\\/]/).pop().replace(/[^\w.\-() ]+/g, '_') || 'file';
      res.set('Content-Type', 'application/octet-stream').set('Content-Disposition', `attachment; filename="${name}"`);
      await m.rt(vm.id).guestReadFile(p, (b) => new Promise((ok) => { if (res.write(b)) ok(); else res.once('drain', ok); }));
      res.end();
    } catch (e) {
      const missing = /No such file|cannot find|not found|failed to open/i.test(e.message);
      if (!res.headersSent) res.status(missing ? 404 : e.status || 500).json({ error: missing ? U.T('File not found in the VM.') : e.message });
      else res.destroy();
    }
  });
  router.post('/vms/:id/guest/update', h((req) => job(m.guestUpdate(req.params.id))));
  router.post('/vms/:id/snapshots/auto-run', h(async (req) => { const vm = m.get(req.params.id); await m.takeSnapshot(vm.id, { name: m.freeSnapName(vm.id, `auto-${require('./manager').stamp()}`), note: 'Automatic snapshot', auto: true }); return { pruned: await m.pruneAutoSnaps(vm.id) }; }));
  router.put('/vms/:id/disks/:disk', h((req) => m.resizeDisk(req.params.id, req.params.disk, body(req))));
  router.delete('/vms/:id/disks/:disk', h((req) => m.removeDisk(req.params.id, req.params.disk)));

  router.post('/vms/:id/snapshots', h((req) => m.takeSnapshot(req.params.id, body(req))));
  router.post('/vms/:id/snapshots/:name/restore', h((req) => m.restoreSnapshot(req.params.id, req.params.name)));
  router.delete('/vms/:id/snapshots/:name', h((req) => m.deleteSnapshot(req.params.id, req.params.name)));

  router.post('/vms/:id/template', h((req) => m.setTemplate(req.params.id, body(req).on !== false)));
  router.post('/vms/:id/clone', h((req) => job(m.create({ ...body(req), source: 'clone', from: req.params.id }))));
  router.post('/vms/:id/from-template', h((req) => job(m.create({ ...body(req), source: 'template', template: req.params.id }))));

  router.get('/vms/:id/backups', h((req) => m.listBackups(req.params.id)));
  router.post('/vms/:id/backups', h((req) => job(m.backup(req.params.id, body(req).label))));
  router.post('/vms/:id/backups/restore', h((req) => job(m.restoreBackup(req.params.id, body(req).file))));
  router.delete('/vms/:id/backups/:file', h((req) => { m.removeBackup(req.params.id, req.params.file); return m.listBackups(req.params.id); }));
  router.post('/vms/:id/export', h((req) => job(m.exportDisk(req.params.id, body(req)))));
}

module.exports = { routes };
