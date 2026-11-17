'use strict';
/*
 * App templates (#9): ready app VMs on top of the cloud images. Each app is data – packages from the guest's own
 * distribution, a fixed setup script (written with cloud-init write_files, run once at the first start), the port
 * forwards it needs and the address the overview opens ("Open WordPress"). Only for Debian/Ubuntu images (apt).
 *
 * Plus the person's own start commands and bash script (cleanStartScript): every command becomes one runcmd entry
 * ["sh", "-c", "<command>"] written as an escaped YAML string, the script travels base64 – nothing typed here can
 * change the structure of the cloud-init file.
 *
 * In the guest: /var/lib/hostwerk/app.sh (+ log /var/log/hostwerk-app.log, marker app-ready or app-failed),
 * /var/lib/hostwerk/start-script.sh (+ log /var/log/hostwerk-start-script.log, marker start-script-done/-failed).
 */
const { fail } = require('./util');

const APT = ['debian', 'ubuntu'];
const STATE_DIR = '/var/lib/hostwerk';

/** Docker from the distribution (docker.io) – Compose from the distribution as well, whichever name it has there. */
const DOCKER_SETUP = [
  'export DEBIAN_FRONTEND=noninteractive',
  'apt-get install -y -q docker-compose-v2 >/dev/null 2>&1 || apt-get install -y -q docker-compose >/dev/null 2>&1 || true',
  'systemctl enable --now docker',
  'id "$HW_USER" >/dev/null 2>&1 && usermod -aG docker "$HW_USER" || true',
];
/** A container that starts with the VM; waits until the web port answers (the first pull can take minutes). */
const container = (name, image, args, port) => [
  ...DOCKER_SETUP,
  `docker rm -f ${name} >/dev/null 2>&1 || true`,
  `docker run -d --name ${name} --restart unless-stopped ${args} ${image}`,
  `for i in $(seq 1 120); do curl -fsS -o /dev/null http://127.0.0.1:${port}/ && exit 0; sleep 5; done; echo "${name} does not answer on port ${port}" >&2; exit 1`,
];

const APPS = [
  {
    id: 'nginx', label: 'Nginx web server', open: 'Open the web page', memoryMb: 1024, diskGb: 10,
    text: 'Nginx with a start page – put your own pages into /var/www/html.',
    packages: ['nginx', 'curl'],
    forwards: [{ id: 'web', guest: 80, host: 8080, label: 'Web' }], url: { forward: 'web', path: '/' },
    script: [
      'cat > /var/www/html/index.html <<EOF',
      '<!doctype html><meta charset="utf-8"><title>$(hostname)</title><h1>Nginx on $(hostname) works</h1><p>Created by Hostwerk. Your pages: /var/www/html</p>',
      'EOF',
      'systemctl enable --now nginx',
      'systemctl reload nginx',
      'curl -fsS -o /dev/null http://127.0.0.1/',
    ],
  },
  {
    id: 'docker', label: 'Docker host', open: null, memoryMb: 2048, diskGb: 20,
    text: 'Docker Engine and Compose from the distribution; your user may run docker without sudo.',
    packages: ['docker.io', 'curl'],
    forwards: [], url: null,
    script: [...DOCKER_SETUP, 'docker info >/dev/null'],
  },
  {
    id: 'wordpress', label: 'WordPress', open: 'Open WordPress', memoryMb: 2048, diskGb: 15,
    text: 'WordPress with Apache, PHP and MariaDB (packages of the distribution) – the setup wizard opens on the first visit.',
    packages: ['apache2', 'mariadb-server', 'php', 'libapache2-mod-php', 'php-mysql', 'php-gd', 'php-curl', 'php-xml', 'php-mbstring', 'php-zip', 'wordpress', 'curl'],
    forwards: [{ id: 'web', guest: 80, host: 8080, label: 'WordPress' }], url: { forward: 'web', path: '/' },
    script: [
      'export DEBIAN_FRONTEND=noninteractive',
      'systemctl enable --now mariadb',
      'PW=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d " \\n")',
      'mysql -e "CREATE DATABASE IF NOT EXISTS wordpress DEFAULT CHARACTER SET utf8mb4; CREATE USER IF NOT EXISTS wordpress@localhost IDENTIFIED BY \'$PW\'; ALTER USER wordpress@localhost IDENTIFIED BY \'$PW\'; GRANT ALL ON wordpress.* TO wordpress@localhost; FLUSH PRIVILEGES;"',
      'mkdir -p /etc/wordpress /var/lib/wordpress/wp-content/uploads',
      'cat > /etc/wordpress/config-default.php <<EOF',
      "<?php define('DB_NAME', 'wordpress'); define('DB_USER', 'wordpress'); define('DB_PASSWORD', '$PW'); define('DB_HOST', 'localhost'); define('WP_CONTENT_DIR', '/var/lib/wordpress/wp-content'); define('FS_METHOD', 'direct');",
      'EOF',
      'chown root:www-data /etc/wordpress/config-default.php; chmod 640 /etc/wordpress/config-default.php',
      'chown -R www-data:www-data /var/lib/wordpress/wp-content',
      'cat > /etc/apache2/sites-available/wordpress.conf <<"EOF"',
      '<VirtualHost *:80>',
      '  DocumentRoot /usr/share/wordpress',
      '  Alias /wp-content /var/lib/wordpress/wp-content',
      '  <Directory /usr/share/wordpress>',
      '    Options FollowSymLinks',
      '    AllowOverride Limit Options FileInfo',
      '    DirectoryIndex index.php',
      '    Require all granted',
      '  </Directory>',
      '  <Directory /var/lib/wordpress/wp-content>',
      '    Options FollowSymLinks',
      '    Require all granted',
      '  </Directory>',
      '</VirtualHost>',
      'EOF',
      'a2dissite 000-default >/dev/null; a2ensite wordpress >/dev/null; a2enmod rewrite >/dev/null',
      'systemctl restart apache2',
      'curl -fsS -o /dev/null -L http://127.0.0.1/',
    ],
  },
  {
    id: 'nextcloud', label: 'Nextcloud', open: 'Open Nextcloud', memoryMb: 2048, diskGb: 20,
    text: 'Files, calendar and contacts in your own cloud – official Nextcloud container; the first visit creates the admin account.',
    packages: ['docker.io', 'curl'],
    forwards: [{ id: 'web', guest: 80, host: 8081, label: 'Nextcloud' }], url: { forward: 'web', path: '/' },
    script: container('nextcloud', 'nextcloud:stable', '-p 80:80 -v nextcloud:/var/www/html -e NEXTCLOUD_TRUSTED_DOMAINS="127.0.0.1 localhost"', 80),
  },
  {
    id: 'gitea', label: 'Gitea (Git server)', open: 'Open Gitea', memoryMb: 1024, diskGb: 15,
    text: 'Your own small GitHub: repositories, issues and pull requests – official Gitea container.',
    packages: ['docker.io', 'curl'],
    forwards: [{ id: 'web', guest: 3000, host: 3000, label: 'Gitea' }], url: { forward: 'web', path: '/' },
    script: container('gitea', 'gitea/gitea:1', '-p 3000:3000 -v gitea:/data', 3000),
  },
  {
    id: 'uptime-kuma', label: 'Uptime Kuma (monitoring)', open: 'Open Uptime Kuma', memoryMb: 1024, diskGb: 10,
    text: 'Watches websites and services and reports outages – official Uptime Kuma container.',
    packages: ['docker.io', 'curl'],
    forwards: [{ id: 'web', guest: 3001, host: 3001, label: 'Uptime Kuma' }], url: { forward: 'web', path: '/' },
    script: container('uptime-kuma', 'louislam/uptime-kuma:1', '-p 3001:3001 -v uptime-kuma:/app/data', 3001),
  },
];

function list() { return APPS.map(({ script, ...a }) => ({ ...a, families: APT })); }
function get(id) { return APPS.find((a) => a.id === id) || null; }

/** The app for a new VM: known, and the image uses apt. → app or null */
function checkApp(id, entry) {
  if (!id) return null;
  const app = get(String(id));
  if (!app) throw fail(400, 'Unknown app template.');
  if (!entry || !APT.includes(entry.family)) throw fail(400, 'App templates need Debian or Ubuntu.');
  return app;
}

/** The setup script of an app (bash). HW_USER = the VM's user (already checked: [a-z0-9_-] only). */
function appScript(app, user) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(String(user || ''))) throw fail(400, 'Invalid user name.');
  return ['#!/bin/bash', `# Hostwerk app template: ${app.id}`, 'set -e', `HW_USER=${user}`, ...app.script, ''].join('\n');
}

const MAX_COMMANDS = 50;
const MAX_COMMAND = 2000;
const MAX_SCRIPT = 64 * 1024;
/**
 * The person's own start commands (one per line, empty lines and lines starting with "#" are skipped) and bash script.
 * → { commands: [...], script: '...' | null }
 */
function cleanStartScript({ commands, script } = {}) {
  const lines = (Array.isArray(commands) ? commands : String(commands || '').split(/\r?\n/)).map((l) => String(l).trim()).filter((l) => l && !l.startsWith('#'));
  if (lines.length > MAX_COMMANDS) throw fail(400, 'At most {n} commands at the first start – put more into the script.', { n: MAX_COMMANDS });
  for (const l of lines) {
    if (l.length > MAX_COMMAND) throw fail(400, 'A command may have at most {n} characters.', { n: MAX_COMMAND });
    if (/\u0000/.test(l)) throw fail(400, 'Invalid character in a command.');
  }
  let s = script == null ? '' : String(script).replace(/\r\n/g, '\n');
  if (!s.trim()) s = '';
  if (Buffer.byteLength(s) > MAX_SCRIPT) throw fail(400, 'The script may have at most 64 KB.');
  if (/\u0000/.test(s)) throw fail(400, 'Invalid character in the script.');
  if (s && !s.startsWith('#!')) s = `#!/bin/bash\n${s}`;
  if (s && !s.endsWith('\n')) s += '\n';
  return { commands: lines, script: s || null };
}

/**
 * A YAML double-quoted string that PyYAML (cloud-init) reads back exactly: JSON escaping plus \u/\U escapes for
 * everything outside printable ASCII (YAML 1.1 treats U+2028/2029 as line breaks and refuses some characters raw).
 */
function yq(v) {
  let out = '';
  for (const ch of JSON.stringify(String(v))) {
    const cp = ch.codePointAt(0);
    if (cp < 0x7f) out += ch;
    else if (cp > 0xffff) out += `\\U${cp.toString(16).padStart(8, '0')}`;
    else out += `\\u${cp.toString(16).padStart(4, '0')}`;
  }
  return out;
}

/** For tests and the live check: reads a yq() string back (JSON plus \U escapes). */
function unyq(s) {
  return JSON.parse(String(s).replace(/\\U([0-9a-f]{8})/gi, (m, h) => { const cp = parseInt(h, 16); const c = String.fromCodePoint(cp); return c.split('').map((u) => `\\u${u.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''); }));
}

/** Where a running app VM answers on this PC – from its forward. */
function appUrl(vm) {
  const app = vm && vm.app && get(vm.app.id);
  if (!app || !app.url) return null;
  const fw = (vm.net && vm.net.forwards) || [];
  const guest = (app.forwards.find((y) => y.id === app.url.forward) || {}).guest;
  const f = fw.find((x) => x.id === `app-${app.url.forward}`) || fw.find((x) => x.guest === guest && x.proto === 'tcp');
  return f ? { url: `http://127.0.0.1:${f.host}${app.url.path || '/'}`, port: f.host, label: app.open, lan: f.bind === 'lan' } : null;
}

/** Shell command for the guest agent: state of the app setup and the start script → JSON line. */
const STATE_CMD = `d=${STATE_DIR}; s() { if [ -f "$d/$1-ready" ] || [ -f "$d/$1-done" ]; then echo ok; elif [ -f "$d/$1-failed" ]; then echo failed; elif [ -f "$d/$1.sh" ]; then echo running; else echo none; fi; }; printf '{"app":"%s","script":"%s"}\\n' "$(s app)" "$(s start-script)"; tail -n 15 /var/log/hostwerk-app.log 2>/dev/null; tail -n 15 /var/log/hostwerk-start-script.log 2>/dev/null; true`;

module.exports = { APPS, APT, STATE_DIR, list, get, checkApp, appScript, cleanStartScript, yq, unyq, appUrl, STATE_CMD };
