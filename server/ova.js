'use strict';
/*
 * A whole VM as one appliance file (OVA): a tar archive with the description (OVF 1.0), the disks as stream-optimised
 * VMDK and a manifest with their SHA-256 sums – what VirtualBox, VMware and Proxmox import. Counterpart of importer.js
 * (tests/package6.test.js packs one and reads it back with it).
 *
 *   buildOvf(vm, disks)            → the OVF text; disks: [{ file, size (bytes of the file), capacity (bytes in the VM) }]
 *   manifestText(entries)          → "SHA256(name)= hex" lines; entries: [{ name, sha256 }]
 *   writeTar(dest, files, onBytes) → packs files: [{ name, path } | { name, data }] in this order
 */
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** What the importing program should take the system for (CIM id for OVF, VMware's own name). */
function osOf(vm) {
  if (vm.osType === 'windows') return { id: 103, vmw: 'windows9_64Guest', text: 'Windows (64-bit)' };
  if (vm.osType === 'linux') return { id: 101, vmw: 'otherLinux64Guest', text: 'Linux (64-bit)' };
  return { id: 102, vmw: 'otherGuest64', text: 'Other (64-bit)' };
}

/** One hardware item; the rasd elements in alphabetical order, as OVF 1.0 asks for. */
function item(fields) {
  const body = Object.keys(fields).sort().map((k) => `        <rasd:${k}>${esc(fields[k])}</rasd:${k}>`).join('\n');
  return `      <Item>\n${body}\n      </Item>`;
}

function buildOvf(vm, disks) {
  const id = String(vm.name || vm.id || 'vm');
  const os = osOf(vm);
  const files = disks.map((d, i) => `    <File ovf:id="file${i + 1}" ovf:href="${esc(d.file)}" ovf:size="${Number(d.size) || 0}"/>`).join('\n');
  const dsk = disks.map((d, i) => `    <Disk ovf:diskId="vmdisk${i + 1}" ovf:fileRef="file${i + 1}" ovf:capacity="${Number(d.capacity) || 0}" ovf:format="http://www.vmware.com/interfaces/specifications/vmdk.html#streamOptimized"/>`).join('\n');
  const items = [
    item({ Caption: `${vm.cpus} virtual CPU`, Description: 'Number of virtual CPUs', ElementName: `${vm.cpus} virtual CPU`, InstanceID: 1, ResourceType: 3, VirtualQuantity: vm.cpus }),
    item({ AllocationUnits: 'byte * 2^20', Caption: `${vm.memoryMb} MB of memory`, Description: 'Memory Size', ElementName: `${vm.memoryMb} MB of memory`, InstanceID: 2, ResourceType: 4, VirtualQuantity: vm.memoryMb }),
    // SATA boots everywhere (VirtualBox, VMware) – virtio would need drivers in the importing program's guest
    item({ Address: 0, Caption: 'sataController0', Description: 'SATA Controller', ElementName: 'sataController0', InstanceID: 3, ResourceSubType: 'AHCI', ResourceType: 20 }),
    ...disks.map((d, i) => item({ AddressOnParent: i, Caption: `disk${i + 1}`, Description: 'Disk Image', ElementName: `disk${i + 1}`, HostResource: `ovf:/disk/vmdisk${i + 1}`, InstanceID: 4 + i, Parent: 3, ResourceType: 17 })),
    item({ AutomaticAllocation: 'true', Caption: 'Ethernet adapter on NAT', Connection: 'NAT', ElementName: 'Ethernet adapter on NAT', InstanceID: 4 + disks.length, ResourceSubType: 'E1000', ResourceType: 10 }),
  ].join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Envelope ovf:version="1.0" xml:lang="en-US" xmlns="http://schemas.dmtf.org/ovf/envelope/1" xmlns:ovf="http://schemas.dmtf.org/ovf/envelope/1" xmlns:rasd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_ResourceAllocationSettingData" xmlns:vssd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_VirtualSystemSettingData" xmlns:vmw="http://www.vmware.com/schema/ovf" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <References>
${files}
  </References>
  <DiskSection>
    <Info>List of the virtual disks used in the package</Info>
${dsk}
  </DiskSection>
  <NetworkSection>
    <Info>Logical networks used in the package</Info>
    <Network ovf:name="NAT">
      <Description>Logical network used by this appliance.</Description>
    </Network>
  </NetworkSection>
  <VirtualSystem ovf:id="${esc(id)}">
    <Info>A virtual machine</Info>
    <Name>${esc(id)}</Name>
    <OperatingSystemSection ovf:id="${os.id}" vmw:osType="${os.vmw}">
      <Info>The kind of installed guest operating system</Info>
      <Description>${os.text}</Description>
    </OperatingSystemSection>
    <VirtualHardwareSection>
      <Info>Virtual hardware requirements for a virtual machine</Info>
      <System>
        <vssd:ElementName>Virtual Hardware Family</vssd:ElementName>
        <vssd:InstanceID>0</vssd:InstanceID>
        <vssd:VirtualSystemIdentifier>${esc(id)}</vssd:VirtualSystemIdentifier>
        <vssd:VirtualSystemType>vmx-13</vssd:VirtualSystemType>
      </System>
${items}
      <vmw:Config ovf:required="false" vmw:key="firmware" vmw:value="${vm.firmware === 'uefi' ? 'efi' : 'bios'}"/>
    </VirtualHardwareSection>
  </VirtualSystem>
</Envelope>
`;
}

const manifestText = (entries) => entries.map((e) => `SHA256(${e.name})= ${e.sha256}\n`).join('');

/** One 512-byte tar header (ustar). Sizes from 8 GiB on are written base-256 (GNU), which every importer reads. */
function tarHeader(name, size, mtime = Math.floor(Date.now() / 1000)) {
  const nameBuf = Buffer.from(String(name), 'utf8');
  if (nameBuf.length > 100) throw new Error(`tar: name too long (${name})`);
  const h = Buffer.alloc(512);
  nameBuf.copy(h, 0);
  const oct = (n, len) => `${n.toString(8).padStart(len - 1, '0')}\0`;
  h.write(oct(0o644, 8), 100, 'ascii'); h.write(oct(0, 8), 108, 'ascii'); h.write(oct(0, 8), 116, 'ascii');
  if (size < 8 * 2 ** 30) h.write(oct(size, 12), 124, 'ascii');
  else { h[124] = 0x80; h.writeBigUInt64BE(BigInt(size), 128); }
  h.write(oct(mtime, 12), 136, 'ascii');
  h.fill(0x20, 148, 156); // the checksum field counts as spaces
  h[156] = 0x30; // '0': a plain file
  h.write('ustar\0', 257, 'ascii'); h.write('00', 263, 'ascii');
  let sum = 0; for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

async function writeTar(dest, files, onBytes = () => {}) {
  const out = fs.createWriteStream(dest);
  const write = (buf) => new Promise((resolve, reject) => { out.write(buf, (e) => (e ? reject(e) : resolve())); });
  let done = 0;
  try {
    for (const f of files) {
      const size = f.path ? fs.statSync(f.path).size : Buffer.byteLength(f.data);
      await write(tarHeader(f.name, size));
      if (f.path) { for await (const chunk of fs.createReadStream(f.path, { highWaterMark: 4 * 2 ** 20 })) { await write(chunk); done += chunk.length; onBytes(done); } }
      else { await write(Buffer.from(f.data)); done += size; onBytes(done); }
      const pad = (512 - (size % 512)) % 512;
      if (pad) await write(Buffer.alloc(pad));
    }
    await write(Buffer.alloc(1024)); // two empty blocks end the archive
    await new Promise((resolve, reject) => { out.on('error', reject); out.end(resolve); });
  } catch (e) { out.destroy(); throw e; }
  return dest;
}

/** A name for the files inside the appliance: plain ASCII, no spaces (VMware's ovftool is picky). */
const fileBase = (name) => String(name || 'vm').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'vm';

module.exports = { buildOvf, manifestText, tarHeader, writeTar, fileBase, basename: path.basename };
