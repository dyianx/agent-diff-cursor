// OpenCode plugin: show OpenCode's file edits as Cursor inline diffs (Keep / Undo).
//
// Copy this file to .opencode/plugins/ in a project, or to ~/.config/opencode/plugins/ for all
// projects. It needs the agent-diff command on the PATH (see the README).
//
// Written from OpenCode's plugin docs (opencode.ai/docs/build/plugins/server, November 2026).
// Not yet tested against a running OpenCode.
//
// How it works: before an edit tool runs, the files it will touch are snapshotted. After it
// runs, every snapshotted file is shown in Cursor. The docs give no ID that links a "before"
// event to its "after" event, so the plugin keeps a list of files waiting to be shown.
import { Plugin } from "@opencode/plugin";
import { spawn } from "node:child_process";
import * as path from "node:path";

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);

/** Files a tool call will change, from its arguments. */
function findFilesInToolInput(input: any): string[] {
  if (!input || typeof input !== "object") return [];
  const files: string[] = [];
  // edit and write use `path`. Older OpenCode versions used `filePath`.
  for (const key of ["path", "filePath"]) {
    if (typeof input[key] === "string") files.push(input[key]);
  }
  // patch lists its files in lines like "*** Update File: src/a.ts".
  const patchText = input.patchText ?? input.patch;
  if (typeof patchText === "string") {
    for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      files.push(match[1].trim());
    }
    // A moved file shows up under its new name too.
    for (const match of patchText.matchAll(/^\*\*\* Move to: (.+)$/gm)) files.push(match[1].trim());
  }
  return files;
}

function runAgentDiff(command: "snapshot" | "show", files: string[]): Promise<void> {
  // On Windows the command is a .cmd file, which only runs through the shell. File names go in
  // as JSON on stdin, never as arguments, so a name like "a&b.ts" cannot run anything.
  // The command never fails the agent; errors here only mean it is not installed.
  return new Promise((resolve) => {
    const child = spawn("agent-diff", [command, "--stdin", "--quiet"], { shell: process.platform === "win32", stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ files }));
  });
}

export default Plugin.define({
  id: "agent-diff",
  async setup(ctx) {
    const projectFolder = ctx.location.directory;
    const filesWaitingToBeShown = new Set<string>();

    await ctx.tool.hook("execute.before", async (event) => {
      if (!EDIT_TOOLS.has(event.tool)) return;
      const files = findFilesInToolInput(event.input).map((file) => path.resolve(projectFolder, file));
      if (files.length === 0) return;
      for (const file of files) filesWaitingToBeShown.add(file);
      await runAgentDiff("snapshot", files);
    });

    // Runs after the tool finished or failed. A failed edit may still have changed some files.
    await ctx.tool.hook("execute.after", async () => {
      if (filesWaitingToBeShown.size === 0) return;
      const files = [...filesWaitingToBeShown];
      filesWaitingToBeShown.clear();
      await runAgentDiff("show", files);
    });
  },
});
