// Two silent, severe defects in the ACP path, both invisible until agents moved
// onto it in 0.1.48:
//
// 1. session/new sent `mcpServers: []` hardcoded, so an ACP agent had NO agensis
//    tools — no read_doc, no list_docs, no post_message, no whoami. The classic
//    path had always wired them, so the capability just vanished.
//
// 2. session/request_permission was answered with a FLAT outcome. The harness
//    reads `response.outcome.outcome`; flat makes that undefined, so it took its
//    else branch and told the model
//    { behavior: "deny", message: "User refused permission to run tool", interrupt: true }.
//    Every tool call became a refusal the human never made, and it aborted the
//    turn — which is why agents with full permissions could not write files.
//
// The shapes asserted here are the ones @zed-industries/claude-code-acp actually
// reads in createSession/canUseTool. They are a WIRE CONTRACT with a separate
// program: a "tidier" shape is a silent outage, so it is pinned.

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loadExecutor = () => import(pathToFileURL(path.join(root, "packages/agensis-cli/src/acp/executor.mjs")).href);

test("the agensis MCP server is built in the shape session/new expects", async () => {
  const { acpMcpServers } = await loadExecutor();
  const servers = acpMcpServers({
    url: "https://agensis-backend.fly.dev/backend/mcp",
    env: { AGENSIS_MCP_TOKEN: "aga_secret" },
  });

  assert.equal(servers.length, 1);
  const [server] = servers;
  assert.equal(server.type, "http");
  assert.equal(server.name, "agensis", 'the harness keys servers by name — it must be stable');
  assert.equal(server.url, "https://agensis-backend.fly.dev/backend/mcp");
  // A LIST of {name,value}: the harness does Object.fromEntries(headers.map(...)),
  // so an object here arrives as nonsense and the server authenticates as nobody.
  assert.deepEqual(server.headers, [{ name: "Authorization", value: "Bearer aga_secret" }]);
});

test("no MCP runtime configured means no server entry, not a broken one", async () => {
  const { acpMcpServers } = await loadExecutor();
  assert.deepEqual(acpMcpServers(null), []);
  assert.deepEqual(acpMcpServers({ url: "" }), []);
  // A URL with no token is still worth sending — the server decides on auth.
  assert.equal(acpMcpServers({ url: "https://x/mcp" })[0].headers, undefined);
});

test("agensis permission modes map onto ACP session modes", async () => {
  const { acpPermissionMode } = await loadExecutor();
  // bypassPermissions is the ONLY value that stops the harness asking at all.
  assert.equal(acpPermissionMode("yolo"), "bypassPermissions");
  assert.equal(acpPermissionMode("accept_edits"), "acceptEdits");
  assert.equal(acpPermissionMode("default"), "default");
  assert.equal(acpPermissionMode(""), "default");
  assert.equal(acpPermissionMode(undefined), "default");
});

test("an auto-approved permission reply nests its outcome, as the harness reads it", async () => {
  // Drive the real client's stdin/stdout handling against a fake harness process
  // so the exact JSON-RPC frame is asserted, not a helper's return value.
  const { createAcpClient } = await import(
    pathToFileURL(path.join(root, "packages/agensis-cli/src/acp/client.mjs")).href
  );
  const fs = await import("node:fs");
  const os = await import("node:os");
  const outFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "acp-perm-")),
    "reply.json",
  );

  // A harness that asks exactly one permission question and records the answer it
  // was given — the real thing this contract is with.
  const script = `
    const fs = require("node:fs");
    let buf = "";
    process.stdin.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\\n")) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: 9001, method: "session/request_permission",
            params: { sessionId: "s1", options: [
              { kind: "allow_always", name: "Always Allow", optionId: "allow_always" },
              { kind: "allow_once", name: "Allow", optionId: "allow" },
              { kind: "reject_once", name: "Reject", optionId: "reject" },
            ] },
          }) + "\\n");
        } else if (msg.id === 9001) {
          fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(msg.result));
        }
      }
    });
  `;

  const client = createAcpClient({
    command: process.execPath,
    args: ["-e", script],
    cwd: root,
    autoApprove: true,
    onLog: () => {},
  });

  client.initialize().catch(() => {});

  const deadline = Date.now() + 10_000;
  let reply = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(outFile)) { reply = JSON.parse(fs.readFileSync(outFile, "utf8")); break; }
    await new Promise((r) => setTimeout(r, 25));
  }
  client.dispose();
  assert.ok(reply, "the client never answered the permission request");

  // THE REGRESSION. Flat here is a silent, total permission failure.
  assert.deepEqual(
    reply,
    { outcome: { outcome: "selected", optionId: "allow" } },
    'the harness reads response.outcome.outcome — a flat outcome reads as a refusal',
  );
  assert.notEqual(reply.outcome.optionId, "allow_always", "a blanket grant is a human's call, not ours");
});
