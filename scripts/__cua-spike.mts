/**
 * M0 probe (throwaway, v3): isolate the two open questions —
 * verifyState predicate shape, and whether a FRESH element token clicks.
 * Cleanup is by exact launched pid, always.
 */
import {
  CuaDriver,
  ActionTarget,
  ClickPosition,
  ClickButton,
  InputDeliveryMode,
} from '@trycua/cua-driver';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const driver = CuaDriver.create({ claudeCodeCompatibility: false });
let pid: number | null = null;

try {
  const launched = await driver.callTool(
    'launch_app',
    JSON.stringify({ aumid: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' }),
  );
  const parsed = JSON.parse(launched.structuredJson || '{}') as {
    pid?: number; windows?: Array<{ window_id: number | string }>;
  };
  pid = typeof parsed.pid === 'number' ? parsed.pid : null;
  console.log('launched pid', pid, '| windows', JSON.stringify(parsed.windows ?? []));
  await sleep(800);

  const { windows } = await driver.listWindows({ pid: pid ?? undefined });
  const win = windows[0];
  if (!win?.pid) throw new Error('no window');
  const target = new ActionTarget.Window({ pid: win.pid, windowId: win.windowId });

  // 1) verify with the documented predicate shape.
  const v = await driver.verifyState({
    pid: BigInt(win.pid),
    windowId: win.windowId,
    expect: [{ window: { exists: true } }],
    timeoutMs: 1500n,
    stableSamples: 1n,
  });
  console.log('verify(exists):', { isError: v.isError, status: v.verification?.status, stable: v.verification?.stable, text: v.text.slice(0, 140) });

  // 2) element click with a token from a FRESH snapshot, taken right now.
  const fresh = await driver.getWindowState({
    pid: win.pid,
    windowId: win.windowId,
    includeAccessibilityTree: true,
    includeScreenshot: false,
    maxElements: 30,
  });
  const el = (fresh.elements ?? []).find((e) => e.elementToken && (e.actions ?? []).includes('text'))
    ?? (fresh.elements ?? []).find((e) => e.elementToken);
  console.log('picked element:', el?.role, JSON.stringify(String(el?.label ?? el?.value ?? '').slice(0, 30)), el?.elementToken ? 'token ok' : 'NO TOKEN');
  if (el?.elementToken) {
    try {
      const r = await driver.click({
        target,
        position: new ClickPosition.Element({ elementToken: el.elementToken }),
        deliveryMode: InputDeliveryMode.Background,
      });
      console.log('element click OK:', { effect: r.effect, route: r.route, delivery: r.delivery });
    } catch (err) {
      console.log('element click THREW:', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    }
  }

  // 3) is the app still alive after the element click?
  const after = await driver.listWindows({ pid: win.pid });
  console.log('windows after element click:', after.windows.length);

  // 4) per-pid background typing (the M1 'type into notepad' gate).
  const t = await driver.typeText({ text: 'zapi m0', target });
  console.log('typeText:', { isError: t.isError, effect: t.action?.effect, route: t.action?.route, text: t.text.slice(0, 120) });

  // 5) px click last, so a re-snapshot can't invalidate the token we used.
  const px = await driver.click({
    target,
    position: new ClickPosition.Coordinates({ x: 100, y: 200 }),
    deliveryMode: InputDeliveryMode.Background,
    button: ClickButton.Left,
  });
  console.log('px click:', { effect: px.effect, route: px.route, delivery: px.delivery });
} catch (err) {
  console.log('PROBE ERROR:', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
} finally {
  if (pid !== null) {
    const k = await driver.callTool('kill_app', JSON.stringify({ pid }));
    console.log('kill_app ->', k.isError ? `ERR ${k.text.slice(0, 120)}` : k.text.slice(0, 80));
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      const still = await driver.listWindows({ pid });
      if (still.windows.length === 0) { console.log('gone after', (i + 1) * 300, 'ms'); break; }
      if (i === 9) console.log('STILL PRESENT:', still.windows.length);
    }
  }
  try { driver.shutdown(); } catch { /* ignore */ }
}
