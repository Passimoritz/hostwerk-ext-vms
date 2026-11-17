'use strict';
/*
 * Keyboard and mouse for the screen in Hostwerk: browser KeyboardEvent.code (the physical key) → QEMU qcode, so the
 * guest's own keyboard layout decides which character appears – exactly like on a real PC. Plus text → key strokes for
 * "Type text" (US layout, the default of cloud images and installers).
 */
const CODE = {
  Escape: 'esc', Backspace: 'backspace', Tab: 'tab', Enter: 'ret', Space: 'spc', CapsLock: 'caps_lock',
  Minus: 'minus', Equal: 'equal', BracketLeft: 'bracket_left', BracketRight: 'bracket_right', Backslash: 'backslash',
  Semicolon: 'semicolon', Quote: 'apostrophe', Backquote: 'grave_accent', Comma: 'comma', Period: 'dot', Slash: 'slash', IntlBackslash: 'less', IntlRo: 'ro', IntlYen: 'yen',
  PrintScreen: 'print', ScrollLock: 'scroll_lock', Pause: 'pause', Insert: 'insert', Home: 'home', PageUp: 'pgup', Delete: 'delete', End: 'end', PageDown: 'pgdn',
  ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up', NumLock: 'num_lock', ContextMenu: 'menu',
  NumpadDivide: 'kp_divide', NumpadMultiply: 'kp_multiply', NumpadSubtract: 'kp_subtract', NumpadAdd: 'kp_add', NumpadEnter: 'kp_enter', NumpadDecimal: 'kp_decimal', NumpadEqual: 'kp_equals', NumpadComma: 'kp_comma',
  ControlLeft: 'ctrl', ShiftLeft: 'shift', AltLeft: 'alt', MetaLeft: 'meta_l', ControlRight: 'ctrl_r', ShiftRight: 'shift_r', AltRight: 'alt_r', MetaRight: 'meta_r',
};
for (let i = 0; i < 26; i++) { const c = String.fromCharCode(97 + i); CODE[`Key${c.toUpperCase()}`] = c; }
for (let i = 0; i <= 9; i++) { CODE[`Digit${i}`] = String(i); CODE[`Numpad${i}`] = `kp_${i}`; }
for (let i = 1; i <= 12; i++) CODE[`F${i}`] = `f${i}`;

function qcodeOf(code) { return CODE[String(code)] || null; }

/** US layout: character → [qcode, shift] */
const US = {};
for (let i = 0; i < 26; i++) { const c = String.fromCharCode(97 + i); US[c] = [c, false]; US[c.toUpperCase()] = [c, true]; }
'1234567890'.split('').forEach((d) => { US[d] = [d, false]; });
Object.assign(US, {
  '!': ['1', true], '@': ['2', true], '#': ['3', true], $: ['4', true], '%': ['5', true], '^': ['6', true], '&': ['7', true], '*': ['8', true], '(': ['9', true], ')': ['0', true],
  '-': ['minus', false], _: ['minus', true], '=': ['equal', false], '+': ['equal', true], '[': ['bracket_left', false], '{': ['bracket_left', true], ']': ['bracket_right', false], '}': ['bracket_right', true],
  '\\': ['backslash', false], '|': ['backslash', true], ';': ['semicolon', false], ':': ['semicolon', true], "'": ['apostrophe', false], '"': ['apostrophe', true],
  '`': ['grave_accent', false], '~': ['grave_accent', true], ',': ['comma', false], '<': ['comma', true], '.': ['dot', false], '>': ['dot', true], '/': ['slash', false], '?': ['slash', true],
  ' ': ['spc', false], '\n': ['ret', false], '\t': ['tab', false],
});

/*
 * German layout (QWERTZ, as the guest sets it): character → [qcode of the physical key, modifier]. qcodes name the key
 * position of a US keyboard, so "z" is on the key US calls "y". Modifier: '' none, 's' Shift, 'g' AltGr (right Alt).
 * Dead keys (^ ´ `) are left out – they would combine with the next character.
 */
const DE = {};
for (let i = 0; i < 26; i++) { const c = String.fromCharCode(97 + i); DE[c] = [c, '']; DE[c.toUpperCase()] = [c, 's']; }
DE.z = ['y', '']; DE.Z = ['y', 's']; DE.y = ['z', '']; DE.Y = ['z', 's'];
'1234567890'.split('').forEach((d) => { DE[d] = [d, '']; });
Object.assign(DE, {
  '!': ['1', 's'], '"': ['2', 's'], '§': ['3', 's'], $: ['4', 's'], '%': ['5', 's'], '&': ['6', 's'], '/': ['7', 's'], '(': ['8', 's'], ')': ['9', 's'], '=': ['0', 's'],
  '²': ['2', 'g'], '³': ['3', 'g'], '{': ['7', 'g'], '[': ['8', 'g'], ']': ['9', 'g'], '}': ['0', 'g'],
  'ß': ['minus', ''], '?': ['minus', 's'], '\\': ['minus', 'g'],
  'ü': ['bracket_left', ''], 'Ü': ['bracket_left', 's'], '+': ['bracket_right', ''], '*': ['bracket_right', 's'], '~': ['bracket_right', 'g'],
  'ö': ['semicolon', ''], 'Ö': ['semicolon', 's'], 'ä': ['apostrophe', ''], 'Ä': ['apostrophe', 's'],
  '#': ['backslash', ''], "'": ['backslash', 's'], '°': ['grave_accent', 's'],
  '<': ['less', ''], '>': ['less', 's'], '|': ['less', 'g'],
  ',': ['comma', ''], ';': ['comma', 's'], '.': ['dot', ''], ':': ['dot', 's'], '-': ['slash', ''], _: ['slash', 's'],
  '@': ['q', 'g'], '€': ['e', 'g'], 'µ': ['m', 'g'],
  ' ': ['spc', ''], '\n': ['ret', ''], '\t': ['tab', ''],
});
const LAYOUTS = { us: Object.fromEntries(Object.entries(US).map(([c, [q, s]]) => [c, [q, s ? 's' : '']])), de: DE };
const MOD = { s: 'shift', g: 'alt_r' };

/** Text → list of send-key calls ([['shift','a'], ['b'] …]) for the guest's keyboard layout. Unknown characters are refused. */
function textToKeys(text, layout = 'us') {
  const map = LAYOUTS[layout] || LAYOUTS.us;
  const out = [];
  for (const ch of String(text).replace(/\r\n?/g, '\n')) {
    const k = map[ch];
    if (!k) throw Object.assign(new Error(layout === 'de' ? `Cannot type “${ch}” – not on a German keyboard.` : `Cannot type “${ch}” – only characters of a US keyboard.`), { status: 400 });
    out.push(k[1] ? [MOD[k[1]], k[0]] : [k[0]]);
  }
  return out;
}

/** Shortcuts the screen offers as buttons (they would otherwise be caught by this PC). */
const COMBOS = {
  'ctrl-alt-del': ['ctrl', 'alt', 'delete'], 'ctrl-alt-f1': ['ctrl', 'alt', 'f1'], 'ctrl-alt-f2': ['ctrl', 'alt', 'f2'], 'ctrl-alt-f7': ['ctrl', 'alt', 'f7'],
  'alt-tab': ['alt', 'tab'], 'alt-f4': ['alt', 'f4'], meta: ['meta_l'], 'ctrl-esc': ['ctrl', 'esc'], print: ['print'],
};

const BUTTONS = { left: 'left', right: 'right', middle: 'middle', 'wheel-up': 'wheel-up', 'wheel-down': 'wheel-down' };

/**
 * Events from the interface → QMP input-send-event events.
 *   { t: 'm', x, y } (0–1)  ·  { t: 'b', b: 'left', d: true }  ·  { t: 'k', c: 'KeyA', d: true }
 */
function toQmpEvents(list) {
  const out = [];
  for (const e of (Array.isArray(list) ? list : []).slice(0, 200)) {
    if (!e || typeof e !== 'object') continue;
    if (e.t === 'm' && Number.isFinite(e.x) && Number.isFinite(e.y)) {
      const v = (n) => Math.round(Math.max(0, Math.min(1, n)) * 32767);
      out.push({ type: 'abs', data: { axis: 'x', value: v(e.x) } }, { type: 'abs', data: { axis: 'y', value: v(e.y) } });
    } else if (e.t === 'b' && BUTTONS[e.b]) out.push({ type: 'btn', data: { down: !!e.d, button: BUTTONS[e.b] } });
    else if (e.t === 'k') { const q = qcodeOf(e.c); if (q) out.push({ type: 'key', data: { down: !!e.d, key: { type: 'qcode', data: q } } }); }
  }
  return out;
}

module.exports = { qcodeOf, textToKeys, toQmpEvents, COMBOS, CODE, LAYOUTS };
