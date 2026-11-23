// Finds the files a shell command changed, so edits made by scripts show up too.
// Before the command we can't know which files it will touch. So we ask git what is already
// changed and copy those few files. After the command, every other file git now reports as
// changed was clean before, so git's saved copy is its text from before the command.
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getCommandRunsFolder, makePrivateFolder } from "../shared/common";
import { MAX_FILE_BYTES, Snapshot, readFileForSnapshot } from "./snapshots";

const MAX_RUN_AGE_MS = 24 * 60 * 60 * 1000;

/** A file git already reported as changed before the command ran. */
interface FileBeforeCommand {
  existed: boolean;
  size: number;
  modifiedAt: number;
  /** `null` when the file is too large or binary, so it can't be shown anyway. */
  content: string | null;
}

interface CommandRun {
  repoFolder: string;
  takenAt: number;
  changedFiles: Record<string, FileBeforeCommand>;
}

function runGit(folder: string, args: string[]): Buffer | null {
  const result = spawnSync("git", ["-C", folder, ...args], { maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  return result.status === 0 ? result.stdout : null;
}

function findRepoFolder(folder: string): string | null {
  const output = runGit(folder, ["rev-parse", "--show-toplevel"]);
  return output ? path.resolve(output.toString("utf8").trim()) : null;
}

/** Full paths of every file git reports as changed, deleted or new. Ignored files are not listed. */
function listChangedFiles(repoFolder: string): string[] | null {
  const output = runGit(repoFolder, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  if (!output) return null;
  return output.toString("utf8").split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => path.join(repoFolder, entry.slice(3)));
}

function getRunFile(runKey: string): string {
  const name = crypto.createHash("sha1").update(runKey).digest("hex").slice(0, 24);
  return path.join(getCommandRunsFolder(), `${name}.json`);
}

function describeFile(filePath: string): FileBeforeCommand {
  if (!fs.existsSync(filePath)) return { existed: false, size: 0, modifiedAt: 0, content: null };
  const stats = fs.statSync(filePath);
  const current = readFileForSnapshot(filePath);
  return { existed: true, size: stats.size, modifiedAt: stats.mtimeMs, content: "skipReason" in current ? null : current.content };
}

/** Runs a command left behind (it crashed or never finished) are forgotten after a day. */
function deleteOldRuns(): void {
  if (!fs.existsSync(getCommandRunsFolder())) return;
  for (const name of fs.readdirSync(getCommandRunsFolder())) {
    const file = path.join(getCommandRunsFolder(), name);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > MAX_RUN_AGE_MS) fs.rmSync(file, { force: true });
    } catch {
      // Another command may be removing it right now.
    }
  }
}

/** Before a command: remember what git already sees as changed. Returns a reason when it can't. */
export function rememberFilesBeforeCommand(folder: string, runKey: string): string | null {
  const repoFolder = findRepoFolder(folder);
  if (!repoFolder) return `${folder} is not in a git repository, so changes made by commands can't be found.`;
  const files = listChangedFiles(repoFolder);
  if (!files) return `git status failed in ${repoFolder}.`;
  deleteOldRuns();
  const run: CommandRun = { repoFolder, takenAt: Date.now(), changedFiles: {} };
  for (const file of files) run.changedFiles[file] = describeFile(file);
  makePrivateFolder(getCommandRunsFolder());
  fs.writeFileSync(getRunFile(runKey), JSON.stringify(run), { mode: 0o600 });
  return null;
}

/** Git's saved copy of a file that was clean. `null` means git doesn't have it, so the command created it. */
function readSavedCopy(repoFolder: string, filePath: string, currentText: string): string | null | undefined {
  const relativePath = path.relative(repoFolder, filePath).split(path.sep).join("/");
  const output = runGit(repoFolder, ["cat-file", "-p", `:${relativePath}`]);
  if (!output) return null;
  if (output.length > MAX_FILE_BYTES || output.subarray(0, 8000).includes(0)) return undefined;
  // Git may keep the file with different line endings than the copy on disk. Use the disk's
  // line endings, or every line would look changed.
  const text = output.toString("utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  return currentText.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
}

/** After a command: the text from before the command of every file it changed. */
export function findFilesChangedByCommand(runKey: string): Snapshot[] {
  const runFile = getRunFile(runKey);
  let run: CommandRun;
  try {
    run = JSON.parse(fs.readFileSync(runFile, "utf8"));
  } catch {
    return [];
  }
  fs.rmSync(runFile, { force: true });
  const originals: Snapshot[] = [];
  for (const filePath of listChangedFiles(run.repoFolder) ?? []) {
    // A deleted file has nothing to show the hunks in.
    if (!fs.existsSync(filePath)) continue;
    const current = readFileForSnapshot(filePath);
    if ("skipReason" in current) continue;
    const before = run.changedFiles[filePath];
    if (before) {
      // It was already changed before the command; it only counts if the command changed it again.
      const stats = fs.statSync(filePath);
      if (before.existed && stats.size === before.size && stats.mtimeMs === before.modifiedAt) continue;
      if (before.existed && before.content === null) continue;
      originals.push({ path: filePath, existed: before.existed, content: before.content ?? "", takenAt: run.takenAt });
      continue;
    }
    const savedCopy = readSavedCopy(run.repoFolder, filePath, current.content);
    if (savedCopy === undefined) continue;
    originals.push({ path: filePath, existed: savedCopy !== null, content: savedCopy ?? "", takenAt: run.takenAt });
  }
  return originals;
}
