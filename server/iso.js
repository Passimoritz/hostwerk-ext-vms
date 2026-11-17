'use strict';
/*
 * A tiny ISO 9660 writer with Joliet names – enough for cloud-init's NoCloud seed (volume "cidata" with the files
 * user-data, meta-data, network-config). No external program (genisoimage, mkisofs, oscdimg) is needed, so it works the
 * same on Windows, Linux and macOS, for QEMU and VirtualBox. One flat root folder, small files.
 *
 *   buildIso({ volume: 'cidata', files: { 'user-data': '…', 'meta-data': '…' } }) → Buffer
 *   readIso(buffer) → { volume, joliet: true, files: { name: Buffer } }   (used by the tests and the self-check)
 *
 * Layout (2048-byte sectors): 0–15 system area · 16 primary volume descriptor · 17 Joliet descriptor · 18 terminator ·
 * 19/20 path tables (primary L/M) · 21/22 path tables (Joliet L/M) · 23 root (primary) · 24 root (Joliet) · 25… files.
 */
const S = 2048;

function both16(buf, off, v) { buf.writeUInt16LE(v, off); buf.writeUInt16BE(v, off + 2); }
function both32(buf, off, v) { buf.writeUInt32LE(v, off); buf.writeUInt32BE(v, off + 4); }
function ascii(buf, off, len, s) { buf.fill(0x20, off, off + len); buf.write(String(s).slice(0, len), off, 'ascii'); }
function ucs2(s) { const b = Buffer.alloc(s.length * 2); for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), i * 2); return b; }
function ucs2Field(buf, off, len, s) { for (let i = 0; i < len; i += 2) buf.writeUInt16BE(0x0020, off + i); ucs2(String(s).slice(0, len / 2)).copy(buf, off); }

/** 7-byte date of a directory record. */
function dirDate(d) {
  return Buffer.from([d.getUTCFullYear() - 1900, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), 0]);
}
/** 17-byte date of a volume descriptor ("YYYYMMDDHHMMSScc" + offset). */
function volDate(buf, off, d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  buf.write(`${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}00`, off, 'ascii');
  buf[off + 16] = 0;
}

function dirRecord({ lba, size, dir, name, date }) {
  const nameLen = name.length;
  const len = 33 + nameLen + (nameLen % 2 === 0 ? 1 : 0);
  const r = Buffer.alloc(len);
  r[0] = len;
  r[1] = 0;
  both32(r, 2, lba);
  both32(r, 10, size);
  dirDate(date).copy(r, 18);
  r[25] = dir ? 2 : 0;
  r[26] = 0; r[27] = 0;
  both16(r, 28, 1);
  r[32] = nameLen;
  name.copy(r, 33);
  return r;
}

/** Primary name: d-characters 8.3 + ";1", unique. */
function primaryNames(list) {
  const used = new Set();
  return list.map((n) => {
    const up = n.toUpperCase().replace(/[^A-Z0-9_.]/g, '_');
    const dot = up.lastIndexOf('.');
    let base = (dot > 0 ? up.slice(0, dot) : up).replace(/\./g, '_').slice(0, 8);
    const ext = (dot > 0 ? up.slice(dot + 1) : '').slice(0, 3);
    let candidate = `${base}.${ext}`;
    for (let i = 1; used.has(candidate); i++) { base = `${base.slice(0, 8 - String(i).length)}${i}`; candidate = `${base}.${ext}`; }
    used.add(candidate);
    return `${candidate};1`;
  });
}

function buildIso({ volume = 'cidata', files = {}, date = new Date() } = {}) {
  const names = Object.keys(files).sort();
  for (const n of names) if (!/^[A-Za-z0-9._-]{1,64}$/.test(n)) throw new Error(`iso: invalid file name ${n}`);
  const data = names.map((n) => (Buffer.isBuffer(files[n]) ? files[n] : Buffer.from(String(files[n]), 'utf8')));
  const prim = primaryNames(names);
  const ROOT_P = 23;
  const ROOT_J = 24;
  let lba = 25;
  const at = data.map((b) => { const l = lba; lba += Math.max(1, Math.ceil(b.length / S)); return l; });
  const total = lba;

  const rootDir = (self, joliet) => {
    const recs = [
      dirRecord({ lba: self, size: S, dir: true, name: Buffer.from([0]), date }),
      dirRecord({ lba: self, size: S, dir: true, name: Buffer.from([1]), date }),
      ...names.map((n, i) => dirRecord({ lba: at[i], size: data[i].length, dir: false, name: joliet ? ucs2(`${n};1`) : Buffer.from(prim[i], 'ascii'), date })),
    ];
    const buf = Buffer.concat(recs);
    if (buf.length > S) throw new Error('iso: too many files for one directory sector');
    const sec = Buffer.alloc(S);
    buf.copy(sec);
    return sec;
  };
  const pathTable = (root, be) => {
    const t = Buffer.alloc(S);
    t[0] = 1; t[1] = 0;
    if (be) { t.writeUInt32BE(root, 2); t.writeUInt16BE(1, 6); } else { t.writeUInt32LE(root, 2); t.writeUInt16LE(1, 6); }
    t[8] = 0; // root identifier
    return t;
  };
  const descriptor = (type, root, ptL, ptM, joliet) => {
    const v = Buffer.alloc(S);
    v[0] = type;
    v.write('CD001', 1, 'ascii');
    v[6] = 1;
    if (joliet) { ucs2Field(v, 8, 32, ''); ucs2Field(v, 40, 32, volume); } else { ascii(v, 8, 32, ''); ascii(v, 40, 32, volume.toUpperCase()); }
    both32(v, 80, total);
    if (joliet) v.write('%/E', 88, 'ascii'); // UCS-2 level 3
    both16(v, 120, 1);
    both16(v, 124, 1);
    both16(v, 128, S);
    both32(v, 132, 10); // path table size
    v.writeUInt32LE(ptL, 140);
    v.writeUInt32BE(ptM, 148);
    dirRecord({ lba: root, size: S, dir: true, name: Buffer.from([0]), date }).copy(v, 156);
    for (const [off, len] of [[190, 128], [318, 128], [446, 128], [574, 128]]) { if (joliet) ucs2Field(v, off, len, ''); else ascii(v, off, len, ''); }
    if (joliet) ucs2Field(v, 574, 128, 'HOSTWERK'); else ascii(v, 574, 128, 'HOSTWERK');
    for (const [off, len] of [[702, 37], [739, 37], [776, 37]]) { if (joliet) ucs2Field(v, off, len - 1, ''); else ascii(v, off, len, ''); }
    volDate(v, 813, date);
    volDate(v, 830, date);
    v.write('0000000000000000', 847, 'ascii'); v[863] = 0;
    volDate(v, 864, date);
    v[881] = 1;
    return v;
  };
  const term = Buffer.alloc(S);
  term[0] = 255; term.write('CD001', 1, 'ascii'); term[6] = 1;

  const out = Buffer.alloc(total * S);
  descriptor(1, ROOT_P, 19, 20, false).copy(out, 16 * S);
  descriptor(2, ROOT_J, 21, 22, true).copy(out, 17 * S);
  term.copy(out, 18 * S);
  pathTable(ROOT_P, false).copy(out, 19 * S);
  pathTable(ROOT_P, true).copy(out, 20 * S);
  pathTable(ROOT_J, false).copy(out, 21 * S);
  pathTable(ROOT_J, true).copy(out, 22 * S);
  rootDir(ROOT_P, false).copy(out, ROOT_P * S);
  rootDir(ROOT_J, true).copy(out, ROOT_J * S);
  data.forEach((b, i) => b.copy(out, at[i] * S));
  return out;
}

/** Reads an ISO written by buildIso (or any simple one-folder ISO): volume name and files – Joliet names preferred. */
function readIso(buf) {
  if (buf.length < 19 * S || buf.toString('ascii', 16 * S + 1, 16 * S + 6) !== 'CD001') throw new Error('Not an ISO 9660 image');
  let joliet = null;
  let primary = null;
  for (let s = 16; s < 32 && (s + 1) * S <= buf.length; s++) {
    const t = buf[s * S];
    if (t === 255) break;
    if (t === 1) primary = s;
    if (t === 2 && buf.toString('ascii', s * S + 88, s * S + 91).startsWith('%/')) joliet = s;
  }
  const vd = joliet ?? primary;
  const off = vd * S;
  const decode = (b) => (joliet !== null ? Array.from({ length: b.length / 2 }, (_, i) => String.fromCharCode(b.readUInt16BE(i * 2))).join('') : b.toString('ascii'));
  const volume = decode(buf.subarray(off + 40, off + 72)).trim();
  const rootLba = buf.readUInt32LE(off + 156 + 2);
  const rootSize = buf.readUInt32LE(off + 156 + 10);
  const files = {};
  let p = rootLba * S;
  const end = p + rootSize;
  while (p < end) {
    const len = buf[p];
    if (!len) { p = (Math.floor(p / S) + 1) * S; continue; }
    const flags = buf[p + 25];
    const nameLen = buf[p + 32];
    const raw = buf.subarray(p + 33, p + 33 + nameLen);
    if (!(nameLen === 1 && (raw[0] === 0 || raw[0] === 1)) && !(flags & 2)) {
      const name = decode(raw).replace(/;1$/, '').replace(/\.$/, '');
      const lba = buf.readUInt32LE(p + 2);
      const size = buf.readUInt32LE(p + 10);
      files[name] = buf.subarray(lba * S, lba * S + size);
    }
    p += len;
  }
  return { volume, joliet: joliet !== null, files };
}

module.exports = { buildIso, readIso, primaryNames };
