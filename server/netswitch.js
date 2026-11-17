'use strict';
/*
 * Internal networks between VMs (#7): a small Ethernet switch per network inside Hostwerk, on 127.0.0.1 only.
 *
 * Why not QEMU's multicast socket (`-netdev socket,mcast=…` / `dgram` with a multicast group)? On Windows QEMU binds
 * the socket to the multicast address itself, which Windows refuses ("can't bind ip=230.0.0.1 to socket", checked
 * with QEMU 11.1). Point-to-point UDP works, so every NIC of a VM in an internal network is a
 *   -netdev dgram,local=127.0.0.1:<port of the NIC>,remote=127.0.0.1:<port of the switch>
 * and this switch forwards the Ethernet frames (one frame per UDP datagram) like a real one: it learns which MAC sits
 * behind which port, floods broadcasts/unknown destinations, and accepts frames only from 127.0.0.1 and only from the
 * ports of NICs that are registered right now. Nothing leaves this PC.
 *
 *   const sw = new Switches();
 *   const port = await sw.attach('lab', 47321)   // NIC port of a starting VM → port of the switch for 'lab'
 *   sw.detach('lab', 47321)                       // VM stopped; the last one closes the switch
 */
const dgram = require('dgram');

const LOOPBACK = '127.0.0.1';
const MAX_MACS = 4096;

class Switch {
  constructor(id) {
    this.id = id; this.sock = null; this.port = null;
    this.members = new Set(); // UDP ports of the NICs in this network
    this.macs = new Map(); // MAC (hex) → port it was last seen on
    this.stats = { frames: 0, dropped: 0 };
  }
  open() {
    if (this.sock) return Promise.resolve(this.port);
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      s.once('error', reject);
      s.bind({ address: LOOPBACK, port: 0, exclusive: true }, () => {
        s.removeListener('error', reject);
        s.on('error', () => {}); // a VM that just stopped (ICMP port unreachable) must not end the switch
        s.on('message', (buf, rinfo) => this.onFrame(buf, rinfo));
        this.sock = s; this.port = s.address().port;
        resolve(this.port);
      });
    });
  }
  close() { if (this.sock) { try { this.sock.close(); } catch { /* egal */ } } this.sock = null; this.port = null; this.macs.clear(); }

  /** One Ethernet frame from a NIC: learn the sender, forward to the right port (or all others). */
  onFrame(buf, rinfo) {
    if (rinfo.address !== LOOPBACK || !this.members.has(rinfo.port) || buf.length < 14) { this.stats.dropped++; return; }
    this.stats.frames++;
    const dst = buf.subarray(0, 6).toString('hex');
    const src = buf.subarray(6, 12).toString('hex');
    if (!(buf[6] & 1)) { // never learn a multicast source
      if (!this.macs.has(src) && this.macs.size >= MAX_MACS) this.macs.clear();
      this.macs.set(src, rinfo.port);
    }
    const known = !(buf[0] & 1) && this.macs.get(dst);
    const targets = known && this.members.has(known) ? [known] : [...this.members];
    for (const p of targets) if (p !== rinfo.port) this.sock.send(buf, p, LOOPBACK);
  }
}

class Switches {
  constructor() { this.nets = new Map(); }
  /** A NIC (its UDP port) joins network `id` → the switch's port (opened on first use). */
  async attach(id, nicPort) {
    let sw = this.nets.get(id);
    if (!sw) { sw = new Switch(id); this.nets.set(id, sw); }
    const port = await sw.open();
    sw.members.add(Number(nicPort));
    return port;
  }
  detach(id, nicPort) {
    const sw = this.nets.get(id);
    if (!sw) return;
    sw.members.delete(Number(nicPort));
    for (const [mac, p] of sw.macs) if (p === Number(nicPort)) sw.macs.delete(mac);
    if (!sw.members.size) { sw.close(); this.nets.delete(id); }
  }
  info(id) { const sw = this.nets.get(id); return sw ? { port: sw.port, members: sw.members.size, ...sw.stats } : null; }
  closeAll() { for (const sw of this.nets.values()) sw.close(); this.nets.clear(); }
}

/** A free UDP port on 127.0.0.1 for a NIC (asked from the system; QEMU binds it a moment later). */
function freeUdpPort(avoid = new Set()) {
  return new Promise((resolve, reject) => {
    const tryOnce = (n) => {
      const s = dgram.createSocket('udp4');
      s.once('error', (e) => { s.close(); if (n > 0) tryOnce(n - 1); else reject(e); });
      s.bind({ address: LOOPBACK, port: 0, exclusive: true }, () => {
        const p = s.address().port;
        s.close(() => { if (avoid.has(p) && n > 0) tryOnce(n - 1); else resolve(p); });
      });
    };
    tryOnce(20);
  });
}

module.exports = { Switches, Switch, freeUdpPort, LOOPBACK };
