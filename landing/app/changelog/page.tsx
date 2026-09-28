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
  title: 'zapi — changelog',
  description: 'What shipped in Zapi, newest first. Windows · free.',
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

const ENTRIES = [
  {
    v: 'v1.1.0',
    date: '2026-09-18',
    name: 'polish',
    items: [
      'agent echo ripples — every agent click lands with a visible ripple so you can follow along',
      'adaptive always-on VAD — the mic opens only while you’re actually speaking, quieter idle, snappier wake',
      'fish audio voices — new voice options for talk-back, alongside the existing providers',
      'smoother draw-on-screen overlays and faster hotkey wake on Windows',
    ],
  },
  {
    v: 'v1.0.0',
    date: '2026-08-02',
    name: 'first flight',
    items: [
      'talk — press the hotkey, ask out loud, get an answer back',
      'on-screen drawing — arrows, boxes, labels and highlights drawn right where you’re looking',
      'agent mode — say “zapi agent” and it takes the mouse + keyboard to do the task',
      'dictation — speak and zapi types wherever your cursor is',
      'always-on buddy that lives on your desktop, Windows only for now',
    ],
  },
] as const;

export default function ChangelogPage() {
  return (
    <>
      <DesktopIcons />
      <main>
        <section className="section" id="top">
          <h2 className="sec-head">changelog</h2>
          <p className="sec-sub">what shipped in zapi, newest first.</p>
          <Win title="changelog.txt" icon={<TextFileIcon />} width="760px" className="faq center">
            {ENTRIES.map((e) => (
              <details key={e.v} open={e.v === 'v1.1.0'}>
                <summary>
                  {e.v} · {e.name} <span className="log-date">{e.date}</span>
                </summary>
                <ul className="log-list">
                  {e.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </details>
            ))}
          </Win>
          <p className="back-home">
            <Link href="/"><Mark className="back-mark" /> back to zapi.exe</Link>
          </p>
        </section>

        <footer>
          <div className="foot-links">
            <Link href="/">Home</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/careers">Careers</Link>
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
