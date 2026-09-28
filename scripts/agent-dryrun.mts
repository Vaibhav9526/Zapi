/**
 * Dry-run proof for src/main/services/agent-driver.ts.
 *
 * Runs a deliberately inert action sequence through runAgentActions:
 * nudge the cursor +80px, move it back, wait, done. Exercises the
 * lazy nut-js load path, the display-space→physical coordinate
 * scaling, and the executed/failed reporting — without clicking or
 * typing anything.
 *
 * Run:  bun scripts/agent-dryrun.mts
 * Exits 0 when the batch completes and every action executed;
 * exits 1 when nut-js is missing or any action failed.
 */
import { runAgentActions } from '../src/main/services/agent-driver';
import type { AgentAction, ScreenCapture } from '../src/shared/types';

// Fabricated single-display capture. The actions only need the
// screenIndex/displayId fields for the scaleFactor lookup.
const fakeCapture: ScreenCapture = {
  dataBase64: '',
  displayId: 0,
  imageWidth: 1600,
  imageHeight: 900,
  displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  isCursorScreen: true,
};

// Probe the native module directly so "unavailable" is reported as a
// finding instead of silently degrading every action below.
let cx = 960;
let cy = 540;
try {
  const nut = await import('@nut-tree-fork/nut-js');
  const pos = await nut.mouse.getPosition();
  cx = Math.round(pos.x);
  cy = Math.round(pos.y);
  console.log(`nut-js loaded — cursor currently at ${cx},${cy}`);
} catch (err) {
  console.log('nut-js native module unavailable:', err);
}

const actions: AgentAction[] = [
  { kind: 'move', x: cx + 80, y: cy, screenIndex: 0 },
  { kind: 'move', x: cx, y: cy, screenIndex: 0 },
  { kind: 'wait', amount: 100 },
  { kind: 'done', text: 'ok' },
];

const result = await runAgentActions(actions, [fakeCapture], {
  onAction: (a) => console.log(`hook → ${a.kind}: ${a.label}`),
});

console.log('result:', JSON.stringify(result, null, 2));

const clean = !result.failed && result.executed.every((l) => !l.includes('failed'));
console.log(clean ? 'PASS agent dry run' : 'FAIL agent dry run');
process.exit(clean ? 0 : 1);
