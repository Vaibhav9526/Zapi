import type { CSSProperties, ReactElement } from 'react';

/**
 * Inline line-icon set in the SF-Symbols idiom.
 *
 * Drawn, not licensed: SF Symbols may not be redistributed outside Apple
 * platforms, and a webfont of it would be the same problem with extra
 * bytes. So every glyph here is hand-authored geometry on a 24×24 grid —
 * ~1.5px round-capped strokes, no fills, `currentColor` throughout so an
 * icon inherits whatever the row it sits in is painted (macOS sidebar
 * semantics: one accent color for the active row, muted for the rest).
 *
 * Zero dependencies, per AGENTS.md. `size` scales the box; the stroke
 * stays 1.5 user units so a 14px icon doesn't turn spindly and a 28px one
 * doesn't turn chunky.
 */

export type IconName =
  | 'home'
  | 'sliders'
  | 'ear'
  | 'mic'
  | 'waveform'
  | 'chat'
  | 'sparkle';

export interface IconProps {
  name: IconName;
  /** Rendered box in px. Default 18 — the sidebar row height. */
  size?: number;
  /** Override the 1.5 line weight (rarely needed). */
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
  /**
   * Accessible name. Omitted (the default) the SVG is `aria-hidden`,
   * which is what an icon inside a labelled button wants; pass a title
   * for an icon that stands alone.
   */
  title?: string;
}

/**
 * Glyphs, each a fragment of sibling elements so multi-part marks (the
 * sliders' knobs, the ear's canal) share one stroke pass.
 */
const GLYPHS: Record<IconName, ReactElement> = {
  // House: roof ridge + walls, with the wall line stopping at the eaves.
  home: (
    <>
      <path d="M3.5 10.6 12 3.8l8.5 6.8" />
      <path d="M5.6 9.4V19.4a.8.8 0 0 0 .8.8h11.2a.8.8 0 0 0 .8-.8V9.4" />
      <path d="M10 20.2v-4.4h4v4.4" />
    </>
  ),
  // Sliders: three rails with a knob each, the third one offset right so
  // the mark reads as settings rather than as an equalizer.
  sliders: (
    <>
      <path d="M3.5 7.2h6.2M15.4 7.2h5.1" />
      <circle cx="12.1" cy="7.2" r="2.3" />
      <path d="M3.5 12h3.2M12.3 12h8.2" />
      <circle cx="9" cy="12" r="2.3" />
      <path d="M3.5 16.8h9.3M18.1 16.8h2.4" />
      <circle cx="15.2" cy="16.8" r="2.3" />
    </>
  ),
  // Ear: outer helix, the canal's inner curve, and the lobe.
  ear: (
    <>
      <path d="M8.4 9.1a3.7 3.7 0 1 1 7.4 0c0 1.9-1.3 2.8-2.2 3.8-.7.8-1 1.4-1 2.3a2.6 2.6 0 0 1-5.2.1" />
      <path d="M11.2 9.3a1.5 1.5 0 0 1 3 0c0 .9-.7 1.3-1.1 2" />
    </>
  ),
  // Mic: capsule, pickup arc, stem and base.
  mic: (
    <>
      <rect x="9.2" y="3.2" width="5.6" height="9.6" rx="2.8" />
      <path d="M5.9 11.4a6.1 6.1 0 0 0 12.2 0" />
      <path d="M12 17.6v3.2" />
      <path d="M9 20.8h6" />
    </>
  ),
  // Waveform: one continuous envelope, so it reads as audio over time
  // rather than as a row of equalizer bars.
  waveform: (
    <>
      <path d="M2.8 12h2.4l1.9-5.6 3 11.2 2.7-8.4 1.8 4.2 1.5-1.4h4.3" />
    </>
  ),
  // Chat bubble: rounded body with a tail on the lower left.
  chat: (
    <>
      <path d="M4.2 7.4A2.9 2.9 0 0 1 7.1 4.5h9.8a2.9 2.9 0 0 1 2.9 2.9v5.4a2.9 2.9 0 0 1-2.9 2.9H10l-4.6 3.7a.5.5 0 0 1-.8-.4v-3.3a2.9 2.9 0 0 1-.4-1.3z" />
      <path d="M8.2 9.2h7.6M8.2 12.4h4.6" />
    </>
  ),
  // Sparkle: the four-point star the assistant pill and the app icon both
  // use, with concave sides so it stays a sparkle and not a diamond.
  sparkle: (
    <>
      <path d="M12 3.2c.85 4.2 2.05 5.4 6.2 6.2-4.15.8-5.35 2-6.2 6.2-.85-4.2-2.05-5.4-6.2-6.2 4.15-.8 5.35-2 6.2-6.2z" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  strokeWidth = 1.5,
  className,
  style,
  title,
}: IconProps): ReactElement {
  const labelled = typeof title === 'string' && title.length > 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      // Chromium won't focus an svg by default; spell it out so a
      // keyboard user doesn't land on an unlabelled decoration.
      focusable="false"
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      aria-label={labelled ? title : undefined}
    >
      {labelled ? <title>{title}</title> : null}
      {GLYPHS[name]}
    </svg>
  );
}

export default Icon;
