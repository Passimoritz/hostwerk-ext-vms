![Virtuelle Maschinen](banner.svg)

# Virtuelle Maschinen

Virtuelle Maschinen wie mit VirtualBox – nur einfacher und schneller: fertige Linux-VMs in rund einer Minute (Cloud-Image mit Benutzer, SSH-Schlüssel und Gast-Agent), Installation von ISO (Windows, Linux, alles andere), Import aus VirtualBox, VMware und Hyper-V. Bildschirm direkt in Hostwerk mit Maus und Tastatur, serielle Konsole, Snapshots auch im laufenden Betrieb, Vorlagen mit verknüpften Klonen in Sekunden, Portweiterleitungen live, Sicherungen, Autostart und Hardware-Beschleunigung (WHPX, KVM, HVF) über QEMU. Vorhandene VirtualBox-VMs gleich mit im Blick.

[English](README.md) · Eine offizielle [Hostwerk](https://github.com/Passimoritz/hostwerk-public) Erweiterung (SDK 2.7, native Erweiterung)

## Was sie kann

- **In einer Minute fertig** – Cloud-Images von Debian, Ubuntu, AlmaLinux und Fedora mit deinem Benutzer, Passwort oder SSH-Schlüssel, Gast-Agent und passender Plattengröße; Prüfsumme bei jedem Download geprüft
- **Installation von ISO** – Windows (UEFI, SATA, e1000e), Linux, BSD und alles andere; Installer von Alpine, Debian und Ubuntu mit einem Klick geladen
- **Bildschirm in Hostwerk** – Maus und Tastatur (jede Taste geht an die VM, im Vollbild auch Alt+Tab und die Windows-Taste; die rechte Strg-Taste gibt die Tastatur zurück), ein Menü für Strg+Alt+Entf und andere Tasten, die dieser PC für sich behält, eine gemeinsame Zwischenablage in beide Richtungen (Strg+C / Strg+V), Bildschirmfoto, Vollbild; oder ein eigenes Fenster auf diesem PC; dazu die serielle Konsole
- **Snapshots auch im laufenden Betrieb** – Platten-Snapshots laufender VMs (mit eingefrorenem Dateisystem über den Gast-Agenten), mit Arbeitsspeicher, wo der Beschleuniger es erlaubt
- **Vorlagen und verknüpfte Klone** – eine VM zur Vorlage machen und daraus in Sekunden neue VMs anlegen
- **Import** – VirtualBox-VMs (mit CPU, RAM und Platten übernommen), OVA/OVF, VDI, VMDK, VHD(X), qcow2 und Rohabbilder; Export als VDI, VMDK, VHDX oder qcow2
- **Netzwerk** – SSH-Weiterleitung automatisch, weitere Portweiterleitungen live im laufenden Betrieb, IP-Adressen über den Gast-Agenten
- **Ganz Hostwerk** – Übersicht, Suche, Start/Stopp, Aufgaben, Sicherungen in der Sicherungs-Zentrale, Autostart, Neustart nach Absturz, CPU-/RAM-Verlauf
- **VirtualBox im Blick** – vorhandene VirtualBox-VMs starten, stoppen, Snapshots und Bildschirmfoto

## Installieren

In Hostwerk: **Erweiterungen → Entdecken** und „Installieren“ klicken.

Native Erweiterungen laufen als Teil von Hostwerk (eigener Server- und Oberflächen-Teil). Deshalb installiert Hostwerk sie nur aus dem offiziellen Katalog (mit Prüfsumme) oder im Entwickler-Modus.

## Daten

Jede VM liegt in einem eigenen Ordner unter `<Hostwerk>/vms/<id>/` (Platten, UEFI-Variablen, Cloud-Init-Daten, `vm.json`). Sicherungen liegen in `<Hostwerk>/vms/.backups/`. Beim Entfernen der Erweiterung wird nichts gelöscht; VirtualBox-VMs bleiben, wo VirtualBox sie ablegt.

## Entwickeln

```bash
node --test tests/*.test.js          # Tests
node build-native.js .               # Oberfläche bauen (sdk/build-native.js aus hostwerk-public)
node check.js . --strict             # dieselbe Prüfung wie der Katalog (sdk/check.js)
node tests/live/real-life.js <ordner> # Praxistest: echtes Hostwerk, QEMU, Downloads, SSH, VirtualBox (~400 MB)
```

Der Praxistest startet ein Test-Hostwerk mit dieser Erweiterung und steuert alles über dessen API: eine Debian-Cloud-VM
(Download mit Prüfsumme, SSH-Anmeldung, Gast-Agent, Bildschirm, serielle Konsole, Portweiterleitung im Betrieb,
Snapshot und Sicherung im Betrieb, sauberes Herunterfahren, Snapshot und Sicherung zurückspielen, Vorlage mit
verknüpftem Klon), eine Alpine-Installer-ISO (Tippen auf dem Bildschirm, ISO-Wechsel im Betrieb) und eine VirtualBox-VM
(Start, Bildschirmfoto, Snapshot, Übernahme in QEMU). Andere VirtualBox-VMs auf dem PC werden nie verändert – der Test
prüft nur, dass Löschen abgelehnt wird.

**Zur Engine.** QEMU nutzt WHPX unter Windows, KVM unter Linux und HVF unter macOS. WHPX kann den Arbeitsspeicher einer
laufenden VM nicht speichern; Snapshots im Betrieb sind dort Platten-Snapshots – stimmig durch das Einfrieren des
Dateisystems über den Gast-Agenten. Mit KVM/HVF/TCG können Snapshots den Arbeitsspeicher enthalten. Ein Neustart aus
dem Gast heraus bliebe unter WHPX hängen; deshalb laufen dort alle VMs mit `-no-reboot`, und Hostwerk startet QEMU von
selbst neu (die VM zeigt kurz „Startet“, dann „Läuft“).

**Skripte und andere Werkzeuge.** QMP, Gast-Agent und serielle Konsole sind QEMU-Sockets auf 127.0.0.1, die immer nur
einen Client annehmen – Hostwerk hält sie, solange eine VM läuft; ein zweites Programm bekommt dort „Verbindung
abgelehnt“ oder eine Zeitüberschreitung. Stattdessen Hostwerks API nutzen (gleiche Anmeldung wie die Seite, z. B. der
Header `x-hostwerk-key`): `POST /api/vms/<id>/guest/exec` `{ "command": "…", "timeoutMs": 60000 }` (über den
Gast-Agenten), `GET|POST /api/vms/<id>/serial`, `GET /api/vms/<id>/screen` (PNG), `POST /api/vms/<id>/type`
`{ "text": "…" }`, `POST /api/vms/<id>/combo` `{ "combo": "ctrl-alt-del" }` oder `{ "keys": ["ctrl", "alt", "t"] }`,
`GET /api/vms/<id>/clipboard?watch=1` (in der VM kopierter Text) und `POST /api/vms/<id>/clipboard` `{ "text": "…" }` (spice-vdagent in der VM, oder unter Linux der Gast-Agent mit wl-clipboard/Klipper/xclip), `…/restart`, `…/stop`, `…/reset`,
`GET /api/vms/<id>/guest/download?path=…` und `POST /api/vms/<id>/guest/upload?name=…` (die Datei als Request-Body).

Oberfläche in `ui/src`, Server-Teil in `server/`. Texte im Code sind Englisch, Deutsch steht in `locales/de.json`.

## Lizenz

MIT
