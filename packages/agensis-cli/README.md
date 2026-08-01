# Agensis Agent source

**Relay host** source for agensis workspace agents (published as
`@agensis/agensis-agent`). The installed command is `agensis`.

It connects over WebSocket, receives jobs for agents set to **Relay** in the UI,
runs your coding CLI in the local folder, and posts results back. Same job path
as desktop ACP. **Direct** agents run on agensis servers (this package is not
used). **Connector** is MCP.

This workspace contains the readable source for the published package.

## Install

```sh
npm install -g @agensis/agensis-agent
```

Or run without a global install:

```sh
npx @agensis/agensis-agent connect --help
```

## Connect a Relay agent

In agensis, set the agent to **Relay**, open Connect, and copy the generated
command. It should look like:

```sh
agensis connect \
  --url https://agensis.io \
  --token aga_... \
  --workspace <workspace-id> \
  --agent <agent-id> \
  --handle general \
  --name general \
  --model claude-haiku-4-5 \
  --permission-mode default
```

Run it from the folder where the coding CLI should execute:

```sh
cd /path/to/repo
agensis connect --url ... --token ... --workspace ... --agent ...
```

The command stays connected, sends heartbeats, accepts queued jobs, and exits on
Ctrl+C.

## Options

Required:

- `--url <url>`: agensis app/backend URL, for example `https://agensis.io` or `http://localhost:5173`
- `--token <token>`: agent connection token from agensis
- `--workspace <id>`: workspace id
- `--agent <id>`: workspace agent id

Optional:

- `--handle <name>`: mention handle used in channels
- `--name <name>`: display name
- `--cwd <path>`: folder where the coding CLI runs
- `--runtime <runtime>`: lock this profile to `claude`, `codex`, or `amp`
- `--coding-cmd <command>`: command used for jobs, default `claude -p`
- `--amp-cmd <path>`: Amp CLI executable used by Amp Orb agents, default `amp`
- `--no-coding`: disable coding jobs while keeping presence or shared inference online
- `--full-cli-context`: opt out of the default lean launch and load all user-level
  Claude/Codex skills, plugins, hooks, memory, and MCP servers
- `--max-concurrency <n>`: simultaneous coding CLI jobs, default `2`
- `--model <id>`: default model passed to supported coding CLIs
- `--permission-mode <mode>`: `default`, `accept_edits`, or `yolo`
- `--yolo`: alias for `--permission-mode yolo`
- `--no-sandbox`: alias for `--permission-mode yolo`
- `--timeout-ms <ms>`: kill a job after this time, default `1800000`
- `--heartbeat-ms <ms>`: local terminal heartbeat interval, default `15000`
- `--share`: advertise the models in `--shared-models-file` to this workspace
- `--shared-models-file <path>`: JSON configuration for loopback OpenAI-compatible models
- `--once`: run one queued job then exit
- `--version`: print the CLI version
- `--help`: show help

Environment fallbacks:

- `AGENSIS_URL`
- `AGENSIS_TOKEN`
- `AGENSIS_WORKSPACE` or `AGENSIS_WORKSPACE_ID`
- `AGENSIS_AGENT` or `AGENSIS_AGENT_ID`
- `AGENSIS_HANDLE`
- `AGENSIS_NAME`
- `AGENSIS_CWD`
- `AGENSIS_RUNTIME`
- `AGENSIS_CODING_CMD` or `CODING_CMD`
- `AGENSIS_AMP_CMD`
- `AGENSIS_NO_CODING=1`
- `AGENSIS_MODEL` or `CLAUDE_MODEL`
- `AGENSIS_PERMISSION_MODE`
- `AGENSIS_TIMEOUT_MS`
- `AGENSIS_HEARTBEAT_MS`
- `AGENSIS_SHARE=1`
- `AGENSIS_SHARED_MODELS_FILE`
- `AGENSIS_ONCE=1`

## Run Amp Orb Agents

Create an **Amp Orb** agent from the Agensis template gallery, then connect that
agent from the repository it should work on using the normal copied `agensis
connect --runtime amp` command. The daemon uses the Amp CLI on this machine to start a fresh
orb for the first message in an Agensis conversation and continues the exact Amp
thread for later messages in that conversation.

Before connecting:

```sh
amp version
amp usage
amp projects status --json
```

The repository must be an Amp project that the signed-in account can access. If
the repository has an `.agents/setup` script, make it executable so Amp can run
it while preparing a fresh orb. A nonstandard Amp installation can be selected
with `--amp-cmd /path/to/amp` or `AGENSIS_AMP_CMD`.

Amp account credentials and billing stay on this daemon host. Agensis receives
the streamed conversation output and the Amp thread ID/link, never the account
token. Missing CLI, unsupported versions, signed-out or expired accounts,
project access, setup, credit, provisioning, cancellation, timeout, and missing
thread failures are returned to the Agensis conversation as explicit errors;
an Amp agent never falls back to another coding CLI.

Committed repository guidance and skills are cloned into the orb with the
repository. That includes `AGENTS.md` and skills under `.agents/skills` or
`.claude/skills`. Host-global skills and skill bodies stored only in Agensis are
not copied into an orb; move any required skill into the repository first.

## Share Local Inference

The daemon can make a model running on the same machine available to its
Agensis workspace and a paired Agent Farm. The upstream endpoint must resolve
to loopback; private endpoint and key fields are never sent in the capability
advertisement.

```json
{
  "models": [
    {
      "id": "qwen3-8b",
      "name": "Qwen 3 8B",
      "provider": "ollama",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "upstreamModel": "qwen3:8b",
      "capabilities": ["text", "streaming", "tools"],
      "maxConcurrency": 2
    }
  ]
}
```

```sh
agensis connect \
  --url https://agensis.io \
  --token aga_... \
  --workspace <workspace-id> \
  --agent <agent-id> \
  --share \
  --shared-models-file ./shared-models.json
```

Each model appears in the Agensis chat selector as a workspace-scoped route.
Inference requests relay over the existing authenticated daemon connection;
the model server does not need a public listener.

## Tool approvals

In the default permission mode the daemon asks a human before running a tool the
agent isn't already cleared for. The request goes to agensis as an
`agent_permission_request` frame, appears as a card in the conversation the job
is running in, and the answer comes back as `agent_permission_decision`. The
turn parks until someone answers; after `AGENSIS_PERMISSION_TIMEOUT_MS` (default
10 minutes) it is refused, so the model reports "nobody approved this" rather
than the whole job dying on its own timeout.

Answers come in three widths: **once** (this call), **this session** (handed to
the coding CLI as a session rule, gone when the connection closes), and
**always** — stored on the agent in agensis and replayed into every later job,
so it survives a daemon restart.

Two things worth knowing:

- **A settings file on this host is not the grant store.** Lean mode (the
  default) runs Claude with `settingSources: []`, and the subprocess lane passes
  `--safe-mode`, so `~/.claude/settings.local.json` is not read at all. Editing
  it has no effect and produces no error. Grants live in agensis, on the agent.
- **A grant cannot reach a folder.** Access outside the working directory is a
  separate gate that no permission rule lifts — not even
  `--dangerously-skip-permissions`. Use `--host-folder` (or the agent's Host
  folders in agensis) for that.

`--permission-mode yolo` skips asking entirely and hands the coding CLI
unrestricted access to this machine; `accept_edits` auto-approves file edits
only. Codex agents can be answered once/session but not always: the app-server
has no per-rule grant to store.

## Security

The daemon runs on your machine and executes the configured coding command in
the selected working directory. Your local credentials and filesystem stay
local; agensis sends the job payload and receives the result. Treat the daemon
like any local coding agent with access to the folder you start it in.

Farm-originated coding jobs use the same queue and can be cancelled by exact job
ID. A cancellation from the authenticated workspace aborts that process without
stopping work in another channel or queue lane.

Keep `aga_...` tokens out of shared logs and shell history. Generate a fresh
token from agensis if one is exposed.

## Release checks

From the repository root, run:

```sh
npm run verify
```

Only `packages/agensis-agent` is published. This source workspace is private to
the npm monorepo so it cannot be released accidentally under the legacy name.
