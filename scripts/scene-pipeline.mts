/**
 * Scene/agent pipeline smoke test — exercises parseScene + parseAgentActions
 * on a realistic tagged model response against a fake 2-display capture set.
 *
 * Fake topology (both shots captured at 2x downscale):
 *   screen0: primary  1920x1080 @ x=0     — screenshot image 960x540
 *   screen1: secondary 2560x1440 @ x=1920 — screenshot image 1280x720
 *
 * Asserts cue ORDER (tag order is replay order), per-cue screenIndex,
 * display-space coordinate mapping (scale + display origin), and that
 * step/total numbering applies to 'point' cues only.
 *
 * Run: bun scripts/scene-pipeline.mts   (exit 1 on any failure)
 */

import { parseScene, parseAgentActions } from '../src/main/services/element-detector';
import type { ScreenCapture } from '../src/shared/types';

const screenshots: ScreenCapture[] = [
  {
    dataBase64: '',
    displayId: 1,
    imageWidth: 960,
    imageHeight: 540,
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    isCursorScreen: true,
  },
  {
    dataBase64: '',
    displayId: 2,
    imageWidth: 1280,
    imageHeight: 720,
    displayBounds: { x: 1920, y: 0, width: 2560, height: 1440 },
    isCursorScreen: false,
  },
];

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const approx = (a: number, b: number) => Math.abs(a - b) < 0.01;

// ── parseScene ──────────────────────────────────────────────────────

const sceneText =
  'watch this — [ARROW:100,200:500,300:screen1:flow] ' +
  'the save button lives [POINT:640,380:Save:screen0] ' +
  'and check [BOX:50,50:200,100:screen1] this area ' +
  '[CIRCLE:300,150:40,30:screen0] ' +
  '[HILITE:10,10:100,50:screen1:there] ' +
  '[PATH:0,0;100,100;200,50:screen0] ' +
  '[WRITE:700,600:screen1:done] ' +
  '[CLEAR] then [POINT:10,20:OK:screen0] ' +
  'plus a bad [BOX:1,1:2,2:screen9] tag';

console.log('parseScene');
const scene = parseScene(sceneText, screenshots);
check('scene parsed', scene !== null);
const cues = scene?.cues ?? [];

check('cue count (bad-screen tag dropped)', cues.length === 9, `got ${cues.length}`);
check(
  'cue order matches tag order',
  JSON.stringify(cues.map((c) => c.kind)) ===
    JSON.stringify(['arrow', 'point', 'box', 'circle', 'hilite', 'path', 'write', 'clear', 'point']),
  cues.map((c) => c.kind).join(','),
);
check(
  'per-cue screenIndex',
  JSON.stringify(cues.map((c) => c.screenIndex)) === JSON.stringify([1, 0, 1, 0, 1, 0, 1, 0, 0]),
  cues.map((c) => c.screenIndex).join(','),
);

const [arrow, pt1, box, circle, hilite, path, write, clear, pt2] = cues;

// display-space mapping: shot px * 2 + display origin
check('arrow mapped to display 2 space',
  !!arrow && approx(arrow.x, 2120) && approx(arrow.y, 400) &&
  approx(arrow.x2 ?? -1, 2920) && approx(arrow.y2 ?? -1, 600) && arrow.text === 'flow',
  JSON.stringify(arrow));
check('point mapped on display 1', !!pt1 && approx(pt1.x, 1280) && approx(pt1.y, 760) && pt1.text === 'Save');
check('box size scaled', !!box && approx(box.x, 2020) && approx(box.y, 100) && approx(box.w ?? -1, 400) && approx(box.h ?? -1, 200));
check('circle radii scaled', !!circle && approx(circle.x, 600) && approx(circle.y, 300) && approx(circle.w ?? -1, 80) && approx(circle.h ?? -1, 60));
check('hilite mapped', !!hilite && approx(hilite.x, 1940) && approx(hilite.y, 20) && hilite.text === 'there');
check('path points mapped', !!path && path.points?.length === 3 &&
  approx(path.points[2].x, 400) && approx(path.points[2].y, 100));
check('write anchor + text', !!write && approx(write.x, 3320) && approx(write.y, 1200) && write.text === 'done');
check('clear cue', !!clear && clear.kind === 'clear');

// step/total only on point cues, numbered among themselves
check('point cues numbered 1..2 among themselves',
  pt1?.step === 1 && pt1?.total === 2 && pt2?.step === 2 && pt2?.total === 2,
  `pt1=${pt1?.step}/${pt1?.total} pt2=${pt2?.step}/${pt2?.total}`);
check('non-point cues carry no step/total',
  cues.filter((c) => c.kind !== 'point').every((c) => c.step === undefined && c.total === undefined));

// ── parseAgentActions ───────────────────────────────────────────────

console.log('parseAgentActions');
const actions = parseAgentActions(
  '[ACT:click:960,540:screen1] [ACT:wait:200] [ACT:done:opened]',
  screenshots,
);
check('action count', actions.length === 3, `got ${actions.length}`);
check('action order', JSON.stringify(actions.map((a) => a.kind)) === JSON.stringify(['click', 'wait', 'done']));
check('click mapped to display 2 space',
  !!actions[0] && approx(actions[0].x ?? -1, 3840) && approx(actions[0].y ?? -1, 1080) && actions[0].screenIndex === 1,
  JSON.stringify(actions[0]));
check('wait amount', actions[1]?.amount === 200);
check('done text', actions[2]?.text === 'opened');

// ── summary ─────────────────────────────────────────────────────────

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll checks passed');
