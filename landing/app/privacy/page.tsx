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
  title: 'zapi — privacy',
  description: 'How Zapi handles your screen, your keys, and your chats. Private by default.',
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

export default function PrivacyPage() {
  return (
    <>
      <DesktopIcons />
      <main>
        <section className="section" id="top">
          <h2 className="sec-head">privacy</h2>
          <p className="sec-sub">private by default — here’s exactly what that means.</p>
          <Win title="privacy.txt" icon={<TextFileIcon />} width="760px" className="faq center">
            <details open>
              <summary>when is my screen captured?</summary>
              <p>
                only when you press the hotkey — that’s the whole trigger. if you turn on
                always-on mode, the mic still only listens while you’re speaking, and a
                screenshot is only taken at the moment you ask something.
              </p>
            </details>
            <details>
              <summary>where do screenshots go?</summary>
              <p>
                screenshots are sent to whichever model provider you chose, as context for
                that one answer — and never stored by us. there is no zapi server keeping
                copies; once the answer is back, the image is gone.
              </p>
            </details>
            <details>
              <summary>where do my api keys live?</summary>
              <p>
                in your OS credential store — DPAPI on Windows. they’re encrypted at rest on
                your own machine and never leave it except in the calls you configure,
                straight to the providers you picked.
              </p>
            </details>
            <details>
              <summary>where is my chat history?</summary>
              <p>
                on your machine, in the app’s local storage. long conversations compact into
                a summary so a single chat can keep going — all of it stays local.
              </p>
            </details>
            <details>
              <summary>can i delete everything?</summary>
              <p>
                anytime. clear chat history from inside the app, revoke keys from your OS
                credential store, or uninstall — there’s no account and no server-side copy
                to chase down.
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
