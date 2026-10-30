import * as fs from "fs";
import * as pathModule from "path";
import { fileURLToPath } from "url";

// ============================================================
// textlint-lsp — pluggable natural language linting for LSP
// ============================================================

const LOG_FILE = process.env.TEXTLINT_LSP_LOG_FILE ?? "";
function log(msg: string) {
  if (!LOG_FILE) return;
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

interface Doc {
  languageId: string;
  version: number;
  text: string;
}
const docs = new Map<string, Doc>();

let textlintModule: any = null;
let textlintRoot = "";
let workspaceRoot = "";

// ============================================================
// URI → file path
// ============================================================

function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch (e) {
    log(`uriToPath failed: ${uri}: ${e}`);
    return "";
  }
}

// ============================================================
// textlint 探索
// ============================================================

function findTextlintRoot(forUri: string): string {
  if (textlintRoot) {
    try {
      require.resolve(
        pathModule.join(textlintRoot, "node_modules", "textlint"),
      );
      return textlintRoot;
    } catch {}
  }
  const candidates: string[] = [];
  if (workspaceRoot) candidates.push(workspaceRoot);
  let dir = pathModule.dirname(uriToPath(forUri));
  while (dir !== pathModule.dirname(dir)) {
    candidates.push(dir);
    dir = pathModule.dirname(dir);
  }
  for (const c of candidates) {
    if (fs.existsSync(pathModule.join(c, "node_modules", "textlint"))) {
      textlintRoot = c;
      return c;
    }
  }
  return workspaceRoot;
}

function loadTextlint(forUri: string): boolean {
  if (textlintModule) return true;
  const root = findTextlintRoot(forUri);
  try {
    textlintModule = require(pathModule.join(root, "node_modules", "textlint"));
    return true;
  } catch (e) {
    log(`loadTextlint failed: ${root}: ${e}`);
    return false;
  }
}

// ============================================================
// Linter生成（キャッシュ付き）
// ============================================================

let cachedLinter: any = null;

async function createLinter(): Promise<any> {
  if (cachedLinter) return cachedLinter;
  const { createLinter, loadTextlintrc } = textlintModule;
  const descriptor = await loadTextlintrc({
    configFilePath: pathModule.join(textlintRoot, ".textlintrc"),
  });
  cachedLinter = createLinter({
    descriptor,
    cwd: textlintRoot,
    ignoreFilePath: pathModule.join(textlintRoot, ".textlintignore"),
  });
  return cachedLinter;
}

// ============================================================
// messages → diagnostics
// ============================================================

function toDiagnostics(messages: any[], docText: string): any[] {
  return messages.map((msg: any) => {
    const sl = Math.max(0, msg.line - 1);
    const sc = Math.max(0, msg.column - 1);
    const line = docText.split("\n")[sl] ?? "";
    const el =
      line.slice(sc).match(/^[\w\u3000-\u9fff\u3040-\u309f\u30a0-\u30ff]+/)?.[0]
        ?.length ?? 1;
    return {
      severity: msg.severity === 2 ? 1 : 2,
      range: {
        start: { line: sl, character: sc },
        end: { line: sl, character: sc + el },
      },
      message: `[${msg.ruleId}] ${msg.message}`,
      source: `textlint:${msg.ruleId}`,
      code: msg.ruleId,
    };
  });
}

function offsetToPosition(
  text: string,
  offset: number,
): { line: number; character: number } {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

// ============================================================
// Lint（キャッシュ付き）
// ============================================================

// lintText does not respect .textlintignore, and lintFiles reads from disk instead of the unsaved buffer
async function isIgnored(linter: any, uri: string): Promise<boolean> {
  if (!fs.existsSync(pathModule.join(textlintRoot, ".textlintignore")))
    return false;
  try {
    const scan = await linter.scanFilePath(uriToPath(uri));
    return scan.status === "ignored";
  } catch (e) {
    log(`WARNING: .textlintignore requires textlint >= 14.1.0: ${e}`);
    return false;
  }
}

let lintSeq = 0;
const lintCache = new Map<string, { version: number; diagnostics: any[] }>();

async function lint(uri: string): Promise<any[]> {
  const doc = docs.get(uri);
  if (!doc || !loadTextlint(uri)) return [];

  const cached = lintCache.get(uri);
  if (cached && cached.version === doc.version) return cached.diagnostics;

  const ext =
    pathModule.extname(uriToPath(uri)) ||
    (doc.languageId === "mdx" ? ".mdx" : ".md");

  try {
    const originalCwd = process.cwd();
    process.chdir(textlintRoot);
    const linter = await createLinter();
    const result = (await isIgnored(linter, uri))
      ? { messages: [] }
      : await linter.lintText(doc.text, `.textlint-lsp-cache/_lint${ext}`);
    process.chdir(originalCwd);
    const diagnostics = toDiagnostics(result.messages ?? [], doc.text);
    lintCache.set(uri, { version: doc.version, diagnostics });
    return diagnostics;
  } catch (e) {
    log(`lint failed: ${uri}: ${e}`);
    return [];
  }
}

function publishDiagnostics(uri: string) {
  lint(uri).then((d) =>
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics: d },
    }),
  );
}

// ============================================================
// 10秒間隔の自動lint（編集が続く限りタイマーを延長）
// ============================================================

const lintTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleLint(uri: string) {
  const existing = lintTimers.get(uri);
  if (existing) clearTimeout(existing);
  lintTimers.set(
    uri,
    setTimeout(() => {
      lintTimers.delete(uri);
      log("scheduleLint fired: " + uri.split("/").pop());
      publishDiagnostics(uri);
    }, 10000),
  );
}

// ============================================================
// テキスト編集
// ============================================================

function applyEdit(text: string, range: any, newText: string): string {
  const lines = text.split("\n");
  const before = lines.slice(0, range.start.line);
  const startLine = lines[range.start.line] ?? "";
  const endLine = lines[range.end.line] ?? "";
  const after = lines.slice(range.end.line + 1);
  before.push(
    startLine.slice(0, range.start.character) +
      newText +
      endLine.slice(range.end.character),
  );
  before.push(...after);
  return before.join("\n");
}

// ============================================================
// CodeAction（キャッシュ＋重複除去）
// ============================================================

const caCache = new Map<string, { text: string; result: any }>();

async function getCodeActions(
  uri: string,
  contextDiagnostics: any[],
): Promise<any[]> {
  const doc = docs.get(uri);
  if (!doc || !loadTextlint(uri)) return [];

  const ext =
    pathModule.extname(uriToPath(uri)) ||
    (doc.languageId === "mdx" ? ".mdx" : ".md");
  const filePath = pathModule.join(
    textlintRoot,
    `.textlint-lsp-cache/_ca${ext}`,
  );

  // キャッシュ: 同じテキストなら再lintしない
  let result: any;
  const cached = caCache.get(uri);
  if (cached && cached.text === doc.text) {
    result = cached.result;
  } else {
    try {
      const originalCwd = process.cwd();
      process.chdir(textlintRoot);
      const linter = await createLinter();
      result = await linter.lintText(doc.text, filePath);
      process.chdir(originalCwd);
      caCache.set(uri, { text: doc.text, result });
    } catch (e) {
      log(`getCodeActions failed: ${uri}: ${e}`);
      return [];
    }
  }

  const isMdx = uri.endsWith(".mdx") || doc.languageId?.toLowerCase() === "mdx";
  const isReview = uri.endsWith(".re");
  const toComment = (directive: string) =>
    isReview
      ? `#@# ${directive}`
      : isMdx
        ? `{/* <!-- ${directive} --> */}`
        : `<!-- ${directive} -->`;
  const docLines = doc.text.split("\n");

  const actions: any[] = [];
  const seenDisable = new Set<string>();
  let seenDisableAll = false;

  for (const msg of result.messages) {
    const msgLine = msg.line - 1;
    const msgCol = msg.column - 1;
    const msgEndLine = (msg.loc?.end.line ?? msg.line) - 1;
    const msgEndLineLength = (docLines[msgEndLine] ?? "").replace(/\r$/, "")
      .length;
    if (contextDiagnostics.length === 0) continue;
    const matches = contextDiagnostics.some((d: any) => {
      const ds = d.range.start,
        de = d.range.end;
      return (
        msgLine >= ds.line &&
        msgLine <= de.line &&
        msgCol >= ds.character &&
        msgCol <= de.character
      );
    });
    if (!matches) continue;

    // fix.text が正規表現ならスキップ（prhのvalidationルールなど）
    if (
      msg.fix &&
      typeof msg.fix.text === "string" &&
      !msg.fix.text.startsWith("/")
    ) {
      const startPos = offsetToPosition(doc.text, msg.fix.range[0]);
      const endPos = offsetToPosition(doc.text, msg.fix.range[1]);
      actions.push({
        title: `[${msg.ruleId}] ${msg.message}`,
        kind: "quickfix",
        edit: {
          changes: {
            [uri]: [
              {
                range: { start: startPos, end: endPos },
                newText: msg.fix.text,
              },
            ],
          },
        },
      });
    }

    // 無効化（同一ルールは重複除去）
    const disableKey = `disable:${msg.ruleId}`;
    if (!seenDisable.has(disableKey)) {
      seenDisable.add(disableKey);
      actions.push({
        title: `無効化: ${msg.ruleId}（この行だけ）`,
        kind: "quickfix",
        edit: {
          changes: {
            [uri]: [
              {
                range: {
                  start: { line: msgLine, character: 0 },
                  end: { line: msgLine, character: 0 },
                },
                newText: `${toComment(`textlint-disable ${msg.ruleId}`)}\n`,
              },
              // Inserting at the start of the next line fails when the message is on the last line
              {
                range: {
                  start: { line: msgEndLine, character: msgEndLineLength },
                  end: { line: msgEndLine, character: msgEndLineLength },
                },
                newText: `\n${toComment(`textlint-enable ${msg.ruleId}`)}`,
              },
            ],
          },
        },
      });
    }

    // すべてのルールを無効化（1回だけ）
    if (!seenDisableAll) {
      seenDisableAll = true;
      actions.push({
        title: `無効化: すべてのルール（この行以降）`,
        kind: "quickfix",
        edit: {
          changes: {
            [uri]: [
              {
                range: {
                  start: { line: msgLine, character: 0 },
                  end: { line: msgLine, character: 0 },
                },
                newText: `${toComment("textlint-disable")}\n`,
              },
            ],
          },
        },
      });
    }
  }
  return actions;
}

// ============================================================
// JSON-RPC

// ============================================================
// JSON-RPC
// ============================================================

let rawBuffer = Buffer.alloc(0);

function send(msg: object) {
  const json = JSON.stringify(msg);
  try {
    process.stdout.write(
      `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`,
    );
  } catch {}
}

function handleRequest(msg: any) {
  const { id, method, params } = msg;
  log(`RECV: ${method}`);

  switch (method) {
    case "initialize": {
      if (params?.workspaceFolders?.[0]?.uri)
        workspaceRoot = uriToPath(params.workspaceFolders[0].uri);
      else if (params?.rootUri) workspaceRoot = uriToPath(params.rootUri);
      send({
        jsonrpc: "2.0",
        id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            codeActionProvider: true,
          },
          serverInfo: { name: "textlint-lsp", version: "0.1.1" },
        },
      });
      break;
    }

    case "initialized":
      break;
    case "shutdown": {
      send({ jsonrpc: "2.0", id, result: null });
      break;
    }

    case "textDocument/didOpen": {
      const td = params.textDocument;
      docs.set(td.uri, {
        languageId: td.languageId,
        version: td.version,
        text: td.text,
      });
      publishDiagnostics(td.uri);
      break;
    }

    case "textDocument/didChange": {
      const td = params.textDocument;
      const doc = docs.get(td.uri);
      if (!doc) break;
      for (const change of params.contentChanges) {
        if (change.range) {
          doc.text = applyEdit(doc.text, change.range, change.text ?? "");
        } else if (change.text !== undefined) {
          doc.text = change.text;
        }
      }
      doc.version = td.version;
      // 即時lint（キャッシュがあるので高速）
      publishDiagnostics(td.uri);
      break;
    }

    case "textDocument/didSave": {
      log("didSave: " + params.textDocument.uri.split("/").pop());
      publishDiagnostics(params.textDocument.uri);
      break;
    }

    case "textDocument/didClose": {
      const uri = params.textDocument.uri;
      const t = lintTimers.get(uri);
      if (t) {
        clearTimeout(t);
        lintTimers.delete(uri);
      }
      docs.delete(uri);
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri, diagnostics: [] },
      });
      break;
    }

    case "textDocument/codeAction": {
      const uri = params.textDocument.uri;
      const rid = id;
      getCodeActions(uri, params.context?.diagnostics ?? [])
        .then((a) => send({ jsonrpc: "2.0", id: rid, result: a }))
        .catch((e: any) => {
          log(`codeAction failed: ${uri}: ${e}`);
          send({ jsonrpc: "2.0", id: rid, result: [] });
        });
      break;
    }

    default:
      log(`UNHANDLED: ${method}`);
      break;
  }
}

function processBuffer() {
  while (rawBuffer.length > 0) {
    const peek = rawBuffer.toString(
      "utf-8",
      0,
      Math.min(rawBuffer.length, 200),
    );
    const h = peek.match(/^Content-Length: (\d+)\r\n\r\n/);
    if (!h) {
      const f = rawBuffer.toString("utf-8");
      const n = f.search(/Content-Length: \d+\r\n\r\n/);
      if (n > 0) {
        rawBuffer = rawBuffer.slice(n);
        continue;
      }
      break;
    }
    const cl = parseInt(h[1], 10);
    const hl = Buffer.byteLength(h[0], "utf-8");
    if (rawBuffer.length < hl + cl) break;
    const body = rawBuffer.slice(hl, hl + cl);
    rawBuffer = rawBuffer.slice(hl + cl);
    try {
      handleRequest(JSON.parse(body.toString("utf-8")));
    } catch (e) {
      log(`handleRequest failed: ${e}`);
    }
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  rawBuffer = Buffer.concat([rawBuffer, chunk]);
  processBuffer();
});
process.stdin.on("end", () => process.exit(0));
