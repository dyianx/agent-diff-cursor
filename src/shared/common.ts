// Things both the CLI and the Cursor extension need to agree on.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Bump when the code added to Cursor changes, so `install` replaces an older copy. */
export const PATCH_VERSION = 7;

/** Commands the patch adds inside Cursor. The leading "_" hides them from the command palette. */
export const PATCH_COMMANDS = {
  show: "_agentDiff.show",
  clear: "_agentDiff.clear",
  list: "_agentDiff.list",
  version: "_agentDiff.version",
} as const;

/** Folder where the tool keeps snapshots, backups and the list of open Cursor windows. */
export function getDataFolder(): string {
  if (process.env.AGENT_DIFF_HOME) return process.env.AGENT_DIFF_HOME;
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "agent-diff");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "agent-diff");
  }
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "agent-diff");
}

export const getWindowsFolder = () => path.join(getDataFolder(), "windows");
export const getSnapshotsFolder = () => path.join(getDataFolder(), "snapshots");
export const getBackupsFolder = () => path.join(getDataFolder(), "backups");
/** What git reported as changed before each shell command, until the command finishes. */
export const getCommandRunsFolder = () => path.join(getDataFolder(), "command-runs");

/** Create a folder only this user can open. Snapshots hold copies of the files an agent edits. */
export function makePrivateFolder(folder: string): void {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  // Older versions made the data folder with default rights, so fix it here too. Windows ignores
  // these modes; its folder under AppData is already private to the user.
  if (process.platform !== "win32") fs.chmodSync(getDataFolder(), 0o700);
}

/** Header in which a window sends back its proof (see WindowInfo.proof). */
export const PROOF_HEADER = "x-agent-diff-proof";

/** Turn a path into a form that can be compared. Windows paths ignore case. */
export function toComparablePath(filePath: string): string {
  const fullPath = path.resolve(filePath);
  return process.platform === "win32" ? fullPath.toLowerCase() : fullPath;
}

/** What each Cursor window writes to the windows folder, so the CLI can reach it. */
export interface WindowInfo {
  port: number;
  /** Secret the CLI must send back; stops web pages and other users from calling the window. */
  token: string;
  /**
   * Secret the window sends back, only to callers with the token. A window file can outlive a
   * crashed Cursor, and another program may later get its port. The proof shows the CLI it
   * reached the real window before it sends any file text.
   */
  proof: string;
  pid: number;
  folders: string[];
  startedAt: number;
}

export interface ShowRequest {
  path: string;
  /** Text of the file before the agent edited it. `null` means the file did not exist. */
  original: string | null;
  /** Open the file in an editor tab without taking focus. */
  open?: boolean;
}

export interface ShowResult {
  diffId: string | null;
  /** `false` when the file is back to its original text, so nothing is shown. */
  changed: boolean;
}

export interface ClearRequest {
  /** Only clear this file. Clears every diff the tool made when missing. */
  path?: string;
}

export interface DiffInfo {
  path: string;
  diffId: string;
  /** `true` for diffs this tool made, `false` for Cursor's own agent diffs. */
  isOurs: boolean;
}

export interface WindowStatus {
  /** Version of the code added to Cursor, or `null` when Cursor is not patched. */
  patchVersion: number | null;
  folders: string[];
  editorVersion: string;
}
