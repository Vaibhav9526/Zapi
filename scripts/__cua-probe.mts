/**
 * M0 probe (throwaway): does the in-process SDK load under our node, and
 * what is the real tool surface? Nothing is spawned, nothing is clicked.
 *
 *   bun scripts/__cua-probe.mts
 */
import { CuaDriver } from '@trycua/cua-driver';

let pass = 0;
let fail = 0;
const ok = (c: boolean, n: string, x?: unknown) => {
  if (c) { pass++; console.log('OK  ', n); } else { fail++; console.log('FAIL', n, x ?? ''); }
};

try {
  const driver = CuaDriver.create({ claudeCodeCompatibility: false });
  ok(!!driver, 'CuaDriver.create() returned an object');
  ok(driver.isAvailable() === true, 'isAvailable()', driver.isAvailable());
  console.log('executionMode:', driver.executionMode());
  console.log('socketPath:', JSON.stringify(driver.socketPath()));
  const meta = await driver.metadata();
  console.log('metadata:', JSON.stringify(meta).slice(0, 400));

  const tools = await driver.listToolsJson();
  const parsed = JSON.parse(tools) as unknown;
  const names: string[] = Array.isArray(parsed)
    ? parsed.map((t) => String((t as { name?: string }).name ?? t))
    : ((parsed as { tools?: Array<{ name?: string }> }).tools ?? []).map((t) => t.name ?? '');
  console.log('tool count:', names.length);
  console.log('tool names:', names.join(', '));

  const wins = await driver.listWindows({});
  console.log('windows:', wins.windows.length);
  for (const w of wins.windows.slice(0, 5)) {
    console.log('  ', w.appName, '|', String(w.title).slice(0, 40), '| pid', w.pid, '| hwnd', String(w.windowId), '| onscreen', w.isOnScreen, '| min', w.minimized);
  }
  const apps = await driver.listApps({});
  console.log('apps:', apps.apps.length, apps.apps.slice(0, 6).map((a) => `${a.name}${a.running ? '' : ' (stopped)'}`).join(', '));
} catch (err) {
  fail++;
  console.log('FAIL create/probe threw:', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
}
console.log(`\n${pass} ok, ${fail} failed`);
