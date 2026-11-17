import { Monitor, Server, AppWindow, Box } from 'lucide-react';
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
export const isOn = (s) => ['running', 'paused', 'starting', 'stopping'].includes(s);

export function OsIcon({ vm, size = 18 }) {
  const Icon = vm.template ? Box : vm.osType === 'windows' ? AppWindow : vm.osType === 'linux' ? Server : Monitor;
  return <Icon size={size} aria-hidden="true" />;
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
