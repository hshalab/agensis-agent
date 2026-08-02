// Minimal ACP client over a child process stdio (NDJSON JSON-RPC 2.0).
// Ported from agensis electron/acp/client.cjs for the Relay CLI.
// Spec: https://agentclientprotocol.com/protocol/overview

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve as pathResolve } from "node:path";

export const PROTOCOL_VERSION = 1;

function buildPathEnv() {
  const parts = [];
  if (process.env.PATH) parts.push(...process.env.PATH.split(delimiter).filter(Boolean));
  const home = homedir();
  parts.push(
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".grok", "bin"),
    join(home, ".volta", "bin"),
  );
  const seen = new Set();
  return parts.filter((p) => {
    if (!p || seen.has(p)) return false;
    seen.add(p);
    return true;
  }).join(delimiter);
}

export function extractTextFromUpdate(update) {
  if (!update || typeof update !== "object") return "";
  const sessionUpdate = String(update.sessionUpdate || update.session_update || update.type || "");
  const isAgentMessage = sessionUpdate === "agent_message_chunk"
    || sessionUpdate === "agent_message"
    || sessionUpdate === "message";
  if (!isAgentMessage) return "";

  const content = update.content || update.message?.content;
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (Array.isArray(content)) {
      return content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("");
    }
  }
  if (typeof update.text === "string") return update.text;
  return "";
}

export function extractTextFromResult(result) {
  if (!result || typeof result !== "object") return "";
  if (typeof result.text === "string") return result.text;
  if (Array.isArray(result.content)) {
    return result.content.map((c) => c?.text || "").join("");
  }
  return "";
}

/**
 * @param {{
 *   command: string,
 *   args?: string[],
 *   cwd?: string,
 *   env?: Record<string, string>,
 *   autoApprove?: boolean,
 *   mcpServers?: Array<object>,
 *   permissionMode?: string,
 *   onUpdate?: (params: object) => void,
 *   onLog?: (line: string) => void,
 *   clientName?: string,
 * }} options
 */
export function createAcpClient(options) {
  const {
    command,
    args = [],
    cwd = process.cwd(),
    env = {},
    autoApprove = true,
    mcpServers = [],
    permissionMode = "",
    onUpdate = null,
    onLog = null,
    clientName = "agensis-agent",
  } = options;

  let nextId = 1;
  /** @type {Map<number, { resolve: Function, reject: Function }>} */
  const pending = new Map();
  /** @type {Set<(params: object) => void>} */
  const updateHandlers = new Set();
  if (typeof onUpdate === "function") updateHandlers.add(onUpdate);

  let closed = false;
  let buffer = "";
  let sessionId = null;
  let initializeResult = null;

  const log = (line) => {
    if (typeof onLog === "function") onLog(line);
  };

  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      PATH: buildPathEnv(),
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk || "").split("\n")) {
      if (line.trim()) log(`[stderr] ${line}`);
    }
  });

  child.on("error", (err) => {
    closed = true;
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });

  child.on("exit", (code, signal) => {
    closed = true;
    const err = new Error(`ACP process exited (code=${code}, signal=${signal || "none"})`);
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log(`[bad-json] ${line.slice(0, 200)}`);
        continue;
      }
      handleMessage(msg);
    }
  });

  function write(msg) {
    if (closed || !child.stdin.writable) {
      throw new Error("ACP process is not writable");
    }
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  function request(method, params = {}) {
    if (closed) return Promise.reject(new Error("ACP process is closed"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  function notify(method, params = {}) {
    write({ jsonrpc: "2.0", method, params });
  }

  function emitUpdate(params) {
    for (const handler of updateHandlers) {
      try {
        handler(params);
      } catch {
        // never break the pipe
      }
    }
  }

  function handleMessage(msg) {
    if (msg && Object.prototype.hasOwnProperty.call(msg, "id")
      && (msg.result !== undefined || msg.error)) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || JSON.stringify(msg.error));
        err.code = msg.error.code;
        err.data = msg.error.data;
        waiter.reject(err);
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }

    if (msg && msg.method && Object.prototype.hasOwnProperty.call(msg, "id")) {
      void handleAgentRequest(msg).catch((err) => {
        try {
          write({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: err?.message || String(err) },
          });
        } catch {
          // process gone
        }
      });
      return;
    }

    if (msg && msg.method === "session/update") {
      emitUpdate(msg.params || {});
      return;
    }
    if (msg && msg.method) log(`[notify] ${msg.method}`);
  }

  async function handleAgentRequest(msg) {
    const method = msg.method;
    const params = msg.params || {};

    if (method === "session/request_permission") {
      const optionsList = Array.isArray(params.options) ? params.options : [];
      // Prefer a one-shot allow over allow_always: a blanket grant is the agent's
      // to keep for the session, and "Always" is a decision a human makes.
      const allow = optionsList.find((o) => /^allow(_once)?$/i.test(String(o?.optionId || "")))
        || optionsList.find((o) => /allow|accept|yes|approve/i.test(
          String(o?.optionId || o?.name || o?.kind || ""),
        ))
        || optionsList[0];
      // RequestPermissionResponse nests the outcome: { outcome: { outcome, optionId } }.
      // Sending it FLAT is silently fatal — the harness reads response.outcome.outcome,
      // gets undefined, falls to its else branch and answers the model with
      // { behavior: "deny", message: "User refused permission to run tool", interrupt: true }.
      // So every tool call became a refusal the human never made, and the turn aborted:
      // agents that plainly had permission could not write files.
      const result = autoApprove
        ? { outcome: { outcome: "selected", optionId: allow?.optionId || allow?.id || "allow" } }
        : { outcome: { outcome: "cancelled" } };
      write({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }

    if (method === "fs/read_text_file") {
      const filePath = String(params.path || "");
      if (!isAbsolute(filePath)) {
        write({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "path must be absolute" },
        });
        return;
      }
      try {
        let content = readFileSync(filePath, "utf8");
        const max = 512 * 1024;
        if (content.length > max) content = content.slice(0, max);
        write({ jsonrpc: "2.0", id: msg.id, result: { content } });
      } catch (err) {
        write({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: err?.message || String(err) },
        });
      }
      return;
    }

    if (method === "fs/write_text_file") {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "fs/write_text_file not enabled in agensis-agent ACP v1" },
      });
      return;
    }

    write({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }

  async function initialize() {
    initializeResult = await request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: clientName, title: "agensis-agent", version: process.env.npm_package_version || "0.1.0" },
    });
    try {
      notify("notifications/initialized", {});
    } catch {
      // optional
    }
    return initializeResult;
  }

  async function newSession(sessionCwd = cwd) {
    // mcpServers is how an ACP agent is given tools. Sending [] — which this did,
    // hardcoded — is why agents over ACP had no agensis tools at all: no read_doc,
    // no list_docs, no post_message, no whoami. The classic path had always wired
    // them (connectionExecutors.mjs), so the capability silently vanished the day
    // jobs started preferring ACP.
    const result = await request("session/new", {
      cwd: pathResolve(sessionCwd),
      mcpServers: Array.isArray(mcpServers) ? mcpServers : [],
    });
    sessionId = result?.sessionId || result?.session_id || result?.id || null;
    if (!sessionId) throw new Error("session/new did not return a sessionId");
    // The agent's configured permission mode has to be ASSERTED — a harness starts
    // every session at "default" and there is no session/new field for it. Without
    // this a yolo agent is still asked to approve each tool call, which is both
    // wrong and, before the response-shape fix above, fatal.
    if (permissionMode) {
      try {
        await request("session/set_mode", { sessionId, modeId: permissionMode });
      } catch (error) {
        // Older or simpler harnesses may not implement modes. Auto-approve still
        // covers us, so this is a degradation, not a failure.
        log(`[acp] session/set_mode ${permissionMode} not accepted: ${error?.message || error}`);
      }
    }
    return result;
  }

  /**
   * @param {string} text
   * @param {{ onChunk?: (text: string) => void }} [opts]
   */
  async function prompt(text, opts = {}) {
    if (!sessionId) throw new Error("No ACP session — call newSession first");
    const chunks = [];
    const handler = (params) => {
      const update = params?.update || params;
      const bit = extractTextFromUpdate(update);
      if (bit) {
        chunks.push(bit);
        if (typeof opts.onChunk === "function") opts.onChunk(bit);
      }
    };
    updateHandlers.add(handler);
    try {
      const result = await request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: String(text || "") }],
      });
      const reply = chunks.join("") || extractTextFromResult(result) || "";
      return {
        stopReason: result?.stopReason || result?.stop_reason || "end_turn",
        text: reply,
        result,
      };
    } finally {
      updateHandlers.delete(handler);
    }
  }

  function cancel() {
    if (!sessionId || closed) return;
    try {
      notify("session/cancel", { sessionId });
    } catch {
      // ignore
    }
  }

  function dispose() {
    closed = true;
    try { child.stdin.end(); } catch { /* ignore */ }
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    const t = setTimeout(() => {
      try {
        if (!child.killed) child.kill("SIGKILL");
      } catch { /* ignore */ }
    }, 2000);
    if (typeof t.unref === "function") t.unref();
  }

  return {
    get sessionId() { return sessionId; },
    get initializeResult() { return initializeResult; },
    get pid() { return child.pid; },
    get closed() { return closed; },
    initialize,
    newSession,
    prompt,
    cancel,
    dispose,
    request,
  };
}
