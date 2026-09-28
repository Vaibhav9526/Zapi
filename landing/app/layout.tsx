import type { Metadata, Viewport } from 'next';
import { FlickyCursor } from './components/FlickyCursor';
import './globals.css';

export const metadata: Metadata = {
  title: 'zapi — an ai buddy that lives on your pc',
  description:
    'Press the hotkey and Zapi sees what you see; ask out loud and it draws the answer right on your screen, or say "zapi agent" and it does the task for you. Windows · free.',
  icons: { icon: '/favicon.svg' },
  openGraph: {
    title: 'ZAPI — an ai buddy that lives on your pc',
    description:
      'press the hotkey, zapi sees your screen, draws the answer, or does the task',
    url: 'https://github.com/pango07/flicky',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ZAPI — an ai buddy that lives on your pc',
    description:
      'press the hotkey, zapi sees your screen, draws the answer, or does the task',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#eef1f6' },
    { media: '(prefers-color-scheme: dark)', color: '#0f0f10' },
  ],
};

/* Runs before first paint so the right palette is on <html> immediately. */
const themeScript = `(function(){try{var t=localStorage.getItem('zapi-theme')||localStorage.getItem('flicky-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <FlickyCursor />
        {children}
      </body>
    </html>
  );
}
