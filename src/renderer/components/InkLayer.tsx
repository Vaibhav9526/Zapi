import { useEffect, useMemo, useRef, useState } from 'react';
import type { SceneCue } from '../../shared/types';
import {
  arrowPath,
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
  // draw — they drive the companion cursor in OverlayApp.
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

  return (
    <svg
      className={`ink-layer${fading ? ' ink-fading' : ''}`}
      aria-hidden
      // Fullscreen fixed overlay; pointer-events none inherited from CSS
      // so the window stays click-through no matter what is drawn.
    >
      {/* Retirees paint UNDER live ink — a fading old stroke should
          never cover a fresh one during its 0.45s exit. */}
      {retired.map(({ cue, index }) => (
        <g key={`ink-old-${index}`} className="ink-stroke ink-retiring">
          {strokeContent(cue, index, lx, ly, reduced)}
        </g>
      ))}
      {live.map(({ cue, index }) => (
        <g key={`ink-${index}`} className="ink-stroke">
          {strokeContent(cue, index, lx, ly, reduced)}
        </g>
      ))}
    </svg>
  );
}

// Inner artwork for one stroke (no key — the caller wraps it in a keyed
// <g>). Shared by live and retiring renders so both show identical ink.
function strokeContent(
  cue: SceneCue,
  index: number,
  lx: (x: number) => number,
  ly: (y: number) => number,
  reduced: boolean,
) {
  const { dx, dy } = wobble(index);
  // Faint offset echo doubles as the hand-drawn wobble — a second
  // pass 1.2px off at low opacity reads as marker bleed.
  switch (cue.kind) {
          case 'arrow': {
            const d = arrowPath(lx(cue.x) + dx, ly(cue.y) + dy, lx(cue.x2 ?? cue.x) + dx, ly(cue.y2 ?? cue.y) + dy);
            // Land pulse anchor — the head tip in window-local coords.
            const tipX = lx(cue.x2 ?? cue.x) + dx;
            const tipY = ly(cue.y2 ?? cue.y) + dy;
            return (
              <g className="ink-stroke">
                <path d={d} className="ink-under" pathLength={1} style={{ strokeWidth: 5 + UNDER_EXTRA }} />
                <path d={d} className="ink-draw" pathLength={1} stroke={INK_AMBER} style={{ strokeWidth: 5 }} />
                {/* The echo must sit 1.2px off like circle/box — on the
                    identical path it's an invisible no-op, not a bleed. */}
                <path d={d} className="ink-echo" pathLength={1} stroke={INK_AMBER} style={{ strokeWidth: 5 }} transform="translate(1.2 1.2)" />
                {/* Reduced motion skips the pulse node itself — CSS alone
                    would still flash it for one frame before hiding it. */}
                {!reduced && <circle cx={tipX} cy={tipY} r={7} className="ink-land" />}
              </g>
            );
          }
          case 'circle': {
            const rx = Math.max(cue.w ?? 40, 4);
            const ry = Math.max(cue.h ?? 40, 4);
            return (
              <g className="ink-stroke">
                <ellipse cx={lx(cue.x) + dx} cy={ly(cue.y) + dy} rx={rx} ry={ry} className="ink-under" pathLength={1} style={{ strokeWidth: 5 + UNDER_EXTRA }} />
                <ellipse cx={lx(cue.x) + dx} cy={ly(cue.y) + dy} rx={rx} ry={ry} className="ink-draw" pathLength={1} stroke={INK_RED} style={{ strokeWidth: 5 }} />
                <ellipse cx={lx(cue.x) + dx + 1.2} cy={ly(cue.y) + dy + 1.2} rx={rx} ry={ry} className="ink-echo" pathLength={1} stroke={INK_RED} style={{ strokeWidth: 5 }} />
              </g>
            );
          }
          case 'box': {
            const w = Math.max(cue.w ?? 80, 8);
            const h = Math.max(cue.h ?? 48, 8);
            return (
              <g className="ink-stroke">
                <rect x={lx(cue.x) + dx} y={ly(cue.y) + dy} width={w} height={h} rx={10} className="ink-under" pathLength={1} style={{ strokeWidth: 4 + UNDER_EXTRA }} />
                <rect x={lx(cue.x) + dx} y={ly(cue.y) + dy} width={w} height={h} rx={10} className="ink-draw" pathLength={1} stroke={INK_AMBER} style={{ strokeWidth: 4 }} />
                <rect x={lx(cue.x) + dx + 1.2} y={ly(cue.y) + dy + 1.2} width={w} height={h} rx={10} className="ink-echo" pathLength={1} stroke={INK_AMBER} style={{ strokeWidth: 4 }} />
              </g>
            );
          }
          case 'hilite': {
            const w = Math.max(cue.w ?? 120, 8);
            const h = Math.max(cue.h ?? 28, 8);
            // Hilite pops with a quick fade, not a draw-on — a marker
            // swipe has no single pen path to animate.
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
            const d = smoothPath(pts);
            return (
              <g className="ink-stroke">
                <path d={d} className="ink-under" pathLength={1} style={{ strokeWidth: 4 + UNDER_EXTRA }} />
                <path d={d} className="ink-draw" pathLength={1} stroke={INK_AMBER} style={{ strokeWidth: 4 }} />
                <path d={d} className="ink-echo" pathLength={1} stroke={INK_AMBER} style={{ strokeWidth: 4 }} transform="translate(1.2 1.2)" />
              </g>
            );
          }
          case 'write': {
            const rows = wrapWriteLines(cue.text ?? '');
            const wx = lx(cue.x) + dx;
            const wy = ly(cue.y) + dy;
            return (
              <text
                x={wx}
                y={wy}
                className="ink-write ink-write-reveal"
              >
                {rows.map((row, ri) => (
                  <tspan key={ri} x={wx} dy={ri === 0 ? 0 : '1.25em'}>
                    {row}
                  </tspan>
                ))}
              </text>
            );
          }
          default:
            return null;
  }
}
