'use strict';
/*
 * Shared folders PC → VM (#13): a small WebDAV server inside Hostwerk, on 127.0.0.1 only.
 *
 * Why WebDAV: QEMU on Windows has no virtfs/9p, Windows file sharing (SMB) for a VM needs administrator rights and a
 * second network, and nothing may be downloaded on this PC. QEMU's user network (slirp) maps the guest address
 * 10.0.2.2 to this PC's 127.0.0.1 – so a server bound to 127.0.0.1 is reachable from every VM with "user" networking
 * and from nowhere else in the network. Linux mounts it with davfs2, Windows maps it as a network drive (WebClient).
 *
 * Each shared folder has a random token (32 hex characters) as the first part of the address:
 *   http://10.0.2.2:<port>/<token>/…   → the folder on this PC (read-only shares refuse every change with 403)
 * `resolve(token)` decides – the manager answers only for running VMs. Paths never leave the shared folder
 * ("..", drive letters, links pointing outside are refused).
 *
 *   const dav = createShareServer({ resolve: (token) => ({ root, readOnly, name }) | null });
 *   const port = await dav.listen(47950); … dav.close();
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const TOKEN_RE = /^[a-f0-9]{32}$/;
const WRITE = new Set(['PUT', 'DELETE', 'MKCOL', 'MOVE', 'COPY', 'PROPPATCH', 'LOCK', 'UNLOCK']);
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const encPath = (p) => p.split('/').map((x) => encodeURIComponent(x)).join('/');

/** "/<token>/a/b%20c" → { token, parts: ['a', 'b c'] } or null (bad token, "..", backslash, NUL, drive letter). */
function parseUrl(url) {
  const raw = String(url || '').split('?')[0];
  const segs = raw.split('/').filter((s) => s !== '');
  if (!segs.length || !TOKEN_RE.test(segs[0])) return null;
  const parts = [];
  for (const s of segs.slice(1)) {
    let d;
    try { d = decodeURIComponent(s); } catch { return null; }
    if (d === '.') continue;
    if (d === '..' || /[\\\0]/.test(d) || /^[A-Za-z]:/.test(d) || d.includes('/')) return null;
    parts.push(d);
  }
  return { token: segs[0], parts };
}

/** The real path inside `root` – or null when it would end up outside (also through links). */
function inside(root, parts) {
  const base = path.resolve(root);
  const p = path.resolve(base, ...parts);
  const rel = path.relative(base, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  // Nearest existing part: its real path must still be inside the real root (no junction/link out of the share)
  let probe = p;
  while (!fs.existsSync(probe) && probe !== base) probe = path.dirname(probe);
  try {
    const realBase = fs.realpathSync(base);
    const real = fs.realpathSync(probe);
    const r2 = path.relative(realBase, real);
    if (r2.startsWith('..') || path.isAbsolute(r2)) return null;
  } catch { return null; }
  return p;
}

function propEntry(href, st, name) {
  const dir = st.isDirectory();
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  return `<D:response><D:href>${xmlEsc(href)}</D:href><D:propstat><D:prop>`
    + `<D:displayname>${xmlEsc(name)}</D:displayname>`
    + `<D:resourcetype>${dir ? '<D:collection/>' : ''}</D:resourcetype>`
    + (dir ? '' : `<D:getcontentlength>${st.size}</D:getcontentlength><D:getcontenttype>application/octet-stream</D:getcontenttype>`)
    + `<D:getlastmodified>${new Date(st.mtimeMs).toUTCString()}</D:getlastmodified>`
    + `<D:creationdate>${new Date(st.birthtimeMs || st.mtimeMs).toISOString()}</D:creationdate>`
    + `<D:getetag>${etag}</D:getetag>`
    + '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>'
    + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
}

function createShareServer({ resolve, host = '127.0.0.1', log = () => {} }) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`WebDAV ${req.method} ${e.message}`);
      if (!res.headersSent) { res.statusCode = e.status || 500; res.end(); } else res.destroy();
    });
  });
  server.on('clientError', (e, sock) => { try { sock.destroy(); } catch { /* egal */ } });

  async function handle(req, res) {
    const m = req.method.toUpperCase();
    res.setHeader('DAV', '1, 2');
    res.setHeader('MS-Author-Via', 'DAV');
    const u = parseUrl(req.url);
    const share = u && resolve(u.token);
    if (!share) { req.resume(); res.statusCode = 404; return res.end(); }
    if (m === 'OPTIONS') {
      res.setHeader('Allow', share.readOnly ? 'OPTIONS, GET, HEAD, PROPFIND' : 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, PROPFIND, PROPPATCH, LOCK, UNLOCK');
      res.statusCode = 200; return res.end();
    }
    if (share.readOnly && WRITE.has(m) && !(m === 'LOCK' || m === 'UNLOCK')) { req.resume(); res.statusCode = 403; return res.end(); }
    const file = inside(share.root, u.parts);
    if (!file) { req.resume(); res.statusCode = 403; return res.end(); }
    const href = `/${u.token}/${encPath(u.parts.join('/'))}`;
    const st = fs.existsSync(file) ? fs.statSync(file) : null;

    if (m === 'PROPFIND') {
      req.resume();
      if (!st) { res.statusCode = 404; return res.end(); }
      const depth = String(req.headers.depth ?? '1');
      const items = [propEntry(st.isDirectory() && !href.endsWith('/') ? `${href}/` : href, st, u.parts[u.parts.length - 1] || share.name || 'share')];
      if (st.isDirectory() && depth !== '0') {
        for (const name of fs.readdirSync(file)) {
          let s2; try { s2 = fs.statSync(path.join(file, name)); } catch { continue; }
          const base = href.endsWith('/') ? href : `${href}/`;
          items.push(propEntry(`${base}${encodeURIComponent(name)}${s2.isDirectory() ? '/' : ''}`, s2, name));
        }
      }
      const body = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${items.join('')}</D:multistatus>`;
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      return res.end(body);
    }
    if (m === 'GET' || m === 'HEAD') {
      if (!st) { res.statusCode = 404; return res.end(); }
      if (st.isDirectory()) {
        const body = `<!doctype html><meta charset="utf-8"><title>${xmlEsc(share.name || 'share')}</title><ul>${fs.readdirSync(file).map((n) => `<li><a href="${xmlEsc(encodeURIComponent(n))}">${xmlEsc(n)}</a></li>`).join('')}</ul>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
        return res.end(m === 'HEAD' ? undefined : body);
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Last-Modified': new Date(st.mtimeMs).toUTCString(), ETag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"` });
      if (m === 'HEAD') return res.end();
      return new Promise((ok) => { const r = fs.createReadStream(file); r.on('error', () => { res.destroy(); ok(); }); r.on('end', ok); r.pipe(res); });
    }
    if (m === 'PUT') {
      if (st && st.isDirectory()) { req.resume(); res.statusCode = 405; return res.end(); }
      if (!fs.existsSync(path.dirname(file))) { req.resume(); res.statusCode = 409; return res.end(); }
      const tmp = `${file}.hwdav-${crypto.randomBytes(4).toString('hex')}`;
      await new Promise((ok, bad) => {
        const out = fs.createWriteStream(tmp);
        out.on('error', bad); req.on('error', bad); req.on('aborted', () => bad(new Error('aborted')));
        out.on('finish', ok);
        req.pipe(out);
      }).catch((e) => { fs.rmSync(tmp, { force: true }); throw e; });
      fs.renameSync(tmp, file);
      res.statusCode = st ? 204 : 201; return res.end();
    }
    req.resume();
    if (m === 'DELETE') {
      if (!st) { res.statusCode = 404; return res.end(); }
      if (!u.parts.length) { res.statusCode = 403; return res.end(); } // never the shared folder itself
      fs.rmSync(file, { recursive: true, force: true });
      res.statusCode = 204; return res.end();
    }
    if (m === 'MKCOL') {
      if (st) { res.statusCode = 405; return res.end(); }
      if (!fs.existsSync(path.dirname(file))) { res.statusCode = 409; return res.end(); }
      fs.mkdirSync(file);
      res.statusCode = 201; return res.end();
    }
    if (m === 'MOVE' || m === 'COPY') {
      if (!st) { res.statusCode = 404; return res.end(); }
      let dest = null;
      try { dest = parseUrl(new URL(String(req.headers.destination || ''), 'http://x').pathname); } catch { dest = null; }
      if (!dest || dest.token !== u.token || !dest.parts.length || !u.parts.length) { res.statusCode = 403; return res.end(); }
      const to = inside(share.root, dest.parts);
      if (!to) { res.statusCode = 403; return res.end(); }
      const exists = fs.existsSync(to);
      if (exists && String(req.headers.overwrite || 'T').toUpperCase() === 'F') { res.statusCode = 412; return res.end(); }
      if (!fs.existsSync(path.dirname(to))) { res.statusCode = 409; return res.end(); }
      if (exists) fs.rmSync(to, { recursive: true, force: true });
      if (m === 'MOVE') fs.renameSync(file, to); else fs.cpSync(file, to, { recursive: true });
      res.statusCode = exists ? 204 : 201; return res.end();
    }
    if (m === 'LOCK') {
      // Windows and davfs2 lock before writing; one user per share – a lock token is enough, nothing is held
      const token = `opaquelocktoken:${crypto.randomUUID()}`;
      const body = `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth><D:timeout>Second-3600</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken><D:lockroot><D:href>${xmlEsc(href)}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>`;
      res.writeHead(st ? 200 : 201, { 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${token}>`, 'Content-Length': Buffer.byteLength(body) });
      if (!st && !share.readOnly && fs.existsSync(path.dirname(file))) fs.writeFileSync(file, ''); // lock-null resource
      return res.end(body);
    }
    if (m === 'UNLOCK') { res.statusCode = 204; return res.end(); }
    if (m === 'PROPPATCH') {
      if (!st) { res.statusCode = 404; return res.end(); }
      const body = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:"><D:response><D:href>${xmlEsc(href)}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      return res.end(body);
    }
    res.statusCode = 405; return res.end();
  }

  return {
    server,
    get port() { const a = server.address(); return a ? a.port : null; },
    listen(port = 0) {
      return new Promise((ok, bad) => {
        server.once('error', bad);
        server.listen({ port, host, exclusive: true }, () => { server.removeListener('error', bad); ok(server.address().port); });
      });
    },
    close() { return new Promise((ok) => { if (!server.listening) return ok(); server.close(() => ok()); if (server.closeAllConnections) server.closeAllConnections(); }); },
  };
}

const newToken = () => crypto.randomBytes(16).toString('hex');

/**
 * Commands in the guest. Linux (through the guest agent, as root): install davfs2 if missing, mount below
 * /mnt/hostwerk/<name> (read-only when the share is). Windows: the command for the person's own session – a drive
 * mapped by the agent (SYSTEM) would not show up for the signed-in user.
 */
function linuxMountScript({ url, mount, readOnly, user = null }) {
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const opts = [readOnly ? 'ro' : 'rw', user ? `uid=${user},gid=${user}` : null, 'file_mode=0664', 'dir_mode=0775'].filter(Boolean).join(',');
  return [
    'set -e',
    'if ! command -v mount.davfs >/dev/null 2>&1; then',
    '  if command -v apt-get >/dev/null; then echo "davfs2 davfs2/suid_file boolean false" | debconf-set-selections 2>/dev/null || true; DEBIAN_FRONTEND=noninteractive apt-get install -y -q davfs2 >/dev/null 2>&1 || { apt-get update -q >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -q davfs2 >/dev/null; };',
    '  elif command -v dnf >/dev/null; then dnf install -y -q davfs2 >/dev/null;',
    '  elif command -v zypper >/dev/null; then zypper --non-interactive install davfs2 >/dev/null;',
    '  elif command -v pacman >/dev/null; then pacman -S --noconfirm davfs2 >/dev/null; fi',
    'fi',
    'mkdir -p /etc/davfs2',
    `grep -qF ${q(url)} /etc/davfs2/secrets 2>/dev/null || printf '%s hostwerk hostwerk\\n' ${q(url)} >> /etc/davfs2/secrets`,
    'chmod 600 /etc/davfs2/secrets',
    'grep -q "^use_locks 0" /etc/davfs2/davfs2.conf 2>/dev/null || echo "use_locks 0" >> /etc/davfs2/davfs2.conf',
    `mkdir -p ${q(mount)}`,
    `if mountpoint -q ${q(mount)}; then echo already; else mount -t davfs -o ${opts} ${q(url)} ${q(mount)} </dev/null; echo mounted; fi`,
  ].join('\n');
}
function windowsMapCommand({ url, letter = '*' }) { return `net use ${letter} "${url}" /persistent:yes`; }

module.exports = { createShareServer, parseUrl, inside, newToken, linuxMountScript, windowsMapCommand, TOKEN_RE };
