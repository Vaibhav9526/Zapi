import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { SceneCue } from '../../shared/types';
import {
  arrowHead,
  cueVisibleOnDisplay,
  sliceExcess,
  sliceLive,
  smoothPath,
  STROKE_BUDGET,
  wobble,
  wrapWriteLines,
} from './inkMath';

// Marker-pen palette — warm amber for most strokes so ink reads as
// "assistant drew this", red reserved for circles that mean "look here".
const INK_AMBER = '#ff9d0a';
const INK_RED = '#ff4d3d';
const HILITE_FILL = 'rgba(255,196,0,.30)';
// Dark halo painted ~2px wider under every stroke so ink stays legible
// on both light and dark apps underneath the transparent overlay. The
// color lives on the .ink-under CSS class; this is the width boost.
const UNDER_EXTRA = 2.5;

/**
 * One turbulence/displacement filter for the whole scene. Per-cue filter
 * elements would re-rasterize the noise field once per stroke; a single
 * group filter lets Chromium cache the turbulence (its inputs never
 * change — the seed is fixed, so the pattern can't crawl between frames)
 * and pay only for the displacement. Fixed seed matters for the same
 * reason: a per-render seed makes the ink shimmer.
 */
const WOBBLE_FILTER_ID = 'zapi-ink-wobble';
/** Peak vertex jitter of a hand-drawn pass, in px. */
const SKETCH_AMP = 1.15;
/** The second pass is offset harder — that's what makes it read as a
 *  second pen stroke rather than a smudge. */
const SKETCH_AMP_2 = 1.9;
/** Arrow shafts bow by this fraction of their length — a hand never
 *  draws a ruler-straight line. */
const ARROW_BEND = 0.08;
/** Point-cue target: two concentric sketchy rings. */
const POINT_RING_R = 15;
const POINT_RING_GAP = 6;
/** Handwritten label box metrics. 13px/char and 38px/line match the
 *  estimates inkMath.cueBox uses, so the cull stays conservative. */
const LABEL_CHAR_W = 13;
const LABEL_LINE_H = 38;
const LABEL_PAD_X = 10;
const LABEL_PAD_Y = 8;
/** Degrees a hand-drawn label leans. */
const LABEL_TILT = -0.5;

// Retiring strokes fade out over CSS 0.45s; the timer drops them just
// after so the fade always completes even under rapid beats.
const RETIRE_MS = 500;

// Live mirror of the OS reduced-motion setting. CSS handles most of it
// via media query; JS needs it for things CSS can't reach (skipping the
// land-pulse node, snapping the cursor glide in OverlayApp).
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export interface InkLayerProps {
  /** Full ordered cue list from the latest SCENE message. */
  cues: SceneCue[];
  /** Latest SCENE_CUE beat index, or null when no beat is active. */
  beat: number | null;
  /** True during the ~600ms fade-out after SCENE null. */
  fading: boolean;
  /**
   * This overlay's display bounds in display-space logical pixels, or
   * null while unknown. Used both to shift cues into window-local coords
   * and to cull other displays' cues — without this, every overlay inks
   * every cue and overlapping/mirrored layouts double-draw.
   */
  bounds: { x: number; y: number; width: number; height: number } | null;
}

interface Drawable {
  cue: SceneCue;
  index: number;
}

// ── Sketch geometry ──────────────────────────────────────────────────
// Everything below is deterministic: the same cue always inks the same
// way. Math.random would reshuffle strokes on every re-render (the ink
// would crawl while the draw-on animation ran) and two overlays showing
// the same cue would disagree.

/** Deterministic noise in -1..1 — a hash, not a random source. */
function noise(seed: number, k: number): number {
  const s = Math.sin(seed * 127.1 + k * 311.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

const n2 = (v: number): string => (Math.round(v * 100) / 100).toString();

/** Per-vertex jitter, applied along the outward normal of a point list
 *  is overkill for a marker pen — a flat 2D offset reads the same. */
function jitter(
  pts: Array<{ x: number; y: number }>,
  seed: number,
  amp: number,
): Array<{ x: number; y: number }> {
  return pts.map((p, i) => ({
    x: p.x + noise(seed, i * 2 + 1) * amp,
    y: p.y + noise(seed, i * 2 + 2) * amp,
  }));
}

/** Closed Catmull-Rom → cubic bezier loop (inkMath.smoothPath is the
 *  open variant; a ring needs the wrap-around segment). */
function closedSmooth(pts: Array<{ x: number; y: number }>): string {
  const n = pts.length;
  if (n < 3) return '';
  let d = `M ${n2(pts[0].x)} ${n2(pts[0].y)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${n2(c1x)} ${n2(c1y)} ${n2(c2x)} ${n2(c2y)} ${n2(p2.x)} ${n2(p2.y)}`;
  }
  return `${d} Z`;
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number): Array<{ x: number; y: number }> {
  // Sampled by arc length for the same reason roundRectPoints is: the
  // Catmull-Rom control offset scales with the neighbour gap.
  const n = Math.max(14, Math.min(48, Math.round((Math.PI * (rx + ry)) / SKETCH_STEP)));
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return out;
}

/** How far apart hand-drawn samples sit, in px. The closed Catmull-Rom
 *  pulls each control point a third of the way toward its neighbour, so
 *  sparse sampling on a long edge is what makes a "hand-drawn" box bulge
 *  at the corners. ~22px keeps every control offset under a few px while
 *  still leaving vertices for the jitter to push around. */
const SKETCH_STEP = 22;

function roundRectPoints(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): Array<{ x: number; y: number }> {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const out: Array<{ x: number; y: number }> = [];
  // Corner centres in clockwise order, each with the angle its arc starts at.
  const corners: Array<[number, number, number]> = [
    [x + w - rr, y + rr, -Math.PI / 2],
    [x + w - rr, y + h - rr, 0],
    [x + rr, y + h - rr, Math.PI / 2],
    [x + rr, y + rr, Math.PI],
  ];
  const onCorner = (c: [number, number, number], a: number) => ({
    x: c[0] + rr * Math.cos(a),
    y: c[1] + rr * Math.sin(a),
  });
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i];
    // Corner arc: ~1 sample per SKETCH_STEP of arc.
    const arcSteps = Math.max(2, Math.round(((Math.PI / 2) * rr) / SKETCH_STEP));
    for (let k = 0; k <= arcSteps; k++) {
      out.push(onCorner(c, c[2] + (k / arcSteps) * (Math.PI / 2)));
    }
    // Straight run to the next corner's arc start, sampled by length.
    const from = onCorner(c, c[2] + Math.PI / 2);
    const next = corners[(i + 1) % corners.length];
    const to = onCorner(next, next[2]);
    const run = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.round(run / SKETCH_STEP));
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
  }
  return out;
}

/** Hand-drawn ellipse/ring. */
export function sketchEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seed: number,
  amp = SKETCH_AMP,
): string {
  return closedSmooth(jitter(ellipsePoints(cx, cy, rx, ry), seed, amp));
}

/** Hand-drawn rounded box. */
export function sketchRoundRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  seed: number,
  amp = SKETCH_AMP,
): string {
  return closedSmooth(jitter(roundRectPoints(x, y, w, h, r), seed, amp));
}

/** Hand-drawn open stroke through the given vertices. */
export function sketchLine(
  pts: Array<{ x: number; y: number }>,
  seed: number,
  amp = SKETCH_AMP,
): string {
  return smoothPath(jitter(pts, seed, amp));
}

/**
 * One arrow as a hand would draw it: a shaft bowed off-axis, plus two
 * barbs that are each their own short curved stroke rather than two
 * straight lines welded to the tip.
 *
 * Barb endpoints still come from inkMath.arrowHead (the head length and
 * spread are covered by scripts/ink-check.mts) — only the pen path
 * between them is ours.
 */
export function sketchArrow(
  x: number,
  y: number,
  x2: number,
  y2: number,
  seed: number,
  amp = SKETCH_AMP,
): { shaft: string; barbs: [string, string]; tip: { x: number; y: number } } {
  const h = arrowHead(x, y, x2, y2);
  if (!h) {
    // Degenerate cue: a dot, matching arrowPath's behaviour.
    return { shaft: `M ${n2(x)} ${n2(y)} L ${n2(x + 0.1)} ${n2(y + 0.1)}`, barbs: ['', ''], tip: { x, y } };
  }
  const dx = x2 - x;
  const dy = y2 - y;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular bow; the seed picks which way the hand drifted, so
  // parallel arrows in one scene don't curve in lockstep.
  const bow = (noise(seed, 1) >= 0 ? 1 : -1) * ARROW_BEND * len;
  const cx = (x + x2) / 2 + (-dy / len) * bow;
  const cy = (y + y2) / 2 + (dx / len) * bow;
  const shaft = `M ${n2(x)} ${n2(y)} Q ${n2(cx)} ${n2(cy)} ${n2(x2)} ${n2(y2)}`;
  const barb = (bx: number, by: number, k: number): string => {
    const mx = (bx + x2) / 2 + noise(seed, k) * amp * 1.4;
    const my = (by + y2) / 2 + noise(seed, k + 0.5) * amp * 1.4;
    return `M ${n2(bx)} ${n2(by)} Q ${n2(mx)} ${n2(my)} ${n2(x2)} ${n2(y2)}`;
  };
  return { shaft, barbs: [barb(h.hx1, h.hy1, 2), barb(h.hx2, h.hy2, 3)], tip: { x: x2, y: y2 } };
}

/** All three pen strokes of an arrow in one `d`, so the dash draw-on
 *  runs tail→tip→barb instead of restarting per segment. */
function arrowInk(x: number, y: number, x2: number, y2: number, seed: number, amp: number): string {
  const a = sketchArrow(x, y, x2, y2, seed, amp);
  return [a.shaft, a.barbs[0], a.barbs[1]].filter(Boolean).join(' ');
}

/** The label box a hand-drawn caption sits in, plus the transform both
 *  the border and its text share so the tilt never splits them. */
export interface LabelBox {
  d: string;
  /** Tilt about this point — the same origin for border and text. */
  origin: { x: number; y: number };
  textX: number;
  textY: number;
  tilt: string | undefined;
}

export function labelBox(
  rows: string[],
  x: number,
  y: number,
  seed: number,
  reduced: boolean,
  amp = SKETCH_AMP,
): LabelBox {
  const maxLen = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const w = Math.max(56, maxLen * LABEL_CHAR_W + LABEL_PAD_X * 2);
  // The text anchor is the FIRST line's baseline, so the box hangs ~0.8
  // line-heights above it and grows downward with the rows.
  const h = rows.length * LABEL_LINE_H + LABEL_PAD_Y;
  const bx = x - LABEL_PAD_X;
  const by = y - LABEL_LINE_H * 0.8;
  const cx = bx + w / 2;
  const cy = by + h / 2;
  return {
    d: sketchRoundRect(bx, by, w, h, 7, seed, amp),
    origin: { x: cx, y: cy },
    textX: x,
    textY: y,
    // Reduced motion gets the label square to the grid: a leaning box
    // over a UI the user is trying to read is motion-adjacent jitter.
    tilt: reduced ? undefined : `rotate(${LABEL_TILT} ${n2(cx)} ${n2(cy)})`,
  };
}

export function InkLayer({ cues, beat, fading, bounds }: InkLayerProps) {
  // No viewBox on purpose: bare SVG user units are CSS px, which match
  // the display-space logical pixels main authors cues in at any
  // devicePixelRatio — a viewBox scale would blur or offset strokes on
  // HiDPI. Window-local = display-space minus this display's origin.
  const ox = bounds?.x ?? 0;
  const oy = bounds?.y ?? 0;
  const lx = (x: number) => x - ox;
  const ly = (y: number) => y - oy;
  const reduced = usePrefersReducedMotion();

  // Reveal cues[0..beat] cumulatively; 'clear' wipes strokes drawn so
  // far so a long scene can reset the board mid-flow. Point cues never
  // accumulate ink — they steer the cursor (see activePoint) and their
  // target ring is a single live marker, not a stroke.
  const full = useMemo<Drawable[]>(() => {
    if (beat === null || beat < 0) return [];
    const out: Drawable[] = [];
    const top = Math.min(beat, cues.length - 1);
    for (let i = 0; i <= top; i++) {
      const cue = cues[i];
      // 'clear' is board-global, never per-display — apply it even when
      // this overlay has culled everything else so all screens reset.
      if (cue.kind === 'clear') {
        out.length = 0;
        continue;
      }
      if (cue.kind === 'point') continue;
      // Cull other displays' cues: coords are display-space, so anything
      // outside this window's viewport belongs to a sibling overlay. A
      // cue straddling the boundary is kept on BOTH overlays and each
      // window clips to its half — nothing drawn twice, nothing lost.
      if (!cueVisibleOnDisplay(cue, bounds)) continue;
      out.push({ cue, index: i });
    }
    return out;
  }, [cues, beat, bounds]);

  // The point cue the cursor is heading for gets a sketchy double-ring
  // target. It is deliberately NOT part of `full`: the ring belongs to
  // the live beat only, so pointing at four things in a row doesn't
  // leave four rings stacked on the board. Visibility is tested inline
  // because inkMath.cueBox paints nothing for point cues (they never
  // accumulated ink) — this is a marker, not a stroke.
  const activePoint = useMemo<SceneCue | null>(() => {
    if (beat === null || beat < 0) return null;
    const cue = cues[Math.min(beat, cues.length - 1)];
    if (!cue || cue.kind !== 'point') return null;
    if (bounds) {
      const px = cue.x - ox;
      const py = cue.y - oy;
      const r = POINT_RING_R + POINT_RING_GAP;
      if (px < -r || px > bounds.width + r || py < -r || py > bounds.height + r) return null;
    }
    return cue;
  }, [cues, beat, bounds, ox, oy]);

  // Live window = newest STROKE_BUDGET; older strokes retire with a fade
  // instead of blinking out mid-explanation.
  const live = sliceLive(full);
  const [retired, setRetired] = useState<Drawable[]>([]);
  const retireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fresh scene = fresh board: drop any mid-fade retirees from the old
  // scene and cancel their removal timer so rapid SCENE replacements
  // can't leak pending timers or ghost strokes.
  useEffect(() => {
    if (retireTimerRef.current) {
      clearTimeout(retireTimerRef.current);
      retireTimerRef.current = null;
    }
    setRetired([]);
  }, [cues]);

  useEffect(() => {
    const excess = sliceExcess(full);
    const excessKeys = new Set(excess.map((d) => d.index));
    // Prune first: a 'clear' beat (or any rewind) drops retirees that are
    // no longer excess, so the board wipes promptly instead of showing
    // fading ghosts over a cleared canvas.
    setRetired((prev) => {
      if (excess.length === 0) return prev.length ? [] : prev;
      const kept = prev.filter((d) => excessKeys.has(d.index));
      const keptKeys = new Set(kept.map((d) => d.index));
      const add = excess.filter((d) => !keptKeys.has(d.index));
      if (add.length === 0 && kept.length === prev.length) return prev;
      return [...kept, ...add].slice(-STROKE_BUDGET);
    });
    if (retireTimerRef.current) clearTimeout(retireTimerRef.current);
    if (excess.length > 0) {
      retireTimerRef.current = setTimeout(() => {
        retireTimerRef.current = null;
        setRetired([]);
      }, RETIRE_MS);
    }
    return () => {
      if (retireTimerRef.current) {
        clearTimeout(retireTimerRef.current);
        retireTimerRef.current = null;
      }
    };
  }, [full]);

  useEffect(
    () => () => {
      if (retireTimerRef.current) {
        clearTimeout(retireTimerRef.current);
        retireTimerRef.current = null;
      }
    },
    [],
  );

  // Text lives in its own unfiltered layer: the displacement filter would
  // blur glyph edges, and a 30px handwritten label has to stay crisp to
  // be read at all. The border around it (in the filtered layer) is the
  // part allowed to wobble.
  const textLayer = (list: Drawable[], keyPrefix: string, cls: string) =>
    list.map(({ cue, index }) => {
      const body = labelText(cue, index, lx, ly, reduced);
      return body ? (
        <g key={`${keyPrefix}${index}`} className={cls}>
          {body}
        </g>
      ) : null;
    });

  return (
    <svg
      className={`ink-layer${fading ? ' ink-fading' : ''}`}
      aria-hidden
      // Fullscreen fixed overlay; pointer-events none inherited from CSS
      // so the window stays click-through no matter what is drawn.
    >
      <defs>
        {/*
          Hand-drawn wobble. fractalNoise + displacement is the cheap way
          to make every stroke below look like it was drawn by a hand on a
          rough surface — the geometry underneath is still exact, so the
          hit targets the agent reasons about never drift. scale=2 is
          ~1px of visible wander at our stroke widths; the two-octave
          noise keeps it from looking like a sine wave.
        */}
        <filter
          id={WOBBLE_FILTER_ID}
          x="-6%"
          y="-6%"
          width="112%"
          height="112%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.02"
            numOctaves="2"
            seed="3"
            result="ink-noise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="ink-noise"
            scale="2"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>

      {/* One filter for the scene, not one per stroke. Reduced motion
          drops the filter entirely: perfectly straight ink that just
          appears, no wobble and no draw-on. */}
      <g className="ink-wobble" filter={reduced ? undefined : `url(#${WOBBLE_FILTER_ID})`}>
        {/* Retirees paint UNDER live ink — a fading old stroke should
            never cover a fresh one during its 0.45s exit. */}
        {retired.map(({ cue, index }) => (
          <g key={`ink-old-${index}`} className="ink-stroke ink-retiring">
            {strokeInk(cue, index, lx, ly, reduced)}
          </g>
        ))}
        {live.map(({ cue, index }) => (
          <g key={`ink-${index}`} className="ink-stroke">
            {strokeInk(cue, index, lx, ly, reduced)}
          </g>
        ))}
        {activePoint && pointRing(activePoint, lx, ly, reduced)}
      </g>

      {/* Unfiltered text, drawn above the ink so a label always reads
          even when a stroke passes behind it. */}
      {textLayer(retired, 'ink-txt-old-', 'ink-text ink-retiring')}
      {textLayer(live, 'ink-txt-', 'ink-text')}
    </svg>
  );
}

// ── Per-cue artwork ─────────────────────────────────────────────────

/**
 * Ink (filtered layer) for one cue: two hand-drawn passes over a dark
 * halo. The second pass is a harder-jittered duplicate of the same
 * shape at .ink-echo's 40% — the rough.js double-stroke idiom, which
 * reads as two pen passes instead of one blurry one. Under reduced
 * motion it is dropped: a doubled outline is the same "unsettled"
 * signal the wobble is, and the user asked for still.
 */
function strokeInk(
  cue: SceneCue,
  index: number,
  lx: (x: number) => number,
  ly: (y: number) => number,
  reduced: boolean,
): ReactElement | null {
  // Per-cue translation on top of the per-vertex jitter: two circles at
  // the same coords in one scene should not ink identically.
  const { dx, dy } = wobble(index);
  // Reduced motion zeroes the jitter amplitude, which is the honest
  // switch for "no wobble": the geometry underneath is exact, so at
  // amp=0 every shape is its nominal self and only the pen's inherent
  // curvature is left. (Dropping the filter alone would still leave
  // hand-jittered outlines, which is the thing the setting asks away.)
  const amp = reduced ? 0 : SKETCH_AMP;
  const amp2 = reduced ? 0 : SKETCH_AMP_2;

  switch (cue.kind) {
    case 'arrow': {
      const x = lx(cue.x) + dx;
      const y = ly(cue.y) + dy;
      const x2 = lx(cue.x2 ?? cue.x) + dx;
      const y2 = ly(cue.y2 ?? cue.y) + dy;
      const d1 = arrowInk(x, y, x2, y2, index + 1, amp);
      const d2 = arrowInk(x, y, x2, y2, index + 1, amp2);
      const tip = sketchArrow(x, y, x2, y2, index + 1).tip;
      return (
        <g className="ink-stroke">
          <path d={d1} className="ink-under" pathLength={1} style={{ strokeWidth: 5 + UNDER_EXTRA }} />
          <path d={d1} className="ink-draw" pathLength={1} stroke={INK_AMBER} style={{ strokeWidth: 5 }} />
          {!reduced && <path d={d2} className="ink-echo" pathLength={1} stroke={INK_AMBER} style={{ strokeWidth: 5 }} />}
          {/* Reduced motion skips the pulse node itself — CSS alone
              would still flash it for one frame before hiding it. */}
          {!reduced && <circle cx={tip.x} cy={tip.y} r={7} className="ink-land" />}
        </g>
      );
    }
    case 'circle': {
      const rx = Math.max(cue.w ?? 40, 4);
      const ry = Math.max(cue.h ?? 40, 4);
      const cx = lx(cue.x) + dx;
      const cy = ly(cue.y) + dy;
      const d1 = sketchEllipse(cx, cy, rx, ry, index + 1, amp);
      const d2 = sketchEllipse(cx, cy, rx, ry, index + 2, amp2);
      return (
        <g className="ink-stroke">
          <path d={d1} className="ink-under" pathLength={1} style={{ strokeWidth: 5 + UNDER_EXTRA }} />
          <path d={d1} className="ink-draw" pathLength={1} stroke={INK_RED} style={{ strokeWidth: 5 }} />
          {!reduced && <path d={d2} className="ink-echo" pathLength={1} stroke={INK_RED} style={{ strokeWidth: 5 }} />}
        </g>
      );
    }
    case 'box': {
      const w = Math.max(cue.w ?? 80, 8);
      const h = Math.max(cue.h ?? 48, 8);
      const x = lx(cue.x) + dx;
      const y = ly(cue.y) + dy;
      const d1 = sketchRoundRect(x, y, w, h, 10, index + 1, amp);
      const d2 = sketchRoundRect(x, y, w, h, 10, index + 2, amp2);
      return (
        <g className="ink-stroke">
          <path d={d1} className="ink-under" pathLength={1} style={{ strokeWidth: 4 + UNDER_EXTRA }} />
          <path d={d1} className="ink-draw" pathLength={1} stroke={INK_AMBER} style={{ strokeWidth: 4 }} />
          {!reduced && <path d={d2} className="ink-echo" pathLength={1} stroke={INK_AMBER} style={{ strokeWidth: 4 }} />}
        </g>
      );
    }
    case 'hilite': {
      const w = Math.max(cue.w ?? 120, 8);
      const h = Math.max(cue.h ?? 28, 8);
      // Hilite pops with a quick fade, not a draw-on — a marker swipe
      // has no single pen path to animate. Its edges ride the wobble
      // filter like every other ink, but it is NOT tilted: it sits over a
      // real UI element, and a leaning highlight would misregister.
      return (
        <rect
          x={lx(cue.x)}
          y={ly(cue.y)}
          width={w}
          height={h}
          rx={6}
          className="ink-hilite"
          fill={HILITE_FILL}
        />
      );
    }
    case 'path': {
      const pts = (cue.points ?? []).map((p) => ({ x: lx(p.x) + dx, y: ly(p.y) + dy }));
      if (pts.length === 0) return null;
      const d1 = sketchLine(pts, index + 1, amp);
      const d2 = sketchLine(pts, index + 2, amp2);
      return (
        <g className="ink-stroke">
          <path d={d1} className="ink-under" pathLength={1} style={{ strokeWidth: 4 + UNDER_EXTRA }} />
          <path d={d1} className="ink-draw" pathLength={1} stroke={INK_AMBER} style={{ strokeWidth: 4 }} />
          {!reduced && <path d={d2} className="ink-echo" pathLength={1} stroke={INK_AMBER} style={{ strokeWidth: 4 }} />}
        </g>
      );
    }
    case 'write': {
      // The hand-drawn border around the caption. The text itself is
      // rendered by labelText() into the unfiltered layer so the glyphs
      // stay crisp; both share one tilt origin.
      const rows = wrapWriteLines(cue.text ?? '');
      const box = labelBox(rows, lx(cue.x) + dx, ly(cue.y) + dy, index + 1, reduced, amp);
      return (
        <g className="ink-stroke">
          <path d={box.d} className="ink-label" pathLength={1} transform={box.tilt} />
          {!reduced && (
            <path
              d={sketchRoundRect(
                lx(cue.x) + dx - LABEL_PAD_X,
                ly(cue.y) + dy - LABEL_LINE_H * 0.8,
                Math.max(56, rows.reduce((m, r) => Math.max(m, r.length), 0) * LABEL_CHAR_W + LABEL_PAD_X * 2),
                rows.length * LABEL_LINE_H + LABEL_PAD_Y,
                7,
                index + 2,
                amp2,
              )}
              className="ink-echo"
              pathLength={1}
              stroke={INK_AMBER}
              style={{ strokeWidth: 2 }}
              transform={box.tilt}
            />
          )}
        </g>
      );
    }
    default:
      return null;
  }
}

/** The unfiltered half of a write cue: handwriting, plus the tilt that
 *  keeps it inside its hand-drawn border. */
function labelText(
  cue: SceneCue,
  index: number,
  lx: (x: number) => number,
  ly: (y: number) => number,
  reduced: boolean,
): ReactElement | null {
  if (cue.kind !== 'write') return null;
  const rows = wrapWriteLines(cue.text ?? '');
  const box = labelBox(rows, lx(cue.x), ly(cue.y), index + 1, reduced);
  return (
    <text x={box.textX} y={box.textY} className="ink-write ink-write-reveal" transform={box.tilt}>
      {rows.map((row, ri) => (
        <tspan key={ri} x={box.textX} dy={ri === 0 ? 0 : '1.25em'}>
          {row}
        </tspan>
      ))}
    </text>
  );
}

/** Sketchy double-ring target for the live point cue. Under reduced
 *  motion it collapses to one clean ring: the second pass and the
 *  jitter are both "unsettled" signals. */
function pointRing(
  cue: SceneCue,
  lx: (x: number) => number,
  ly: (y: number) => number,
  reduced: boolean,
): ReactElement | null {
  const cx = lx(cue.x);
  const cy = ly(cue.y);
  const amp = reduced ? 0 : SKETCH_AMP;
  const ring = sketchEllipse(cx, cy, POINT_RING_R, POINT_RING_R, 11, amp);
  return (
    <g className="ink-stroke ink-point-ring">
      <path d={ring} className="ink-under" pathLength={1} style={{ strokeWidth: 3 + UNDER_EXTRA }} />
      <path d={ring} className="ink-draw" pathLength={1} stroke={INK_AMBER} style={{ strokeWidth: 3 }} />
      {!reduced && (
        <path
          d={sketchEllipse(cx, cy, POINT_RING_R + POINT_RING_GAP, POINT_RING_R + POINT_RING_GAP, 12, SKETCH_AMP_2)}
          className="ink-echo"
          pathLength={1}
          stroke={INK_AMBER}
          style={{ strokeWidth: 2.5 }}
        />
      )}
    </g>
  );
}
