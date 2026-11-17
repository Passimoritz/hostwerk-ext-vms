# 3D graphics (roadmap #18) – verified 17 Nov 2026

This PC: Windows 11 Home, Ryzen 7 7800X3D, AMD Radeon RX 9070 XT, QEMU 11.1 (WHPX). QEMU's Windows build brings
`virtio-vga-gl`, `libvirglrenderer-1.dll`, `libepoxy` and ANGLE (`libEGL.dll`, `libGLESv2.dll`).

## How it runs

Graphics "3D" (`vga: 'virtio-gl'`) with the screen in an own window (`display: 'window'`) →
`-device virtio-vga-gl -display sdl,gl=on`, no `-vnc` (QEMU refuses VNC next to that OpenGL context). The guest renders
through virgl on the host's graphics card. 3D with the screen in Hostwerk runs as plain virtio (`glMode()` in
`server/qemu-args.js`).

## Findings

| What | Seen | Change |
|---|---|---|
| QEMU's own window stayed invisible | Hostwerk starts every program with `windowsHide: true`; on Windows that hides QEMU's SDL window too (no window handle, `IsWindowVisible` false). Affected every VM with "Own window", not only 3D. | Hostwerk core: `ManagedProcess.start({ hide })` (default `true`, unchanged for everything else); the VM runtime passes `hide: false` for "Own window". Older Hostwerk ignores the option – the window stays hidden there. |
| Debian cloud images have no 3D driver | kernel `6.1.0-*-cloud-amd64`: no `virtio_gpu` module, no `/dev/dri` – virgl unused. | Health check: an info line for every running 3D VM with a `-cloud-` kernel, with the fix. With `linux-image-amd64` (cloud kernel removed, restart): `[drm] features: +virgl`, `/dev/dri/renderD128`. |
| PNG screen of a 3D window VM | QMP `screendump` → "no surface" (HTTP 500). | `Runtime.screen()` answers 409 "This VM shows 3D in its own window on this PC – the picture is only there." |
| 3D in the Hostwerk screen via `egl-headless` | Tried: QEMU starts with `-display egl-headless` + VNC, virgl renders (renderer "virgl (ANGLE (AMD … Direct3D…))"), but every `SET_SCANOUT` fails (`virtio_gpu_virgl_process_cmd: ctrl 0x103, error 0x1203`) – VNC and screendump show only "Display output is not active". `gl=es` the same, `gl=core` does not start. | Not used; 3D stays in the own window. |

Performance in the guest (Debian 12, Mesa 22.3.6, `glmark2-es2-drm --off-screen`): renderer
`virgl (AMD Radeon RX 9070 XT)`, OpenGL ES 3.2; build/shading/texture/refract 64–98 fps (score 64–96 across runs).

## Real-life test

`node tests/live/gl.js <work folder>` (port 7870, Windows only, Debian image from the cache, packages from the internet in
the guest) – 10/10:

| Step | Result |
|---|---|
| 3D VM, own window | `-device virtio-vga-gl -display sdl,gl=on`, no `-vnc`, no VNC port |
| PNG screen | 409 „Diese VM zeigt 3D in ihrem eigenen Fenster auf diesem PC – das Bild gibt es nur dort.“ |
| Cloud kernel | no `/dev/dri`, `virtio_gpu` not found; health check names “GL 3D” with the fix |
| Standard kernel + restart | kernel 6.1.0-56-amd64 |
| virgl | `+virgl`, `renderD128`, `GL_RENDERER: virgl (AMD Radeon RX 9070 XT)` |
| glmark2 | 92 / 67 / 72 / 64 fps, score 72 |
| Hint gone | no health line after the switch |
| QEMU's window | “QEMU (GL 3D-0)” 1296×839, guest console with login prompt (picture through PrintWindow) |
| Clean-up | VM deleted |
