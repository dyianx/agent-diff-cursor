// Sets up coding agents (Claude Code, OpenCode) to call agent-diff around every edit, for all
// projects or for one project. The hooks and the plugin come from the examples folder, so the
// files people copy by hand and the files this writes are the same.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { getBackupsFolder, makePrivateFolder } from "../shared/common";

export type AgentName = "claude" | "opencode";
export type Scope = "global" | "project";

interface Agent {
  name: AgentName;
  label: string;
  /** The agent's own command, to tell whether it is installed. */
  commandName: string;
  /** Its settings folder for all projects, also a sign that it is installed. */
  globalFolder: () => string;
  /** What to tell the user once its hooks are in place. */
  restartNote: string;
}

const getClaudeFolder = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const getOpenCodeFolder = () =>
  process.env.OPENCODE_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode");

export const AGENTS: Agent[] = [
  {
    name: "claude",
    label: "Claude Code",
    commandName: "claude",
    globalFolder: getClaudeFolder,
    restartNote: "New Claude Code sessions use the hooks. Restart sessions that are already running.",
  },
  {
    name: "opencode",
    label: "OpenCode",
    commandName: "opencode",
    globalFolder: getOpenCodeFolder,
    restartNote: "Restart OpenCode to load the plugin.",
  },
];

const getExamplesFolder = () => path.join(__dirname, "..", "examples");
const OPENCODE_PLUGIN_NAME = "agent-diff.ts";

/** A hook command that runs agent-diff, however it was written: our own, or copied by hand. */
const isOurCommand = (command: unknown) =>
  typeof command === "string" && /agent-diff(\.cmd|\.js)?"?\s+(snapshot|show|clear)\b/.test(command);

export function isOnPath(command: string): boolean {
  const finder = process.platform === "win32" ? "where" : "which";
  return spawnSync(finder, [command], { stdio: "ignore", windowsHide: true }).status === 0;
}

export function isAgentInstalled(agent: Agent): boolean {
  return isOnPath(agent.commandName) || fs.existsSync(agent.globalFolder());
}

// ---------- Claude Code ----------

function getClaudeSettingsFile(scope: Scope, projectFolder: string): string {
  // For one project we use the personal settings file, which is not shared with teammates.
  return scope === "global"
    ? path.join(getClaudeFolder(), "settings.json")
    : path.join(projectFolder, ".claude", "settings.local.json");
}

function readJsonObject(file: string): { value: any } | { problem: string } {
  if (!fs.existsSync(file)) return { value: {} };
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  if (text.trim() === "") return { value: {} };
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return { value };
    return { problem: "it does not hold a JSON object" };
  } catch (error) {
    return { problem: `it is not valid JSON (${error instanceof Error ? error.message : error})` };
  }
}

/** Takes our hooks out of a Claude Code settings object. Returns whether any were there. */
function removeClaudeHooks(settings: any): boolean {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  let foundAny = false;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const groups = hooks[event]
      .map((group: any) => {
        if (!group || !Array.isArray(group.hooks)) return group;
        const kept = group.hooks.filter((hook: any) => !isOurCommand(hook?.command));
        if (kept.length === group.hooks.length) return group;
        foundAny = true;
        return kept.length > 0 ? { ...group, hooks: kept } : null;
      })
      .filter((group: any) => group !== null);
    if (groups.length > 0) hooks[event] = groups;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return foundAny;
}

function readClaudeExampleHooks(): Record<string, unknown[]> {
  const example = JSON.parse(fs.readFileSync(path.join(getExamplesFolder(), "claude-code", "settings.json"), "utf8"));
  return example.hooks;
}

/** Copies a file we are about to change into our backups folder. Returns the copy's path. */
function backUp(file: string, label: string): string | null {
  if (!fs.existsSync(file)) return null;
  const folder = path.join(getBackupsFolder(), "agent-settings");
  makePrivateFolder(folder);
  const time = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const copy = path.join(folder, `${label}-${time}${path.extname(file)}`);
  fs.copyFileSync(file, copy);
  return copy;
}

/** Writes through a temporary file, so a crash never leaves half a settings file. */
function writeFileSafely(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.agent-diff-${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, text);
  fs.renameSync(temporaryFile, file);
}

function writeJsonIfChanged(file: string, before: string | null, settings: any, label: string): string[] {
  const after = `${JSON.stringify(settings, null, 2)}\n`;
  if (before !== null && before.replace(/^﻿/, "").trim() === after.trim()) return [];
  const backup = backUp(file, label);
  writeFileSafely(file, after);
  return backup ? [`  (the old file is saved at ${backup})`] : [];
}

function addClaudeHooks(scope: Scope, projectFolder: string): string[] {
  const file = getClaudeSettingsFile(scope, projectFolder);
  const read = readJsonObject(file);
  if ("problem" in read) {
    return [
      `Claude Code: left ${file} alone: ${read.problem}.`,
      `  Add the hooks from ${path.join(getExamplesFolder(), "claude-code", "settings.json")} by hand.`,
    ];
  }
  const settings = read.value;
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const hadOurHooks = removeClaudeHooks(settings);
  settings.hooks ??= {};
  for (const [event, groups] of Object.entries(readClaudeExampleHooks())) {
    settings.hooks[event] = [...(Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []), ...groups];
  }
  const backupLines = writeJsonIfChanged(file, before, settings, `claude-${scope}-settings`);
  const lines = backupLines.length === 0 && before !== null && hadOurHooks
    ? [`Claude Code: hooks already set up in ${file}.`]
    : [`Claude Code: hooks ${hadOurHooks ? "updated" : "added"} in ${file}.`, ...backupLines];
  if (scope === "project") lines.push(...keepOutOfGit(projectFolder, ".claude/settings.local.json"));
  return lines;
}

function removeClaudeHooksFromFile(file: string, scope: Scope): string[] {
  const read = readJsonObject(file);
  if ("problem" in read || !removeClaudeHooks(read.value)) return [];
  const before = fs.readFileSync(file, "utf8");
  const backupLines = writeJsonIfChanged(file, before, read.value, `claude-${scope}-settings`);
  return [`Claude Code: hooks removed from ${file}.`, ...backupLines];
}

// ---------- OpenCode ----------

/** OpenCode loads every plugin file in this folder. */
function getOpenCodePluginFile(scope: Scope, projectFolder: string): string {
  const folder = scope === "global" ? getOpenCodeFolder() : path.join(projectFolder, ".opencode");
  return path.join(folder, "plugins", OPENCODE_PLUGIN_NAME);
}

/** Our plugin says so in its first line. A file of the same name without it is someone else's. */
const isOurPlugin = (text: string) => text.split("\n", 1)[0].includes("agent-diff");

function addOpenCodePlugin(scope: Scope, projectFolder: string): string[] {
  const file = getOpenCodePluginFile(scope, projectFolder);
  const plugin = fs.readFileSync(path.join(getExamplesFolder(), "opencode", OPENCODE_PLUGIN_NAME), "utf8");
  const lines: string[] = [];
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, "utf8");
    if (!isOurPlugin(current)) return [`OpenCode: left ${file} alone: it is not the agent-diff plugin.`];
    if (current === plugin) lines.push(`OpenCode: plugin already set up in ${file}.`);
    else {
      writeFileSafely(file, plugin);
      lines.push(`OpenCode: plugin updated in ${file}.`);
    }
  } else {
    writeFileSafely(file, plugin);
    lines.push(`OpenCode: plugin added in ${file}.`);
  }
  if (scope === "project") lines.push(...keepOutOfGit(projectFolder, `.opencode/plugins/${OPENCODE_PLUGIN_NAME}`));
  return lines;
}

function removeOpenCodePlugin(scope: Scope, projectFolder: string): string[] {
  const file = getOpenCodePluginFile(scope, projectFolder);
  if (!fs.existsSync(file) || !isOurPlugin(fs.readFileSync(file, "utf8"))) return [];
  fs.rmSync(file);
  return [`OpenCode: plugin removed from ${file}.`];
}

// ---------- Both ----------

/**
 * Files we add to one project are personal. When git doesn't ignore them already, list them in
 * .git/info/exclude, which ignores them on this computer only, without changing .gitignore.
 */
function keepOutOfGit(projectFolder: string, relativePath: string): string[] {
  const git = (args: string[]) => spawnSync("git", ["-C", projectFolder, ...args], { encoding: "utf8", windowsHide: true });
  const check = git(["check-ignore", "-q", relativePath]);
  if (check.status !== 1) return []; // 0: already ignored. Anything else: not a git repo.
  const excludePath = git(["rev-parse", "--git-path", "info/exclude"]);
  if (excludePath.status !== 0) return [];
  const excludeFile = path.resolve(projectFolder, excludePath.stdout.trim());
  const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  fs.appendFileSync(excludeFile, `${separator}/${relativePath}\n`);
  return [`  (git ignores it in this project only on this computer, through ${excludeFile})`];
}

export function setUpAgents(agents: AgentName[], scope: Scope, projectFolder: string): string[] {
  const lines: string[] = [];
  for (const agent of AGENTS.filter((candidate) => agents.includes(candidate.name))) {
    const agentLines = agent.name === "claude" ? addClaudeHooks(scope, projectFolder) : addOpenCodePlugin(scope, projectFolder);
    lines.push(...agentLines);
    // "left ... alone" means nothing was set up, so there is nothing to restart for.
    if (!agentLines[0].includes(" left ")) lines.push(`  ${agent.restartNote}`);
  }
  if (lines.length > 0 && !isOnPath("agent-diff")) {
    lines.push(
      "warning: the agent-diff command is not on your PATH, so the agents can't run it.",
      "  Install it for all projects: npm install -g agent-diff-cursor",
    );
  }
  return lines;
}

/** Removes our hooks and plugin for all projects and for the given project. */
export function removeAgentSetup(projectFolder: string): string[] {
  const lines = [
    ...removeClaudeHooksFromFile(getClaudeSettingsFile("global", projectFolder), "global"),
    ...removeClaudeHooksFromFile(getClaudeSettingsFile("project", projectFolder), "project"),
    ...removeOpenCodePlugin("global", projectFolder),
    ...removeOpenCodePlugin("project", projectFolder),
  ];
  // The shared project file goes to teammates too, so we only point it out.
  const sharedFile = path.join(projectFolder, ".claude", "settings.json");
  const shared = readJsonObject(sharedFile);
  if ("value" in shared && removeClaudeHooks(structuredClone(shared.value))) {
    lines.push(`Claude Code: ${sharedFile} still runs agent-diff. It is shared with your team, so remove those hooks by hand.`);
  }
  return lines;
}

export function parseAgentNames(text: string): AgentName[] {
  if (text.trim().toLowerCase() === "none") return [];
  const names = text.split(/[\s,]+/).filter(Boolean).map((name) => name.toLowerCase());
  const known = AGENTS.map((agent) => agent.name as string);
  const unknown = names.filter((name) => !known.includes(name));
  if (unknown.length > 0) throw new Error(`Unknown agent "${unknown[0]}". Use ${known.join(", ")} or none.`);
  return names as AgentName[];
}

/** Asks which agents to set up and where. Returns null when the user skips it. */
export async function askAboutAgents(projectFolder: string, knownScope?: Scope): Promise<{ agents: AgentName[]; scope: Scope } | null> {
  const prompt = readline.createInterface({ input: process.stdin });
  // Read lines through one buffered reader, so answers typed (or pasted) ahead are not lost.
  const lines = prompt[Symbol.asyncIterator]();
  /** The typed answer, or null when the input ended. */
  const ask = async (question: string): Promise<string | null> => {
    process.stdout.write(question);
    const line = await lines.next();
    return line.done ? null : String(line.value).trim();
  };
  try {
    console.log("\nWhich agents should show their edits in Cursor?");
    AGENTS.forEach((agent, index) => {
      console.log(`  ${index + 1}. ${agent.label}${isAgentInstalled(agent) ? "" : "   (not found on this computer)"}`);
    });
    let agents: AgentName[] | null = null;
    while (agents === null) {
      const answer = await ask("Numbers, separated by commas (e.g. 1,2), or Enter to skip: ");
      if (answer === null || answer === "") return null;
      const numbers = answer.split(/[\s,]+/).filter(Boolean).map(Number);
      if (numbers.every((number) => Number.isInteger(number) && number >= 1 && number <= AGENTS.length)) {
        agents = [...new Set(numbers)].map((number) => AGENTS[number - 1].name);
      } else {
        console.log(`Please type numbers from 1 to ${AGENTS.length}.`);
      }
    }
    if (knownScope) return { agents, scope: knownScope };
    console.log("\nFor all projects, or only this one?");
    console.log("  1. All projects (default)");
    console.log(`  2. Only this project: ${projectFolder}`);
    let scope: Scope | null = null;
    while (scope === null) {
      const answer = await ask("Number, or Enter for 1: ");
      if (answer === null) return null;
      if (answer === "" || answer === "1") scope = "global";
      else if (answer === "2") scope = "project";
      else console.log("Please type 1 or 2.");
    }
    console.log("");
    return { agents, scope };
  } finally {
    prompt.close();
  }
}
