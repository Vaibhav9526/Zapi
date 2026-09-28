'use client';

import { useEffect, useRef, useState } from 'react';
import { Win } from './Win';

const DEMOS = [
  {
    id: 'talk',
    file: 'zapi-talk.mp4',
    src: '/demos/clicky-fl.mp4',
    label: 'talk',
    caption: 'press the hotkey, ask out loud',
  },
  {
    id: 'see',
    file: 'zapi-sees.mp4',
    src: '/demos/clicky-spatial.mp4',
    label: 'see',
    caption: 'it sees what you see',
  },
  {
    id: 'draw',
    file: 'zapi-draws.mp4',
    src: '/demos/heyclicky-draw.mp4',
    label: 'draw',
    caption: 'it draws the answer on your screen',
  },
  {
    id: 'agent',
    file: 'zapi-agent.mp4',
    src: '/demos/usecase.mp4',
    label: 'agent',
    caption: 'say “zapi agent” and it does the task',
  },
] as const;

/**
 * Hero demo window: tabbed player for the four Zapi demo clips.
 * Autoplays muted + looping; pauses for prefers-reduced-motion
 * (controls shown instead so the clip is still playable).
 */
export function HeroVideo() {
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLVideoElement | null>(null);
  const demo = DEMOS[active];

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.load();
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      if (mq.matches) {
        el.controls = true;
        el.loop = false;
        el.pause();
      } else {
        el.controls = false;
        el.loop = true;
        void el.play().catch(() => {});
      }
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [active]);

  return (
    <Win title={demo.file} className="video-win" flush>
      <div className="demo-tabs" role="tablist" aria-label="demo videos">
        {DEMOS.map((d, i) => (
          <button
            key={d.id}
            role="tab"
            aria-selected={i === active}
            className={`demo-tab${i === active ? ' on' : ''}`}
            onClick={() => setActive(i)}
          >
            {d.label}
          </button>
        ))}
      </div>
      <video
        key={demo.src}
        ref={ref}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        aria-label={`Zapi demo: ${demo.caption}`}
      >
        <source src={demo.src} type="video/mp4" />
      </video>
      <div className="demo-caption">
        <span className="demo-dot" aria-hidden="true" />
        {demo.caption}
      </div>
    </Win>
  );
}
