// Command-line entry point. Agents call `snapshot` before an edit and `show` after it.
import * as fs from "node:fs";
import * as path from "node:path";
import { DiffInfo, PATCH_VERSION, ShowResult, WindowStatus, toComparablePath } from "../shared/common";
import { findCursorApp, installExtension, installPatch, readPatchState, uninstallExtension, uninstallPatch } from "./patcher";
import { deleteAllSnapshots, deleteOldSnapshots, deleteSnapshot, readFileForSnapshot, readSnapshot, saveSnapshot } from "./snapshots";
import { callWindow, findWindowForFile, listWindows } from "./windows";

const HELP = `agent-diff: show any agent's edits as Cursor inline diffs (Keep / Undo).

For agents:
  agent-diff snapshot <file>...        Run before editing: save the files as they are now
  agent-diff show <file>... [--open]   Run after editing: show the changes in Cursor
  agent-diff clear [<file>...]         Stop showing diffs and forget snapshots (all when no file)
  agent-diff list                      List the inline diffs in open Cursor windows

Setup:
  agent-diff install [--cursor <folder>] [--extensions-dir <folder>] [--skip-extension]
  agent-diff uninstall [--cursor <folder>] [--extensions-dir <folder>] [--skip-extension]
  agent-diff status [--cursor <folder>]

snapshot, show and clear never fail the agent: problems are printed as warnings and the exit code is 0.
Add --quiet to print warnings only.
Add --stdin to take the file from an agent hook's JSON on stdin (the "file_path", "filePath",
"path" or "notebook_path" field, inside "tool_input" when there is one), e.g. for Claude Code hooks.
Scripts can send {"cwd": "...", "files": ["a.ts", "b.ts"]} to --stdin instead of passing file names.`;

interface Options {
  files: string[];
  open: boolean;
  quiet: boolean;
  readStdin: boolean;
  skipExtension: boolean;
  cursorFolder?: string;
  extensionsFolder?: string;
}

function parseArguments(args: string[]): Options {
  const options: Options = { files: [], open: false, quiet: false, readStdin: false, skipExtension: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const takeValue = () => {
      const value = args[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value.`);
      return value;
    };
    if (arg === "--open") options.open = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--stdin") options.readStdin = true;
    else if (arg === "--skip-extension") options.skipExtension = true;
    else if (arg === "--cursor") options.cursorFolder = takeValue();
    else if (arg === "--extensions-dir") options.extensionsFolder = takeValue();
    else if (arg.startsWith("--")) throw new UsageError(`Unknown option ${arg}.`);
    else options.files.push(toFullPath(arg));
  }
  return options;
}

class UsageError extends Error {}

/** Absolute path with the real letter case on Windows, so Cursor matches it to the open editor. */
function toFullPath(file: string): string {
  const fullPath = path.resolve(file);
  try {
    return fs.realpathSync.native(fullPath);
  } catch {
    return fullPath;
  }
}

const HOOK_PATH_FIELDS = ["file_path", "filePath", "path", "notebook_path"];

/**
 * File paths from an agent hook's JSON, e.g. Claude Code's
 * {"cwd": "...", "tool_input": {"file_path": "..."}}, or a list: {"cwd": "...", "files": [...]}.
 * Relative paths are taken from "cwd". Scripts should send paths this way rather than as
 * arguments, so a file name never passes through a shell.
 */
function readFilesFromHookInput(): string[] {
  let input: any;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    warn("--stdin: could not read JSON from stdin.");
    return [];
  }
  const toolInput = input?.tool_input ?? input;
  const baseFolder = typeof input?.cwd === "string" ? input.cwd : process.cwd();
  const fileList: unknown[] = Array.isArray(input?.files) ? input.files : [];
  return [...HOOK_PATH_FIELDS.map((field) => toolInput?.[field]), ...fileList]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((file) => toFullPath(path.resolve(baseFolder, file)));
}

let isQuiet = false;
const say = (message: string) => { if (!isQuiet) console.log(message); };
const warn = (message: string) => console.error(`warning: ${message}`);
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function takeSnapshots(files: string[]): Promise<void> {
  deleteOldSnapshots();
  const windows = listWindows();
  for (const file of files) {
    const current = readFileForSnapshot(file);
    if ("skipReason" in current) {
      warn(`skipped ${file}: ${current.skipReason}`);
      continue;
    }
    if (readSnapshot(file) && (await isEarlierChangeStillPending(file, windows))) {
      say(`kept earlier snapshot: ${file}`);
      continue;
    }
    saveSnapshot(current);
    say(`saved snapshot: ${file}`);
  }
}

/**
 * Keep the earlier snapshot while its changes are still waiting for Keep / Undo in Cursor,
 * or were never shown, so several agent edits show up as one diff.
 */
async function isEarlierChangeStillPending(file: string, windows: ReturnType<typeof listWindows>): Promise<boolean> {
  const window = findWindowForFile(file, windows);
  if (!window) return true;
  try {
    const diffs = await callWindow<DiffInfo[]>(window, "POST", "/list");
    return diffs.some((diff) => toComparablePath(diff.path) === toComparablePath(file));
  } catch {
    return true;
  }
}

async function showChanges(files: string[], open: boolean): Promise<void> {
  const windows = listWindows();
  for (const file of files) {
    const snapshot = readSnapshot(file);
    if (!snapshot) {
      warn(`no snapshot for ${file}. Run "agent-diff snapshot" before the edit.`);
      continue;
    }
    const window = findWindowForFile(file, windows);
    if (!window) {
      warn(`no open Cursor window has a folder containing ${file}. The snapshot is kept for later.`);
      continue;
    }
    try {
      const original = snapshot.existed ? snapshot.content : null;
      const result = await callWindow<ShowResult>(window, "POST", "/show", { path: file, original, open });
      if (result.changed) {
        say(`shown in Cursor: ${file}`);
      } else {
        deleteSnapshot(file);
        say(`no changes: ${file}`);
      }
    } catch (error) {
      warn(`could not show ${file}: ${errorMessage(error)}`);
    }
  }
}

async function clearDiffs(files: string[]): Promise<void> {
  const windows = listWindows();
  if (files.length === 0) {
    const deletedCount = deleteAllSnapshots();
    let clearedCount = 0;
    for (const window of windows) {
      try {
        clearedCount += (await callWindow<{ cleared: number }>(window, "POST", "/clear", {})).cleared;
      } catch (error) {
        warn(`could not clear a Cursor window: ${errorMessage(error)}`);
      }
    }
    say(`cleared ${clearedCount} diff(s) and ${deletedCount} snapshot(s).`);
    return;
  }
  for (const file of files) {
    deleteSnapshot(file);
    const window = findWindowForFile(file, windows);
    if (!window) continue;
    try {
      await callWindow(window, "POST", "/clear", { path: file });
      say(`cleared: ${file}`);
    } catch (error) {
      warn(`could not clear ${file}: ${errorMessage(error)}`);
    }
  }
}

async function listDiffs(): Promise<void> {
  const windows = listWindows();
  if (windows.length === 0) console.log("No Cursor window with the extension is open.");
  for (const window of windows) {
    console.log(`Window: ${window.folders.join(", ") || "(no folder)"}`);
    try {
      const diffs = await callWindow<DiffInfo[]>(window, "POST", "/list");
      if (diffs.length === 0) console.log("  no inline diffs");
      for (const diff of diffs) console.log(`  ${diff.isOurs ? "this tool" : "Cursor   "}  ${diff.path}`);
    } catch (error) {
      console.log(`  ${errorMessage(error)}`);
    }
  }
}

async function printStatus(options: Options): Promise<void> {
  try {
    const app = findCursorApp(options.cursorFolder);
    const state = readPatchState(app);
    console.log(`Cursor ${app.version} at ${app.appFolder}`);
    console.log(state.patchVersion === null
      ? "  patch: not installed. Run: agent-diff install"
      : `  patch: version ${state.patchVersion}${state.patchVersion < PATCH_VERSION ? " (older; run install again)" : ""}`);
    if (state.isChecksumCorrect === false) console.log("  checksum: wrong, Cursor will say the install is corrupt. Run install again.");
  } catch (error) {
    console.log(errorMessage(error));
  }
  const windows = listWindows();
  console.log(windows.length === 0 ? "No Cursor window with the extension is open." : "Open windows:");
  for (const window of windows) {
    try {
      const status = await callWindow<WindowStatus>(window, "GET", "/status");
      const patch = status.patchVersion === null ? "patch not loaded (restart Cursor after install)" : `patch version ${status.patchVersion}`;
      console.log(`  ${status.folders.join(", ") || "(no folder)"}: ${patch}`);
    } catch (error) {
      console.log(`  ${window.folders.join(", ")}: not answering (${errorMessage(error)})`);
    }
  }
}

function printNextSteps(): void {
  const examplesFolder = path.join(__dirname, "..", "examples");
  console.log(`
Next steps:
  1. Restart Cursor (close every window).
  2. Run "agent-diff status" to check that it works.
  3. Make your agent call "agent-diff snapshot" before each edit and "agent-diff show" after it.
     Ready-made hooks for Claude Code and a plugin for OpenCode are in:
     ${examplesFolder}
After every Cursor update, close Cursor and run "agent-diff install" again.`);
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return 0;
  }
  const options = parseArguments(rest);
  isQuiet = options.quiet;
  const needsFiles = command === "snapshot" || command === "show";
  if (needsFiles && options.readStdin) {
    options.files.push(...readFilesFromHookInput());
    // A hook can fire for a tool that has no file. That is not an error.
    if (options.files.length === 0) return 0;
  }
  if (needsFiles && options.files.length === 0) throw new UsageError(`${command} needs at least one file.`);

  switch (command) {
    case "snapshot":
      await takeSnapshots(options.files);
      return 0;
    case "show":
      await showChanges(options.files, options.open);
      return 0;
    case "clear":
      await clearDiffs(options.files);
      return 0;
    case "list":
      await listDiffs();
      return 0;
    case "status":
      await printStatus(options);
      return 0;
    case "install": {
      const app = findCursorApp(options.cursorFolder);
      for (const line of installPatch(app)) console.log(line);
      if (!options.skipExtension) for (const line of installExtension(app, options.extensionsFolder)) console.log(line);
      printNextSteps();
      return 0;
    }
    case "uninstall": {
      const app = findCursorApp(options.cursorFolder);
      for (const line of uninstallPatch(app)) console.log(line);
      if (!options.skipExtension) for (const line of uninstallExtension(app, options.extensionsFolder)) console.log(line);
      return 0;
    }
    default:
      throw new UsageError(`Unknown command "${command}".`);
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${HELP}`);
      process.exitCode = 2;
    } else {
      const command = process.argv[2];
      console.error(errorMessage(error));
      // Agent-facing commands must never break the agent's run.
      process.exitCode = command === "snapshot" || command === "show" || command === "clear" ? 0 : 1;
    }
  },
);
