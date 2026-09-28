import * as electron from 'electron';

/**
 * Native auto-typer wrapper. The underlying module (`@nut-tree-fork/nut-js`)
 * ships native bindings for libnut and emits global keyboard events through
 * the OS. We load it lazily so a failed install doesn't crash the main
 * process — every consumer goes through `typeText`, which returns `false`
 * if the module or the required permission is unavailable, and the caller
 * falls back to clipboard handoff.
 */

type NutJs = typeof import('@nut-tree-fork/nut-js');

let nutJs: NutJs | null = null;
let loadAttempted = false;

async function load(): Promise<NutJs | null> {
  if (loadAttempted) return nutJs;
  loadAttempted = true;
  try {
    nutJs = await import('@nut-tree-fork/nut-js');
  } catch (err) {
    console.error('[Zapi] auto-typer native module unavailable:', err);
    nutJs = null;
    // Don't latch a transient failure (antivirus lock, dll still
    // extracting) — the next attempt retries the import.
    loadAttempted = false;
  }
  return nutJs;
}

/**
 * Whether the OS permission required for auto-typing is currently granted.
 * On macOS this is Accessibility (Input Monitoring is not enough — typing
 * keystrokes globally requires the Accessibility trust list). On other
 * platforms there is no equivalent gate.
 */
export function isAccessibilityGranted(): boolean {
  if (process.platform !== 'darwin') return true;
  return electron.systemPreferences.isTrustedAccessibilityClient(false);
}

/**
 * Surface the macOS Accessibility prompt and add Zapi to the trust
 * list. The user still has to enable the checkbox themselves; the OS
 * does not return a granted state until they do, but the dialog gives
 * them the discovery path.
 */
export function promptAccessibility(): boolean {
  if (process.platform !== 'darwin') return true;
  return electron.systemPreferences.isTrustedAccessibilityClient(true);
}

/**
 * Text keystroke-typing can't be trusted to reproduce: multi-line
 * content ('\n' arrives as Enter — which *sends* a chat message rather
 * than breaking the line) and anything outside ASCII (emoji, CJK,
 * accents — libnut's Unicode coverage is patchy on Windows). Those go
 * through the clipboard + synthetic paste: instant, exact, and it lands
 * newlines as real line breaks.
 */
function needsClipboardPaste(text: string): boolean {
  for (const ch of text) {
    // C0 controls (\n, \t, \r, and the rest that type weirdly anyway),
    // DEL, or anything non-ASCII → paste. Code-point loop instead of a
    // regex so we don't need a no-control-regex waiver.
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp >= 0x7f) return true;
  }
  return false;
}

/**
 * Type `text` into whatever the OS considers the focused element.
 * Returns true when the keys were sent successfully, false when the
 * caller should fall back to clipboard handoff (module missing,
 * permission missing, or libnut threw).
 */
export async function typeText(text: string): Promise<boolean> {
  if (!text) return false;
  const lib = await load();
  if (!lib) return false;
  if (!isAccessibilityGranted()) return false;
  try {
    // Default delay is fine for native apps; web inputs sometimes drop
    // characters at zero delay, but raising this hurts the "magical"
    // feel. If we see drops in practice we can bump to ~5–10ms.
    lib.keyboard.config.autoDelayMs = 0;
    if (needsClipboardPaste(text)) {
      const { Key } = lib;
      const modifier = process.platform === 'darwin' ? Key.LeftCmd : Key.LeftControl;
      // Dictation mutates the user's clipboard — stash + restore it so
      // paste-out doesn't silently clobber whatever they copied. The
      // restore waits a beat because the focused app reads the
      // clipboard asynchronously on some platforms.
      const previous = electron.clipboard.readText();
      electron.clipboard.writeText(text);
      await lib.keyboard.pressKey(modifier);
      await lib.keyboard.pressKey(Key.V);
      await lib.keyboard.releaseKey(Key.V);
      await lib.keyboard.releaseKey(modifier);
      const restore = previous;
      setTimeout(() => {
        try { electron.clipboard.writeText(restore); } catch { /* cosmetic — skip */ }
      }, 400);
      return true;
    }
    await lib.keyboard.type(text);
    return true;
  } catch (err) {
    console.error('[Zapi] auto-type failed:', err);
    return false;
  }
}
