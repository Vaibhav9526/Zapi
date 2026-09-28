/**
 * Contract check for prompts.ts — the system prompts are the third leg
 * of the tag DSL (shared/types.ts shapes + element-detector.ts regexes
 * must move with these strings), so the load-bearing lines are pinned
 * here instead of trusted to a review read.
 *
 * Pinned:
 *  - BASE_PROMPT's must-point rule ("names anything the user can see →
 *    you MUST point") — without it the cursor sits parked while the
 *    reply describes on-screen things;
 *  - the POINT→TYPE ordering and per-step pointing rules;
 *  - AGENT_PROMPT's point-before-click hint ("the click lands exactly
 *    where you point" → aim for the element center);
 *  - buildSystemPrompt composition: mode swap, app-guide injection,
 *    web-search note, tone.
 *
 * Pure string checks — runs under any runner:
 *   bunx tsx scripts/prompt-check.mts   (or: bun scripts/prompt-check.mts)
 */
import {
  BASE_PROMPT,
  AGENT_PROMPT,
  WEB_SEARCH_NOTE,
  TONE_STYLES,
  buildSystemPrompt,
} from '../src/main/services/prompts';

let pass = 0;
let fail = 0;
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

// ── BASE_PROMPT: the must-point language ────────────────────────────────
{
  check(BASE_PROMPT.includes('POINT FIRST'), 'base: POINT FIRST section exists');
  check(
    BASE_PROMPT.includes('the user can see') && BASE_PROMPT.includes('MUST point'),
    "base: 'names anything the user can see' → 'MUST point' requirement",
  );
  check(
    BASE_PROMPT.includes('emits no [POINT:') && BASE_PROMPT.includes('failed reply'),
    'base: a screen-describing reply with no point is called a failed reply',
  );
  // Ordering: cursor lands on the field before the text is offered.
  check(
    /\[POINT:[^\]]*\][^\n]*\[TYPE:/.test(BASE_PROMPT) ||
      BASE_PROMPT.includes('emit a [POINT:') ,
    'base: POINT-before-TYPE ordering is documented',
  );
  check(
    BASE_PROMPT.includes('per step') || BASE_PROMPT.includes('one [POINT:'),
    'base: sequential guides get one point per step',
  );
}

// ── AGENT_PROMPT: point-before-click + the closed rules ─────────────────
{
  check(
    AGENT_PROMPT.includes('where you point') && AGENT_PROMPT.includes('center'),
    'agent: point-before-click hint — aim center, click lands where you point',
  );
  check(
    AGENT_PROMPT.includes('[ACT:move:x,y:screenN]'),
    'agent: hover (ACT:move) exists as the non-click pointing action',
  );
  check(
    AGENT_PROMPT.includes('[ACT:done:summary]') && AGENT_PROMPT.includes('[ACT:fail:reason]'),
    'agent: terminal actions documented',
  );
  check(
    AGENT_PROMPT.includes('[MEMO:') && AGENT_PROMPT.includes('AGENTS.md'),
    'agent: memo/workspace contract is in the prompt',
  );
}

// ── buildSystemPrompt composition ───────────────────────────────────────
{
  const talk = buildSystemPrompt('friendly', { hasWebSearch: false });
  const agent = buildSystemPrompt('concise', {
    hasWebSearch: true,
    mode: 'agent',
    appGuide: { app: 'vscode', text: 'keyboard-first' },
  });
  check(talk.includes(BASE_PROMPT) && !talk.includes('drive their mouse'),
    'compose: talk mode carries BASE_PROMPT, not the agent DSL');
  check(agent.includes(AGENT_PROMPT), 'compose: agent mode carries AGENT_PROMPT');
  check(
    talk.includes(TONE_STYLES.friendly) && agent.includes(TONE_STYLES.concise),
    'compose: the chosen tone rides at the end',
  );
  check(
    agent.includes('Focused app: vscode') && !talk.includes('Focused app:'),
    'compose: app guide injects in agent mode only',
  );
  check(
    agent.includes(WEB_SEARCH_NOTE) && !talk.includes(WEB_SEARCH_NOTE),
    'compose: web-search note is opt-in',
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
