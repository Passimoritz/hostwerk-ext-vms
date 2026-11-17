![Virtual machines](banner.svg)

# Virtual machines

Virtual machines like VirtualBox – only simpler and faster: ready-made Linux VMs in about a minute (cloud image with user, SSH key and guest agent), installing from an ISO (Windows, Linux, anything else), import from VirtualBox, VMware and Hyper-V. The screen right inside Hostwerk with mouse and keyboard, serial console, snapshots even while running, templates with linked clones in seconds, live port forwarding, backups, autostart and hardware acceleration (WHPX, KVM, HVF) through QEMU. Existing VirtualBox VMs at a glance as well.

[Deutsch](README.de.md) · An official [Hostwerk](https://github.com/Passimoritz/hostwerk-public) extension (SDK 2.7, native extension)

## What it does

- **Ready in a minute** – Debian, Ubuntu, AlmaLinux and Fedora cloud images with your user, password or SSH key, guest agent and the right disk size; checksum checked on every download
- **Install from ISO** – Windows (UEFI, SATA, e1000e), Linux, BSD and everything else; Alpine, Debian and Ubuntu installers downloadable in one click
- **Screen inside Hostwerk** – mouse and keyboard, Ctrl+Alt+Del, screenshot, full screen; or a separate window on this PC; plus the serial console
- **Snapshots even while running** – disk snapshots of running VMs (with a frozen file system through the guest agent), with RAM where the accelerator allows it
- **Templates and linked clones** – turn a VM into a template and create new VMs from it in seconds
- **Import** – VirtualBox VMs (taken over with CPU, RAM and disks), OVA/OVF, VDI, VMDK, VHD(X), qcow2 and raw images; export as VDI, VMDK, VHDX or qcow2
- **Network** – SSH forwarding set up automatically, more port forwards added live while the VM runs, IP addresses through the guest agent
- **Hostwerk all the way** – overview, search, start/stop, scheduled tasks, backups in the backup centre, autostart, crash restart, CPU/RAM graphs
- **VirtualBox at a glance** – start, stop, snapshots and screenshot of existing VirtualBox VMs

## Install

In Hostwerk: **Extensions → Discover** and click “Install”.

Native extensions run as part of Hostwerk (own server and interface part). That is why Hostwerk only installs them from the official catalogue (with checksum) or in developer mode.

## Data

Each VM lives in its own folder under `<Hostwerk>/vms/<id>/` (disks, UEFI variables, cloud-init seed, `vm.json`). Backups go to `<Hostwerk>/vms/.backups/`. Removing the extension deletes nothing; VirtualBox VMs stay where VirtualBox keeps them.

## Develop

```bash
node --test tests/*.test.js          # tests
node build-native.js .               # build the interface (sdk/build-native.js from hostwerk-public)
node check.js . --strict             # same check as the catalogue (sdk/check.js)
node tests/live/real-life.js <folder> # real-life test: real Hostwerk, QEMU, downloads, SSH, VirtualBox (~400 MB)
```

The real-life test starts a Hostwerk test instance with this extension and drives everything through its API: a Debian
cloud VM (download with checksum, SSH login, guest agent, screen, serial console, live port forwarding, live snapshot,
live backup, clean shutdown, snapshot and backup restore, template with linked clone), an Alpine installer ISO (typing on
the screen, ISO change while running) and a VirtualBox VM (start, screenshot, snapshot, takeover into QEMU). Other
VirtualBox VMs on the PC are never changed – the test only checks that deleting them is refused.

**Engine notes.** QEMU uses WHPX on Windows, KVM on Linux and HVF on macOS. WHPX cannot save the memory of a running VM
(no dirty-page tracking), so snapshots of running VMs are disk snapshots there – consistent through the guest agent's
file-system freeze; with KVM/HVF/TCG snapshots can include the memory.

Interface source in `ui/src`, server part in `server/`. Texts in the code are English, German is in `locales/de.json`.

## License

MIT
