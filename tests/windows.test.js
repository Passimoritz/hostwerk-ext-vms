'use strict';
/*
 * Windows guests: answer file (autounattend.xml), the UNATTEND ISO and the virtio-win lookup. Pure – nothing runs,
 * nothing is downloaded.   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const W = require('../server/windows');
const { readIso } = require('../server/iso');

const OK = { user: 'demo', password: 'Secret-123', computerName: 'WIN11-TEST' };

/**
 * Minimal XML well-formedness check without regexes over the whole document: walks the text character by character,
 * checks that tags are balanced and properly nested, attributes are quoted, and every "&" starts a known entity.
 * Returns { root, elements: [{ name, attrs, text, path }] }.
 */
function parseXml(src) {
  let i = 0;
  const stack = [];
  const elements = [];
  let root = null;
  const err = (m) => { throw new Error(`XML: ${m} at ${i}`); };
  const isName = (c) => /[A-Za-z0-9_:.-]/.test(c);
  const entity = (str) => {
    for (let k = 0; k < str.length; k++) {
      if (str[k] === '<') err('raw < in text');
      if (str[k] === '&') {
        const end = str.indexOf(';', k);
        const e = str.slice(k + 1, end);
        if (end < 0 || !['amp', 'lt', 'gt', 'quot', 'apos'].includes(e)) err(`bad entity &${e}`);
      }
    }
    return str.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  };
  while (i < src.length) {
    if (src[i] !== '<') {
      const next = src.indexOf('<', i);
      const text = src.slice(i, next < 0 ? src.length : next);
      if (!stack.length && text.trim()) err('text outside root');
      const t = entity(text);
      if (stack.length) stack[stack.length - 1].text += t;
      i = next < 0 ? src.length : next;
      continue;
    }
    if (src.startsWith('<?', i)) { const e = src.indexOf('?>', i); if (e < 0) err('open PI'); i = e + 2; continue; }
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); if (e < 0) err('open comment'); if (src.slice(i + 4, e).includes('--')) err('-- in comment'); i = e + 3; continue; }
    if (src[i + 1] === '/') {
      i += 2; let name = ''; while (isName(src[i])) name += src[i++];
      while (src[i] === ' ') i++;
      if (src[i] !== '>') err('bad end tag');
      i++;
      const open = stack.pop();
      if (!open || open.name !== name) err(`</${name}> does not close <${open && open.name}>`);
      continue;
    }
    i++;
    let name = ''; while (isName(src[i])) name += src[i++];
    if (!name) err('empty tag name');
    const attrs = {};
    for (;;) {
      while (/\s/.test(src[i])) i++;
      if (src[i] === '>' || src.startsWith('/>', i)) break;
      let an = ''; while (isName(src[i])) an += src[i++];
      if (!an || src[i] !== '=') err('bad attribute');
      i++;
      const qch = src[i];
      if (qch !== '"' && qch !== "'") err('unquoted attribute');
      const e = src.indexOf(qch, i + 1);
      if (an in attrs) err(`duplicate attribute ${an}`);
      attrs[an] = entity(src.slice(i + 1, e));
      i = e + 1;
    }
    if (!stack.length && root) err('second root element');
    const el = { name, attrs, text: '', path: [...stack.map((s) => s.name), name].join('/') };
    elements.push(el);
    if (!root) root = el;
    if (src.startsWith('/>', i)) { i += 2; continue; }
    i++;
    stack.push(el);
  }
  if (stack.length) err(`unclosed <${stack[stack.length - 1].name}>`);
  if (!root) err('no root');
  return { root, elements };
}
const texts = (doc, pathEnd) => doc.elements.filter((e) => e.path.endsWith(pathEnd)).map((e) => e.text);

test('xml checker itself rejects broken documents', () => {
  assert.doesNotThrow(() => parseXml('<?xml version="1.0"?><a x="1"><b>t &amp; u</b><c/></a>'));
  for (const bad of ['<a><b></a></b>', '<a>', '<a>x & y</a>', '<a x=1></a>', '<a></a><b></b>', '<a>1 < 2</a>']) assert.throws(() => parseXml(bad), bad);
});

test('windows: answer file is well-formed with all three passes and sane defaults', () => {
  const doc = parseXml(W.unattendXml(OK));
  assert.equal(doc.root.name, 'unattend');
  assert.equal(doc.root.attrs.xmlns, 'urn:schemas-microsoft-com:unattend');
  assert.deepEqual(doc.elements.filter((e) => e.name === 'settings').map((e) => e.attrs.pass), ['windowsPE', 'specialize', 'oobeSystem']);
  for (const c of doc.elements.filter((e) => e.name === 'component')) {
    assert.equal(c.attrs.processorArchitecture, 'amd64');
    assert.equal(c.attrs.publicKeyToken, '31bf3856ad364e35');
  }
  assert.deepEqual(texts(doc, 'SetupUILanguage/UILanguage'), ['de-DE']);
  assert.ok(texts(doc, '/InputLocale').every((t) => t === '0407:00000407'));
  assert.deepEqual(texts(doc, '/TimeZone'), ['W. Europe Standard Time']);
  assert.deepEqual(texts(doc, '/ComputerName'), ['WIN11-TEST']);
  assert.deepEqual(texts(doc, 'MetaData/Key'), ['/IMAGE/NAME']);
  assert.deepEqual(texts(doc, 'MetaData/Value'), ['Windows 11 Pro']);
  assert.deepEqual(texts(doc, 'UserData/AcceptEula'), ['true']);
  assert.equal(texts(doc, 'ProductKey/Key').length, 0, 'no product key unless given');
  // local account, no Microsoft account, privacy questions answered
  assert.deepEqual(texts(doc, 'LocalAccount/Name'), ['demo']);
  assert.deepEqual(texts(doc, 'LocalAccount/Group'), ['Administrators']);
  assert.deepEqual(texts(doc, 'OOBE/HideOnlineAccountScreens'), ['true']);
  assert.deepEqual(texts(doc, 'OOBE/ProtectYourPC'), ['3']);
  assert.ok(texts(doc, 'RunSynchronousCommand/Path').some((p) => p.includes('OOBE') && p.includes('BypassNRO')));
  // AutoLogon once (default) and the password removed again afterwards
  assert.deepEqual(texts(doc, 'AutoLogon/LogonCount'), ['1']);
  const first = texts(doc, 'SynchronousCommand/CommandLine');
  assert.ok(first.some((c) => c.includes('DefaultPassword')));
  assert.equal(texts(doc, 'FirstLogonCommands/SynchronousCommand/Order').join(','), first.map((_, i) => i + 1).join(','));
});

test('windows: first logon deletes the Panther copies first and installs the guest tools last (its agent means "done")', () => {
  const doc = parseXml(W.unattendXml(OK));
  const first = texts(doc, 'SynchronousCommand/CommandLine');
  assert.match(first[0], /Panther\\unattend\.xml/);
  assert.match(first[0], /Panther\\Unattend\\\*\.xml/);
  const last = first[first.length - 1];
  assert.match(last, /virtio-win-guest-tools\.exe/);
  assert.match(last, /'\/install','\/quiet','\/norestart'/);
  if (OK.autoLogon) assert.ok(first.findIndex((c) => /DefaultPassword/.test(c)) < first.length - 1, 'AutoLogon password gone before the tools');
  // without drivers and without AutoLogon only the clean-up remains
  const d2 = parseXml(W.unattendXml({ ...OK, drivers: false, autoLogon: false }));
  const f2 = texts(d2, 'SynchronousCommand/CommandLine');
  assert.equal(f2.length, 1); assert.match(f2[0], /Panther/);
  assert.equal(texts(d2, 'AutoLogon/Enabled').length, 0);
  assert.equal(d2.elements.filter((e) => e.name === 'DriverPaths').length, 0);
});

test('windows: driver paths for viostor, vioscsi, NetKVM and Balloon on D: to H:', () => {
  const doc = parseXml(W.unattendXml({ ...OK, diskBus: 'virtio' }));
  const paths = texts(doc, 'PathAndCredentials/Path');
  for (const p of ['D:\\viostor\\w11\\amd64', 'H:\\vioscsi\\2k22\\amd64', 'F:\\NetKVM\\w10\\amd64', 'E:\\Balloon\\w11\\amd64']) assert.ok(paths.includes(p), p);
  const keys = doc.elements.filter((e) => e.name === 'PathAndCredentials').map((e) => e.attrs['wcm:keyValue']);
  assert.equal(new Set(keys).size, keys.length, 'keyValue must be unique');
  assert.throws(() => W.unattendXml({ ...OK, diskBus: 'virtio', drivers: false }), /virtio/);
});

test('windows: hardware-check bypass only when wanted', () => {
  const on = texts(parseXml(W.unattendXml(OK)), 'RunSynchronousCommand/Path').join('\n');
  for (const k of ['BypassTPMCheck', 'BypassSecureBootCheck', 'BypassRAMCheck']) assert.match(on, new RegExp(`LabConfig" /v ${k} /t REG_DWORD /d 1`));
  const off = texts(parseXml(W.unattendXml({ ...OK, bypassChecks: false })), 'RunSynchronousCommand/Path').join('\n');
  assert.doesNotMatch(off, /LabConfig/);
});

test('windows: UEFI vs BIOS partition layout', () => {
  const u = parseXml(W.unattendXml({ ...OK, firmware: 'uefi' }));
  assert.deepEqual(texts(u, 'CreatePartition/Type'), ['EFI', 'MSR', 'Primary']);
  assert.deepEqual(texts(u, 'CreatePartition/Size'), ['300', '16']);
  assert.deepEqual(texts(u, 'ModifyPartition/Format'), ['FAT32', 'NTFS']);
  assert.deepEqual(texts(u, 'InstallTo/PartitionID'), ['3']);
  assert.deepEqual(texts(u, 'Disk/WillWipeDisk'), ['true']);
  assert.deepEqual(texts(u, 'Disk/DiskID'), ['0']);
  const b = parseXml(W.unattendXml({ ...OK, firmware: 'bios' }));
  assert.deepEqual(texts(b, 'CreatePartition/Type'), ['Primary', 'Primary']);
  assert.deepEqual(texts(b, 'CreatePartition/Size'), ['500']);
  assert.deepEqual(texts(b, 'CreatePartition/Extend'), ['true']);
  assert.deepEqual(texts(b, 'ModifyPartition/Active'), ['true']);
  assert.deepEqual(texts(b, 'InstallTo/PartitionID'), ['2']);
  assert.deepEqual(texts(b, 'ModifyPartition/Letter'), ['C']);
});

test('windows: every user value is escaped', () => {
  const pw = `<&"'>]]>--`;
  const xml = W.unattendXml({ ...OK, user: "O'Neil & Co", password: pw, edition: 'Windows 11 Pro <N> & "x"' });
  assert.ok(!xml.includes(pw));
  assert.ok(xml.includes('&lt;&amp;&quot;&apos;&gt;]]&gt;--'));
  const doc = parseXml(xml);
  assert.deepEqual(texts(doc, 'LocalAccount/Password/Value'), [pw]);
  assert.deepEqual(texts(doc, 'AutoLogon/Password/Value'), [pw]);
  assert.deepEqual(texts(doc, 'LocalAccount/Name'), ["O'Neil & Co"]);
  assert.deepEqual(texts(doc, 'MetaData/Value'), ['Windows 11 Pro <N> & "x"']);
  assert.equal(W.xmlEscape(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&apos;f');
});

test('windows: edition by index, product key, language and time zone', () => {
  const doc = parseXml(W.unattendXml({ ...OK, edition: 6, productKey: 'abcde-12345-fghij-67890-klmno', language: 'en-US', timezone: 'UTC' }));
  assert.deepEqual(texts(doc, 'MetaData/Key'), ['/IMAGE/INDEX']);
  assert.deepEqual(texts(doc, 'MetaData/Value'), ['6']);
  assert.deepEqual(texts(doc, 'ProductKey/Key'), ['ABCDE-12345-FGHIJ-67890-KLMNO']);
  assert.deepEqual(texts(doc, 'SetupUILanguage/UILanguage'), ['en-US']);
  assert.ok(texts(doc, '/InputLocale').every((t) => t === '0409:00000409'));
  assert.deepEqual(texts(doc, '/TimeZone'), ['UTC']);
  assert.deepEqual(texts(parseXml(W.unattendXml({ ...OK, edition: '2' })), 'MetaData/Key'), ['/IMAGE/INDEX']);
  // UI in English, formats and keyboard German
  const mix = parseXml(W.unattendXml({ ...OK, language: 'en-US', locale: 'de-DE' }));
  assert.deepEqual(texts(mix, 'SetupUILanguage/UILanguage'), ['en-US']);
  assert.ok(texts(mix, '/UserLocale').every((t) => t === 'de-DE'));
});

test('windows: invalid input is rejected with status 400', () => {
  const bad = [
    { user: '' }, { user: 'a'.repeat(21) }, { user: 'Administrator' }, { user: 'guest' }, { user: 'a/b' }, { user: 'a\\b' },
    { user: 'a@b' }, { user: 'a[b]' }, { user: 'a:b' }, { user: 'a;b' }, { user: 'a|b' }, { user: 'a=b' }, { user: 'a,b' },
    { user: 'a+b' }, { user: 'a*b' }, { user: 'a?b' }, { user: 'a<b' }, { user: 'a"b' }, { user: '...' },
    { password: '' }, { password: undefined }, { password: 'x'.repeat(128) }, { password: 'a\nb' }, { password: 'a\u0001b' },
    { computerName: '' }, { computerName: 'a'.repeat(16) }, { computerName: '12345' }, { computerName: 'win_11' }, { computerName: 'wín' },
    { computerName: '-win' }, { language: 'xx-XX' }, { timezone: 'Europe/Berlin<' }, { edition: 0 }, { edition: 100 },
    { edition: 'x'.repeat(81) }, { productKey: 'ABCDE-12345' },
  ];
  for (const b of bad) assert.throws(() => W.unattendXml({ ...OK, ...b }), (e) => e.status === 400, JSON.stringify(b));
  assert.throws(() => W.unattendXml(), (e) => e.status === 400);
  // borders that are fine
  assert.doesNotThrow(() => W.unattendXml({ ...OK, user: 'a'.repeat(20), password: 'x'.repeat(127), computerName: 'a'.repeat(15) }));
  assert.doesNotThrow(() => W.unattendXml({ ...OK, user: 'Max Mustermann', computerName: 'PC-1' }));
});

test('windows: UNATTEND iso round-trips autounattend.xml', () => {
  const iso = W.unattendIso(OK);
  assert.equal(iso.length % 2048, 0);
  const r = readIso(iso);
  assert.equal(r.joliet, true);
  assert.equal(r.volume, 'UNATTEND');
  assert.deepEqual(Object.keys(r.files), ['autounattend.xml']);
  const xml = r.files['autounattend.xml'].toString('utf8');
  assert.ok(xml.startsWith('<?xml'));
  parseXml(xml);
  assert.throws(() => W.unattendIso({ ...OK, user: '' }), (e) => e.status === 400);
});

test('windows: virtio-win catalog entry and release lookup', async () => {
  assert.ok(W.VIRTIO_WIN.url.startsWith('https://fedorapeople.org/'));
  assert.equal(W.VIRTIO_WIN.checksum, false);
  const base = 'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/';
  const stablePage = `<title>Index of /groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-0.1.302-1</title>
    <a href="CHECKSUM">CHECKSUM</a> <a href="virtio-win-0.1.302-1.noarch.rpm">x</a> <a href="virtio-win-0.1.302.iso">x</a>`;
  const archivePage = '<a href="virtio-win-0.1.99-1/">a</a><a href="virtio-win-0.1.302-1/">b</a><a href="virtio-win-0.1.285-1/">c</a><a href="virtio-win-0.1.302-2/">d</a>';
  const md5Only = `${'a'.repeat(32)}  virtio-win-0.1.302-1.noarch.rpm\n${'b'.repeat(32)}  virtio-win-0.1.302-1.src.rpm\n`;
  const calls = [];
  const fake = (pages) => async (url) => { calls.push(url); if (url in pages) { const p = pages[url]; if (p instanceof Error) throw p; return p; } throw new Error(`404 ${url}`); };

  // today: only MD5 sums of the RPMs → no hash, versioned https URL
  const r = await W.resolveVirtioWin({ fetchText: fake({ [`${base}stable-virtio/`]: stablePage, [`${base}archive-virtio/virtio-win-0.1.302-1/CHECKSUM`]: md5Only }) });
  assert.deepEqual(r, { url: `${base}archive-virtio/virtio-win-0.1.302-1/virtio-win-0.1.302.iso`, file: 'virtio-win-0.1.302.iso', version: '0.1.302', hash: W.PINNED_SHA256['0.1.302'], algo: 'sha256', pinned: true }); // no published checksum → the one held fixed in windows.js
  assert.match(W.PINNED_SHA256['0.1.302'], /^[0-9a-f]{64}$/);

  // a future sha256 for the ISO is used
  const sha = 'c'.repeat(64);
  const r2 = await W.resolveVirtioWin({ fetchText: fake({ [`${base}stable-virtio/`]: stablePage, [`${base}archive-virtio/virtio-win-0.1.302-1/CHECKSUM`]: `${md5Only}${sha}  virtio-win-0.1.302.iso\n` }) });
  assert.deepEqual([r2.hash, r2.algo], [sha, 'sha256']);

  // stable listing unreachable (e.g. the http redirect is refused) → newest folder in archive-virtio/, numeric order
  const r3 = await W.resolveVirtioWin({ fetchText: fake({ [`${base}stable-virtio/`]: new Error('redirect to http refused'), [`${base}archive-virtio/?C=M;O=D`]: archivePage }) });
  assert.equal(r3.url, `${base}archive-virtio/virtio-win-0.1.302-2/virtio-win-0.1.302.iso`);
  assert.equal(r3.hash, W.PINNED_SHA256['0.1.302']); // no CHECKSUM reachable → the hash held fixed for this version

  await assert.rejects(W.resolveVirtioWin({ fetchText: async () => 'nothing here' }), /virtio-win/);
  assert.ok(calls.every((u) => u.startsWith('https://')));
});
