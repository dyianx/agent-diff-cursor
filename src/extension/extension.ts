// Runs in each Cursor window. The patched code inside Cursor cannot open a network port,
// so this extension listens on 127.0.0.1 and passes CLI requests to the patched commands.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  ClearRequest,
  DiffInfo,
  PATCH_COMMANDS,
  PATCH_VERSION,
  PROOF_HEADER,
  ShowRequest,
  ShowResult,
  WindowInfo,
  WindowStatus,
  getWindowsFolder,
  makePrivateFolder,
} from "../shared/common";

const MAX_REQUEST_BYTES = 50 * 1024 * 1024;

let server: http.Server | undefined;
let windowFile: string | undefined;

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const token = crypto.randomBytes(24).toString("hex");
  const proof = crypto.randomBytes(24).toString("hex");
  const startedAt = Date.now();
  const log = vscode.window.createOutputChannel("Agent Diff");
  context.subscriptions.push(log);

  server = http.createServer((request, response) => {
    // Only callers with the token get the proof, so nobody can learn it and pretend to be this window later.
    const isTokenRight = request.headers.authorization === `Bearer ${token}`;
    if (isTokenRight) response.setHeader(PROOF_HEADER, proof);
    (isTokenRight ? handleRequest(request) : Promise.reject(new RequestError(403, "Wrong token.")))
      .then((body) => sendJson(response, 200, body))
      .catch((error: unknown) => {
        const status = error instanceof RequestError ? error.status : 500;
        const message = error instanceof Error ? error.message : String(error);
        if (status === 500) log.appendLine(`Request failed: ${message}`);
        sendJson(response, status, { error: message });
      });
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  makePrivateFolder(getWindowsFolder());
  windowFile = path.join(getWindowsFolder(), `${process.pid}-${port}.json`);
  const saveWindowFile = () => {
    const info: WindowInfo = { port, token, proof, pid: process.pid, folders: getOpenFolders(), startedAt };
    fs.writeFileSync(windowFile!, JSON.stringify(info), { mode: 0o600 });
  };
  saveWindowFile();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(saveWindowFile));
  context.subscriptions.push({ dispose: stop });

  const patchVersion = await getPatchVersion();
  log.appendLine(patchVersion === null
    ? "Cursor is not patched. Run: agent-diff install"
    : `Ready on port ${port} (patch version ${patchVersion}).`);
  if (patchVersion !== PATCH_VERSION) {
    // Every Cursor update replaces the patched file, so this is the usual reason the tool stops working.
    const reason = patchVersion === null
      ? "Cursor is not patched. This happens after every Cursor update."
      : `Cursor has patch version ${patchVersion}, but this extension needs version ${PATCH_VERSION}.`;
    void vscode.window.showWarningMessage(`Agent Diff: ${reason} Close Cursor and run: agent-diff install`);
  }
}

export function deactivate(): void {
  stop();
}

function stop(): void {
  server?.close();
  server = undefined;
  if (windowFile) fs.rmSync(windowFile, { force: true });
  windowFile = undefined;
}

function getOpenFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => folder.uri.fsPath);
}

async function getPatchVersion(): Promise<number | null> {
  try {
    const version = await vscode.commands.executeCommand<number>(PATCH_COMMANDS.version);
    return typeof version === "number" ? version : null;
  } catch {
    return null;
  }
}

/** Call a patched command, with a clear message when the patch is missing. */
async function runPatchCommand<T>(command: string, ...args: unknown[]): Promise<T> {
  if ((await getPatchVersion()) === null) {
    throw new RequestError(409, "Cursor is not patched, or was updated since. Run: agent-diff install, then restart Cursor.");
  }
  return vscode.commands.executeCommand<T>(command, ...args);
}

async function handleRequest(request: http.IncomingMessage): Promise<unknown> {
  const route = `${request.method} ${request.url}`;

  if (route === "GET /status") {
    const status: WindowStatus = { patchVersion: await getPatchVersion(), folders: getOpenFolders(), editorVersion: vscode.version };
    return status;
  }
  if (route === "POST /list") {
    return runPatchCommand<DiffInfo[]>(PATCH_COMMANDS.list);
  }
  if (route === "POST /show") {
    const body = (await readJson(request)) as ShowRequest;
    if (typeof body.path !== "string" || !path.isAbsolute(body.path)) throw new RequestError(400, "path must be an absolute path.");
    if (body.original !== null && typeof body.original !== "string") throw new RequestError(400, "original must be text or null.");
    const uri = vscode.Uri.file(body.path);
    const result = await runPatchCommand<ShowResult>(PATCH_COMMANDS.show, uri, body.original);
    if (body.open && result.changed) {
      await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true });
    }
    return result;
  }
  if (route === "POST /clear") {
    const body = (await readJson(request)) as ClearRequest;
    const uri = typeof body.path === "string" ? vscode.Uri.file(body.path) : undefined;
    return runPatchCommand<{ cleared: number }>(PATCH_COMMANDS.clear, uri);
  }
  throw new RequestError(404, `Unknown request: ${route}`);
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new RequestError(413, "Request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new RequestError(400, "Request body is not valid JSON.");
  }
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}
