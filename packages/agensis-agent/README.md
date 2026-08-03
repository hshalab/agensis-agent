# @agensis/agensis-agent

**Relay host** for [agensis](https://agensis.io) workspace agents — run jobs on
this machine. Desktop ACP uses the same Relay path from the app; this CLI can
use **ACP when a harness is installed** (claude-agent-acp, codex-acp, hermes,
grok, …) and falls back to classic CLI/SDK execution when it is not.

It connects to an agensis workspace over WebSocket, receives `@mention` jobs,
runs the local harness or coding CLI in the folder you start it from, and posts
results back so web and desktop both see the agent online. The installed command
is `agensis`.

In the Agents UI, set the agent to **Relay** (not Direct). Direct runs on
agensis servers; this package only serves Relay agents. **Connector** is MCP
and is a separate attach path.

Prefer ACP by default. Disable with `--no-acp` or `AGENSIS_ACP=0`. Pin a harness
with `--acp-harness hermes` (or agent `metadata.acp_harness`).

## Install

```sh
npm install -g @agensis/agensis-agent
```

Or run without installing:

```sh
npx @agensis/agensis-agent agensis --help
```

## Connect a Relay agent

In agensis, open the agent profile (run mode **Relay**), choose **Connect**,
and copy the generated command. It looks like:

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

## Keep the agent running

After a successful connection saves the local profile, install it as a per-user
background service:

```sh
agensis service install --profile default
agensis service status --profile default
agensis service logs --profile default
```

This installs a macOS LaunchAgent (`RunAtLoad` + `KeepAlive`) or Linux systemd
user unit (`Restart=always`) around `agensis supervise`, so the agent survives
terminal and desktop-app exits. The service definition contains no connection
token or workspace data; it references only the profile name, executable paths,
and log paths. The token stays in the existing mode-0600 daemon profile.

`agensis service logs --profile default --follow` explicitly follows the two
logs. `agensis service uninstall --profile default` disables and removes only
that profile's service. Windows service installation is not yet supported.

## Options

Required:

- `--url <url>` — agensis app/backend URL, e.g. `https://agensis.io` or `http://localhost:5173`
- `--token <token>` — agent connection token from agensis
- `--workspace <id>` — workspace id
- `--agent <id>` — workspace agent id

Optional:

- `--handle <name>` — mention handle used in channels
- `--name <name>` — display name
- `--cwd <path>` — folder where the coding CLI runs
- `--coding-cmd <command>` — command used for jobs (default `claude -p`)
- `--full-cli-context` — opt out of the default isolated Claude/Codex launch
- `--sync-memory` — opt in to mirroring Claude memory files to Agensis
- `--max-concurrency <n>` — simultaneous coding CLI jobs (default `2`)
- `--model <id>` — default model passed to supported coding CLIs
- `--permission-mode <mode>` — `default`, `accept_edits`, or `yolo`
- `--yolo` / `--no-sandbox` — alias for `--permission-mode yolo`
- `--timeout-ms <ms>` — kill a job after this time (default `1800000`)
- `--heartbeat-ms <ms>` — heartbeat interval (default `15000`)
- `--once` — run one queued job then exit
- `--profile <name>` — select a saved profile for connect, supervise, or service commands
- `--version` — print the CLI version
- `--help` — show help

Environment fallbacks: `AGENSIS_URL`, `AGENSIS_TOKEN`,
`AGENSIS_WORKSPACE` / `AGENSIS_WORKSPACE_ID`, `AGENSIS_AGENT` / `AGENSIS_AGENT_ID`,
`AGENSIS_HANDLE`, `AGENSIS_NAME`, `AGENSIS_CWD`, `AGENSIS_CODING_CMD` / `CODING_CMD`,
`AGENSIS_MODEL` / `CLAUDE_MODEL`, `AGENSIS_PERMISSION_MODE`, `AGENSIS_TIMEOUT_MS`,
`AGENSIS_HEARTBEAT_MS`, `AGENSIS_SYNC_MEMORY=1`, `AGENSIS_ONCE=1`.

## Security

The daemon runs on your machine and executes the configured coding command in
the working directory you start it in. Agensis sends the job payload and
receives streamed CLI output and the final result. Local credentials are not
intentionally uploaded, but the coding CLI can read files allowed by its own
permission mode, so treat it like any local coding agent with access to that
folder.

Claude memory synchronization is off by default. `--sync-memory` opts in to
uploading the selected project's memory file names, contents, sizes, and
absolute memory-root path to the connected Agensis workspace. Reads are
restricted to that root and each file is capped at 256 KiB.

Keep `aga_...` tokens out of shared logs and shell history. Generate a fresh
token from agensis if one is exposed.

By default, Claude runs in safe mode and Codex skips user configuration,
project instructions, memories, plugins, hooks, and skill search. Both are
given only the Agensis MCP configuration, and the complete daemon prompt is
bounded. `--full-cli-context` deliberately restores normal CLI discovery.

## Requirements

- Node.js >= 18

## License

[MIT](./LICENSE)
