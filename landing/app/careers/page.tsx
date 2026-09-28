import type { Metadata } from 'next';
import Link from 'next/link';
import { DesktopIcons } from '../components/DesktopIcons';
import { Taskbar } from '../components/Taskbar';
import { Win } from '../components/Win';
import { Mark } from '../components/Mark';
import { TextFileIcon } from '../components/Icons';

const OG_TITLE = 'ZAPI — an ai buddy that lives on your pc';
const OG_DESC = 'press the hotkey, zapi sees your screen, draws the answer, or does the task';

export const metadata: Metadata = {
  title: 'zapi — careers',
  description: 'Join the tiny team building a computer companion for Windows.',
  openGraph: {
    title: OG_TITLE,
    description: OG_DESC,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: OG_TITLE,
    description: OG_DESC,
  },
};

const ROLES = [
  {
    id: 'systems',
    title: 'founding engineer — systems (rust/electron)',
    points: [
      'own the windows desktop app: hotkeys, overlays, screen capture, agent input control',
      'rust + electron, performance-obsessed, pixels matter',
      'ship weekly, talk to users, fix what’s actually broken',
    ],
  },
  {
    id: 'design',
    title: 'founding designer — motion',
    points: [
      'own how zapi feels: draw-on-screen overlays, ripples, walkthroughs, the buddy itself',
      'motion-first — every arrow, highlight and agent click should read instantly',
      'prototype in code, sweat the 60fps details on real windows hardware',
    ],
  },
] as const;

export default function CareersPage() {
  return (
    <>
      <DesktopIcons />
      <main>
        <section className="section" id="top">
          <h2 className="sec-head">careers</h2>
          <p className="sec-sub">zapi is a tiny team building a computer companion for windows.</p>
          <Win title="careers.txt" icon={<TextFileIcon />} width="760px" className="faq center">
            <details open>
              <summary>why join?</summary>
              <p>
                we’re a tiny team making the pc feel alive — a buddy that sees your screen,
                draws answers on it, and does tasks for you. small crew, big surface area,
                everything you ship lands in front of real users fast.
              </p>
            </details>
            {ROLES.map((r) => (
              <details key={r.id} open>
                <summary>{r.title}</summary>
                <ul className="log-list">
                  {r.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </details>
            ))}
            <details open>
              <summary>remote + how to apply</summary>
              <p>
                both roles are remote — async-first, overlapping a few hours for the stuff
                that needs a call. write to{' '}
                <a href="mailto:hello@zapi">hello@zapi</a> with what you’ve built and which
                role you want; show, don’t tell.
              </p>
            </details>
          </Win>
          <p className="back-home">
            <Link href="/"><Mark className="back-mark" /> back to zapi.exe</Link>
          </p>
        </section>

        <footer>
          <div className="foot-links">
            <Link href="/">Home</Link>
            <Link href="/changelog">Changelog</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/#pricing">Pricing</Link>
            <Link href="/#faq">FAQ</Link>
          </div>
          <div className="foot-note">ZAPI · built for windows</div>
          <div className="kao" aria-hidden="true">( ˶ˆ ᗜ ˆ˵ )</div>
        </footer>
      </main>
      <Taskbar />
    </>
  );
}
