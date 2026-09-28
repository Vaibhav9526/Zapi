import type { SceneCue } from '../../shared/types';

/**
 * Pure geometry/layout helpers for InkLayer — no React, no DOM. Kept in
 * a separate module so scripts/ink-check.mts can exercise the exact math
 * the overlay ships (culling, budget slicing, arrow heads, wrap, wobble)
 * instead of a duplicated copy that can silently drift.
 */

// Stroke budget — one SVG node per stroke ×3 passes (under/ink/echo),
// so long scenes cap live DOM at the newest ~48 and retire the rest.
// Point cues never count: they drive the cursor, they don't draw.
export const STROKE_BUDGET = 48;

// Newest window kept live; the head of the list is what retires.
export function sliceLive<T>(items: T[]): T[] {
  return items.length > STROKE_BUDGET ? items.slice(items.length - STROKE_BUDGET) : items;
}

// The strokes that just left the live window — they get the fade-out.
export function sliceExcess<T>(items: T[]): T[] {
  return items.length > STROKE_BUDGET ? items.slice(0, items.length - STROKE_BUDGET) : [];
}

// Deterministic per-stroke wobble so parallel strokes don't look
// copy-pasted, without any randomness that would shimmer on re-render.
export function wobble(i: number): { dx: number; dy: number } {
  return { dx: (((i * 37) % 5) - 2) * 0.75, dy: (((i * 53 + 1) % 5) - 2) * 0.75 };
}

// Catmull-Rom → cubic bezier through polyline vertices. Unlike chained
// line joins this stays smooth at every vertex, which is what sells a
// freehand marker stroke instead of a connect-the-dots polyline.
export function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y} L ${pts[0].x + 0.1} ${pts[0].y + 0.1}`;
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    // Clamp ends by duplicating — the curve then passes through the
    // first and last vertices instead of overshooting past them.
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
  }
  return d;
}

// Handwritten labels cap at ~46ch so a long model string can't sprawl
// across the whole display; overflow wraps instead. The anchor stays
// at the cue's x,y (first-line origin) — only rows grow downward.
export const WRITE_MAX_CH = 46;

function wrapWriteLine(line: string, maxCh: number): string[] {
  if (line.length <= maxCh) return [line];
  const rows: string[] = [];
  let cur = '';
  for (const word of line.split(' ')) {
    if (word.length > maxCh) {
      // One giant token (a URL, a path) — hard-break it mid-word.
      if (cur) {
        rows.push(cur);
        cur = '';
      }
      for (let i = 0; i < word.length; i += maxCh) rows.push(word.slice(i, i + maxCh));
    } else if (!cur) {
      cur = word;
    } else if (cur.length + 1 + word.length <= maxCh) {
      cur += ` ${word}`;
    } else {
      rows.push(cur);
      cur = word;
    }
  }
  if (cur) rows.push(cur);
  return rows.length ? rows : [''];
}

export function wrapWriteLines(text: string): string[] {
  // Split on explicit \n first so the model controls verses, then wrap
  // each paragraph to the width cap. Empty paragraphs survive as blank
  // rows so stanza breaks keep their spacing.
  const rows: string[] = [];
  for (const para of text.split('\n')) rows.push(...wrapWriteLine(para, WRITE_MAX_CH));
  return rows.length ? rows : [''];
}

// ── Arrow heads ───────────────────────────────────────────────────
// Head geometry lives in numbers so the draw path AND the headless
// check agree on where the barbs land — parsing path strings back out
// would test formatting, not aim.

export const ARROW_HEAD_MAX = 14;
export const ARROW_HEAD_MIN = 6;
/** Head shrinks with shaft length so short arrows aren't all head. */
export const ARROW_HEAD_FRACTION = 0.4;
/** Barb spread as a fraction of π off the shaft direction (±147.6°). */
export const ARROW_BARB_RADIANS = Math.PI * 0.82;
/** Shafts shorter than this draw as a dot — a head would float alone. */
export const ARROW_DEGENERATE_LEN = 2;

export interface ArrowHead {
  /** Barb endpoints (the tip is always the cue's x2,y2). */
  hx1: number;
  hy1: number;
  hx2: number;
  hy2: number;
  /** Barb length actually used, after the min/max clamp. */
  head: number;
  /** Shaft direction in radians — barbs sit at angle ±BARB_RADIANS. */
  angle: number;
}

export function arrowHead(x: number, y: number, x2: number, y2: number): ArrowHead | null {
  const len = Math.hypot(x2 - x, y2 - y);
  if (len < ARROW_DEGENERATE_LEN) return null;
  const head = Math.min(ARROW_HEAD_MAX, Math.max(ARROW_HEAD_MIN, len * ARROW_HEAD_FRACTION));
  const angle = Math.atan2(y2 - y, x2 - x);
  const a1 = angle + ARROW_BARB_RADIANS;
  const a2 = angle - ARROW_BARB_RADIANS;
  return {
    hx1: x2 + Math.cos(a1) * head,
    hy1: y2 + Math.sin(a1) * head,
    hx2: x2 + Math.cos(a2) * head,
    hy2: y2 + Math.sin(a2) * head,
    head,
    angle,
  };
}

export function arrowPath(x: number, y: number, x2: number, y2: number): string {
  // Single path (shaft + head) so the draw-on dash animation runs
  // continuously from tail to tip instead of restarting per segment.
  const h = arrowHead(x, y, x2, y2);
  // Degenerate cue with no tip — a round-capped dot reads better than
  // a stray arrowhead floating where no arrow was meant.
  if (!h) return `M ${x} ${y} L ${x + 0.1} ${y + 0.1}`;
  return (
    `M ${x} ${y} L ${x2} ${y2} ` +
    `M ${h.hx1} ${h.hy1} L ${x2} ${y2} L ${h.hx2} ${h.hy2}`
  );
}

// ── Per-display culling ───────────────────────────────────────────

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Local-space bbox of one draw cue, padded for stroke width, wobble,
// and arrowhead overhang. Null when the cue paints nothing viewable
// (empty path, blank write) so it never reaches the DOM at all.
export function cueBox(
  cue: SceneCue,
  ox: number,
  oy: number,
): Box | null {
  const lx = (x: number) => x - ox;
  const ly = (y: number) => y - oy;
  switch (cue.kind) {
    case 'arrow': {
      const x = lx(cue.x);
      const y = ly(cue.y);
      const x2 = lx(cue.x2 ?? cue.x);
      const y2 = ly(cue.y2 ?? cue.y);
      const pad = 24;
      return {
        x0: Math.min(x, x2) - pad,
        y0: Math.min(y, y2) - pad,
        x1: Math.max(x, x2) + pad,
        y1: Math.max(y, y2) + pad,
      };
    }
    case 'circle': {
      const rx = Math.max(cue.w ?? 40, 4);
      const ry = Math.max(cue.h ?? 40, 4);
      const pad = 14;
      return {
        x0: lx(cue.x) - rx - pad,
        y0: ly(cue.y) - ry - pad,
        x1: lx(cue.x) + rx + pad,
        y1: ly(cue.y) + ry + pad,
      };
    }
    case 'box':
    case 'hilite': {
      const w = Math.max(cue.w ?? (cue.kind === 'box' ? 80 : 120), 8);
      const h = Math.max(cue.h ?? (cue.kind === 'box' ? 48 : 28), 8);
      const pad = 12;
      return {
        x0: lx(cue.x) - pad,
        y0: ly(cue.y) - pad,
        x1: lx(cue.x) + w + pad,
        y1: ly(cue.y) + h + pad,
      };
    }
    case 'path': {
      const pts = cue.points ?? [];
      if (pts.length === 0) return null;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of pts) {
        const x = lx(p.x);
        const y = ly(p.y);
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
      const pad = 12;
      return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
    }
    case 'write': {
      const rows = wrapWriteLines(cue.text ?? '');
      if (!rows.some((r) => r.trim())) return null;
      // Rough overestimate (tall/wide) on purpose — culling must never
      // eat a visible stroke, only skip what is clearly off-window.
      const maxLen = Math.min(
        WRITE_MAX_CH,
        rows.reduce((n, r) => Math.max(n, r.length), 0),
      );
      return {
        x0: lx(cue.x) - 8,
        y0: ly(cue.y) - 32,
        x1: lx(cue.x) + maxLen * 13 + 8,
        y1: ly(cue.y) + rows.length * 38,
      };
    }
    default:
      return null;
  }
}

/** True when a local-space cue bbox touches the window's viewport at all. */
export function boxIntersects(box: Box, vw: number, vh: number): boolean {
  return !(box.x0 > vw || box.x1 < 0 || box.y0 > vh || box.y1 < 0);
}

/**
 * The cull predicate InkLayer applies per draw cue. Bounds null (display
 * info not yet arrived) draws everything — the window still clips to its
 * own screen. A cue straddling two displays returns true on BOTH overlays
 * and each window clips to its half, so nothing is double-drawn or lost.
 */
export function cueVisibleOnDisplay(
  cue: SceneCue,
  bounds: { x: number; y: number; width: number; height: number } | null,
): boolean {
  if (!bounds) return true;
  const box = cueBox(cue, bounds.x, bounds.y);
  if (!box) return false;
  return boxIntersects(box, bounds.width, bounds.height);
}
