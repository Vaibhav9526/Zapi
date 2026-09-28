import { CuaDriver } from "@trycua/cua-driver";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const d = CuaDriver.create({ claudeCodeCompatibility: false });
const variants: Array<[string, string]> = [
  ["aumid", JSON.stringify({ aumid: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" })],
  ["bundle_id", JSON.stringify({ bundle_id: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" })],
  ["path-shell", JSON.stringify({ path: "shell:appsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" })],
  ["launch_path", JSON.stringify({ launch_path: "C:\\Windows\\System32\\notepad.exe" })],
  ["name-notepad", JSON.stringify({ name: "notepad" })],
];
const launched: number[] = [];
for (const [label, args] of variants) {
  const r = await d.callTool("launch_app", args);
  console.log(label, "->", r.isError ? "ERR " + r.text.slice(0, 130) : "OK " + r.text.slice(0, 200), "| structured", (r.structuredJson ?? "").slice(0, 200));
  if (!r.isError) {
    await sleep(1200);
    const { windows } = await d.listWindows({});
    const np = windows.filter((w) => /notepad/i.test(`${w.appName} ${w.title}`));
    for (const w of np) { console.log("   window:", w.appName, "|", w.title, "| pid", w.pid, "| hwnd", String(w.windowId)); if (typeof w.pid === "number") launched.push(w.pid); }
    if (np.length) break; // one is enough
  }
}
for (const p of new Set(launched)) {
  const k = await d.callTool("kill_app", JSON.stringify({ pid: p }));
  console.log("cleanup kill_app", p, "->", k.isError ? "ERR " + k.text.slice(0, 100) : "ok");
}