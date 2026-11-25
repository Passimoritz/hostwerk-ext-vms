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
// Older browsers name the Windows key OSLeft/OSRight; media keys of keyboards that have them
Object.assign(CODE, {
  OSLeft: 'meta_l', OSRight: 'meta_r', AudioVolumeMute: 'audiomute', AudioVolumeDown: 'volumedown', AudioVolumeUp: 'volumeup',
  MediaPlayPause: 'audioplay', MediaStop: 'audiostop', MediaTrackNext: 'audionext', MediaTrackPrevious: 'audioprev',
});
/** Every qcode the screen may send – also the check for key lists from outside. */
const QCODES = new Set(Object.values(CODE));
/** Modifier qcodes: released all at once when the screen loses the keyboard, so none stays stuck in the guest. */
const MODIFIERS = ['ctrl', 'ctrl_r', 'shift', 'shift_r', 'alt', 'alt_r', 'meta_l', 'meta_r'];

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

/**
 * Shortcuts the screen offers in its menu – the ones this PC, Windows or the browser would catch before the page sees
 * them (Ctrl+Alt+Del, Alt+Tab, the Windows key …), plus the common ones for people who prefer a click.
 */
const COMBOS = {
  'ctrl-alt-del': ['ctrl', 'alt', 'delete'], 'ctrl-shift-esc': ['ctrl', 'shift', 'esc'], 'ctrl-alt-backspace': ['ctrl', 'alt', 'backspace'],
  'alt-tab': ['alt', 'tab'], 'alt-shift-tab': ['alt', 'shift', 'tab'], 'alt-f4': ['alt', 'f4'], 'alt-f2': ['alt', 'f2'], 'alt-space': ['alt', 'spc'], 'alt-esc': ['alt', 'esc'],
  meta: ['meta_l'], 'meta-d': ['meta_l', 'd'], 'meta-e': ['meta_l', 'e'], 'meta-l': ['meta_l', 'l'], 'meta-r': ['meta_l', 'r'], 'meta-tab': ['meta_l', 'tab'], 'meta-space': ['meta_l', 'spc'], 'meta-v': ['meta_l', 'v'],
  'ctrl-esc': ['ctrl', 'esc'], print: ['print'], 'alt-print': ['alt', 'print'],
  'ctrl-c': ['ctrl', 'c'], 'ctrl-v': ['ctrl', 'v'], 'ctrl-x': ['ctrl', 'x'], 'ctrl-a': ['ctrl', 'a'], 'ctrl-z': ['ctrl', 'z'], 'ctrl-y': ['ctrl', 'y'],
  'ctrl-shift-c': ['ctrl', 'shift', 'c'], 'ctrl-shift-v': ['ctrl', 'shift', 'v'], 'shift-insert': ['shift', 'insert'],
  'ctrl-w': ['ctrl', 'w'], 'ctrl-t': ['ctrl', 't'], 'ctrl-n': ['ctrl', 'n'], 'ctrl-shift-t': ['ctrl', 'shift', 't'], 'ctrl-tab': ['ctrl', 'tab'], 'ctrl-shift-tab': ['ctrl', 'shift', 'tab'], 'ctrl-q': ['ctrl', 'q'], 'ctrl-r': ['ctrl', 'r'],
  f1: ['f1'], f5: ['f5'], f11: ['f11'], f12: ['f12'], esc: ['esc'],
};
for (let i = 1; i <= 12; i++) COMBOS[`ctrl-alt-f${i}`] = ['ctrl', 'alt', `f${i}`];

/**
 * Keys of a combination: a name from COMBOS, or a list of 1–6 different qcodes (["ctrl", "alt", "t"]). Throws 400 for
 * anything else – nothing unknown reaches QEMU.
 */
function comboKeys(combo) {
  if (Array.isArray(combo)) {
    const keys = combo.map(String);
    if (!keys.length || keys.length > 6 || new Set(keys).size !== keys.length || !keys.every((k) => QCODES.has(k))) throw Object.assign(new Error('Unknown key combination.'), { status: 400 });
    return keys;
  }
  const keys = Object.prototype.hasOwnProperty.call(COMBOS, String(combo)) ? COMBOS[String(combo)] : null;
  if (!keys) throw Object.assign(new Error('Unknown key combination.'), { status: 400 });
  return keys;
}

const BUTTONS = { left: 'left', right: 'right', middle: 'middle', 'wheel-up': 'wheel-up', 'wheel-down': 'wheel-down' };

/**
 * Events from the interface → QMP input-send-event events.
 *   { t: 'm', x, y } (0–1)  ·  { t: 'b', b: 'left', d: true }  ·  { t: 'k', c: 'KeyA', d: true }
 *   { t: 'r' } – let go of every modifier (the page lost the keyboard: blur, Alt+Tab away, released) so none stays stuck
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
    else if (e.t === 'r') for (const q of MODIFIERS) out.push({ type: 'key', data: { down: false, key: { type: 'qcode', data: q } } });
  }
  return out;
}

module.exports = { qcodeOf, textToKeys, toQmpEvents, comboKeys, COMBOS, CODE, QCODES, MODIFIERS, LAYOUTS };
