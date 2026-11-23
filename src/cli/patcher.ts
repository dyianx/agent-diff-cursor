// Adds the payload to Cursor's workbench file, removes it again, and keeps product.json's
// checksum in step so Cursor does not report a corrupt installation.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { PATCH_VERSION, getBackupsFolder } from "../shared/common";
import { PAYLOAD_TEMPLATE } from "./payload";

const WORKBENCH_RELATIVE_PATH = "vs/workbench/workbench.desktop.main.js";
const START_MARKER_PREFIX = "/*agent-diff:start v";
const END_MARKER = "/*agent-diff:end*/";
const PATCH_BLOCK_PATTERN = /\n\/\*agent-diff:start v(\d+)\*\/[\s\S]*?\/\*agent-diff:end\*\/\n/;

export interface CursorApp {
  /** The `resources/app` folder. */
  appFolder: string;
  workbenchFile: string;
  productFile: string;
  version: string;
  commit: string;
}

export interface PatchState {
  patchVersion: number | null;
  /** `null` when product.json has no checksum for the workbench file. */
  isChecksumCorrect: boolean | null;
}

/** Default install folder, or the AGENT_DIFF_APP environment variable when set. */
function getDefaultCursorFolder(): string | undefined {
  if (process.env.AGENT_DIFF_APP) return process.env.AGENT_DIFF_APP;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "Programs", "cursor");
  }
  if (process.platform === "darwin") return "/Applications/Cursor.app";
  return undefined;
}

/** Accepts the install folder, the `.app` bundle on macOS, or the `resources/app` folder itself. */
export function findCursorApp(givenFolder?: string): CursorApp {
  const chosenFolder = givenFolder ?? getDefaultCursorFolder();
  if (!chosenFolder) throw new Error("Could not guess where Cursor is installed. Pass --cursor <folder>.");
  const folder = path.resolve(chosenFolder);
  const candidates = [folder, path.join(folder, "resources", "app"), path.join(folder, "Contents", "Resources", "app")];
  for (const candidate of candidates) {
    const workbenchFile = path.join(candidate, "out", ...WORKBENCH_RELATIVE_PATH.split("/"));
    const productFile = path.join(candidate, "product.json");
    if (fs.existsSync(workbenchFile) && fs.existsSync(productFile)) {
      const product = JSON.parse(fs.readFileSync(productFile, "utf8"));
      return {
        appFolder: candidate,
        workbenchFile,
        productFile,
        version: readAppVersion(candidate, product),
        commit: String(product.commit ?? "unknown"),
      };
    }
  }
  throw new Error(`No Cursor install found in ${folder}. Pass --cursor <folder>.`);
}

function readAppVersion(appFolder: string, product: { version?: string }): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(appFolder, "package.json"), "utf8")).version;
  } catch {
    return product.version ?? "unknown";
  }
}

/** Same format as product.json: SHA-256, base64, without the "=" padding. */
function computeChecksum(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("base64").replace(/=+$/, "");
}

const CHECKSUM_PATTERN = new RegExp(`("${WORKBENCH_RELATIVE_PATH.replace(/[/.]/g, "\\$&")}"\\s*:\\s*")([^"]*)(")`);

export function readPatchState(app: CursorApp): PatchState {
  const workbench = fs.readFileSync(app.workbenchFile);
  const match = PATCH_BLOCK_PATTERN.exec(workbench.toString("utf8"));
  const checksumMatch = CHECKSUM_PATTERN.exec(fs.readFileSync(app.productFile, "utf8"));
  return {
    patchVersion: match ? Number(match[1]) : null,
    isChecksumCorrect: checksumMatch ? checksumMatch[2] === computeChecksum(workbench) : null,
  };
}

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find the minified names the payload needs. Fails with a clear message if Cursor changed. */
function findMinifiedNames(workbench: string): { createDecorator: string; commandsRegistry: string } {
  const decoratorMatch = /[\w$]+=([\w$]+)\("instantiationService"\)/.exec(workbench);
  const registryMatch = /([\w$]+)\.registerCommand\("_workbench\.openMultiDiffEditor"/.exec(workbench);
  if (!decoratorMatch) throw new Error("Could not find Cursor's service lookup function. This Cursor version is not supported.");
  if (!registryMatch) throw new Error("Could not find Cursor's command list. This Cursor version is not supported.");
  const createDecorator = decoratorMatch[1];
  const commandsRegistry = registryMatch[1];

  // The same function must create the inline diff service key, and must be a top-level function.
  const checks: Array<[RegExp, string]> = [
    [new RegExp(`=${escapeForRegex(createDecorator)}\\("inlineDiffService"\\)`), "the inline diff service"],
    [new RegExp(`function ${escapeForRegex(createDecorator)}\\(\\w+\\)\\{if\\([\\w$]+\\.serviceIds\\.has\\(`), "the service lookup function"],
    [/addDecorationsOnlyDiff\(/, "addDecorationsOnlyDiff"],
    [/getHandlerByDiffId\(/, "getHandlerByDiffId"],
    [/onDidRejectPartialDiff/, "onDidRejectPartialDiff"],
    [/"speculative-full-file"/, "the diff source name"],
  ];
  for (const [pattern, description] of checks) {
    if (!pattern.test(workbench)) throw new Error(`Could not find ${description}. This Cursor version is not supported.`);
  }
  return { createDecorator, commandsRegistry };
}

function buildPatchBlock(names: { createDecorator: string; commandsRegistry: string }): string {
  // split/join instead of replace(): minified names can contain "$", which replace() treats specially.
  const payload = PAYLOAD_TEMPLATE
    .split("__CREATE_DECORATOR__").join(names.createDecorator)
    .split("__COMMANDS_REGISTRY__").join(names.commandsRegistry)
    .split("__PATCH_VERSION__").join(String(PATCH_VERSION));
  return `\n${START_MARKER_PREFIX}${PATCH_VERSION}*/${payload}${END_MARKER}\n`;
}

function writeFileOrExplain(filePath: string, content: string | Buffer): void {
  try {
    fs.writeFileSync(filePath, content);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      throw new Error(`No permission to write ${filePath}. Close Cursor, or run as an admin if Cursor is installed for all users.`);
    }
    if (code === "EBUSY") throw new Error(`${filePath} is in use. Close Cursor and try again.`);
    throw error;
  }
}

function updateChecksum(app: CursorApp, workbench: string): void {
  const product = fs.readFileSync(app.productFile, "utf8");
  if (!CHECKSUM_PATTERN.test(product)) return;
  const checksum = computeChecksum(Buffer.from(workbench, "utf8"));
  // Replace only the one value so the rest of product.json stays byte for byte the same.
  writeFileOrExplain(app.productFile, product.replace(CHECKSUM_PATTERN, (_all, before, _old, after) => `${before}${checksum}${after}`));
}

function backUpOriginalFiles(app: CursorApp): string {
  const backupFolder = path.join(getBackupsFolder(), `${app.version}-${app.commit.slice(0, 8)}`);
  if (!fs.existsSync(backupFolder)) {
    fs.mkdirSync(backupFolder, { recursive: true });
    fs.copyFileSync(app.workbenchFile, path.join(backupFolder, "workbench.desktop.main.js"));
    fs.copyFileSync(app.productFile, path.join(backupFolder, "product.json"));
  }
  return backupFolder;
}

/** Add the payload, or replace an older version of it. Returns lines to print. */
export function installPatch(app: CursorApp): string[] {
  const messages: string[] = [];
  const original = fs.readFileSync(app.workbenchFile, "utf8");
  const existing = PATCH_BLOCK_PATTERN.exec(original);
  if (existing && Number(existing[1]) === PATCH_VERSION) {
    updateChecksum(app, original);
    return [`Cursor ${app.version} is already patched (version ${PATCH_VERSION}).`];
  }
  if (!existing) messages.push(`Backed up the original files to ${backUpOriginalFiles(app)}`);

  const clean = original.replace(PATCH_BLOCK_PATTERN, "");
  const names = findMinifiedNames(clean);
  // Add the code as the last top-level statement, after everything it uses has been set up.
  const exportMatches = [...clean.matchAll(/export\{[\w$]+ as main\};/g)];
  if (exportMatches.length !== 1) throw new Error("Could not find the end of Cursor's workbench file. This Cursor version is not supported.");
  const insertAt = exportMatches[0].index!;
  const patched = clean.slice(0, insertAt) + buildPatchBlock(names) + clean.slice(insertAt);

  writeFileOrExplain(app.workbenchFile, patched);
  updateChecksum(app, patched);
  messages.push(existing
    ? `Updated the patch in Cursor ${app.version} from version ${existing[1]} to ${PATCH_VERSION}.`
    : `Patched Cursor ${app.version} (${app.appFolder}).`);
  return messages;
}

export function uninstallPatch(app: CursorApp): string[] {
  const patched = fs.readFileSync(app.workbenchFile, "utf8");
  if (!PATCH_BLOCK_PATTERN.test(patched)) return [`Cursor ${app.version} is not patched.`];
  const clean = patched.replace(PATCH_BLOCK_PATTERN, "");
  writeFileOrExplain(app.workbenchFile, clean);
  updateChecksum(app, clean);
  return [`Removed the patch from Cursor ${app.version}. Restart Cursor to finish.`];
}

/** Run Cursor's own command-line tool. `action` names the step in the error message. */
function runCursorCli(app: CursorApp, args: string[], action: string, extensionsFolder?: string): void {
  const cursorCli = path.join(app.appFolder, "bin", process.platform === "win32" ? "cursor.cmd" : "cursor");
  if (!fs.existsSync(cursorCli)) throw new Error(`Missing Cursor's command-line tool at ${cursorCli}.`);

  if (extensionsFolder) args = [...args, "--extensions-dir", path.resolve(extensionsFolder)];
  // On Windows a .cmd file can only run through the shell, so quote every part.
  const result = process.platform === "win32"
    ? spawnSync([cursorCli, ...args].map((part) => `"${part}"`).join(" "), { shell: true, encoding: "utf8" })
    : spawnSync(cursorCli, args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0) throw new Error(`${action} failed:\n${output}`);
}

/** Install the bridge extension with Cursor's own command-line tool. */
export function installExtension(app: CursorApp, extensionsFolder?: string): string[] {
  const vsixFile = path.join(__dirname, "agent-diff.vsix");
  if (!fs.existsSync(vsixFile)) throw new Error(`Missing ${vsixFile}. Run "npm run build" first.`);
  runCursorCli(app, ["--install-extension", vsixFile, "--force"], "Installing the extension", extensionsFolder);
  return ["Installed the agent-diff extension."];
}

export function uninstallExtension(app: CursorApp, extensionsFolder?: string): string[] {
  runCursorCli(app, ["--uninstall-extension", "local.agent-diff"], "Removing the extension", extensionsFolder);
  return ["Removed the agent-diff extension."];
}
