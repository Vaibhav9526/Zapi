/**
 * The global hotkey registry — single source of truth for every bindable
 * command. Settings store the accelerator per id; index.ts registers them;
 * the panel's shortcut editor renders this list. Adding a command = a row
 * here + a settings field + a registration path.
 */

export type HotkeyId = 'ptt' | 'dictation' | 'agent' | 'abort';

export interface HotkeyDef {
  id: HotkeyId;
  /** Settings field name carrying its accelerator. */
  label: string;
  description: string;
}

export const HOTKEY_DEFS: HotkeyDef[] = [
  { id: 'ptt',       label: 'Push to talk',        description: 'Hold to speak a question — Zapi answers and can draw.' },
  { id: 'dictation', label: 'Dictation',            description: 'Hold to dictate — text types into the focused app.' },
  { id: 'agent',     label: 'Take control (agent)', description: 'Hold and describe a task — Zapi drives the mouse and keyboard.' },
  { id: 'abort',     label: 'Stop everything',      description: 'Instant kill — aborts the run, speech, and on-screen scene.' },
];

export const HOTKEY_DEFAULTS: Record<HotkeyId, string> = {
  ptt: 'Ctrl+Alt+X',
  dictation: 'Ctrl+Alt+D',
  agent: 'Ctrl+Shift+A',
  abort: 'Ctrl+Alt+Esc',
};

/**
 * Combos Windows claims at the shell level — RegisterHotKey can never take
 * them, so binding one is a guaranteed registration failure. Surfaced in
 * the editor as a conflict before the user even tries.
 */
export const OS_RESERVED_ACCELERATORS = new Set([
  'Ctrl+Esc',            // Start menu
  'Ctrl+Shift+Esc',      // Task Manager
  'Alt+F4',              // close window
  'Win+D', 'Win+E', 'Win+I', 'Win+L', 'Win+R', 'Win+Tab', // shell
  'Alt+Tab', 'Ctrl+Alt+Delete',
]);

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Win'] as const;
const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'Ctrl', control: 'Ctrl', cmdorctrl: 'Ctrl', commandorcontrol: 'Ctrl',
  alt: 'Alt', option: 'Alt',
  shift: 'Shift',
  win: 'Win', meta: 'Win', super: 'Win', command: 'Win', cmd: 'Win',
};

/**
 * Canonicalize an accelerator so 'ctrl+shift+a', 'Control+Shift+A', and
 * 'A+Shift+Ctrl' all compare equal. Modifiers sort to a fixed order;
 * the key token is capitalized ('a' → 'A', 'f5' → 'F5'). Returns '' for
 * empty/unparseable input — callers treat '' as "unbound".
 */
export function normalizeAccelerator(input: string): string {
  if (!input?.trim()) return '';
  const parts = input.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return '';
  const mods: string[] = [];
  let key = '';
  for (const part of parts) {
    const alias = MODIFIER_ALIASES[part.toLowerCase()];
    if (alias) { if (!mods.includes(alias)) mods.push(alias); continue; }
    if (key) return ''; // two non-modifier tokens = invalid
    key = part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1);
  }
  if (!key) return '';
  const ordered = MODIFIER_ORDER.filter((m) => mods.includes(m));
  return [...ordered, key].join('+');
}

/** Canonical equality — the only safe way to compare two bindings. */
export function acceleratorsEqual(a: string, b: string): boolean {
  const na = normalizeAccelerator(a);
  const nb = normalizeAccelerator(b);
  return na !== '' && na === nb;
}
