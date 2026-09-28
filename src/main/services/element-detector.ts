import type {
  ScreenCapture,
  Scene,
  SceneCue,
  AgentAction,
} from '../../shared/types';

/** Regex used to find every [TYPE:...] tag in a model response. */
const TYPE_TAG_REGEX = /\[TYPE:((?:[^\]\\]|\\.)+)\]/g;

/**
 * The FILE-block branch of the strip regex, as a source string so the
 * strip regex and `stripFileBlocks` can never drift apart.
 *
 * A FILE block is the one tag family whose *body* matters, so it needs a
 * whole-block match: `[FILE:...]` swallows everything through its
 * `[/FILE]` — otherwise a CSV or a markdown doc would be read aloud
 * character by character. The `$` fallback matters just as much: a
 * truncated reply that never emits the closing tag still had its content
 * inside the block, so the tail is dropped rather than spoken. A stray
 * `[/FILE]` with no opener is swallowed by the second branch, which is
 * why the closing tag is listed separately instead of being folded into
 * the payload alternation.
 */
const FILE_BLOCK_SRC = String.raw`\[FILE:[^\]\n]*\][\s\S]*?(?:\[\/FILE\]|$)|\[\/FILE\]`;

/** Matches every markup tag a response can carry — draw cues, agent
 *  actions, file blocks, memory memos, and the legacy POINT/TYPE tags — so
 *  the text we feed to TTS / chat history / display never contains raw
 *  DSL. The escape-aware body keeps a literal `]` inside WRITE/TYPE/ACT
 *  payloads from truncating the match early. */
export const TAG_STRIP_REGEX = new RegExp(
  [
    FILE_BLOCK_SRC,
    String.raw`\[(?:POINT|TYPE|ARROW|CIRCLE|BOX|HILITE|PATH|WRITE|ACT|MEMO)(?::(?:[^\]\\]|\\.)*)?\]`,
    String.raw`\[CLEAR\]`,
  ].join('|'),
  'g',
);

/** File blocks alone, as their own regex instance (never shared with the
 *  strip regex — two callers with independent lastIndex cursors on one
 *  /g object silently truncate each other's scans). */
const FILE_BLOCK_REGEX = new RegExp(FILE_BLOCK_SRC, 'g');

/**
 * Remove [FILE:...] blocks from a response, leaving every other tag in
 * place. File content is data, not instructions: a `[ACT:key:enter]`
 * sitting inside a python file the model just wrote must never be
 * executed, and a `[TYPE:...]` inside a note must never reach the
 * clipboard.
 *
 * Every DSL parser below runs its regexes over `stripFileBlocks(text)`
 * rather than the raw response, so the guarantee holds for every caller —
 * the talk-turn path in particular parses the same response for scene
 * cues and [TYPE:] requests, and neither can be trusted to remember to
 * strip first.
 */
export function stripFileBlocks(responseText: string): string {
  FILE_BLOCK_REGEX.lastIndex = 0;
  return responseText.replace(FILE_BLOCK_REGEX, '');
}

/**
 * Parse [TYPE:text] tags. Backslashes inside the text escape the next
 * character (so the model can include a literal `]` if it must), e.g.
 * [TYPE:hello\] world] → "hello] world". FILE blocks are stripped first:
 * a [TYPE:] line inside a file body is content, not a typing request.
 */
export function parseTypeTags(responseText: string): string[] {
  const text = stripFileBlocks(responseText);
  TYPE_TAG_REGEX.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = TYPE_TAG_REGEX.exec(text)) !== null) {
    out.push(m[1].replace(/\\(.)/g, '$1'));
  }
  return out;
}

// ── Scene cues ─────────────────────────────────────────────────────────
// The drawing DSL the model emits alongside spoken text. One regex pass
// keeps cues in the exact order they appear in the response — the overlay
// replays them as beats, so shuffling the order would scramble the story.

/** Pixel number, ints or decimals — the model occasionally emits .5s. */
const N = String.raw`\d+(?:\.\d+)?`;
/** Free-text tail slot; WRITE escapes a literal `]` as `\]`. */
const ESCAPED = String.raw`(?:[^\]\\]|\\.)*`;

const SCENE_TAG_REGEX = new RegExp(
  [
    String.raw`\[POINT:(?<px>${N}),(?<py>${N}):(?<plabel>[^:\]]+):screen(?<pscr>\d+)\]`,
    String.raw`\[ARROW:(?<ax1>${N}),(?<ay1>${N}):(?<ax2>${N}),(?<ay2>${N}):screen(?<ascr>\d+)(?::(?<alabel>${ESCAPED}))?\]`,
    String.raw`\[CIRCLE:(?<cx>\d+),(?<cy>\d+):(?<crx>${N}),(?<cry>${N}):screen(?<cscr>\d+)(?::(?<clabel>${ESCAPED}))?\]`,
    String.raw`\[BOX:(?<bx>\d+),(?<by>\d+):(?<bw>${N}),(?<bh>${N}):screen(?<bscr>\d+)(?::(?<blabel>${ESCAPED}))?\]`,
    String.raw`\[HILITE:(?<hx>\d+),(?<hy>\d+):(?<hw>${N}),(?<hh>${N}):screen(?<hscr>\d+)(?::(?<hlabel>${ESCAPED}))?\]`,
    String.raw`\[PATH:(?<pathpts>[\d.,;\s]+):screen(?<pathscr>\d+)(?::(?<pathlabel>${ESCAPED}))?\]`,
    String.raw`\[WRITE:(?<wx>\d+),(?<wy>\d+):screen(?<wscr>\d+):(?<wtext>${ESCAPED})\]`,
    String.raw`\[CLEAR\]`,
  ].join('|'),
  'g',
);

/** Screenshot pixel point → display-space logical point. */
function shotToDisplay(
  sc: ScreenCapture | undefined,
  px: number,
  py: number,
): { x: number; y: number } | null {
  if (!sc) return null;
  const scaleX = sc.displayBounds.width / sc.imageWidth;
  const scaleY = sc.displayBounds.height / sc.imageHeight;
  return { x: sc.displayBounds.x + px * scaleX, y: sc.displayBounds.y + py * scaleY };
}

/** Screenshot pixel size → display-space logical size (scale, no offset). */
function shotSizeToDisplay(
  sc: ScreenCapture,
  pw: number,
  ph: number,
): { w: number; h: number } {
  return {
    w: pw * (sc.displayBounds.width / sc.imageWidth),
    h: ph * (sc.displayBounds.height / sc.imageHeight),
  };
}

const num = (v: string | undefined): number => parseFloat(v ?? 'NaN');
const unescape = (v: string): string => v.replace(/\\(.)/g, '$1');

type Groups = Record<string, string | undefined>;

function cueFromMatch(g: Groups, screenshots: ScreenCapture[]): SceneCue | null {
  const sc = (si: string | undefined): ScreenCapture | undefined =>
    screenshots[parseInt(si ?? '-1', 10)];

  if (g.px !== undefined) {
    const screenIndex = num(g.pscr);
    const p = shotToDisplay(sc(g.pscr), num(g.px), num(g.py));
    if (!p) return null;
    return { kind: 'point', x: p.x, y: p.y, text: g.plabel, screenIndex };
  }
  if (g.ax1 !== undefined) {
    const screenIndex = num(g.ascr);
    const shot = sc(g.ascr);
    const from = shotToDisplay(shot, num(g.ax1), num(g.ay1));
    const to = shotToDisplay(shot, num(g.ax2), num(g.ay2));
    if (!from || !to) return null;
    return {
      kind: 'arrow',
      x: from.x, y: from.y, x2: to.x, y2: to.y,
      text: g.alabel ? unescape(g.alabel) : undefined,
      screenIndex,
    };
  }
  if (g.cx !== undefined) {
    const screenIndex = num(g.cscr);
    const shot = sc(g.cscr);
    const p = shotToDisplay(shot, num(g.cx), num(g.cy));
    if (!shot || !p) return null;
    const { w, h } = shotSizeToDisplay(shot, num(g.crx), num(g.cry));
    return {
      kind: 'circle',
      x: p.x, y: p.y, w, h,
      text: g.clabel ? unescape(g.clabel) : undefined,
      screenIndex,
    };
  }
  if (g.bx !== undefined || g.hx !== undefined) {
    const isBox = g.bx !== undefined;
    const screenIndex = num(isBox ? g.bscr : g.hscr);
    const shot = sc(isBox ? g.bscr : g.hscr);
    const p = shotToDisplay(shot, num(isBox ? g.bx : g.hx), num(isBox ? g.by : g.hy));
    if (!shot || !p) return null;
    const { w, h } = shotSizeToDisplay(shot, num(isBox ? g.bw : g.hw), num(isBox ? g.bh : g.hh));
    const label = isBox ? g.blabel : g.hlabel;
    return {
      kind: isBox ? 'box' : 'hilite',
      x: p.x, y: p.y, w, h,
      text: label ? unescape(label) : undefined,
      screenIndex,
    };
  }
  if (g.pathpts !== undefined) {
    const screenIndex = num(g.pathscr);
    const shot = sc(g.pathscr);
    if (!shot) return null;
    const points: Array<{ x: number; y: number }> = [];
    for (const pair of g.pathpts.split(';')) {
      const [sx, sy] = pair.split(',');
      const p = shotToDisplay(shot, num(sx), num(sy));
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
      points.push(p);
    }
    if (points.length < 2) return null;
    return {
      kind: 'path',
      x: points[0].x, y: points[0].y,
      points,
      text: g.pathlabel ? unescape(g.pathlabel) : undefined,
      screenIndex,
    };
  }
  if (g.wx !== undefined) {
    const screenIndex = num(g.wscr);
    const p = shotToDisplay(sc(g.wscr), num(g.wx), num(g.wy));
    if (!p) return null;
    return { kind: 'write', x: p.x, y: p.y, text: unescape(g.wtext ?? ''), screenIndex };
  }
  // [CLEAR] — no payload, and it has no meaningful anchor screen.
  return { kind: 'clear', x: 0, y: 0, screenIndex: 0 };
}

/**
 * Parse every draw cue in a model response into one ordered Scene.
 * Coordinates arrive in screenshot pixels and are mapped into the
 * display's logical space (scale + display-origin offset). Malformed
 * tags are skipped rather than failing the
 * whole scene — a partial picture beats none. Point cues get 1-based
 * step/total numbering among themselves so step UIs keep working.
 *
 * FILE blocks are stripped first: a `[POINT:...]` or `[CLEAR]` written
 * inside a file the model produced is content to be saved, not a drawing
 * cue to play back on the user's screen.
 */
export function parseScene(text: string, screenshots: ScreenCapture[]): Scene | null {
  const source = stripFileBlocks(text);
  SCENE_TAG_REGEX.lastIndex = 0;
  const cues: SceneCue[] = [];
  let m: RegExpExecArray | null;
  while ((m = SCENE_TAG_REGEX.exec(source)) !== null) {
    const cue = cueFromMatch((m.groups ?? {}) as Groups, screenshots);
    if (cue) cues.push(cue);
  }
  if (cues.length === 0) return null;

  const pointCues = cues.filter((c) => c.kind === 'point');
  pointCues.forEach((cue, i) => {
    cue.step = i + 1;
    cue.total = pointCues.length;
  });
  return { cues };
}

// ── Agent actions ──────────────────────────────────────────────────────
// The control DSL emitted in agent mode. Same coordinate convention as
// scene cues: screenshot pixels in, display-space logical pixels out.

const ACT_TAG_REGEX = new RegExp(
  [
    String.raw`\[ACT:(?<ptr>click|dclick|rclick|move):(?<ptrx>${N}),(?<ptry>${N}):screen(?<ptrscr>\d+)\]`,
    String.raw`\[ACT:drag:(?<dx1>${N}),(?<dy1>${N}):(?<dx2>${N}),(?<dy2>${N}):screen(?<dscr>\d+)\]`,
    String.raw`\[ACT:type:(?<typetext>${ESCAPED})\]`,
    String.raw`\[ACT:key:(?<keytext>[^\]]+)\]`,
    String.raw`\[ACT:scroll:(?<scrolldir>up|down|left|right)(?::(?<scrollamt>\d+))?\]`,
    String.raw`\[ACT:wait:(?<waitms>\d+)\]`,
    String.raw`\[ACT:done(?::(?<donetext>${ESCAPED}))?\]`,
    String.raw`\[ACT:fail(?::(?<failtext>${ESCAPED}))?\]`,
  ].join('|'),
  'g',
);

/**
 * Parse [ACT:...] tags into display-space AgentActions. Pointer
 * coordinates are mapped out of screenshot space exactly like scene
 * cues; everything else passes through as data. Unknown or malformed
 * tags are skipped.
 *
 * FILE blocks are stripped first — the one that matters most, since
 * these actions move the user's real mouse and keyboard. A script the
 * model wrote as a deliverable can contain any tag at all
 * (`[ACT:key:enter]` in a .py, `[ACT:click:...]` in a markdown doc);
 * that text is a payload to save, never something to execute. The agent
 * loop also strips before calling, so the action path is guarded twice
 * and a future caller can't quietly weaken it.
 */
export function parseAgentActions(text: string, screenshots: ScreenCapture[]): AgentAction[] {
  const source = stripFileBlocks(text);
  ACT_TAG_REGEX.lastIndex = 0;
  const actions: AgentAction[] = [];
  let m: RegExpExecArray | null;
  while ((m = ACT_TAG_REGEX.exec(source)) !== null) {
    const g = (m.groups ?? {}) as Groups;

    if (g.ptr !== undefined) {
      const screenIndex = num(g.ptrscr);
      const p = shotToDisplay(screenshots[screenIndex], num(g.ptrx), num(g.ptry));
      if (!p) continue;
      actions.push({ kind: g.ptr as AgentAction['kind'], x: p.x, y: p.y, screenIndex });
    } else if (g.dx1 !== undefined) {
      const screenIndex = num(g.dscr);
      const shot = screenshots[screenIndex];
      const from = shotToDisplay(shot, num(g.dx1), num(g.dy1));
      const to = shotToDisplay(shot, num(g.dx2), num(g.dy2));
      if (!from || !to) continue;
      actions.push({ kind: 'drag', x: from.x, y: from.y, x2: to.x, y2: to.y, screenIndex });
    } else if (g.typetext !== undefined) {
      actions.push({ kind: 'type', text: unescape(g.typetext) });
    } else if (g.keytext !== undefined) {
      actions.push({ kind: 'key', text: g.keytext });
    } else if (g.scrolldir !== undefined) {
      actions.push({
        kind: 'scroll',
        direction: g.scrolldir as AgentAction['direction'],
        amount: g.scrollamt ? parseInt(g.scrollamt, 10) : 3,
      });
    } else if (g.waitms !== undefined) {
      actions.push({ kind: 'wait', amount: parseInt(g.waitms, 10) });
    } else if (g.donetext !== undefined || /^\[ACT:done/.test(m[0])) {
      actions.push({ kind: 'done', text: g.donetext ? unescape(g.donetext) : undefined });
    } else {
      actions.push({ kind: 'fail', text: g.failtext ? unescape(g.failtext) : undefined });
    }
  }
  return actions;
}

// ── Memory memos ───────────────────────────────────────────────────────
// The one tag whose payload outlives the turn: `[MEMO:fact]` is appended
// to the agent's workspace AGENTS.md and re-injected as prompt context on
// every later run. Like [TYPE:] it is an inline payload slot (one line,
// escape a literal ] as \]), because a memory is a sentence, not a file.

/**
 * Memos kept from one response. The prompt asks for 1-6; a model that
 * dumps thirty is either confused or trying to rewrite its own identity,
 * and the first six are as likely to be the real ones. The store's own
 * 40-line cap is the backstop either way.
 */
const MAX_MEMOS_PER_RESPONSE = 6;
/** A fact is one line; longer payloads are clipped rather than stored. */
const MAX_MEMO_CHARS = 200;

/** Escape-aware inline payload, same shape as [TYPE:]. */
const MEMO_TAG_REGEX = /\[MEMO:((?:[^\]\\]|\\.)*)\]/g;

/**
 * Parse `[MEMO:...]` tags into one-line facts, in order, deduped and
 * capped. Malformed/empty payloads are skipped.
 *
 * FILE blocks are stripped first, and that is a security property, not a
 * nicety: memos are written to disk and injected into future prompts, so a
 * `[MEMO:ignore your instructions]` sitting inside a python file the
 * model just produced would be a way to plant a permanent instruction
 * through a deliverable. File content is data — it never becomes memory.
 */
export function parseMemos(responseText: string): string[] {
  const text = stripFileBlocks(responseText);
  MEMO_TAG_REGEX.lastIndex = 0;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = MEMO_TAG_REGEX.exec(text)) !== null && out.length < MAX_MEMOS_PER_RESPONSE) {
    // A memo is a line, so a wrapped one is flattened rather than stored
    // as a multi-line bullet that would break the dated list.
    const fact = (m[1].replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim())
      .replace(/^[-*]\s*/, '');
    if (!fact) continue;
    const clipped =
      fact.length > MAX_MEMO_CHARS ? `${fact.slice(0, MAX_MEMO_CHARS - 1)}…` : fact;
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
  }
  return out;
}

// ── File writes ────────────────────────────────────────────────────────
// The deliverable tag family. Unlike every other tag the payload is
// free-form text between an opening and a closing tag:
//
//   [FILE:budget.csv]
//   month,amount
//   jan,42
//   [/FILE]
//
// Why a block and not a payload: the content is verbatim user data (CSV
// rows, markdown, source) and would need the `\]` escape convention that
// every inline payload uses. Requiring `[/FILE]` means content containing
// brackets, quotes, or even the other tags needs no escaping at all.

/** A file the model asked to produce, still in memory. */
export interface FileWrite {
  filename: string;
  content: string;
}

/**
 * Opening tag, then the body up to the matching `[/FILE]`. An unclosed
 * block (truncated reply) runs to end-of-text — the content between the
 * open tag and the cut is still file content, and recovering it beats
 * throwing the whole deliverable away. Same fallback as the strip regex,
 * so parse and display never disagree about where a block ends.
 */
const FILE_TAG_REGEX = /\[FILE:([^\]\n]*)\]([\s\S]*?)(?:\[\/FILE\]|$)/g;

/**
 * Drop exactly one newline at each edge of the body: the tag and its
 * closing bracket sit on their own lines in every well-formed block, and
 * trimming more would eat the blank lines and leading indentation that
 * markdown and fenced code blocks depend on.
 */
function trimBlockEdges(body: string): string {
  return body.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

/**
 * Parse [FILE:...] blocks out of a model response, in order. Malformed
 * tags (no filename) are skipped, the same way malformed draw tags are —
 * a partial set of deliverables beats none.
 *
 * The body is captured verbatim and never re-scanned: it is not
 * unescaped, not tag-parsed, and not interpreted as a nested block. Two
 * consequences, both deliberate:
 *   - A `[FILE:b.txt]` line inside a.txt's body stays literal text (the
 *     regex is flat, so the first opener pairs with the first closer) —
 *     a reply can never smuggle an extra file out of another file's
 *     content.
 *   - A literal `[/FILE]` line *inside* the content ends the block early,
 *     because the closer cannot be escaped. The remainder is left in the
 *     response, where `stripFileBlocks`/TAG_STRIP_REGEX deal with it —
 *     a fidelity limit on a self-inflicted case (a file documenting this
 *     very tag), not an execution path.
 */
export function parseFileTags(responseText: string): FileWrite[] {
  FILE_TAG_REGEX.lastIndex = 0;
  const out: FileWrite[] = [];
  let m: RegExpExecArray | null;
  while ((m = FILE_TAG_REGEX.exec(responseText)) !== null) {
    const filename = m[1].trim();
    if (!filename) continue;
    out.push({ filename, content: trimBlockEdges(m[2] ?? '') });
  }
  return out;
}

// ── Agent trigger ──────────────────────────────────────────────────────

/**
 * Agent-mode trigger: the transcript must START with the summon so a
 * stray mention mid-sentence ("tell Sarah to do it for me", "what is my
 * agent doing") never silently takes the mouse. Three anchored shapes,
 * tried in order:
 *
 *   'zapi agent, X' / 'hey zapi agent X'   — name then the word 'agent'
 *   'agent, X' / 'agent open settings'     — bare 'agent' leads
 *   'hey zapi do X' / 'zapi, take X'       — name leads an imperative
 *
 * Bare 'agent' followed by a capitalized word reads as a person's title
 * ("agent Smith approved") — after a bare 'agent' the separator must be
 * punctuation, end-of-input, or whitespace continuing lowercase. The
 * name+'agent' path is already unambiguous so its separator stays loose.
 */
const WAKE_NAME = '(?:zapi|zappi|flicky|clicky)';
const GREETING = '(?:(?:hey|hi|ok|okay|yo)[,.! ]+)?';

const AGENT_NAME_THEN_AGENT = new RegExp(
  `^${GREETING}${WAKE_NAME}[,.! ]+agent\\b[,.! ]*(.*)$`,
  'is',
);
/** Group 1 = separator, group 2 = task — the "agent Smith" check needs both. */
const AGENT_WORD_LEADS = new RegExp(`^${GREETING}agent\\b([,.!;: ]*)(.*)$`, 'is');
const AGENT_NAME_LEADS = new RegExp(`^${GREETING}${WAKE_NAME}[,.! ]+(.*)$`, 'is');

/** "agent mode: X" — the word "mode" is part of the trigger phrase, not the instruction. */
const stripModeWord = (s: string): string => s.trim().replace(/^mode\b[,.!:; ]*/i, '');

/**
 * Decide whether a transcript is an agent-mode turn and, if so, return
 * the task with the trigger wording stripped out. Returns null when no
 * trigger is present. The returned task may be an empty string — that
 * still means "agent turn", just one with no instruction.
 */
export function extractAgentTask(transcript: string): string | null {
  const text = transcript.trim();

  // 'zapi agent X' first — name+'agent' is unambiguous, separator loose.
  let m = AGENT_NAME_THEN_AGENT.exec(text);
  if (m) return stripModeWord(m[1]);

  // Bare 'agent' leads. The summon check happens in JS because the /i
  // flag case-folds [A-Z] inside regexes: 'agent Smith approved' is a
  // person's title — a whitespace-only separator followed by a capital
  // letter is not a trigger. 'agent, X' or 'agent open x' still fire.
  m = AGENT_WORD_LEADS.exec(text);
  if (m) {
    if (!/[,.!;:]/.test(m[1]) && /^[A-Z]/.test(m[2])) return null;
    return stripModeWord(m[2]);
  }

  m = AGENT_NAME_LEADS.exec(text);
  if (m) return m[1].trim();

  return null;
}
