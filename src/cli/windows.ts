// Finds open Cursor windows (each one writes a small file) and sends them requests.
import * as fs from "node:fs";
import * as path from "node:path";
import { PROOF_HEADER, WindowInfo, getWindowsFolder, toComparablePath } from "../shared/common";

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Open windows, newest first. Files left behind by closed windows are removed. */
export function listWindows(): WindowInfo[] {
  if (!fs.existsSync(getWindowsFolder())) return [];
  const windows: WindowInfo[] = [];
  for (const name of fs.readdirSync(getWindowsFolder())) {
    const file = path.join(getWindowsFolder(), name);
    try {
      const info: WindowInfo = JSON.parse(fs.readFileSync(file, "utf8"));
      if (isProcessRunning(info.pid)) windows.push(info);
      else fs.rmSync(file, { force: true });
    } catch {
      // A window may be writing the file right now; skip it this time.
    }
  }
  return windows.sort((a, b) => b.startedAt - a.startedAt);
}

/** The window whose open folder contains the file. The deepest folder wins. */
export function findWindowForFile(filePath: string, windows: WindowInfo[]): WindowInfo | undefined {
  const file = toComparablePath(filePath);
  let best: { window: WindowInfo; length: number } | undefined;
  for (const window of windows) {
    for (const folder of window.folders) {
      const comparableFolder = toComparablePath(folder);
      const isInside = file === comparableFolder || file.startsWith(comparableFolder.endsWith(path.sep) ? comparableFolder : comparableFolder + path.sep);
      if (isInside && (!best || comparableFolder.length > best.length)) best = { window, length: comparableFolder.length };
    }
  }
  return best?.window;
}

/** Windows that already sent back their proof in this run. */
const checkedWindows = new Set<WindowInfo>();

export async function callWindow<T>(window: WindowInfo, method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
  if (typeof window.proof !== "string") throw new Error("This Cursor window runs an older agent-diff extension. Restart Cursor.");
  // Ask first with a request that carries no file text, so text only goes to the real window.
  if (body !== undefined && !checkedWindows.has(window)) await callWindow(window, "GET", "/status");
  const response = await fetch(`http://127.0.0.1:${window.port}${route}`, {
    method,
    headers: { authorization: `Bearer ${window.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (response.headers.get(PROOF_HEADER) !== window.proof) {
    throw new Error(`Port ${window.port} is not the Cursor window that wrote its window file. Restart Cursor if this keeps happening.`);
  }
  checkedWindows.add(window);
  const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error((result as { error?: string }).error ?? `HTTP ${response.status}`);
  return result as T;
}
