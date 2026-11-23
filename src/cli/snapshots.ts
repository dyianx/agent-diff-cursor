// Copies of files taken before an agent edits them. One JSON file per edited file.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getSnapshotsFolder, makePrivateFolder, toComparablePath } from "../shared/common";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SNAPSHOT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface Snapshot {
  path: string;
  /** `false` when the file did not exist yet, so the agent is creating it. */
  existed: boolean;
  content: string;
  takenAt: number;
}

function getSnapshotFile(filePath: string): string {
  const key = crypto.createHash("sha1").update(toComparablePath(filePath)).digest("hex").slice(0, 24);
  return path.join(getSnapshotsFolder(), `${key}.json`);
}

/** Read the file as it is now. Returns a reason instead when the file can't be shown as text. */
export function readFileForSnapshot(filePath: string): Snapshot | { skipReason: string } {
  if (!fs.existsSync(filePath)) return { path: filePath, existed: false, content: "", takenAt: Date.now() };
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) return { skipReason: "not a file" };
  if (stats.size > MAX_FILE_BYTES) return { skipReason: "file is larger than 5 MB" };
  const bytes = fs.readFileSync(filePath);
  if (bytes.subarray(0, 8000).includes(0)) return { skipReason: "file looks binary" };
  // Cursor's editor drops the byte order mark, so drop it here too or line 1 would always differ.
  const content = bytes.toString("utf8").replace(/^﻿/, "");
  return { path: filePath, existed: true, content, takenAt: Date.now() };
}

export function readSnapshot(filePath: string): Snapshot | undefined {
  try {
    return JSON.parse(fs.readFileSync(getSnapshotFile(filePath), "utf8"));
  } catch {
    return undefined;
  }
}

export function saveSnapshot(snapshot: Snapshot): void {
  makePrivateFolder(getSnapshotsFolder());
  fs.writeFileSync(getSnapshotFile(snapshot.path), JSON.stringify(snapshot), { mode: 0o600 });
}

export function deleteSnapshot(filePath: string): void {
  fs.rmSync(getSnapshotFile(filePath), { force: true });
}

export function deleteAllSnapshots(): number {
  if (!fs.existsSync(getSnapshotsFolder())) return 0;
  const files = fs.readdirSync(getSnapshotsFolder()).filter((name) => name.endsWith(".json"));
  for (const name of files) fs.rmSync(path.join(getSnapshotsFolder(), name), { force: true });
  return files.length;
}

/** Snapshots nobody showed for a week are forgotten, so the folder does not grow forever. */
export function deleteOldSnapshots(): void {
  if (!fs.existsSync(getSnapshotsFolder())) return;
  for (const name of fs.readdirSync(getSnapshotsFolder())) {
    const file = path.join(getSnapshotsFolder(), name);
    try {
      const snapshot: Snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Date.now() - snapshot.takenAt > MAX_SNAPSHOT_AGE_MS) fs.rmSync(file, { force: true });
    } catch {
      fs.rmSync(file, { force: true });
    }
  }
}
