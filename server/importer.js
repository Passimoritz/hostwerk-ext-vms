'use strict';
/*
 * Importing appliances: OVA (a tar file with an OVF description and VMDK disks) and OVF. The tar reader and the OVF
 * reading are small and self-contained – no tar.exe, no XML library (tests/importer.test.js).
 *
 *   listTar(file)                     → [{ name, size, offset }]
 *   extractTar(file, dir, filter)     → extracted names (only plain files, never outside `dir`)
 *   parseOvf(xml)                     → { name, cpus, memoryMb, osType, firmware, disks: [{ file, capacity }] }
 */
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

function octal(buf, off, len) { const s = buf.toString('ascii', off, off + len).replace(/\0.*$/, '').trim(); return s ? parseInt(s, 8) : 0; }

function listTar(file) {
  const fd = fs.openSync(file, 'r');
  const out = [];
  try {
    const size = fs.fstatSync(fd).size;
    const h = Buffer.alloc(512);
    let off = 0;
    let longName = null;
    while (off + 512 <= size) {
      fs.readSync(fd, h, 0, 512, off);
      if (h.every((b) => b === 0)) break;
      let name = h.toString('utf8', 0, 100).replace(/\0.*$/, '');
      const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/, '');
      if (prefix && h.toString('ascii', 257, 262) === 'ustar') name = `${prefix}/${name}`;
      const len = octal(h, 124, 12);
      const type = String.fromCharCode(h[156] || 48);
      if (type === 'L') { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off + 512); longName = b.toString('utf8').replace(/\0.*$/, ''); }
      else {
        if (longName) { name = longName; longName = null; }
        if (type === '0' || type === '\0') out.push({ name, size: len, offset: off + 512 });
      }
      off += 512 + Math.ceil(len / 512) * 512;
    }
  } finally { fs.closeSync(fd); }
  return out;
}

async function extractTar(file, dir, filter = () => true) {
  const done = [];
  for (const e of listTar(file)) {
    if (!filter(e.name)) continue;
    const base = path.basename(e.name);
    if (!/^[A-Za-z0-9._ -]{1,120}$/.test(base) || base.startsWith('.')) continue; // never paths out of `dir`
    const dest = path.join(dir, base);
    if (e.size === 0) { fs.writeFileSync(dest, ''); done.push(base); continue; }
    await pipeline(fs.createReadStream(file, { start: e.offset, end: e.offset + e.size - 1 }), fs.createWriteStream(dest));
    done.push(base);
  }
  return done;
}

const attr = (s, name) => { const m = String(s).match(new RegExp(`${name}="([^"]*)"`)); return m ? m[1] : null; };
const decode = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function parseOvf(xml) {
  const x = String(xml || '');
  const files = {};
  for (const m of x.matchAll(/<(?:ovf:)?File\b[^>]*>/g)) { const id = attr(m[0], 'ovf:id') || attr(m[0], 'id'); const href = attr(m[0], 'ovf:href') || attr(m[0], 'href'); if (id && href) files[id] = decode(href); }
  const disks = [];
  for (const m of x.matchAll(/<(?:ovf:)?Disk\b[^>]*>/g)) {
    const ref = attr(m[0], 'ovf:fileRef') || attr(m[0], 'fileRef');
    const cap = Number(attr(m[0], 'ovf:capacity') || attr(m[0], 'capacity') || 0);
    const unit = attr(m[0], 'ovf:capacityAllocationUnits') || 'byte';
    const mult = /2\^30/.test(unit) ? 2 ** 30 : /2\^20/.test(unit) ? 2 ** 20 : 1;
    if (ref && files[ref]) disks.push({ file: files[ref], capacity: cap * mult });
  }
  let cpus = null; let memoryMb = null;
  for (const m of x.matchAll(/<(?:ovf:)?Item\b[^>]*>([\s\S]*?)<\/(?:ovf:)?Item>/g)) {
    const body = m[1];
    const type = (body.match(/<rasd:ResourceType>\s*(\d+)\s*</) || [])[1];
    const qty = Number((body.match(/<rasd:VirtualQuantity>\s*(\d+)\s*</) || [])[1]);
    const unit = (body.match(/<rasd:AllocationUnits>([^<]*)</) || [])[1] || '';
    if (type === '3' && qty) cpus = qty;
    if (type === '4' && qty) memoryMb = /2\^30|GB/i.test(unit) ? qty * 1024 : /byte\s*\*\s*2\^10|KB/i.test(unit) ? Math.round(qty / 1024) : qty;
  }
  const vsName = (x.match(/<(?:ovf:)?VirtualSystem\b[^>]*ovf:id="([^"]+)"/) || [])[1];
  const name = decode((x.match(/<(?:ovf:)?Name>([^<]+)</) || [])[1] || vsName || 'Imported VM');
  const osDesc = `${(x.match(/<(?:ovf:)?OperatingSystemSection\b[^>]*>/) || [''])[0]} ${(x.match(/<vbox:OSType[^>]*>([^<]+)</) || [])[1] || ''} ${(x.match(/<(?:ovf:)?Description>([^<]*)</) || [])[1] || ''}`;
  const osType = /windows|win\d/i.test(osDesc) ? 'windows' : /linux|ubuntu|debian|centos|rhel|fedora|alma|rocky|suse|arch/i.test(osDesc) ? 'linux' : 'other';
  const firmware = /firmware="?efi/i.test(x) || /<Firmware[^>]*type="EFI"/i.test(x) ? 'uefi' : 'bios';
  return { name: name.trim().slice(0, 60), cpus, memoryMb, osType, firmware, disks };
}

module.exports = { listTar, extractTar, parseOvf };
