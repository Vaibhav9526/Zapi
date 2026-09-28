/**
 * Smoke test for artifact-store.ts.
 *
 * Bun-ONLY (uses the Bun.plugin electron stub):
 *   bun --preload ./scripts/store-preload.ts ./scripts/artifact-smoke.mts
 * Under any other runner it prints SKIP lines and exits 0 — the `electron`
 * import in the store cannot be satisfied without the bun preload stub,
 * and a skipped test must never masquerade as PASS.
 *
 * Covers:
 *  a) sanitizeFilename: path traversal collapses to the last segment
 *     ('..' never survives), forward/back slashes stripped, kebab names
 *     untouched, dotfiles un-hidden, Windows device names prefixed;
 *  b) writeArtifact: the resolved file stays inside artifactsDir even for
 *     hostile names, content lands verbatim, re-running the same name
 *     produces name-2 instead of overwriting;
 *  c) list: newest-first, per-agent + merged views, capped at 200;
 *  d) byId: cross-agent lookup, copy semantics, null for unknown ids;
 *  e) inferKind: csv→sheet, md→doc, png→image, ts→code, unknown→other —
 *     and writeArtifact stamps it end-to-end;
 *  f) seeded disk file: malformed rows filtered, order re-sorted.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

declare const Bun: unknown;

let pass = 0;
let fail = 0;
let skipped = 0;
function check(cond: boolean, name: string, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(
      `FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`,
    );
  }
}
function skip(name: string, reason: string): void {
  skipped++;
  console.log(`SKIP ${name} :: ${reason}`);
}

if (typeof Bun === 'undefined') {
  skip('artifacts: all cases', 'requires bun --preload electron stub');
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapi-artifact-smoke-'));
process.env.ZAPI_SMOKE_USERDATA = tmp;
const INDEX_FILE = 'zapi-artifacts.json';

// Seed the index BEFORE first import: one well-formed row + rows missing
// the fields the loader insists on, plus deliberate out-of-order
// createdAt values so the read-side newest-first sort is exercised.
fs.writeFileSync(
  path.join(tmp, INDEX_FILE),
  JSON.stringify({
    seeded: [
      {
        id: 'seed-old',
        agentId: 'seeded',
        title: 'old.csv',
        path: 'C:/tmp/old.csv',
        kind: 'sheet',
        createdAt: 1_000,
      },
      { id: 'seed-bad', agentId: 'seeded', title: 'no-path.csv' }, // no path
      { title: 'no-id.csv', path: 'C:/tmp/x.csv' }, // no id
      'garbage-row',
      {
        id: 'seed-new',
        agentId: 'seeded',
        title: 'new.csv',
        path: 'C:/tmp/new.csv',
        kind: 'sheet',
        createdAt: 9_000,
      },
    ],
  }),
);

const store = await import('../src/main/services/artifact-store');
const {
  sanitizeFilename,
  artifactsDir,
  writeArtifact,
  list,
  byId,
  add,
  inferKind,
  flushSync,
} = store;
const { outputDir, workspacesRoot } = await import('../src/main/services/agent-workspace');

// ── a) sanitizeFilename ────────────────────────────────────────────────
{
  const cases: Array<[string, string]> = [
    ['../../evil.csv', 'evil.csv'],
    ['..\\..\\evil.csv', 'evil.csv'],
    ['dir/sub/report.csv', 'report.csv'],
    ['a/b/../c.txt', 'c.txt'],
    ['..', 'untitled'],
    ['my-report-2026.csv', 'my-report-2026.csv'],
    ['sales data.csv', 'sales-data.csv'],
    ['.env', 'env'],
    ['CON.csv', 'file-CON.csv'],
    ['nul', 'file-nul'],
    ['!!!', 'untitled'],
    ['plain', 'plain'],
  ];
  for (const [raw, want] of cases) {
    check(sanitizeFilename(raw) === want, `sanitize: '${raw}' → '${want}'`, sanitizeFilename(raw));
  }
  check(
    sanitizeFilename('../deep/evil.csv').length <= 64 + 11,
    'sanitize: output stays length-capped',
    sanitizeFilename('../deep/evil.csv'),
  );
  check(
    !/[\\/]/.test(sanitizeFilename('../../x/y/z.txt')),
    'sanitize: no path separator survives',
    sanitizeFilename('../../x/y/z.txt'),
  );
}

// ── b) writeArtifact: stays inside the agent's workspace output/, verbatim content ─
{
  const agent = 'writer';
  // New writes land in the agent's workspace `output/` dir, next to its
  // AGENTS.md; `artifactsDir` is the LEGACY location kept for rows that
  // predate workspaces.
  const dir = outputDir(agent);
  check(
    dir === path.join(workspacesRoot(), agent, 'output'),
    'write: target is the workspace output/ dir, not the legacy artifacts dir',
    { dir, legacy: artifactsDir(agent) },
  );

  const a = writeArtifact(agent, '../../escape.csv', 'h1,h2\n1,2\n');
  check(
    path.dirname(path.resolve(a.path)) === path.resolve(dir),
    'write: traversal name resolves inside the workspace output dir',
    { path: a.path, dir },
  );
  check(
    path.basename(a.path) === 'escape.csv' && fs.readFileSync(a.path, 'utf-8') === 'h1,h2\n1,2\n',
    'write: last segment kept, content written verbatim',
    a.path,
  );
  check(
    a.agentId === agent && a.title === 'escape.csv' && a.kind === 'sheet' && a.size === 10,
    'write: metadata stamped (agentId/title/kind/size)',
    a,
  );

  const again = writeArtifact(agent, 'escape.csv', 'second\n');
  check(
    path.basename(again.path) === 'escape-2.csv' &&
      fs.readFileSync(again.path, 'utf-8') === 'second\n' &&
      fs.readFileSync(a.path, 'utf-8') === 'h1,h2\n1,2\n',
    'write: same name gets a -2 suffix instead of overwriting',
    { first: a.path, second: again.path },
  );

  const kebab = writeArtifact(agent, 'q4-sales-report.csv', 'x\n');
  check(
    path.basename(kebab.path) === 'q4-sales-report.csv',
    'write: kebab-case name passes through untouched',
    kebab.path,
  );
  check(
    !fs.existsSync(path.join(tmp, 'escape.csv')),
    'write: nothing leaked to the userData root',
  );
}

// ── c) list: newest-first, per-agent + merged, cap 200 ─────────────────
{
  // 'cap' agent: 205 adds → only 200 listed, newest first.
  for (let i = 0; i < 205; i++) {
    add({
      agentId: 'cap',
      title: `f${i}.txt`,
      path: `C:/a/f${i}.txt`,
      kind: 'doc',
      createdAt: i, // increasing — newest is i=204
    });
  }
  const capped = list('cap');
  check(
    capped.length === 200 && capped[0].createdAt === 204 && capped[199].createdAt === 5,
    'list: capped at 200, newest-first',
    { len: capped.length, first: capped[0]?.createdAt, last: capped[199]?.createdAt },
  );

  // Per-agent isolation + merged view across agents.
  const merged = list();
  check(
    merged.filter((x) => x.agentId === 'cap').length === 200 &&
      merged.filter((x) => x.agentId === 'writer').length === 3 &&
      merged.filter((x) => x.agentId === 'seeded').length === 2,
    'list: merged view spans agents without double counting',
    { total: merged.length },
  );
  check(
    list('nobody').length === 0,
    'list: unknown agent reads empty, not an error',
  );
}

// ── d) byId: cross-agent hit, copy semantics, null miss ────────────────
{
  const made = writeArtifact('lookup', 'findme.md', '# hi\n');
  const hit = byId(made.id);
  check(
    hit !== null && hit.id === made.id && hit.title === 'findme.md' && hit.agentId === 'lookup',
    'byId: finds an artifact recorded under its agent',
    hit,
  );
  if (hit) {
    hit.title = 'mutated';
    check(
      byId(made.id)?.title === 'findme.md',
      'byId: returns a copy — caller mutation cannot corrupt the index',
    );
  }
  check(byId('does-not-exist') === null, 'byId: unknown id is null, not a throw');
}

// ── e) inferKind: extension table + end-to-end stamp ───────────────────
{
  const cases: Array<[string, string]> = [
    ['data.csv', 'sheet'],
    ['BOOK.XLSX', 'sheet'],
    ['notes.md', 'doc'],
    ['paper.pdf', 'doc'],
    ['shot.png', 'image'],
    ['icon.SVG', 'image'],
    ['main.ts', 'code'],
    ['conf.json', 'code'],
    ['setup.ps1', 'code'],
    ['archive.zip', 'other'],
    ['noext', 'other'],
  ];
  for (const [name, want] of cases) {
    check(inferKind(name) === want, `inferKind: '${name}' → '${want}'`, inferKind(name));
  }
  const w = writeArtifact('kinds', 'metrics.tsv', 'a\tb\n');
  check(w.kind === 'sheet', 'inferKind: writeArtifact stamps kind from the sanitized name', w);
}

// ── f) seeded file: malformed rows dropped, order re-sorted ────────────
{
  const seeded = list('seeded');
  check(
    seeded.length === 2 && seeded[0].id === 'seed-new' && seeded[1].id === 'seed-old',
    'disk: malformed rows filtered, hand-ordered file re-sorted newest-first',
    seeded.map((s) => s.id),
  );
}

// ── g) hostile filenames through writeArtifact: never throws ───────────
// sanitizeFilename's table above is the unit level; this drives the same
// names end-to-end, because the promise the turn pipeline relies on is
// that `writeArtifact` returns an Artifact for ANY filename the model can
// emit — Windows device names, 4 kB names, unicode, empty, dots-only.
//
// Each case gets its own agent id (= its own artifacts dir) on purpose:
// several of these names sanitize to the same output, and Windows paths
// are case-insensitive, so a shared directory would make the -2 collision
// suffix look like a failure. Collision handling is asserted separately,
// at the end of this section.
{
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  // [label, filename, expected basename on disk]
  const cases: Array<[string, string, string]> = [
    ['windows device name + ext', 'CON.txt', 'file-CON.txt'],
    ['windows device name bare', 'aux', 'file-aux'],
    ['nul with ext', 'nul.txt', 'file-nul.txt'],
    ['com1 with ext', 'com1.log', 'file-com1.log'],
    ['lpt9 bare', 'LPT9', 'file-LPT9'],
    ['prn with ext', 'PRN.md', 'file-PRN.md'],
    ['device name, trailing space', 'AUX ', 'file-AUX'],
    ['device name whose ext is unusable', 'con.csv ', 'file-con'],
    ['4 kB name', 'L'.repeat(4096) + '.txt', 'L'.repeat(64) + '.txt'],
    ['200-char stem', 'a'.repeat(200) + '.csv', 'a'.repeat(64) + '.csv'],
    ['over-long extension dropped', `${'a'.repeat(200)}.${'b'.repeat(50)}`, 'a'.repeat(64)],
    ['non-ascii stem keeps the ext', '预算表.csv', 'untitled.csv'],
    ['accented stem', 'résumé.csv', 'r-sum.csv'],
    ['emoji stem', '🎉.txt', 'untitled.txt'],
    ['empty name', '', 'untitled'],
    ['single dot', '.', 'untitled'],
    ['dotdot', '..', 'untitled'],
    ['dots only', '...', 'untitled'],
    ['leading dot (hidden file)', '.hidden', 'hidden'],
    ['whitespace only', '   ', 'untitled'],
    ['extension only', '.csv', 'csv'],
    ['windows path', 'C:\\Windows\\System32\\config\\SAM', 'SAM'],
    ['nul byte in name', 'a\u0000b.txt', 'a-b.txt'],
    ['newline in name', 'a\nb.txt', 'a-b.txt'],
  ];
  cases.forEach(([label, name, expected], i) => {
    const agentId = `edge${i}`;
    const dir = outputDir(agentId);
    let artifact: ReturnType<typeof writeArtifact> | null = null;
    let threw: string | null = null;
    try {
      artifact = writeArtifact(agentId, name, `body of ${label}\n`);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    const base = artifact ? path.basename(artifact.path) : '';
    check(
      threw === null && artifact !== null && base === expected,
      `write: ${label} → '${expected.slice(0, 24)}${expected.length > 24 ? '…' : ''}' (no throw)`,
      threw ?? base,
    );
    check(
      artifact !== null &&
        artifact.path === path.join(dir, expected) &&
        fs.existsSync(artifact.path) &&
        fs.readFileSync(artifact.path, 'utf-8') === `body of ${label}\n`,
      `write: ${label} lands verbatim inside its agent dir`,
      artifact?.path,
    );
    check(
      base.length <= 80 &&
        !base.startsWith('.') &&
        !/[. ]$/.test(base) &&
        !/[\\/:*?"<>|\u0000-\u001f]/.test(base) &&
        !reserved.test(base.split('.')[0]),
      `write: ${label} produced a well-formed, non-reserved name`,
      base,
    );
    check(
      artifact !== null && artifact.agentId === agentId && artifact.title === base,
      `write: ${label} recorded under its own agent`,
      artifact,
    );
  });

  // The same name twice must not clobber the first file, even when the
  // name is device-shaped: the -2 suffix is derived from the sanitized
  // name, not from the raw one.
  const dup1 = writeArtifact('dupes', 'CON.txt', 'first');
  const dup2 = writeArtifact('dupes', 'CON.txt', 'second');
  const dup3 = writeArtifact('dupes', 'con.TXT', 'third');
  check(
    dup1.path !== dup2.path && path.basename(dup2.path) === 'file-CON-2.txt' &&
      fs.readFileSync(dup1.path, 'utf-8') === 'first',
    'write: device-name collision suffixes instead of overwriting',
    [dup1.path, dup2.path],
  );
  check(
    new Set([dup1.path.toLowerCase(), dup2.path.toLowerCase(), dup3.path.toLowerCase()]).size === 3,
    'write: case-variant device names each get their own file (case-insensitive fs)',
    [dup1.path, dup2.path, dup3.path],
  );
}

// ── flushSync persists the index ────────────────────────────────────────
{
  flushSync();
  let onDisk: Record<string, unknown[]> | null = null;
  try {
    onDisk = JSON.parse(fs.readFileSync(path.join(tmp, INDEX_FILE), 'utf-8'));
  } catch {
    onDisk = null;
  }
  check(
    onDisk !== null &&
      Array.isArray(onDisk.cap) &&
      onDisk.cap.length === 200 &&
      Array.isArray(onDisk.lookup) &&
      onDisk.lookup.length === 1,
    'flush: zapi-artifacts.json on disk matches the capped index',
    onDisk ? Object.keys(onDisk) : onDisk,
  );
}

// Best-effort temp cleanup; never fails the run.
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
