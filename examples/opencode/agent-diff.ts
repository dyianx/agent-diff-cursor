// agent-diff plugin for OpenCode: show OpenCode's file edits as Cursor inline diffs (Keep / Undo).
//
// "agent-diff setup" puts this file in ~/.config/opencode/plugins/ (all projects) or in
// .opencode/plugins/ (one project). It needs the agent-diff command on the PATH (see the README).
//
// Checked against OpenCode 2.4.1: a plugin is a default export with an id and a setup function,
// edit and write take `path`, patch takes `patchText`, and the shell tool takes `command` and
// `workdir`. The events before and after a tool call share the call's `id`.
//
// How it works: before an edit tool runs, the files it will touch are snapshotted, and after it
// runs they are shown in Cursor. Before a shell command, git is asked which files are already
// changed; after it, every file the command changed is shown (git repositories only).
import { spawn } from "node:child_process";
import * as path from "node:path";

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);
const SHELL_TOOLS = new Set(["shell", "bash"]);

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

function runAgentDiff(args: string[], input: object): Promise<void> {
  // On Windows the command is a .cmd file, which only runs through the shell. File names go in
  // as JSON on stdin, never as arguments, so a name like "a&b.ts" cannot run anything.
  // The command never fails the agent; errors here only mean it is not installed.
  // The arguments are fixed words, so on Windows they go in one command line (Node warns about an
  // argument list together with the shell).
  const allArgs = [...args, "--stdin", "--quiet"];
  const options = { stdio: ["pipe", "ignore", "ignore"] as const, windowsHide: true };
  return new Promise((resolve) => {
    const child = process.platform === "win32"
      ? spawn(`agent-diff ${allArgs.join(" ")}`, { ...options, shell: true })
      : spawn("agent-diff", allArgs, options);
    child.on("error", () => resolve());
    child.on("close", () => resolve());
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

export default {
  id: "agent-diff",
  async setup(ctx: any) {
    const projectFolder: string = ctx.location?.directory ?? process.cwd();
    /** What each running tool call will need after it finishes, by call ID. */
    const waiting = new Map<string, { files?: string[]; folder?: string }>();

    await ctx.tool.hook("execute.before", async (event: any) => {
      const callId = String(event.id ?? `${event.sessionID}:${event.tool}`);
      if (EDIT_TOOLS.has(event.tool)) {
        const files = findFilesInToolInput(event.input).map((file) => path.resolve(projectFolder, file));
        if (files.length === 0) return;
        waiting.set(callId, { files });
        await runAgentDiff(["snapshot"], { files });
      } else if (SHELL_TOOLS.has(event.tool)) {
        const workdir = event.input?.workdir;
        const folder = typeof workdir === "string" && workdir ? path.resolve(projectFolder, workdir) : projectFolder;
        waiting.set(callId, { folder });
        await runAgentDiff(["snapshot", "--git"], { cwd: folder, tool_use_id: `opencode:${callId}` });
      }
    });

    // Runs after the tool finished or failed. A failed tool may still have changed some files.
    await ctx.tool.hook("execute.after", async (event: any) => {
      const callId = String(event.id ?? `${event.sessionID}:${event.tool}`);
      const call = waiting.get(callId);
      if (!call) return;
      waiting.delete(callId);
      if (call.files) await runAgentDiff(["show"], { files: call.files });
      else await runAgentDiff(["show", "--git"], { cwd: call.folder, tool_use_id: `opencode:${callId}` });
    });
  },
};
