'use strict';
/*
 * AI tools for virtual machines (#20, SDK 3.5 host.aiExtend, describe() since SDK 3.10): list VMs, look at a VM's screen
 * as text, start, shut down, create a VM from an app template and a linked clone from a VM template. Same risk classes
 * as Hostwerk's own tools: reading never asks, everything that changes something asks first in plain words (describe),
 * powering off without shutting down is 'system'. Tool descriptions are German like Hostwerk's – the AI reads them;
 * the person sees label/describe.
 */
const crypto = require('crypto');
const A = require('./apps');
const catalog = require('./catalog');

function vmsAi(m) {
  /** VM by id or (case-insensitive) name */
  const find = (key) => {
    const k = String(key || '').trim();
    if (!k) throw new Error('VM fehlt (id oder Name).');
    if (m.vms.has(k)) return m.vms.get(k);
    const hit = [...m.vms.values()].filter((v) => v.name.toLowerCase() === k.toLowerCase());
    if (hit.length === 1) return hit[0];
    throw new Error(`Keine VM „${k}“ gefunden – vm_list zeigt alle.`);
  };
  const nameOf = (key) => { try { return find(key).name; } catch { return String(key || '?'); } };
  const short = (v) => {
    const st = m.stateOf(v.id);
    const ag = st.agent && st.agent.ok ? st.agent : null;
    return { id: v.id, name: v.name, system: v.osLabel || v.osType, arch: v.arch || 'x86_64', zustand: v.template ? 'Vorlage' : st.state, cpu: v.cpus, ramMb: v.memoryMb, ip: ag && ag.addresses && ag.addresses[0] ? ag.addresses[0].ip : null, app: v.app ? v.app.id : null, adresse: v.app ? (A.appUrl(v) || {}).url || null : null, ssh: m.sshInfo(v) ? m.sshInfo(v).command : null };
  };
  return {
    about: { de: 'virtuelle Maschinen (QEMU, VirtualBox, Hyper-V)', en: 'virtual machines (QEMU, VirtualBox, Hyper-V)' },
    vocab: ['VM', 'QEMU', 'VirtualBox', 'Hyper-V', 'Cloud-Image', 'Snapshot'],
    groups: { vms: { de: 'Virtuelle Maschinen', en: 'Virtual machines' } },
    tools({ add, S, L, clip }) {
      const c = typeof clip === 'function' ? clip : (x) => x;
      add('vm_list', 'vms', 'Virtuelle Maschinen dieses PCs (QEMU) mit id, Zustand, System, CPU/RAM, IP, App-Vorlage, Adresse und SSH-Befehl; dazu VirtualBox- und Hyper-V-VMs (nur Name/Zustand).', {}, [], async () => {
        const out = { vms: [...m.vms.values()].sort((a, b) => a.name.localeCompare(b.name)).map(short) };
        try { out.virtualbox = (await m.vboxList()).map((v) => ({ name: v.name, zustand: v.state })); } catch { /* egal */ }
        try { const h = await m.hypervState(); out.hyperv = h.available ? (h.vms || []).map((v) => ({ name: v.name, zustand: v.state })) : 'nicht verfügbar'; } catch { /* egal */ }
        return c(out);
      }, { risk: 'read' });
      add('vm_apps', 'vms', 'App-Vorlagen für neue VMs (id, Name, was sie installieren, Port auf diesem PC) und die Linux-Images dafür.', {}, [], async () => c({ apps: A.list().map((a) => ({ id: a.id, name: a.label, text: a.text, port: (a.forwards[0] || {}).host || null })), images: catalog.list().filter((e) => e.kind === 'cloud' && A.APT.includes(e.family)).map((e) => ({ id: e.id, name: e.label, arch: e.arch })) }), { risk: 'read' });
      add('vm_screen', 'vms', 'Was gerade auf einer VM passiert – als Text: Zustand, Gast-Agent, letzte Ereignisse und die letzten Zeilen der seriellen Konsole (kein Bild).', { vm: S('id oder Name der VM') }, ['vm'], async ({ vm }) => m.screenContext(find(vm).id).text, { risk: 'read' });
      add('vm_start', 'vms', 'Eine virtuelle Maschine starten.', { vm: S('id oder Name der VM') }, ['vm'], async ({ vm }) => {
        const v = find(vm);
        await m.start(v.id);
        return L(`VM „${v.name}“ startet.`, `VM “${v.name}” is starting.`);
      }, {
        risk: 'change', label: L('VM starten', 'Start VM'), undo: true,
        describe: ({ vm }) => ({ ask: L(`VM „${nameOf(vm)}“ starten?`, `Start VM “${nameOf(vm)}”?`), verb: L('Starten', 'Start'), effect: L('Die VM belegt danach ihren Arbeitsspeicher und ihre CPU-Kerne auf diesem PC.', 'The VM then uses its memory and CPU cores on this PC.'), undo: L('Wieder herunterfahren.', 'Shut it down again.') }),
      });
      add('vm_stop', 'vms', 'Eine virtuelle Maschine sauber herunterfahren (force: true = sofort ausschalten wie Stecker ziehen – nur wenn sie nicht reagiert).', { vm: S('id oder Name der VM'), force: { type: 'boolean', description: 'sofort ausschalten statt herunterfahren' } }, ['vm'], async ({ vm, force }) => {
        const v = find(vm);
        await m.stop(v.id, { force: !!force });
        return force ? L(`VM „${v.name}“ ausgeschaltet.`, `VM “${v.name}” powered off.`) : L(`VM „${v.name}“ fährt herunter.`, `VM “${v.name}” is shutting down.`);
      }, {
        risk: ({ force } = {}) => (force ? 'system' : 'change'), label: L('VM herunterfahren', 'Shut down VM'), undo: true,
        describe: ({ vm, force }) => (force
          ? { ask: L(`VM „${nameOf(vm)}“ sofort ausschalten?`, `Power off VM “${nameOf(vm)}” right away?`), verb: L('Ausschalten', 'Power off'), effect: L('Wie Stecker ziehen – was die VM noch nicht gespeichert hat, geht verloren.', 'Like pulling the plug – unsaved data in the VM is lost.'), undo: L('Wieder starten (ungespeicherte Daten bleiben verloren).', 'Start it again (unsaved data stays lost).') }
          : { ask: L(`VM „${nameOf(vm)}“ herunterfahren?`, `Shut down VM “${nameOf(vm)}”?`), verb: L('Herunterfahren', 'Shut down'), effect: L('Programme in der VM werden beendet; Dienste darin sind nicht mehr erreichbar.', 'Programs in the VM end; its services are no longer reachable.'), undo: L('Wieder starten.', 'Start it again.') }),
      });
      add('vm_create', 'vms', 'Neue fertige Linux-VM anlegen, optional mit App-Vorlage (app: nginx, docker, wordpress, nextcloud, gitea, uptime-kuma – siehe vm_apps). Lädt das Image beim ersten Mal herunter; Anmeldung mit Benutzer und Passwort aus der Antwort.', {
        name: S('Name der neuen VM'), app: S('id der App-Vorlage (optional)'), image: S('Linux-Image, Standard debian-12'), password: S('Passwort des Benutzers (optional – sonst zufällig)'),
      }, ['name'], async ({ name, app, image, password }) => {
        const entry = catalog.get(image || 'debian-12');
        const pw = password && String(password).length >= 6 ? String(password) : crypto.randomBytes(9).toString('base64url');
        const job = m.create({ source: 'cloud', name, image: entry ? entry.id : image, app: app || undefined, user: entry ? entry.user : undefined, password: pw, start: true });
        const a = app ? A.get(app) : null;
        return L(`VM „${name}“ wird angelegt und gestartet (Auftrag ${job.id}). Benutzer ${entry ? entry.user : '?'}, Passwort ${pw}${a ? ` – ${a.label} ist nach einigen Minuten bereit` : ''}.`, `VM “${name}” is being created and started (job ${job.id}). User ${entry ? entry.user : '?'}, password ${pw}${a ? ` – ${a.label} is ready after a few minutes` : ''}.`);
      }, {
        risk: 'change', label: L('VM anlegen', 'Create VM'), undo: true, timeout: 60000,
        describe: ({ name, app, image }) => {
          const a = app ? A.get(app) : null;
          const e = catalog.get(image || 'debian-12');
          return { ask: L(`VM „${name}“ anlegen${a ? ` mit ${a.label}` : ''} (${e ? e.label : image})?`, `Create VM “${name}”${a ? ` with ${a.label}` : ''} (${e ? e.label : image})?`), verb: L('Anlegen', 'Create'), effect: L(`Lädt das Image beim ersten Mal (~${e ? e.sizeMb : '?'} MB), startet die VM${a && a.forwards[0] ? ` und leitet Port ${a.forwards[0].host} dieses PCs weiter` : ''}.`, `Downloads the image the first time (~${e ? e.sizeMb : '?'} MB), starts the VM${a && a.forwards[0] ? ` and forwards port ${a.forwards[0].host} of this PC` : ''}.`), undo: L('Die VM unter „Virtuelle Maschinen“ löschen.', 'Delete the VM under “Virtual machines”.') };
        },
      });
      add('vm_from_template', 'vms', 'Neue VM als verknüpften Klon einer VM-Vorlage anlegen (in Sekunden; template = id oder Name der Vorlage).', { template: S('id oder Name der Vorlage'), name: S('Name der neuen VM') }, ['template', 'name'], async ({ template, name }) => {
        const t = find(template);
        if (!t.template) throw new Error(`„${t.name}“ ist keine Vorlage.`);
        const job = m.create({ source: 'template', template: t.id, name, start: true });
        return L(`VM „${name}“ entsteht aus der Vorlage „${t.name}“ (Auftrag ${job.id}).`, `VM “${name}” is created from template “${t.name}” (job ${job.id}).`);
      }, {
        risk: 'change', label: L('VM aus Vorlage', 'VM from template'), undo: true,
        describe: ({ template, name }) => ({ ask: L(`VM „${name}“ aus der Vorlage „${nameOf(template)}“ anlegen und starten?`, `Create and start VM “${name}” from template “${nameOf(template)}”?`), verb: L('Anlegen', 'Create'), effect: L('Ein verknüpfter Klon – braucht nur Platz für Änderungen; die Vorlage muss bleiben.', 'A linked clone – needs space only for changes; the template has to stay.'), undo: L('Die VM unter „Virtuelle Maschinen“ löschen.', 'Delete the VM under “Virtual machines”.') }),
      });
    },
    // Own @ source in the chat: "@VM" attaches the text view of a VM's screen
    context: {
      kind: 'vm',
      label: { de: 'Virtuelle Maschinen', en: 'Virtual machines' },
      search: async (q) => [...m.vms.values()].filter((v) => !q || v.name.toLowerCase().includes(String(q).toLowerCase())).slice(0, 20).map((v) => ({ id: v.id, label: v.name })),
      resolve: async (id) => m.screenContext(id).text,
    },
  };
}

module.exports = { vmsAi };
