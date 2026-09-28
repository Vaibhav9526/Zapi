import { Mark } from './components/Mark';
import { HeroVideo } from './components/HeroVideo';
import { ShaderWordmark } from './components/ShaderWordmark';
import { Win } from './components/Win';
import { Taskbar } from './components/Taskbar';
import { DesktopIcons } from './components/DesktopIcons';
import { HeroClutter } from './components/HeroClutter';
import { Parallax } from './components/Parallax';
import { PointAt } from './components/PointAt';
import { MockListen, MockSee, MockSpeak, MockPoint } from './components/Mockups';
import {
  WinLogo,
  TextFileIcon,
  FolderIcon,
  InstallerIcon,
} from './components/Icons';

const REPO = 'https://github.com/pango07/flicky';
const RELEASES = `${REPO}/releases/latest`;

const STEPS = [
  {
    n: '01',
    t: 'talk.',
    d: 'press the hotkey and ask out loud. speech-to-text hears you, and a screenshot goes along so you never describe what’s on screen twice.',
    mock: <MockListen />,
  },
  {
    n: '02',
    t: 'it sees what you see.',
    d: 'zapi looks at the exact window you’re in — any app, any tool — and understands buttons, menus, errors and all.',
    mock: <MockSee />,
  },
  {
    n: '03',
    t: 'it draws the answer.',
    d: 'arrows, boxes, labels and highlights land right on your screen, so “click there” actually means something.',
    mock: <MockSpeak />,
  },
  {
    n: '04',
    t: 'or say “zapi agent”.',
    d: 'agent mode takes the mouse and keyboard and does the task for you — walking through apps step by step until it’s done.',
    mock: <MockPoint />,
  },
] as const;

const FEATURES = [
  {
    n: '01',
    file: 'talk.exe',
    t: 'talk',
    d: 'press the hotkey and just ask. it hears you, sees your screen, and talks back — no typing, no pasting screenshots.',
  },
  {
    n: '02',
    file: 'draw.exe',
    t: 'draw',
    d: 'answers arrive as arrows, boxes, labels and highlights drawn directly on your screen, pointing at the exact pixel.',
  },
  {
    n: '03',
    file: 'agent.exe',
    t: 'agent',
    d: 'say “zapi agent” and it takes over mouse + keyboard to do the task for you — multi-step walkthroughs included.',
  },
  {
    n: '04',
    file: 'dictate.txt',
    t: 'dictation',
    d: 'speak and zapi types it where you’re working — docs, chat, code, anywhere the cursor already is.',
  },
  {
    n: '05',
    file: 'always-on.log',
    t: 'always-on',
    d: 'a tiny buddy that lives on your desktop. one hotkey away, listening when you need it, quiet when you don’t.',
  },
  {
    n: '06',
    file: 'private.sys',
    t: 'private by default',
    d: 'your screen is only captured when you press the hotkey. screenshots are never stored — they’re just context for that answer.',
  },
] as const;

const PLANS = [
  {
    name: 'free',
    price: '$0',
    per: 'forever',
    blurb: 'try the buddy on your desktop.',
    feats: ['25 talk messages / mo', '25 agent messages / mo', 'draw-on-screen answers', 'windows app'],
    cta: 'get zapi',
    tag: 'early access',
    highlight: false,
  },
  {
    name: 'pro',
    price: '$20',
    per: '/ mo',
    blurb: 'for daily drivers.',
    feats: ['unlimited talk + dictation', '150 agent messages / mo', 'draw-on-screen answers', 'always-on listening', 'priority updates'],
    cta: 'get zapi pro',
    tag: 'coming soon',
    highlight: true,
  },
  {
    name: 'max',
    price: '$100',
    per: '/ mo',
    blurb: 'for power users + teams.',
    feats: ['everything in pro', '1,000 agent messages / mo', 'longest context + memory', 'early agent features'],
    cta: 'get zapi max',
    tag: 'coming soon',
    highlight: false,
  },
] as const;

const MARQUEE = [
  'press the hotkey',
  'it sees what you see',
  'it draws on your screen',
  '“zapi agent” does it for you',
  'windows · free',
  'private by default',
];

function MarqueeRun({ k }: { k: string }) {
  return (
    <span className="marq-run">
      {MARQUEE.map((m) => (
        <span key={`${k}-${m}`}>
          {m}
          <i>✦</i>
        </span>
      ))}
    </span>
  );
}

export default function Page() {
  return (
    <>
      <DesktopIcons />
      <main>
        {/* ---------------------------------------------------------- hero */}
        <section className="hero" id="top">
          <div className="stage">
            <Parallax />
            <HeroClutter />

            <div className="hero-copy">
              <p className="eyebrow">windows · free</p>
              <ShaderWordmark text="zapi" />
              <p className="lead">an ai buddy that lives on your pc.</p>
              <p className="sub">
                press the hotkey and it sees what you see; ask out loud and it draws the
                answer right on your screen, or say “zapi agent” and it does the task for you.
              </p>
              <div className="cta">
                <a
                  className="btn primary"
                  id="cta-win"
                  href={RELEASES}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <WinLogo className="btn-glyph" />
                  get zapi
                </a>
                <a className="btn ghost" href="#how">
                  watch it work
                </a>
              </div>
              <p className="tiny">windows · free · private by default</p>
            </div>

            <PointAt target="#cta-win" label="click here!" delay={1200} />
          </div>

          <div className="hero-video" id="demos">
            <HeroVideo />
          </div>
        </section>

        {/* -------------------------------------------------- how it works */}
        <section className="section how" id="how">
          <h2 className="sec-head">how it works</h2>
          <div className="rows">
            {STEPS.map((s, i) => (
              <div className={`row${i % 2 ? ' flip' : ''}`} key={s.n}>
                <div className="row-win">
                  <Win title={`step-${s.n}`} icon={<Mark />}>
                    {s.mock}
                  </Win>
                </div>
                <div className="row-say">
                  <span className="chip">
                    <Mark className="chip-mark" />
                    zapi
                  </span>
                  <div className="bubble">
                    <h3>
                      <span className="row-n">{s.n}</span> {s.t}
                    </h3>
                    <p>{s.d}</p>
                  </div>
                </div>
                {s.n === '04' ? (
                  <PointAt target=".dialog-title" label="this one!" side="left" />
                ) : null}
              </div>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------ marquee */}
        <div className="marq" aria-hidden="true">
          <div className="marq-track">
            <MarqueeRun k="a" />
            <MarqueeRun k="b" />
          </div>
        </div>

        {/* ------------------------------------------------------ features */}
        <section className="section" id="features">
          <h2 className="sec-head">what you get</h2>
          <div className="feat-grid">
            {FEATURES.map((f) => (
              <Win key={f.file} title={f.file} icon={<TextFileIcon />} className="feat">
                <span className="feat-n">{f.n}</span>
                <h3>{f.t}</h3>
                <p>{f.d}</p>
              </Win>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------ pricing */}
        <section className="section" id="pricing">
          <h2 className="sec-head">pricing</h2>
          <p className="sec-sub">start free. upgrade when you live in it. billing is early-access — reserve your seat.</p>
          <div className="price-grid">
            {PLANS.map((p) => (
              <Win
                key={p.name}
                title={`${p.name}.plan`}
                icon={<TextFileIcon />}
                className={`price${p.highlight ? ' hot' : ''}`}
              >
                <span className="price-tag">{p.tag}</span>
                <h3 className="price-name">{p.name}</h3>
                <p className="price-amount">
                  {p.price}
                  <span>{p.per}</span>
                </p>
                <p className="price-blurb">{p.blurb}</p>
                <ul className="price-feats">
                  {p.feats.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                <a
                  className={`btn sm${p.highlight ? ' primary' : ' ghost'}`}
                  href={RELEASES}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {p.cta}
                </a>
              </Win>
            ))}
          </div>
        </section>

        {/* ----------------------------------------------------- get zapi */}
        <section className="section" id="get">
          <div className="getcard">
            <span className="free-tag">windows · free</span>
            <h2>get zapi.</h2>
            <p className="get-sub">
              one installer for windows. press the hotkey and it sees what you see.
            </p>
            <div className="dl-grid single">
              <Win title="Zapi-Setup.exe" icon={<InstallerIcon />} className="dl-win">
                <div className="dl-os">windows</div>
                <div className="dl-detail">x64 + arm64 · one installer</div>
                <a
                  className="btn primary sm"
                  id="dl-windows"
                  href={RELEASES}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <WinLogo className="btn-glyph" />
                  download
                </a>
              </Win>
              <Win title="readme.txt" icon={<FolderIcon />} className="dl-win">
                <div className="dl-os small">mac + linux?</div>
                <div className="dl-detail">windows only for now — other platforms later</div>
                <a className="btn ghost sm" href="#faq">
                  read the faq
                </a>
              </Win>
            </div>
            <p className="get-keys">
              screenshots are only captured when you press the hotkey, and never stored.
              bring your own keys or sign in — either way, your screen stays yours.
            </p>
            <PointAt target="#dl-windows" label="over here!" />
          </div>
        </section>

        {/* ----------------------------------------------------- questions */}
        <section className="section" id="faq">
          <h2 className="sec-head">questions</h2>
          <Win title="questions.txt" icon={<TextFileIcon />} width="760px" className="faq center">
            <details>
              <summary>what is zapi?</summary>
              <p>
                zapi is an ai buddy that lives on your pc. press the hotkey and it sees what
                you see; ask out loud and it draws the answer right on your screen — or say
                “zapi agent” and it does the task for you.
              </p>
            </details>
            <details>
              <summary>is my screen private?</summary>
              <p>
                yes — your screen is only captured when you press the hotkey. screenshots are
                never stored; they’re just context for that one answer and then they’re gone.
              </p>
            </details>
            <details>
              <summary>what can it do?</summary>
              <p>
                it teaches any tool, walks you through tasks step by step, draws arrows, boxes,
                labels and highlights on your screen, runs agents that click and type for you,
                and dictates text wherever your cursor is.
              </p>
            </details>
            <details>
              <summary>talk vs agents — what’s the difference?</summary>
              <p>
                talk is ask-and-answer: you ask, zapi explains and draws on screen. agents go
                further — “zapi agent” takes the mouse and keyboard and completes the task for
                you, narrating as it goes.
              </p>
            </details>
            <details>
              <summary>which apps does it work with?</summary>
              <p>
                anything visible on your screen — browsers, spreadsheets, IDEs, design tools,
                system settings. if you can see it, zapi can see it and point at it.
              </p>
            </details>
            <details>
              <summary>windows only?</summary>
              <p>
                windows only for now — that’s where the hotkey, overlay drawing, dictation and
                agent control are built and tested. mac and linux come later.
              </p>
            </details>
          </Win>
        </section>

        {/* -------------------------------------------------------- footer */}
        <footer>
          <div className="foot-links">
            <a href={REPO} target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href={`${REPO}/releases`} target="_blank" rel="noopener noreferrer">Releases</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
            <a href="/changelog">Changelog</a>
            <a href="/privacy">Privacy</a>
            <a href="/careers">Careers</a>
          </div>
          <div className="foot-note">ZAPI · built for windows</div>
          <div className="kao" aria-hidden="true">( ˶ˆ ᗜ ˆ˵ )</div>
        </footer>
      </main>
      <Taskbar />
    </>
  );
}
