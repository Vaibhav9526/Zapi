/**
 * Static preload↔IPC contract check.
 *
 * Verifies, without running Electron:
 *  1) every ipcRenderer.send/invoke/on channel in src/preload/index.ts is an
 *     IPC const value, an AUDIO_IPC value, or an allow-listed raw string —
 *     unknown keys / dangling raw strings are missing-channel bugs;
 *  2) every IPC.SET_* key is sent by at least one preload method
 *     (dead settings channels are findings);
 *  3) every ipcMain.on/handle in src/main/index.ts resolves to IPC/AUDIO_IPC
 *     (orphan handler strings are findings);
 *  4) every onXxx listener in preload has emitter evidence — a channel send
 *     in main/windows, or a companion-manager callback wired to that channel
 *     in main (a subscription with no emitter is a missing-channel bug);
 *  5) companion callbacks invoked in companion-manager are all wired in
 *     main/index.ts, and vice versa (informational);
 *  6) every raw-string channel the preload uses is declared in KNOWN_RAW
 *     (and every KNOWN_RAW entry is actually used) — an undeclared raw
 *     channel is a [FINDING], since it escapes the shared contract;
 *  7) the feature channels added for artifacts / suggestions / read
 *     flags / typed turns are wired by name — method → verb → IPC key —
 *     so a dropped preload method is a FAIL, not just an orphan finding.
 *
 * Runner-agnostic (imports only pure modules): npx tsx scripts/preload-check.mts
 *
 * Prints PASS/FAIL + findings. Exits 1 only on missing-channel bugs:
 * unknown IPC.* keys, unresolvable channels, sends/invokes with no main
 * handler, or listeners with no emitter anywhere.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IPC } from '../src/shared/types';
import { AUDIO_IPC } from '../src/main/services/audio-capture';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string =>
  fs.readFileSync(`${root}/${rel}`.replace(/\\/g, '/'), 'utf-8');

let pass = 0;
let fail = 0;
const findings: string[] = [];
function check(cond: boolean, name: string, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(
      `FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`,
    );
  }
}
function finding(msg: string): void {
  findings.push(msg);
  console.log(`FINDING ${msg}`);
}

/** Strip // and block comments, leaving string literals intact.
 *  Exported so ad-hoc diagnostics can reuse the exact same pass. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        const d = src[i];
        out += d;
        if (d === '\\') {
          out += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        i++;
        if (d === quote) break;
        // Template `${ ... }`: copy the expression through the same
        // comment-stripper so `//` inside an expression can't leak, while
        // comment-like text in nested strings stays intact.
        if (quote === '`' && d === '$' && src[i] === '{') {
          out += '{';
          i++;
          const expr = stripTemplateExpr(src, i);
          out += expr.text;
          i = expr.next;
        }
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Copy a `${ ... }` template expression, stripping comments inside it. */
function stripTemplateExpr(src: string, start: number): { text: string; next: number } {
  let text = '';
  let i = start;
  let depth = 1; // braces opened (we consumed the `{`)
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      text += c;
      i++;
      while (i < src.length) {
        const d = src[i];
        text += d;
        if (d === '\\') {
          text += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        i++;
        if (d === quote) break;
        if (quote === '`' && d === '$' && src[i] === '{') {
          text += '{';
          i++;
          const nested = stripTemplateExpr(src, i);
          text += nested.text;
          i = nested.next;
        }
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth > 0) text += c;
    else text += c;
    i++;
  }
  return { text, next: i };
}

interface ChanRef {
  method: string;
  alias: 'IPC' | 'AUDIO_IPC' | null;
  key: string | null;
  literal: string | null;
  line: number;
}
function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}
const CHAN_ARG = String.raw`(?:(IPC|AUDIO_IPC)\.([A-Za-z0-9_]+)|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")`;

/** receiverPattern is a regex source for the call target, e.g. `ipcRenderer`. */
function collectCalls(
  src: string,
  receiverPattern: string,
  methods: string[],
): ChanRef[] {
  const re = new RegExp(
    `(?:${receiverPattern})\\s*\\.\\s*(${methods.join('|')})\\s*\\(\\s*${CHAN_ARG}`,
    'g',
  );
  const out: ChanRef[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push({
      method: m[1],
      alias: (m[2] as 'IPC' | 'AUDIO_IPC' | undefined) ?? null,
      key: m[3] ?? null,
      literal: m[4] ?? m[5] ?? null,
      line: lineOf(src, m.index),
    });
  }
  return out;
}

// ── Load sources ────────────────────────────────────────────────────────
const preloadSrc = stripComments(read('src/preload/index.ts'));
const mainSrc = stripComments(read('src/main/index.ts'));
const windowsSrc = stripComments(read('src/main/windows.ts'));
const companionSrc = stripComments(read('src/main/companion-manager.ts'));

const ipcValues = new Map<string, string>(Object.entries(IPC) as Array<[string, string]>);
const audioValues = new Map<string, string>(
  Object.entries(AUDIO_IPC) as Array<[string, string]>,
);
const ipcWireSet = new Set(ipcValues.values());
const audioWireSet = new Set(audioValues.values());
/**
 * Every raw-string channel the preload is allowed to use, i.e. the ones
 * that deliberately live outside the `IPC`/`AUDIO_IPC` consts. A raw
 * channel NOT in this list is a [FINDING]: it bypasses the shared
 * contract, so renames and greps that protect every other channel
 * don't cover it. Keep this list in step with the raw literals used in
 * src/preload/index.ts (check 6 enforces that).
 */
const KNOWN_RAW = new Set([
  'play-audio',
  'stop-audio',
  'start-audio-capture',
  'stop-audio-capture',
  'audio-chunk',
  'display-info',
]);

function resolveWire(ref: Pick<ChanRef, 'alias' | 'key' | 'literal'>): string | null {
  if (ref.literal !== null) return ref.literal;
  if (ref.alias === 'IPC' && ref.key) return ipcValues.get(ref.key) ?? null;
  if (ref.alias === 'AUDIO_IPC' && ref.key) return audioValues.get(ref.key) ?? null;
  return null;
}
function describe(ref: Pick<ChanRef, 'alias' | 'key' | 'literal'>): string {
  if (ref.literal !== null) return `'${ref.literal}'`;
  return `${ref.alias ?? '?'}${ref.key ? `.${ref.key}` : ''}`;
}

// ── Extract call sites ──────────────────────────────────────────────────
const preloadCalls = collectCalls(preloadSrc, 'ipcRenderer', ['send', 'invoke', 'on']);
// Handlers live in index.ts, and also next to the window they act on:
// windows.ts self-registers the panel's traffic-light channels from
// createPanelWindow, because those two lines only make sense beside the
// BrowserWindow they drive. Scanning both keeps this check honest about
// "does this channel go somewhere" instead of "is it in index.ts".
const mainHandlers = [
  ...collectCalls(mainSrc, 'ipcMain', ['on', 'once', 'handle']),
  ...collectCalls(windowsSrc, 'ipcMain', ['on', 'once', 'handle']),
];
// Channel sends: sendTo*(...) helpers, direct webContents.send, event replies.
// The generic collector expects a method name after the receiver; send
// helpers take the channel directly, so collect them with a dedicated pattern.
function collectSends(src: string, receiverPattern: string): ChanRef[] {
  const re = new RegExp(`(?:${receiverPattern})\\s*\\(\\s*${CHAN_ARG}`, 'g');
  const out: ChanRef[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push({
      method: 'send',
      alias: (m[1] as 'IPC' | 'AUDIO_IPC' | undefined) ?? null,
      key: m[2] ?? null,
      literal: m[3] ?? m[4] ?? null,
      line: lineOf(src, m.index),
    });
  }
  return out;
}
/**
 * Main-side send receivers. `send` (bare) covers a local indirection like
 * `const send = (channel, payload) => event.sender.send(channel, payload)`
 * inside a handler — the emitter is real even though the channel lands as
 * the helper's first argument.
 */
const MAIN_SEND_RECEIVER =
  'sendTo[A-Za-z]*|\\w+\\.webContents\\.send|sender\\.send|\\bsend';
const allMainSends: ChanRef[] = [
  ...collectSends(mainSrc, MAIN_SEND_RECEIVER),
  ...collectSends(windowsSrc, '\\w+\\.webContents\\.send|\\bsend'),
];

// Companion callbacks: invoked in companion-manager, wired in main.
const invokedCallbacks = new Set<string>();
{
  // `(?:\?\.)?` so optional calls (`onStopAudio?.()`) count as invoked.
  const re = /this\.callbacks\.(on[A-Za-z]+)\s*(?:\?\.)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(companionSrc)) !== null) invokedCallbacks.add(m[1]);
}
const wiredCallbacks = new Map<string, number>(); // onXxx -> line in index.ts
{
  const re = /^\s*(on[A-Za-z]+)\s*:\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(mainSrc)) !== null) wiredCallbacks.set(m[1], lineOf(mainSrc, m.index));
}

// Which wire channels does a given IPC key's traffic use? (key -> wires)
const handlerWires = new Set<string>();
for (const h of mainHandlers) {
  const w = resolveWire(h);
  if (w !== null) handlerWires.add(w);
}
const sendWires = new Set<string>();
for (const s of allMainSends) {
  const w = resolveWire(s);
  if (w !== null) sendWires.add(w);
}

// ── Check 1: preload channels resolve ───────────────────────────────────
/** Raw literals seen in preload that are absent from KNOWN_RAW. */
const unknownRawChannels = new Set<string>();
check(preloadCalls.length > 0, 'preload: channel call sites found', preloadCalls.length);
for (const c of preloadCalls) {
  const label = `preload:${c.line} ipcRenderer.${c.method}(${describe(c)})`;
  if (c.alias === 'IPC' && c.key && !ipcValues.has(c.key)) {
    check(false, label, 'unknown IPC key — undefined at runtime');
    continue;
  }
  if (c.alias === 'AUDIO_IPC' && c.key && !audioValues.has(c.key)) {
    check(false, label, 'unknown AUDIO_IPC key — undefined at runtime');
    continue;
  }
  const wire = resolveWire(c);
  if (wire === null) {
    check(false, label, 'unresolvable channel argument');
    continue;
  }
  if (!ipcWireSet.has(wire) && !audioWireSet.has(wire) && !KNOWN_RAW.has(wire)) {
    const counterpart =
      handlerWires.has(wire) || sendWires.has(wire) || preloadCalls.some((o) => o !== c && resolveWire(o) === wire);
    if (!counterpart) check(false, label, 'raw channel with no counterpart anywhere');
    // Working-but-unknown raw channels are reported once, deduped, by
    // check 6 so a channel with many call sites doesn't spam the log.
    else unknownRawChannels.add(wire);
    continue;
  }
  check(true, label);
}

// ── Check 2: every IPC.SET_* is sent by preload ─────────────────────────
{
  const sentKeys = new Set(
    preloadCalls
      .filter((c) => (c.method === 'send' || c.method === 'invoke') && c.alias === 'IPC' && c.key)
      .map((c) => c.key as string),
  );
  const setKeys = [...ipcValues.keys()].filter((k) => k.startsWith('SET_'));
  check(setKeys.length > 0, 'contract: IPC.SET_* keys exist', setKeys.length);
  for (const k of setKeys) {
    if (sentKeys.has(k)) check(true, `setter live: IPC.${k}`);
    else finding(`dead settings channel: IPC.${k} has no preload sender`);
  }
}

// ── Check 3: main handlers resolve; orphans listed ──────────────────────
check(mainHandlers.length > 0, 'main: ipcMain handler sites found', mainHandlers.length);
for (const h of mainHandlers) {
  const label = `main:${h.line} ipcMain.${h.method}(${describe(h)})`;
  const wire = resolveWire(h);
  if (wire === null) {
    check(false, label, 'handler channel unresolvable');
    continue;
  }
  check(true, label);
  // Orphan = handler whose wire is never sent/invoked from preload.
  const fromPreload = preloadCalls.some(
    (c) => (c.method === 'send' || c.method === 'invoke') && resolveWire(c) === wire,
  );
  if (!fromPreload) {
    finding(`orphan handler: ${label} — no preload send/invoke targets '${wire}'`);
  }
}
// Renderer→main direction, reversed: preload sends/invokes with no handler,
// plus send/invoke ↔ on/handle method mismatches (invoke needs handle,
// send needs on/once — anything else hangs or throws at runtime).
const handlerMethods = new Map<string, Set<string>>();
for (const h of mainHandlers) {
  const w = resolveWire(h);
  if (w === null) continue;
  if (!handlerMethods.has(w)) handlerMethods.set(w, new Set());
  handlerMethods.get(w)?.add(h.method);
}
for (const c of preloadCalls) {
  if (c.method !== 'send' && c.method !== 'invoke') continue;
  const wire = resolveWire(c);
  if (wire === null) continue; // already failed in check 1
  const label = `preload:${c.line} ipcRenderer.${c.method}(${describe(c)})`;
  if (!handlerWires.has(wire)) {
    check(false, label, `no ipcMain handler for '${wire}' — message goes nowhere`);
    continue;
  }
  const methods = handlerMethods.get(wire) ?? new Set();
  const ok =
    c.method === 'send'
      ? methods.has('on') || methods.has('once')
      : methods.has('handle');
  check(ok, `${label} — handler method matches`, [...methods]);
}

// ── Check 4: every preload listener has an emitter ──────────────────────
{
  const listeners = preloadCalls.filter((c) => c.method === 'on');
  check(listeners.length > 0, 'preload: listener subscriptions found', listeners.length);
  for (const l of listeners) {
    const wire = resolveWire(l);
    const label = `preload:${l.line} on(${describe(l)})`;
    if (wire === null) {
      check(false, label, 'listener channel unresolvable');
      continue;
    }
    if (sendWires.has(wire)) {
      check(true, `${label} — emitter in main`);
      continue;
    }
    // Exact fallback: a send-call site in main references this same
    // symbolic key (covers wiring arrows the wire-set already reflects,
    // kept as an independent cross-check).
    const keySent =
      l.key !== null && allMainSends.some((s) => s.alias === l.alias && s.key === l.key);
    if (keySent) {
      check(true, `${label} — emitter in main`);
      continue;
    }
    check(false, label, `subscription with no emitter for '${wire}'`);
  }
}

// ── Check 6: every raw channel used in preload is in KNOWN_RAW ──────────
{
  // All raw literals passed to ipcRenderer.on/send/invoke, with call sites.
  // Note: a literal that happens to equal an AUDIO_IPC value (e.g.
  // 'audio-chunk') still counts as raw usage here — the point of the check
  // is what preload *writes*, not what main happens to export.
  const rawUsed = new Map<string, string[]>();
  for (const c of preloadCalls) {
    if (c.alias !== null || c.literal === null) continue;
    const wire = resolveWire(c);
    if (wire === null) continue;
    const sites = rawUsed.get(wire) ?? [];
    sites.push(`${c.method}@preload:${c.line}`);
    rawUsed.set(wire, sites);
  }
  check(rawUsed.size > 0, 'raw channels: literals found in preload', [
    ...rawUsed.keys(),
  ]);
  for (const [wire, sites] of [...rawUsed.entries()].sort()) {
    if (KNOWN_RAW.has(wire)) {
      check(true, `raw known: '${wire}' (${sites.length} site${sites.length > 1 ? 's' : ''})`);
      continue;
    }
    // Working-but-undeclared raw channel, or a dangling one (check 1
    // already failed the latter) — either way it must be declared.
    finding(
      `raw channel not in KNOWN_RAW: '${wire}' used by ${sites.join(', ')} — ` +
        `add it to KNOWN_RAW in scripts/preload-check.mts if intentional, ` +
        `otherwise move it into the IPC const`,
    );
  }
  // A KNOWN_RAW entry nobody uses is dead allowlist surface.
  for (const known of KNOWN_RAW) {
    if (!rawUsed.has(known)) {
      finding(`KNOWN_RAW entry '${known}' is not used by any preload channel — drop it`);
    }
  }
}

// ── Check 7: feature channels wired by name ────────────────────────────
// Checks 1–4 prove that whatever the preload writes resolves; this table
// proves the expected surface actually exists — each window.flicky method
// must call the right verb with the right IPC key. Discovery can't see an
// absent method, so the contract is stated positively here.
{
  const EXPECTED: Array<{ method: string; verb: 'send' | 'invoke'; key: string }> = [
    { method: 'getArtifacts', verb: 'invoke', key: 'ARTIFACT_LIST' },
    { method: 'openArtifact', verb: 'send', key: 'ARTIFACT_OPEN' },
    { method: 'revealArtifact', verb: 'send', key: 'ARTIFACT_REVEAL' },
    { method: 'getSuggestions', verb: 'invoke', key: 'SUGGESTION_LIST' },
    { method: 'acceptSuggestion', verb: 'send', key: 'SUGGESTION_ACCEPT' },
    { method: 'dismissSuggestion', verb: 'send', key: 'SUGGESTION_DISMISS' },
    { method: 'refreshSuggestions', verb: 'send', key: 'SUGGESTION_REFRESH' },
    { method: 'markChatRead', verb: 'send', key: 'CHAT_MARK_READ' },
    { method: 'sendTextTurn', verb: 'send', key: 'TEXT_TURN' },
    { method: 'openAgentWorkspace', verb: 'send', key: 'OPEN_AGENT_WORKSPACE' },
  ];
  for (const { method, verb, key } of EXPECTED) {
    // `[^\n]*?` anchors the method's signature line; `\s*` after `=>`
    // crosses the line break used by the longer signatures.
    const re = new RegExp(
      `\\b${method}\\s*:[^\\n]*?=>\\s*ipcRenderer\\.${verb}\\s*\\(\\s*IPC\\.${key}\\b`,
    );
    check(
      ipcValues.has(key) && re.test(preloadSrc),
      `surface: window.flicky.${method} → ipcRenderer.${verb}(IPC.${key})`,
      !ipcValues.has(key) ? `IPC.${key} missing from shared/types.ts` : undefined,
    );
  }

  // Listener methods have a different shape — `cb => { …ipcRenderer.on(
  // IPC.KEY, handler); return unsubscribe }` — so they get their own
  // table rather than bending the send/invoke regex.
  const EXPECTED_LISTENERS: Array<{ method: string; key: string }> = [
    { method: 'onPlaySfx', key: 'PLAY_SFX' },
    { method: 'onSpeakText', key: 'SPEAK_TEXT' },
  ];
  for (const { method, key } of EXPECTED_LISTENERS) {
    const re = new RegExp(
      `\\b${method}\\s*:[^\\n]*?=>\\s*\\{[\\s\\S]{0,400}?ipcRenderer\\.on\\s*\\(\\s*IPC\\.${key}\\b`,
    );
    check(
      ipcValues.has(key) && re.test(preloadSrc),
      `surface: window.flicky.${method} → ipcRenderer.on(IPC.${key})`,
      !ipcValues.has(key) ? `IPC.${key} missing from shared/types.ts` : undefined,
    );
  }
}

// ── Callback wiring sanity (informational) ──────────────────────────────
for (const cb of invokedCallbacks) {
  if (!wiredCallbacks.has(cb)) finding(`callback invoked but never wired: ${cb}`);
}
for (const [cb, line] of wiredCallbacks) {
  if (!invokedCallbacks.has(cb)) finding(`callback wired (main:${line}) but never invoked: ${cb}`);
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed, ${findings.length} findings`);
process.exit(fail > 0 ? 1 : 0);
