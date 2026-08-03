// Direct (non-ACP) headless streaming lane.
//
// This is the SECOND choice, not the first. Measured on a real Mac (2026-08,
// trivial prompt, grok):
//
//   warm ACP session ....  5221ms, 2525ms, 2426ms   (handshake 6331ms, paid once)
//   direct re-spawn ..... 14191ms, 15394ms, 16956ms (cold start EVERY turn)
//
// A direct invocation cannot hold a session, so it pays full startup per turn.
// It exists because the previous fallback for a harness agent was
// LocalExecutor — which runs the generic coding command (`claude -p` by
// default). For a Grok or Kimi agent that is both slower AND the wrong model.
// Falling back to the tool's OWN headless mode keeps the agent itself correct.
//
// claude / codex / amp are absent on purpose: they have native runtimes (the
// Claude Agent SDK and the Codex app-server) and must never be routed here.

import { spawn } from "node:child_process";
import { resolveCommandPath } from "./resolve.mjs";

/**
 * Per-tool headless invocation + how to read text out of it.
 *
 * `stream: true` means the tool emits incremental output we can forward as it
 * arrives, so a human sees tokens rather than a wall of text at the end.
 */
export const DIRECT_RUNNERS = {
  grok: {
    bin: "grok",
    // streaming-messages-json is the Anthropic Messages API wire format — the
    // same shape the Claude SDK lane already produces.
    build: (prompt, model) => [
      "-p", prompt,
      "--output-format", "streaming-messages-json",
      "--include-partial-messages",
      "--always-approve",
      ...(model && model !== "auto" ? ["-m", model] : []),
    ],
    stream: true,
  },
  cursor: {
    bin: "cursor-agent",
    build: (prompt, model) => [
      "-p", prompt,
      "--output-format", "stream-json",
      "--stream-partial-output",
      "--force",
      ...(model && model !== "auto" ? ["--model", model] : []),
    ],
    stream: true,
  },
  kimi: {
    bin: "kimi",
    // NOTE: kimi rejects `--prompt` combined with `--yolo` ("Cannot combine
    // --prompt with --yolo"), so permission flags are deliberately omitted.
    build: (prompt, model) => [
      "-p", prompt,
      "--output-format", "stream-json",
      ...(model && model !== "auto" ? ["-m", model] : []),
    ],
    stream: true,
  },
  goose: { bin: "goose", build: (prompt) => ["run", "-t", prompt], stream: false },
  hermes: { bin: "hermes", build: (prompt) => ["-z", prompt, "--yolo"], stream: false },
  opencode: { bin: "opencode", build: (prompt) => ["run", prompt], stream: false },
  openclaw: { bin: "openclaw", build: (prompt) => ["-p", prompt], stream: false },
};

/** @returns {{ command: string, args: string[], stream: boolean } | null} */
export function directRunnerFor(id, { prompt = "", model = "", pathEnv } = {}) {
  const spec = DIRECT_RUNNERS[String(id || "").trim().toLowerCase()];
  if (!spec) return null;
  const command = resolveCommandPath(spec.bin, pathEnv ? { pathEnv } : {});
  if (!command) return null;
  return { command, args: spec.build(prompt, String(model || "").trim()), stream: spec.stream };
}

/**
 * Pull human-readable text out of one NDJSON line.
 *
 * Handles the Anthropic Messages shape (grok) and the looser stream-json shapes
 * cursor/kimi emit. Returns "" for control frames (init, usage, tool events) so
 * they never leak into an agent's reply.
 */
export function parseStreamLine(line) {
  const none = { delta: "", final: null };
  const trimmed = String(line || "").trim();
  if (!trimmed) return none;
  // A plain-text tool: the line IS the output.
  if (!trimmed.startsWith("{")) return { delta: trimmed, final: null };
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return none; }

  // grok wraps every Anthropic frame: {type:"stream_event", event:{...}}.
  // Checking the outer type alone matches nothing — the deltas live inside.
  const ev = msg.type === "stream_event" && msg.event ? msg.event : msg;

  // Incremental assistant text.
  if (ev.type === "content_block_delta") {
    // thinking_delta is the model's PRIVATE reasoning. It must never be
    // forwarded as reply text — grok emits a full paragraph of it before the
    // answer, and surfacing it would leak reasoning into the channel.
    if (ev.delta?.type === "text_delta") return { delta: String(ev.delta.text || ""), final: null };
    return none;
  }
  if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
    return { delta: String(ev.content_block.text || ""), final: null };
  }
  // Control frames: session ids, config, usage. Never reply text.
  if (ev.type === "system" || ev.type === "message_start" || ev.type === "message_stop"
      || ev.type === "message_delta" || ev.type === "content_block_stop") {
    return none;
  }

  // The authoritative final answer. Returned as `final`, NOT as a delta —
  // appending it after streaming the same text is what produced "OKOK".
  if (msg.type === "result") {
    return typeof msg.result === "string" ? { delta: "", final: msg.result } : none;
  }

  // A whole-message recap (grok's trailing {type:"assistant"}, and the only
  // shape some stream-json tools emit). Also a `final` candidate, so a tool
  // that never streams deltas still yields its answer exactly once.
  const content = msg.message?.content ?? msg.content;
  if (Array.isArray(content)) {
    const text = content.filter((c) => c?.type === "text").map((c) => String(c.text || "")).join("");
    return text ? { delta: "", final: text } : none;
  }
  if (typeof msg.text === "string" && msg.type !== "user") return { delta: "", final: msg.text };
  return none;
}

/** Back-compat helper: the incremental text of one line, if any. */
export function textFromStreamLine(line) {
  return parseStreamLine(line).delta;
}

/**
 * Executor over a tool's own headless mode.
 * Same {status,stdout,stderr,error,stop} contract as the ACP and local paths.
 */
export function createDirectExecutor({ harnessId, config, log = console } = {}) {
  return {
    async run(opts = {}) {
      const prompt = opts.prompt != null
        ? String(opts.prompt)
        : String(Array.isArray(opts.args) ? opts.args[opts.args.length - 1] : "");
      const model = String(opts.model || config?.model || "").trim();
      const runner = directRunnerFor(harnessId, { prompt, model });
      if (!runner) {
        return { status: null, stdout: "", stderr: "", error: new Error(`No direct runner for "${harnessId}"`), stop: null, direct: false };
      }

      const cwd = opts.cwd || config?.cwd || process.cwd();
      log.log?.(`[direct] ${harnessId} headless turn (cold start; ACP would be warmer)`);

      return await new Promise((resolve) => {
        let child;
        try {
          child = spawn(runner.command, runner.args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
        } catch (error) {
          return resolve({ status: null, stdout: "", stderr: "", error, stop: null, direct: false });
        }

        let raw = "", text = "", stderr = "", buffer = "", settled = false;
        // The last authoritative whole answer (result frame / message recap).
        // Kept SEPARATE from streamed deltas: appending it to text that was
        // already streamed is what duplicated a reply into "OKOK".
        let finalText = null;
        const consume = (line) => {
          const { delta, final } = parseStreamLine(line);
          if (final !== null) finalText = final;
          if (delta) { text += delta; if (typeof opts.onData === "function") opts.onData(delta); }
        };
        const onAbort = () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } };
        opts.signal?.addEventListener?.("abort", onAbort, { once: true });

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          raw += chunk;
          if (!runner.stream) { if (typeof opts.onData === "function") opts.onData(String(chunk)); return; }
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            consume(line);
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => { stderr += chunk; });

        const finish = (result) => {
          if (settled) return;
          settled = true;
          opts.signal?.removeEventListener?.("abort", onAbort);
          resolve(result);
        };

        child.on("error", (error) => finish({ status: null, stdout: "", stderr, error, stop: null, direct: false }));
        child.on("close", (code) => {
          if (runner.stream && buffer.trim()) consume(buffer);
          // Prefer the authoritative final answer; fall back to what we
          // streamed; and if structured parsing found nothing at all, return
          // the raw output rather than an empty reply — silently swallowing a
          // real answer is far worse than returning an unparsed one.
          const stdout = runner.stream ? (finalText ?? (text || raw)) : raw;
          finish({
            status: code,
            stdout,
            stderr,
            error: code === 0 ? null : new Error(stderr.trim() || `${harnessId} exited with code ${code}`),
            stop: code === 0 ? "end_turn" : null,
            direct: true,
            harnessId,
          });
        });
      });
    },
  };
}
