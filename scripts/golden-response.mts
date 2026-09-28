/**
 * Golden-response dev harness.
 *
 * Feeds a full canned model response — prose plus every draw cue kind plus a
 * few [ACT:] tags — through the real parsers and pretty-prints what the user
 * would actually see:
 *
 *   1. the beat table (cue kind, label, target display, display-space coords),
 *   2. the speech text with every tag stripped (what TTS/chat history gets),
 *   3. the agent action list (what the driver would execute).
 *
 * It is a debugging lens first — add a scenario, read the timeline — and a
 * golden test second: each scenario declares the cue kinds / actions it
 * expects, so a parser regression fails the run instead of silently changing
 * the overlay.
 *
 * Run:  bunx tsx scripts/golden-response.mts [scenario-name]
 *        (no arg = print all scenarios)
 *
 * Runner-agnostic (pure modules, no electron): node/tsx/bun all work.
 */
import {
  parseScene,
  parseAgentActions,
  parseTypeTags,
  TAG_STRIP_REGEX,
} from '../src/main/services/element-detector';
import type {
  AgentAction,
  Scene,
  SceneCue,
  SceneCueKind,
  ScreenCapture,
} from '../src/shared/types';

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra?: unknown): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}

// ── Fake 2-display capture ──────────────────────────────────────────────
// Deliberately mismatched scales so the screenshot-px → display mapping is
// actually exercised: display 0 is a 2880px shot of a 1920x1080 screen
// (2/3), display 1 is a 1:1 shot of a second 1280x800 screen at x=1920.
const SCALE0 = 2 / 3;
const captures: ScreenCapture[] = [
  {
    dataBase64: '',
    displayId: 7,
    imageWidth: 2880,
    imageHeight: 1620,
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    isCursorScreen: true,
  },
  {
    dataBase64: '',
    displayId: 8,
    imageWidth: 1280,
    imageHeight: 800,
    displayBounds: { x: 1920, y: 0, width: 1280, height: 800 },
    isCursorScreen: false,
  },
];

const round1 = (n: number): number => Math.round(n * 10) / 10;
const boundsLabel = (i: number): string => {
  const c = captures[i];
  if (!c) return `screen${i} (MISSING)`;
  const b = c.displayBounds;
  return `screen${i} ${b.width}x${b.height}@${b.x},${b.y}`;
};

// ── Pretty printers ─────────────────────────────────────────────────────
function cueGeometry(cue: SceneCue): string {
  switch (cue.kind) {
    case 'arrow':
      return `(${round1(cue.x)},${round1(cue.y)}) → (${round1(cue.x2 ?? NaN)},${round1(cue.y2 ?? NaN)})`;
    case 'circle':
      return `(${round1(cue.x)},${round1(cue.y)}) r${round1(cue.w ?? NaN)}x${round1(cue.h ?? NaN)}`;
    case 'box':
    case 'hilite':
      return `(${round1(cue.x)},${round1(cue.y)}) ${round1(cue.w ?? NaN)}x${round1(cue.h ?? NaN)}`;
    case 'path':
      return (cue.points ?? [])
        .map((p) => `(${round1(p.x)},${round1(p.y)})`)
        .join(' → ');
    case 'clear':
      return '(wipes the canvas)';
    default:
      return `(${round1(cue.x)},${round1(cue.y)})`;
  }
}

function printBeatTable(scene: Scene | null): void {
  if (!scene) {
    console.log('  (no scene — parseScene returned null)');
    return;
  }
  const rows: string[] = [];
  rows.push(
    '  beat  kind     step  display            label / geometry',
  );
  rows.push(`  ${'-'.repeat(84)}`);
  scene.cues.forEach((cue, i) => {
    const step =
      cue.step !== undefined ? `${cue.step}/${cue.total ?? '?'}` : '—';
    const label = cue.text ? `"${cue.text}"` : cueGeometry(cue);
    const geo = cue.text ? `${label}  ${cueGeometry(cue)}` : label;
    rows.push(
      `  ${String(i).padStart(4)}  ${cue.kind.padEnd(7)}  ${step.padEnd(5)} ${boundsLabel(cue.screenIndex).padEnd(20)} ${geo}`,
    );
  });
  console.log(rows.join('\n'));
}

function printActions(actions: AgentAction[]): void {
  if (actions.length === 0) {
    console.log('  (no [ACT:] tags)');
    return;
  }
  actions.forEach((a, i) => {
    const where =
      a.x !== undefined && a.y !== undefined
        ? `(${round1(a.x)},${round1(a.y)})`
        : a.x2 !== undefined
          ? `(${round1(a.x ?? 0)},${round1(a.y ?? 0)}) → (${round1(a.x2 ?? 0)},${round1(a.y2 ?? 0)})`
          : '';
    const extra =
      a.text !== undefined
        ? ` "${a.text}"`
        : a.direction !== undefined
          ? ` ${a.direction} x${a.amount ?? 3}`
          : a.amount !== undefined && a.kind === 'wait'
            ? ` ${a.amount}ms`
            : '';
    const screen = a.screenIndex !== undefined ? ` [${boundsLabel(a.screenIndex)}]` : '';
    console.log(`  ${String(i).padStart(3)}. ${a.kind.padEnd(7)}${where}${extra}${screen}`);
  });
}

function stripText(response: string): string {
  TAG_STRIP_REGEX.lastIndex = 0;
  return response.replace(TAG_STRIP_REGEX, '').replace(/\s+/g, ' ').trim();
}

function wrap(text: string, width = 78): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// ── Scenarios ───────────────────────────────────────────────────────────
interface Scenario {
  name: string;
  response: string;
  /** Cue kinds expected, in order — the golden part. */
  expectKinds: SceneCueKind[];
  /** Agent action kinds expected, in order. */
  expectActions: string[];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'explain a settings dialog',
    response: [
      "The General tab is where most people get stuck, so let's walk it.",
      '[BOX:180,120:620,540:screen0:the General tab]',
      '[HILITE:220,200:340,36:screen0:Always-on listening]',
      '[CIRCLE:600,320:52,30:screen0:dictation shortcut]',
      '[ARROW:620,320:900,420:screen1:shows the live accelerator]',
      '[WRITE:240,470:screen0:⌘V or Ctrl+V pastes the clipboard]',
      '[PATH:220,560;420,566;600,556:screen0:the save row]',
      'That is the whole panel — nothing else hides here.',
    ].join(' '),
    expectKinds: ['box', 'hilite', 'circle', 'arrow', 'write', 'path'],
    expectActions: [],
  },
  {
    name: 'walkthrough click sequence',
    response: [
      'Three clicks and you have a PDF. Follow along.',
      '[POINT:412,38:click File:screen0]',
      '[POINT:430,112:choose Export:screen0]',
      '[POINT:520,260:pick PDF Format:screen0]',
      '[CLEAR]',
      'The last one is the one people miss.',
    ].join(' '),
    expectKinds: ['point', 'point', 'point', 'clear'],
    expectActions: [],
  },
  {
    name: 'agent open notepad',
    response: [
      'Opening Notepad and typing a note.',
      '[ACT:click:900,540:screen0]',
      '[ACT:type:milk, eggs, coffee]',
      '[ACT:key:ctrl+s]',
      '[ACT:done:notepad is open with the list]',
    ].join(' '),
    expectKinds: [],
    expectActions: ['click', 'type', 'key', 'done'],
  },
];

// ── Run ─────────────────────────────────────────────────────────────────
const only = process.argv[2];
const chosen = only ? SCENARIOS.filter((s) => s.name.includes(only)) : SCENARIOS;
if (chosen.length === 0) {
  console.log(`no scenario matches "${only}"`);
  console.log(`available: ${SCENARIOS.map((s) => s.name).join(' | ')}`);
  process.exit(1);
}

console.log('='.repeat(88));
console.log('GOLDEN RESPONSE HARNESS — what the user sees from a model response');
console.log(`captures: [0] ${boundsLabel(0)} shot 2880x1620 (scale ${round1(SCALE0 * 100)}%)` +
  `, [1] ${boundsLabel(1)} shot 1280x800 (scale 100%)`);

for (const scenario of chosen) {
  console.log('\n' + '='.repeat(88));
  console.log(`SCENARIO: ${scenario.name}`);
  console.log('-'.repeat(88));
  console.log('RAW RESPONSE:');
  for (const l of wrap(scenario.response, 86)) console.log(`  ${l}`);

  const scene = parseScene(scenario.response, captures);
  const actions = parseAgentActions(scenario.response, captures);
  const speech = stripText(scenario.response);
  const typeTags = parseTypeTags(scenario.response);

  console.log('\nBEAT TABLE (scene cues, in response order):');
  printBeatTable(scene);

  console.log('\nSPEECH TEXT (after TAG_STRIP_REGEX — goes to TTS + chat history):');
  for (const l of wrap(speech, 86)) console.log(`  ${l}`);

  console.log('\nAGENT ACTIONS (parseAgentActions):');
  printActions(actions);

  if (typeTags.length > 0) {
    console.log(`\n[TYPE] TAGS: ${JSON.stringify(typeTags)}`);
  }

  // ── Golden assertions ──
  const kinds = (scene?.cues ?? []).map((c) => c.kind);
  const actKinds = actions.map((a) => a.kind);
  check(
    JSON.stringify(kinds) === JSON.stringify(scenario.expectKinds),
    `${scenario.name}: cue kinds in order`,
    { got: kinds, want: scenario.expectKinds },
  );
  check(
    JSON.stringify(actKinds) === JSON.stringify(scenario.expectActions),
    `${scenario.name}: agent actions in order`,
    { got: actKinds, want: scenario.expectActions },
  );
  // Point cues carry 1-based step/total; the beat index stays 0-based.
  const points = (scene?.cues ?? []).filter((c) => c.kind === 'point');
  check(
    points.every((p, i) => p.step === i + 1 && p.total === points.length),
    `${scenario.name}: point cues numbered step/total`,
    points.map((p) => [p.step, p.total]),
  );
  // Every coord must land inside the target display's bounds.
  for (const cue of scene?.cues ?? []) {
    if (cue.kind === 'clear') continue;
    const c = captures[cue.screenIndex];
    check(
      c !== undefined &&
        cue.x >= c.displayBounds.x &&
        cue.x <= c.displayBounds.x + c.displayBounds.width &&
        cue.y >= c.displayBounds.y &&
        cue.y <= c.displayBounds.y + c.displayBounds.height,
      `${scenario.name}: ${cue.kind} anchor inside ${boundsLabel(cue.screenIndex)}`,
      { x: round1(cue.x), y: round1(cue.y) },
    );
  }
  // The speech the user hears must contain no DSL at all.
  check(
    !/\[[A-Z]+:/.test(speech),
    `${scenario.name}: stripped speech has no leftover tags`,
    speech,
  );
  check(speech.length > 0, `${scenario.name}: speech text survived stripping`, speech);
}

console.log('\n' + '='.repeat(88));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
