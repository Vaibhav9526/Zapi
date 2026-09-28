/**
 * Headless math checks for the ink layer — the pure helpers InkLayer
 * actually ships, imported from src/renderer/components/inkMath.ts so
 * this file can't drift from the overlay's real behavior.
 *
 * Covers: per-display culling (incl. boundary straddles), stroke budget
 * live/excess slicing order, arrow head geometry, Catmull-Rom smoothing
 * pass-through, write-wrap invariants, and wobble determinism.
 *
 * Run:  bun scripts/ink-check.mts  (or: npx tsx scripts/ink-check.mts)
 * Prints PASS/FAIL per check, a summary line, and exits 1 on failure.
 */
import {
  arrowHead,
  arrowPath,
  boxIntersects,
  cueBox,
  cueVisibleOnDisplay,
  sliceExcess,
  sliceLive,
  smoothPath,
  STROKE_BUDGET,
  wobble,
  WRITE_MAX_CH,
  wrapWriteLines,
  ARROW_BARB_RADIANS,
  ARROW_HEAD_MAX,
  ARROW_HEAD_MIN,
} from '../src/renderer/components/inkMath';
import type { SceneCue } from '../src/shared/types';

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}
const approx = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;

const cue = (patch: Partial<SceneCue>): SceneCue => ({
  kind: 'arrow',
  x: 0,
  y: 0,
  screenIndex: 0,
  ...patch,
});

// ── Per-display culling ────────────────────────────────────────────────

const D1 = { x: 0, y: 0, width: 1920, height: 1080 };
const D2 = { x: 1920, y: 0, width: 1920, height: 1080 };

check(
  cueVisibleOnDisplay(cue({ x: 100, y: 100, x2: 300, y2: 300 }), D1),
  'cull: arrow fully inside is kept',
);
check(
  !cueVisibleOnDisplay(cue({ x: 2000, y: 100, x2: 2500, y2: 300 }), D1),
  'cull: arrow fully right is dropped',
);
check(
  cueVisibleOnDisplay(cue({ x: 1900, y: 500, x2: 2000, y2: 600 }), D1),
  'cull: arrow straddling right edge is kept (window clips)',
);
check(
  !cueVisibleOnDisplay(cue({ x: -500, y: 100, x2: -100, y2: 300 }), D1),
  'cull: arrow fully left is dropped',
);
check(
  !cueVisibleOnDisplay(cue({ kind: 'box', x: 100, y: 1200, w: 80, h: 48 }), D1),
  'cull: box fully below is dropped',
);
check(
  cueVisibleOnDisplay(cue({ kind: 'box', x: 100, y: 1060, w: 80, h: 48 }), D1),
  'cull: box straddling bottom edge is kept',
);
check(
  cueVisibleOnDisplay(cue({ kind: 'circle', x: 960, y: -10, w: 40, h: 40 }), D1),
  'cull: circle straddling top edge is kept',
);

// The same cue on the second display: visible there, culled here.
const onD2 = cue({ x: 2100, y: 200, x2: 2300, y2: 400 });
check(cueVisibleOnDisplay(onD2, D2), 'cull: display-2 cue kept on display 2');
check(!cueVisibleOnDisplay(onD2, D1), 'cull: display-2 cue dropped on display 1');

// A cue that crosses the display boundary belongs to BOTH overlays.
const straddler = cue({ x: 1800, y: 400, x2: 2050, y2: 600 });
check(
  cueVisibleOnDisplay(straddler, D1) && cueVisibleOnDisplay(straddler, D2),
  'cull: boundary-straddling arrow kept on both displays',
);

// Unknown bounds → everything draws (window clips to its own screen).
check(
  cueVisibleOnDisplay(cue({ x: 99999, y: 99999, x2: 100000, y2: 100000 }), null),
  'cull: null bounds draws everything',
);

// Cues that paint nothing never reach the DOM.
check(
  !cueVisibleOnDisplay(cue({ kind: 'path', points: [] }), D1),
  'cull: empty path dropped',
);
check(
  !cueVisibleOnDisplay(cue({ kind: 'write', x: 100, y: 200, text: '   ' }), D1),
  'cull: blank write dropped',
);
check(
  cueVisibleOnDisplay(cue({ kind: 'write', x: 100, y: 200, text: 'hi' }), D1),
  'cull: real write kept',
);

// boxIntersects is the same predicate InkLayer's cull used inline before.
const edge = cueBox(cue({ x: 100, y: 100, x2: 300, y2: 300 }), 0, 0);
check(
  !!edge && boxIntersects(edge, 1920, 1080) && !boxIntersects(edge, 20, 1080),
  'cull: boxIntersects matches inline predicate shape',
  edge,
);

// ── Stroke budget slicing ──────────────────────────────────────────────

const items = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

check(
  sliceLive(items(30)).length === 30 && sliceExcess(items(30)).length === 0,
  'budget: under budget keeps everything live',
);
check(
  sliceLive(items(STROKE_BUDGET)).length === STROKE_BUDGET &&
    sliceExcess(items(STROKE_BUDGET)).length === 0,
  'budget: exactly at budget, nothing retires',
);
{
  const n = items(STROKE_BUDGET + 1);
  check(
    sliceLive(n).join() === n.slice(1).join() && sliceExcess(n).join() === '1',
    'budget: one over retires only the oldest',
  );
}
{
  const n = items(100);
  const live = sliceLive(n);
  const excess = sliceExcess(n);
  check(
    live.length === STROKE_BUDGET &&
      live[0] === 100 - STROKE_BUDGET + 1 &&
      live[live.length - 1] === 100 &&
      excess.length === 100 - STROKE_BUDGET &&
      excess[0] === 1 &&
      excess[excess.length - 1] === 100 - STROKE_BUDGET,
    'budget: live = newest window in order, excess = oldest first',
    { liveFirst: live[0], excessLast: excess[excess.length - 1] },
  );
}
{
  // Growing scene: the newest stroke is always live, in arrival order.
  let ok = true;
  for (let n = 1; n <= STROKE_BUDGET + 12; n++) {
    const live = sliceLive(items(n));
    if (live[live.length - 1] !== n || live.length !== Math.min(n, STROKE_BUDGET)) ok = false;
  }
  check(ok, 'budget: growth keeps newest stroke live, capped in order');
}

// ── Arrow head geometry ────────────────────────────────────────────────

{
  const h = arrowHead(0, 0, 100, 0);
  check(!!h && h.head === ARROW_HEAD_MAX, 'arrow: long shaft gets max head', h);
  check(
    !!h && h.hx1 < 100 && h.hx2 < 100 && approx(h.hx1, h.hx2) && approx(h.hy1, -h.hy2),
    'arrow: barbs trail the tip symmetrically',
    h,
  );
  check(
    !!h &&
      approx(Math.hypot(100 - h.hx1, 0 - h.hy1), h.head) &&
      approx(Math.hypot(100 - h.hx2, 0 - h.hy2), h.head),
    'arrow: barb endpoints sit exactly head-length from the tip',
    h,
  );
  // Barb direction: angle + π*0.82 and angle - π*0.82 from shaft.
  check(
    !!h &&
      approx(Math.atan2(h.hy1 - 0, h.hx1 - 100), 0 + ARROW_BARB_RADIANS) &&
      approx(Math.atan2(h.hy2 - 0, h.hx2 - 100), 0 - ARROW_BARB_RADIANS),
    'arrow: barb angles are ±0.82π off the shaft',
    h,
  );
}
{
  const h = arrowHead(50, 50, 50, 150);
  check(
    !!h && h.hy1 < 150 && h.hy2 < 150 && h.hx1 < 50 && h.hx2 > 50,
    'arrow: downward arrow barbs fan up-left/up-right',
    h,
  );
}
{
  const h = arrowHead(0, 0, 10, 0);
  check(!!h && h.head === ARROW_HEAD_MIN, 'arrow: tiny shaft clamps to min head', h);
}
{
  // len 25 sits inside the unclamped band: 6 < 25·0.4 < 14.
  const h = arrowHead(0, 0, 15, 20);
  check(!!h && approx(h.head, 25 * 0.4), 'arrow: mid shaft scales head 0.4×len', h);
}
{
  check(arrowHead(10, 10, 10.5, 10.5) === null, 'arrow: degenerate shaft → null head');
  check(
    arrowPath(10, 10, 10.5, 10.5).startsWith('M 10 10 L'),
    'arrow: degenerate shaft draws a dot, not a head',
  );
}
{
  // The tip in the drawn path is exactly the cue's endpoint — the pulse
  // and the head share one coordinate, so the arrow lands on target.
  const d = arrowPath(0, 0, 100, 0);
  check(
    d.includes('L 100 0') && (d.match(/L 100 0/g) ?? []).length === 2,
    'arrow: path tip lands exactly on cue.x2,y2',
    d,
  );
}

// ── Path smoothing ─────────────────────────────────────────────────────

check(smoothPath([]) === '', 'smooth: empty → empty path');
check(
  smoothPath([{ x: 5, y: 6 }]) === 'M 5 6 L 5.1 6.1',
  'smooth: single point → tiny dot',
);
check(
  smoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }]) === 'M 0 0 L 10 10',
  'smooth: two points → straight line',
);
{
  // Catmull-Rom must pass through every vertex: each C segment ends at
  // pts[i+1]. Parse the emitted string and verify.
  const pts = [
    { x: 0, y: 0 },
    { x: 20, y: 30 },
    { x: 50, y: 10 },
    { x: 80, y: 40 },
    { x: 110, y: 5 },
  ];
  const d = smoothPath(pts);
  const segs = [...d.matchAll(/C ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)/g)];
  let through = segs.length === pts.length - 1;
  for (let i = 0; i < segs.length; i++) {
    if (!approx(+segs[i][5], pts[i + 1].x) || !approx(+segs[i][6], pts[i + 1].y)) through = false;
  }
  check(
    through && d.startsWith('M 0 0'),
    'smooth: curve passes through every vertex including endpoints',
    d,
  );
}

// ── Write wrap invariants ──────────────────────────────────────────────

{
  const rows = wrapWriteLines('short note');
  check(rows.length === 1 && rows[0] === 'short note', 'wrap: short text is one row');
}
{
  const rows = wrapWriteLines('alpha bravo charlie delta echo foxtrot golf hotel india juliet');
  check(
    rows.length > 1 && rows.every((r) => r.length <= WRITE_MAX_CH),
    'wrap: every row respects the width cap',
    rows,
  );
  check(
    rows.join(' ').replace(/ +/g, ' ').trim().startsWith('alpha bravo'),
    'wrap: word order preserved across rows',
    rows,
  );
}
{
  const rows = wrapWriteLines('stanza one\n\nstanza two');
  check(
    rows.length === 3 && rows[1] === '',
    'wrap: blank paragraph survives as a blank row',
    rows,
  );
}
{
  const rows = wrapWriteLines('x'.repeat(WRITE_MAX_CH * 2 + 7));
  check(
    rows.length === 3 && rows.every((r) => r.length <= WRITE_MAX_CH),
    'wrap: giant token hard-breaks at the cap',
    { lens: rows.map((r) => r.length) },
  );
}
check(wrapWriteLines('').length === 1, 'wrap: empty text yields one blank row');

// ── Wobble determinism ─────────────────────────────────────────────────

{
  const a = wobble(7);
  const b = wobble(7);
  check(a.dx === b.dx && a.dy === b.dy, 'wobble: same index → same offset');
  let bounded = true;
  let varied = false;
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const w = wobble(i);
    if (Math.abs(w.dx) > 1.5 || Math.abs(w.dy) > 1.5) bounded = false;
    seen.add(`${w.dx},${w.dy}`);
    if (seen.size > 1) varied = true;
  }
  check(bounded, 'wobble: offsets stay inside ±1.5px');
  check(varied, 'wobble: offsets differ across strokes');
}

// ── Write cue box estimate ─────────────────────────────────────────────

{
  const box = cueBox(cue({ kind: 'write', x: 100, y: 200, text: 'hello world' }), 0, 0);
  check(
    !!box && box.x0 < 100 && box.x1 > 100 && box.y0 < 200 && box.y1 > 200,
    'cuebox: write box overestimates around the anchor',
    box,
  );
}
{
  const box = cueBox(cue({ kind: 'box', x: 100, y: 100, w: 80, h: 48 }), 0, 0);
  check(
    !!box && box.x0 === 88 && box.y0 === 88 && box.x1 === 192 && box.y1 === 160,
    'cuebox: box pad is 12px on every side',
    box,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
