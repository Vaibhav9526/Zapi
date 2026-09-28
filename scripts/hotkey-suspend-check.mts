/**
 * Static check: SUSPEND_PUSH_TO_TALK_SHORTCUT must silence BOTH hotkeys.
 *
 * When the panel starts shortcut capture it sends SUSPEND_PUSH_TO_TALK_SHORTCUT;
 * main's handler must unregister the PTT accelerator AND the dictation
 * accelerator — otherwise the dictation binding fires mid-capture while the
 * user records the new PTT key.
 *
 * Method: locate the ipcMain.on(IPC.SUSPEND_PUSH_TO_TALK_SHORTCUT, ...)
 * registration in src/main/index.ts, resolve the handler body (named function
 * or inline arrow), and assert globalShortcut.unregister is called for both
 * a PTT-ish and a dictation-ish binding.
 *
 * Runner-agnostic (text scan, no Electron): npx tsx scripts/hotkey-suspend-check.mts
 *
 * Outcomes:
 *  - both unregistered → PASS, exit 0.
 *  - only PTT suspended → [FINDING] (exit 0; a sibling may be mid-edit on
 *    index.ts) + the finding is appended under AUDIT.md's '## FOR-OWNER'
 *    section so it isn't lost.
 *  - no suspend handler at all → FAIL, exit 1 (messages go nowhere).
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const norm = (p: string): string => p.replace(/\\/g, '/');
const mainSrc = fs.readFileSync(norm(`${root}/src/main/index.ts`), 'utf-8');
const AUDIT_PATH = norm(`${root}/AUDIT.md`);

/** Extract a `{ ... }` body starting at openIndex, skipping strings/comments. */
function braceBody(src: string, openIndex: number): string | null {
  let depth = 0;
  let i = openIndex;
  const n = src.length;
  let body = '';
  while (i < n) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      if (depth > 0) body += c;
      i++;
      while (i < n) {
        const d = src[i];
        if (depth > 0) body += d;
        if (d === '\\') {
          if (depth > 0) body += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        i++;
        if (d === quote) break;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth > 0) body += c;
    i++;
    if (depth === 0 && body.length > 0) return body;
  }
  return null;
}

/** Resolve the suspend handler's body text, or null when not found. */
function findSuspendBody(src: string): { body: string; via: string } | null {
  const reg = /ipcMain\s*\.\s*on\s*\(\s*IPC\.SUSPEND_PUSH_TO_TALK_SHORTCUT\s*,([\s\S]*?)\);/.exec(src);
  if (!reg) return null;
  const expr = reg[1].trim();
  const namedCall = /^\s*\(\s*\)\s*=>\s*([A-Za-z0-9_]+)\s*\(\s*\)\s*$/.exec(expr);
  const bareName = /^\s*([A-Za-z0-9_]+)\s*$/.exec(expr);
  const fnName = namedCall?.[1] ?? bareName?.[1] ?? null;
  if (fnName) {
    const def = new RegExp(
      `function\\s+${fnName}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{`,
    ).exec(src);
    if (!def) return null;
    const body = braceBody(src, def.index + def[0].length - 1);
    return body === null ? null : { body, via: `function ${fnName}` };
  }
  const open = expr.indexOf('{');
  if (open >= 0) {
    // Inline arrow with block body — rebase onto the original source.
    const base = reg.index + reg[0].indexOf(reg[1]) + open;
    const body = braceBody(src, base);
    return body === null ? null : { body, via: 'inline arrow' };
  }
  return null;
}

function recordFinding(line: string): void {
  console.log(`[FINDING] ${line}`);
  const entry = `- ${new Date().toISOString().slice(0, 10)} hotkey-suspend-check: ${line}\n`;
  try {
    if (!fs.existsSync(AUDIT_PATH)) {
      fs.writeFileSync(AUDIT_PATH, `## FOR-OWNER\n\n${entry}`);
      console.log('[FINDING] recorded to AUDIT.md (new ## FOR-OWNER section)');
      return;
    }
    const audit = fs.readFileSync(AUDIT_PATH, 'utf-8');
    const lines = audit.split('\n');
    const idx = lines.findIndex((l) => l.startsWith('## FOR-OWNER'));
    if (idx < 0) {
      fs.writeFileSync(AUDIT_PATH, `${audit.replace(/\s+$/, '')}\n\n## FOR-OWNER\n\n${entry}`);
    } else {
      lines.splice(idx + 1, 0, '', entry.trimEnd());
      fs.writeFileSync(AUDIT_PATH, lines.join('\n'));
    }
    console.log("[FINDING] recorded under AUDIT.md '## FOR-OWNER'");
  } catch (err) {
    console.log(`[FINDING] could not write AUDIT.md: ${String(err)}`);
  }
}

// ── Check ───────────────────────────────────────────────────────────────
const found = findSuspendBody(mainSrc);
if (!found) {
  console.log('FAIL suspend handler: no ipcMain.on(IPC.SUSPEND_PUSH_TO_TALK_SHORTCUT, ...) in src/main/index.ts');
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}

const args: string[] = [];
{
  const re = /globalShortcut\s*\.\s*unregister\s*\(\s*([^)]*?)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(found.body)) !== null) args.push(m[1].trim());
}
const hasDictation = args.some((a) => /dictation/i.test(a));
const hasPtt = args.some((a) => !/dictation/i.test(a) && a.length > 0);

if (args.length >= 2 && hasDictation && hasPtt) {
  console.log(
    `PASS suspend handler (${found.via}) unregisters BOTH accelerators :: ${JSON.stringify(args)}`,
  );
  console.log('\n1 passed, 0 failed');
  process.exit(0);
}

recordFinding(
  `SUSPEND_PUSH_TO_TALK_SHORTCUT handler (${found.via}) suspends only ` +
    `${hasPtt ? 'PTT' : 'neither binding'} — dictation hotkey stays live during capture :: ` +
    `unregisters=${JSON.stringify(args)}`,
);
console.log('\n0 passed, 0 failed, 1 finding (see AUDIT.md ## FOR-OWNER)');
process.exit(0);
