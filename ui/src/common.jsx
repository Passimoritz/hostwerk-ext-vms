import { Monitor, Server, AppWindow, Box, Layers } from 'lucide-react';
import { SvcImage } from '@hostwerk/kit';
import { fmtBytes } from '@hostwerk/api';
import { toast } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';

export const BASE = '#/vms';
export const go = (p = '') => { location.hash = `${BASE.slice(1)}${p ? `/${p}` : ''}`; };

export const STATE = {
  running: { label: 'Running', pill: 'running' },
  paused: { label: 'Paused', pill: 'starting' },
  starting: { label: 'Starting', pill: 'starting' },
  stopping: { label: 'Shutting down', pill: 'starting' },
  stopped: { label: 'Off', pill: 'stopped' },
  saved: { label: 'Saved', pill: 'stopped' },
  error: { label: 'Error', pill: 'error' },
};
export const stateOf = (v) => (v.creating ? 'starting' : (v.status && v.status.state) || 'stopped');
/** Namen vergleichen wie ein Mensch: ohne Groß/Klein und Leerzeichen am Rand. */
export const nameKey = (n) => String(n || '').trim().toLowerCase();
/** Namen, die mehr als eine VM trägt (als nameKey). */
export function dupNames(vms) {
  const seen = new Map();
  for (const v of vms || []) { const k = nameKey(v.name); if (k) seen.set(k, (seen.get(k) || 0) + 1); }
  return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
}
export const isOn = (s) => ['running', 'paused', 'starting', 'stopping'].includes(s);

export function OsIcon({ vm, size = 18 }) {
  const Icon = vm.template ? Box : vm.osType === 'windows' ? AppWindow : vm.osType === 'linux' ? Server : Monitor;
  return <Icon size={size} aria-hidden="true" />;
}

/** Colour of a VM's icon tile – by system, like the brand colours in Hostwerk's "New" menu. */
export function osColor(vm) {
  if (vm.template) return '#10b981';
  const label = String(vm.osLabel || '').toLowerCase();
  if (vm.osType === 'windows') return '#0078d4';
  if (/ubuntu/.test(label)) return '#e95420';
  if (/debian/.test(label)) return '#d70a53';
  if (/fedora/.test(label)) return '#3c6eb4';
  if (/alma|rocky|centos|red hat/.test(label)) return '#0f4266';
  if (/alpine/.test(label)) return '#0d597f';
  if (vm.osType === 'linux') return '#f59e0b';
  return '#64748b';
}

/**
 * Logo of the VM's system through Hostwerk's icon service (kind "vm", sources from server/logos.js – found once,
 * kept, changeable with the pencil like every service picture). Until one is found, or when there is none: the colour
 * tile of the system. small = the 30 px icon of a page title. VirtualBox VMs: vboxUuid + their OS type as hint.
 */
export function VmLogo({ vm, vboxUuid, osType, small = false }) {
  const c = vboxUuid ? '#2563eb' : osColor(vm);
  const tile = (
    <span className={`svc-icon${small ? ' vm-h1-icon' : ''}`} style={{ background: `linear-gradient(135deg, ${c}, ${c}aa)` }}>
      {vboxUuid ? <Layers size={small ? 18 : 20} aria-hidden="true" /> : <OsIcon vm={vm} size={small ? 18 : 20} />}
    </span>
  );
  return <SvcImage kind="vm" id={vboxUuid ? ["vbox", vboxUuid].join("-") : vm.id} hint={vboxUuid ? osType : undefined} size={small ? 30 : undefined} className={small ? 'ico' : 'svc-icon'} fallback={tile} />;
}

/** First IPv4 address the guest agent reports (not loopback) – null while the agent is quiet. */
export function ipOf(vm) {
  const a = vm.status && vm.status.agent;
  const x = a && a.ok && (a.addresses || []).find((y) => y.type === 'ipv4' && !/^127\./.test(y.ip));
  return x ? x.ip : null;
}

/** Breadcrumbs like Hostwerk's detail pages: Virtual machines / … / name. items: [[route|null, label], …] */
export function Crumbs({ items }) {
  return (
    <div className="crumbs small" style={{ marginBottom: 6 }}>
      <a href={BASE}>{t('Virtual machines')}</a>
      {items.map(([route, label], i) => <span key={i} style={{ display: 'contents' }}><span>/</span>{route ? <a href={`${BASE}/${route}`}>{label}</a> : <span>{label}</span>}</span>)}
    </div>
  );
}

export const mem = (mb) => (mb >= 1024 ? `${Math.round(mb / 102.4) / 10} GB` : `${mb} MB`);
export const gb = (bytes) => (bytes == null ? '–' : fmtBytes(bytes));

export function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast.success(t('Copied'))).catch(() => toast.error(t('Could not copy')));
}

/** Runs an API call; errors become a toast. → result, or false on error. */
export async function run(fn, ok) {
  try { const r = await fn(); if (ok) toast.success(t(ok)); return r ?? true; } catch (e) { toast.error(e.message); return false; }
}
