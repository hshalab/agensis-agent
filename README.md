# Agensis Agent

Open-source **Relay host** for [Agensis](https://agensis.io) workspace agents —
connect Claude Code, Codex, Hermes, Grok, and other coding CLIs on a machine
that should execute work.

In the product, agent run modes are:

| Mode | Meaning |
|------|---------|
| **Direct** | Runs on agensis (hosted). No this package. |
| **Relay** | Jobs pushed to a linked host — this CLI **or** desktop ACP. |
| **Connector** | External MCP client acts as the agent. |

The daemon receives Relay jobs over an authenticated WebSocket, runs the
selected coding CLI in the configured working directory, and streams results
back to Agensis (web and desktop). The website, backend, and desktop app live
in a separate repository; this repo is only the host-side Relay client.

Amp Orb agents use the same connection: the daemon invokes the signed-in local
Amp CLI to create or continue an Amp-managed orb thread, then streams that
thread back into its Agensis conversation. Amp authentication and billing stay
on the host. See the CLI package README for setup and failure behavior.

## Install

```sh
npm install -g @agensis/agensis-agent
agensis --help
```

Copy the connection command from an agent profile in Agensis, then run it from
the repository the agent should work in:

```sh
agensis connect --url https://agensis.io --token aga_... --workspace ... --agent ...
```

After that first successful connection has saved a local profile, keep the
agent running when the terminal or desktop app exits:

```sh
agensis service install --profile default
agensis service status --profile default
agensis service logs --profile default
```

`service install` creates a per-user macOS LaunchAgent (`RunAtLoad` +
`KeepAlive`) or Linux systemd user unit (`Restart=always`). Install the CLI
globally first so the recorded executable path remains stable. The service
definition contains only the profile name plus executable and log paths; the
connection token, workspace, agent id, and working directory remain in the
existing mode-0600 profile under `~/.agensis/daemon-profiles`.

Use `agensis service logs --profile default --follow` only when you want a
foreground live tail, and `agensis service uninstall --profile default` to
disable and remove that exact profile's service. Windows service installation
is not implemented; the command fails without changing the machine.

Lean execution is enabled by default. Claude starts in safe mode, Codex skips
user config, project instructions, memories, plugins, hooks, and skill search,
and both receive only the Agensis MCP configuration. Use
`--full-cli-context` only when the connected agent intentionally needs local
Claude/Codex customizations.

Local Claude memory synchronization is off by default. `--sync-memory` opts in
to uploading the selected project's Claude memory files, including file names,
contents, sizes, and the absolute memory-root path, to the connected Agensis
workspace. Each file is read-only, restricted to the derived or configured
memory root, and capped at 256 KiB.

Skill content synchronization is on by default. The daemon already advertises
the NAMES of the skills it finds under `~/.claude/skills`, `~/.codex/skills` and
`<project>/.claude/skills`; it also uploads each one's `SKILL.md` so agents
elsewhere in the workspace can read a skill while this machine is offline. Reads
are confined to those three roots, capped at 64 KiB per skill with any
truncation marked in the text, and a file that cannot be read is simply reported
as having no body. `--no-sync-skills` (or `AGENSIS_SYNC_SKILLS=0`) keeps the
bodies local; only the names are then advertised. Opting out stops further
uploads — it does not delete text already mirrored into the workspace.

## Repository layout

- `packages/agensis-cli` — readable daemon source
- `packages/agensis-agent` — npm package and single-file bundle build
- `tests` — daemon integration and unit tests

## Development

```sh
npm install
npm run verify
```

The release package is `@agensis/agensis-agent`. Its npm name and wire protocol
are stable across the repository split.

## Security

The daemon executes coding CLIs with access to the selected working directory.
Job payloads and CLI results travel through the Agensis backend. Review
permission mode and host-folder settings before connecting it. Keep `aga_...`
connection tokens out of logs and rotate any token that is exposed.

Security reports should be submitted through GitHub's private vulnerability
reporting for this repository.

## License

[MIT](./LICENSE)
