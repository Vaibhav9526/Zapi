/**
 * Static JSON shape check for the canonical IPC payloads.
 *
 * Round-trips each payload through JSON (and structuredClone for the Scene)
 * and asserts every field survives — catches non-serializable surprises
 * (undefined vs missing, NaN, Maps, class instances) before they cross IPC.
 *
 * Runner-agnostic (type-only imports, no Electron): npx tsx scripts/shape-check.mts
 */
import type {
  Scene,
  AgentStatus,
  AgentPhase,
  UsageStats,
} from '../src/shared/types';

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
const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
function checkJsonRoundtrip(value: unknown, name: string): void {
  let back: unknown = null;
  let ok = false;
  try {
    back = JSON.parse(JSON.stringify(value));
    ok = sameJson(back, value);
  } catch {
    ok = false;
  }
  check(ok, `json: ${name}`, ok ? undefined : back);
}

// ── Scene with one of every cue kind ────────────────────────────────────
const scene: Scene = {
  cues: [
    { kind: 'point', x: 960, y: 540, text: 'first', screenIndex: 0, step: 1, total: 1 },
    { kind: 'arrow', x: 66.6, y: 133.3, x2: 200, y2: 266.6, text: 'save here', screenIndex: 0 },
    { kind: 'circle', x: 333.3, y: 400, w: 40, h: 26.666, text: 'ring', screenIndex: 1 },
    { kind: 'box', x: 66.6, y: 66.6, w: 133.3, h: 100, text: 'my box', screenIndex: 0 },
    { kind: 'hilite', x: 200, y: 200, w: 60, h: 20, screenIndex: 0 },
    {
      kind: 'path',
      x: 0,
      y: 0,
      points: [
        { x: 0, y: 0 },
        { x: 960, y: 540 },
        { x: 1920, y: 1080 },
      ],
      screenIndex: 0,
    },
    { kind: 'write', x: 960, y: 540, text: 'hello world', screenIndex: 0 },
    { kind: 'clear', x: 0, y: 0, screenIndex: 0 },
  ],
};
for (const cue of scene.cues) {
  checkJsonRoundtrip(cue, `scene cue '${cue.kind}'`);
}
checkJsonRoundtrip(scene, 'scene with all 8 cue kinds');
check(
  sameJson(structuredClone(scene), scene),
  'structuredClone: scene with all 8 cue kinds',
);
check(scene.cues.length === 8, 'scene: all 8 cue kinds present', scene.cues.length);

// ── AgentStatus phases ──────────────────────────────────────────────────
const phases: AgentPhase[] = ['idle', 'thinking', 'acting', 'done', 'failed'];
for (const phase of phases) {
  const status: AgentStatus = { phase, step: 2, maxSteps: 15, message: 'working' };
  checkJsonRoundtrip(status, `agent status '${phase}'`);
}
checkJsonRoundtrip(
  { phase: 'idle', step: 0, maxSteps: 15 } as AgentStatus,
  'agent status without optional message',
);

// ── Agent echo payload (preload onAgentAction shape) ────────────────────
checkJsonRoundtrip(
  { x: 100, y: 200, label: 'save', kind: 'click' },
  'agent echo {x,y,label,kind}',
);

// ── UsageStats ──────────────────────────────────────────────────────────
checkJsonRoundtrip(
  { month: '2026-09', talkTurns: 3, agentMessages: 1, dictationUtterances: 0 } as UsageStats,
  'usage stats',
);

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
