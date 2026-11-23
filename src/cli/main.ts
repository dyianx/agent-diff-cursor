// Command-line entry point. Agents call `snapshot` before an edit and `show` after it.
import * as fs from "node:fs";
import * as path from "node:path";
import { DiffInfo, PATCH_VERSION, ShowResult, WindowStatus, toComparablePath } from "../shared/common";
import { Scope, askAboutAgents, parseAgentNames, removeAgentSetup, setUpAgents } from "./agent-setup";
import { findFilesChangedByCommand, rememberFilesBeforeCommand } from "./git-changes";
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
                     [--agents <list>] [--scope global|project]
      Patch Cursor, then ask which agents should use agent-diff.
  agent-diff setup [--agents <list>] [--scope global|project]
      Only set up the agents (Cursor can stay open). <list> is claude, opencode,
      claude,opencode or none. --scope project means the current folder only; global is the default.
  agent-diff uninstall [--cursor <folder>] [--extensions-dir <folder>] [--skip-extension]
      Remove the patch, the extension, and the agents' hooks (for all projects and the current folder).
  agent-diff status [--cursor <folder>]

snapshot, show and clear never fail the agent: problems are printed as warnings and the exit code is 0.
Add --quiet to print warnings only.
Add --stdin to take the file from an agent hook's JSON on stdin (the "file_path", "filePath",
"path" or "notebook_path" field, inside "tool_input" when there is one), e.g. for Claude Code hooks.
Scripts can send {"cwd": "...", "files": ["a.ts", "b.ts"]} to --stdin instead of passing file names.

For shell commands, use "snapshot --git" before and "show --git" after. They need no file names:
git tells which files the command changed. Works in git repositories only.`;

interface Options {
  files: string[];
  open: boolean;
  quiet: boolean;
  readStdin: boolean;
  useGit: boolean;
  skipExtension: boolean;
  agents?: string;
  scope?: Scope;
  cursorFolder?: string;
  extensionsFolder?: string;
}

function parseArguments(args: string[]): Options {
  const options: Options = { files: [], open: false, quiet: false, readStdin: false, useGit: false, skipExtension: false };
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
    else if (arg === "--git") options.useGit = true;
    else if (arg === "--skip-extension") options.skipExtension = true;
    else if (arg === "--cursor") options.cursorFolder = takeValue();
    else if (arg === "--extensions-dir") options.extensionsFolder = takeValue();
    else if (arg === "--agents") options.agents = takeValue();
    else if (arg === "--scope") {
      const scope = takeValue();
      if (scope !== "global" && scope !== "project") throw new UsageError("--scope must be global or project.");
      options.scope = scope;
    }
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
function readFilesFromHookInput(input: any): string[] {
  const toolInput = input?.tool_input ?? input;
  const baseFolder = typeof input?.cwd === "string" ? input.cwd : process.cwd();
  const fileList: unknown[] = Array.isArray(input?.files) ? input.files : [];
  return [...HOOK_PATH_FIELDS.map((field) => toolInput?.[field]), ...fileList]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((file) => toFullPath(path.resolve(baseFolder, file)));
}

function readHookInput(): any {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    warn("--stdin: could not read JSON from stdin.");
    return undefined;
  }
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

/**
 * For shell commands, which don't say which files they will change. Before: remember what git
 * already sees as changed. After: show every file the command changed.
 */
async function handleCommandRun(command: string, input: any, open: boolean): Promise<void> {
  const folder = typeof input?.cwd === "string" ? input.cwd : process.cwd();
  // Claude Code gives each tool call an ID, so commands running side by side don't mix.
  const runKey = typeof input?.tool_use_id === "string" ? input.tool_use_id : path.resolve(folder);
  if (command === "snapshot") {
    const problem = rememberFilesBeforeCommand(folder, runKey);
    if (problem) say(problem);
    return;
  }
  const originals = findFilesChangedByCommand(runKey);
  if (originals.length === 0) return;
  const windows = listWindows();
  for (const original of originals) {
    // Same rule as "snapshot": while an earlier change still waits for review, keep its snapshot.
    if (readSnapshot(original.path) && (await isEarlierChangeStillPending(original.path, windows))) continue;
    saveSnapshot(original);
  }
  await showChanges(originals.map((original) => toFullPath(original.path)), open);
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

/** Sets up the agents' hooks: from --agents and --scope, or by asking. */
async function setUpAgentsFromOptions(options: Options): Promise<void> {
  const projectFolder = process.cwd();
  let choice: { agents: string[]; scope: Scope } | null;
  if (options.agents !== undefined) {
    let agents;
    try {
      agents = parseAgentNames(options.agents);
    } catch (error) {
      throw new UsageError(errorMessage(error));
    }
    choice = { agents, scope: options.scope ?? "global" };
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    choice = await askAboutAgents(projectFolder, options.scope);
  } else {
    // Run by a script or an agent: nobody can answer, so only say how.
    console.log('\nTo make your agents use it, run: agent-diff setup --agents claude,opencode [--scope project]');
    return;
  }
  if (!choice || choice.agents.length === 0) {
    console.log('No agents set up. Run "agent-diff setup" to do it later.');
    return;
  }
  for (const line of setUpAgents(choice.agents as any, choice.scope, projectFolder)) console.log(line);
}

function printNextSteps(): void {
  console.log(`
Next steps:
  1. Restart Cursor (close every window).
  2. Run "agent-diff status" to check that it works.
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
  if (needsFiles && options.useGit) {
    await handleCommandRun(command, options.readStdin ? readHookInput() : undefined, options.open);
    return 0;
  }
  if (needsFiles && options.readStdin) {
    options.files.push(...readFilesFromHookInput(readHookInput()));
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
      await setUpAgentsFromOptions(options);
      printNextSteps();
      return 0;
    }
    case "setup":
      await setUpAgentsFromOptions(options);
      return 0;
    case "uninstall": {
      const app = findCursorApp(options.cursorFolder);
      for (const line of uninstallPatch(app)) console.log(line);
      if (!options.skipExtension) for (const line of uninstallExtension(app, options.extensionsFolder)) console.log(line);
      for (const line of removeAgentSetup(process.cwd())) console.log(line);
      return 0;
    }
    default:
      throw new UsageError(`Unknown command "${command}".`);
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    // Agent-facing commands must never break the agent's run. Even a wrong option (say, from a
    // newer hook setup) must exit with 0: exit code 2 makes Claude Code block the tool call.
    const command = process.argv[2];
    const isHookCommand = command === "snapshot" || command === "show" || command === "clear";
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${HELP}`);
      process.exitCode = isHookCommand ? 0 : 2;
    } else {
      console.error(errorMessage(error));
      process.exitCode = isHookCommand ? 0 : 1;
    }
  },
);
