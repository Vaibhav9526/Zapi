/**
 * Smoke test for suggestion-engine.ts + suggestion-store.ts.
 *
 * Engine cases (JSON salvage + generateSuggestions) are pure TypeScript
 * and run under any runner:  bunx tsx scripts/suggestion-smoke.mts
 * Store cases need the electron stub — run the whole file under bun for
 * full coverage:
 *   bun --preload ./scripts/store-preload.ts ./scripts/suggestion-smoke.mts
 * Under another runner the store cases print SKIP and exit 0 — a skipped
 * test must never masquerade as PASS.
 *
 * Covers:
 *  a) parseSuggestionJson tolerance: fenced blocks, prose-wrapped arrays,
 *     bare arrays, a lone object, trailing commas, smart quotes, alias
 *     keys, junk items dropped, cap honored, agentId always re-pinned;
 *  b) generateSuggestions: agents with no history skipped, per-agent
 *     completion failures swallowed, abort signal honored;
 *  c) summarizeChats / buildSuggestionPrompt: open-loop detection and
 *     prompt shape;
 *  d) store: add/list hides dismissed, dismiss permanence via listAll,
 *     per-agent isolation, scoped clear, malformed disk rows dropped.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseSuggestionJson,
  generateSuggestions,
  buildSuggestionPrompt,
  summarizeChats,
} from '../src/main/services/suggestion-engine';

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

const CARD = (title: string, task: string, extra = ''): string =>
  `{"title":"${title}","task":"${task}"${extra}}`;

// ── a) parseSuggestionJson: the model-reply salvage path ───────────────
{
  const bare = parseSuggestionJson(
    `[${CARD('water plants', 'water the plants')},${CARD('file taxes', 'start the tax filing')}]`,
    'main',
    { now: () => 1_700_000_000_000 },
  );
  check(
    bare.length === 2 && bare[0].title === 'water plants' && bare[1].task === 'start the tax filing',
    'parse: bare array yields cards',
    bare,
  );
  check(
    bare[0].agentId === 'main' && bare[0].dismissed === false &&
      typeof bare[0].id === 'string' && bare[0].createdAt === 1_700_000_000_000,
    'parse: cards stamped with agentId/id/createdAt/dismissed',
    bare[0],
  );

  const fenced = parseSuggestionJson(
    `sure! here you go:\n\`\`\`json\n[${CARD('a', 'do a')}]\n\`\`\`\nhope that helps`,
    'main',
  );
  check(fenced.length === 1 && fenced[0].task === 'do a', 'parse: fenced ```json block salvaged', fenced);

  const prose = parseSuggestionJson(
    `I think these make sense: [${CARD('b', 'do b')}] — let me know!`,
    'main',
  );
  check(prose.length === 1 && prose[0].title === 'b', 'parse: array inside prose salvaged', prose);

  const single = parseSuggestionJson(CARD('solo', 'do the solo thing'), 'main');
  check(single.length === 1 && single[0].task === 'do the solo thing', 'parse: lone object treated as one card', single);

  const trailing = parseSuggestionJson(
    `[${CARD('c', 'do c')},]`,
    'main',
  );
  check(trailing.length === 1, 'parse: trailing comma tolerated', trailing);

  const smart = parseSuggestionJson(
    '[{\u201ctitle\u201d:\u201cd\u201d,\u201ctask\u201d:\u201cdo d\u201d}]',
    'main',
  );
  check(smart.length === 1 && smart[0].title === 'd', 'parse: smart quotes normalized', smart);

  const alias = parseSuggestionJson(
    '[{"name":"aliased","instruction":"run it"}]',
    'main',
  );
  check(
    alias.length === 1 && alias[0].title === 'aliased' && alias[0].task === 'run it',
    'parse: name/instruction key aliases accepted',
    alias,
  );

  const junk = parseSuggestionJson(
    `[${CARD('ok', 'real task')},{"title":"no task"},{"task":"no title"},42,"nope"]`,
    'main',
  );
  check(
    junk.length === 1 && junk[0].title === 'ok',
    'parse: items lacking title or task dropped, scalars ignored',
    junk,
  );

  const wrongAgent = parseSuggestionJson(
    `[{"title":"x","task":"y","agentId":"somebody-else"}]`,
    'main',
  );
  check(
    wrongAgent.length === 1 && wrongAgent[0].agentId === 'main',
    'parse: hallucinated agentId re-pinned to the prompted agent',
    wrongAgent,
  );

  const capped = parseSuggestionJson(
    `[${CARD('1', 't1')},${CARD('2', 't2')},${CARD('3', 't3')}]`,
    'main',
    { capPerAgent: 2 },
  );
  check(capped.length === 2, 'parse: capPerAgent truncates the card list', capped);

  for (const [label, raw] of [
    ['empty', ''],
    ['empty array', '[]'],
    ['scalar array', '[1,2,3]'],
    ['prose only', 'no json here at all'],
  ] as const) {
    check(parseSuggestionJson(raw, 'main').length === 0, `parse: ${label} → []`, raw);
  }
}

// ── b) generateSuggestions: fan-out, skip/failure/abort behavior ───────
{
  let calls = 0;
  const cards = await generateSuggestions({
    agents: [{ id: 'main', name: 'Zapi' }, { id: 'quiet' }],
    recentChats: { main: [{ userText: 'how do I pivot a csv?' }] }, // 'quiet' has none
    complete: async () => {
      calls++;
      return `[${CARD('follow up', 'make a pivot table')}]`;
    },
    now: () => 5,
  });
  check(
    calls === 1 && cards.length === 1 && cards[0].agentId === 'main',
    'engine: agents without history are skipped — completion not called',
    { calls, cards },
  );

  const partial = await generateSuggestions({
    agents: [{ id: 'bad' }, { id: 'good' }],
    recentChats: {
      bad: [{ userText: 'x' }],
      good: [{ userText: 'y' }],
    },
    complete: async (prompt) => {
      if (prompt.includes('"bad"')) throw new Error('rate limited');
      return `[${CARD('g', 'good task')}]`;
    },
  });
  check(
    partial.length === 1 && partial[0].agentId === 'good',
    'engine: one agent’s failure leaves the others’ cards intact',
    partial,
  );

  const aborted = await generateSuggestions({
    agents: [{ id: 'main' }],
    recentChats: { main: [{ userText: 'x' }] },
    complete: async () => `[${CARD('z', 'z task')}]`,
    signal: AbortSignal.abort(),
  });
  check(aborted.length === 0, 'engine: aborted signal yields no cards', aborted);
}

// ── c) summarizeChats + buildSuggestionPrompt shape ────────────────────
{
  const { topics, openLoops } = summarizeChats([
    { userText: 'what is a pivot table?' },
    { userText: 'remind me to finish the report later' },
    { userText: 'ok thanks' },
  ]);
  check(
    topics.length === 3 && openLoops.length === 1 && openLoops[0].includes('remind me'),
    'summary: open-loop phrasing separated from plain topics',
    { topics, openLoops },
  );
  const prompt = buildSuggestionPrompt({ id: 'main', name: 'Scout' }, [
    { userText: 'how do I export a csv?' },
  ]);
  check(
    prompt.includes('"Scout"') && prompt.includes('json array') && prompt.includes('export a csv'),
    'prompt: names the agent, embeds chat, demands a JSON array',
    prompt.slice(0, 200),
  );
}

// ── d) suggestion-store: dismiss/list behavior (bun + electron stub) ───
if (typeof Bun === 'undefined') {
  skip('suggestions store: add/list/dismiss/clear', 'requires bun --preload electron stub');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapi-suggestion-smoke-'));
  process.env.ZAPI_SMOKE_USERDATA = tmp;
  // Malformed seed: a row missing `task` and a non-object must not load.
  fs.writeFileSync(
    path.join(tmp, 'zapi-suggestions.json'),
    JSON.stringify({
      main: [
        { id: 'seed-ok', agentId: 'main', title: 'old', task: 'old task', createdAt: 1, dismissed: false },
        { id: 'seed-bad', agentId: 'main', title: 'no task field' },
        42,
      ],
    }),
  );
  const store = await import('../src/main/services/suggestion-store');

  const s = store.add({ agentId: 'main', title: 'fresh', task: 'run fresh' });
  check(
    typeof s.id === 'string' && s.dismissed === false && typeof s.createdAt === 'number',
    'store: add stamps id/createdAt/dismissed',
    s,
  );

  const listed = store.list('main');
  check(
    listed.some((x) => x.id === s.id) && listed.some((x) => x.id === 'seed-ok') &&
      !listed.some((x) => (x as { id?: string }).id === 'seed-bad'),
    'store: list returns live cards, malformed seed rows dropped',
    listed.map((x) => x.id),
  );

  check(store.dismiss(s.id) === true, 'store: dismiss known id returns true');
  check(
    !store.list('main').some((x) => x.id === s.id) &&
      store.listAll('main').some((x) => x.id === s.id && x.dismissed === true),
    'store: dismissed card hides from list but stays in listAll',
  );
  check(store.dismiss('nope') === false, 'store: dismiss unknown id is false, not a throw');

  const other = store.add({ agentId: 'scout', title: 's', task: 'scout task' });
  check(
    store.list('scout').some((x) => x.id === other.id) &&
      !store.list('main').some((x) => x.id === other.id),
    'store: per-agent lists stay isolated',
  );
  check(
    store.list().some((x) => x.id === other.id),
    'store: merged list spans agents',
  );

  store.clear('main');
  check(
    store.list('main').length === 0 && store.listAll('main').length === 0 &&
      store.list('scout').length === 1,
    'store: clear(agentId) wipes only that agent, dismissed included',
  );
  store.flushSync();

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
