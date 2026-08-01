#!/usr/bin/env node
import process from "node:process";
import { AGENSIS_CLI_VERSION, runAgensisDaemon } from "../src/agensis.mjs";
import {
  daemonProfileName,
  daemonProfileSetupMessage,
  hasCompleteDaemonConnection,
  hasDaemonConnectionMaterial,
  mergeDaemonProfile,
  readDaemonProfile,
  writeDaemonProfile,
} from "../src/connectProfiles.mjs";
import { claimCursorBuddyConnectionKey } from "../src/cursorbuddyConnect.mjs";
import { runSetupFlow } from "../src/setupFlow.mjs";

// Last-resort process guards, mirroring the ones the hub installs in
// server/index.cjs.
//
// This daemon is a long-running supervisor of other people's work: it holds the
// hub socket, a job queue, parked permission requests and live CLI subprocesses.
// Until now a single unhandled rejection anywhere in it — a detached promise in
// a bridge, an HTTP response that could not be written, a peer socket erroring
// with no listener — took the WHOLE process down under Node's default
// `--unhandled-rejections=throw`, losing every in-flight turn along with it.
// Nothing in the tree installed a handler (verified by grep across the repo).
//
// Log and stay up: every job path already reports its own failure to the hub, so
// the correct blast radius for a stray rejection is one turn, not the daemon.
process.on("unhandledRejection", (reason) => {
  console.error(`[agensis] unhandled rejection: ${reason?.stack || reason?.message || reason}`);
});
process.on("uncaughtException", (error) => {
  console.error(`[agensis] uncaught exception: ${error?.stack || error?.message || error}`);
});

function parseArgs(argv) {
  const args = { command: "connect" };
  const rest = [...argv];
  const first = rest[0];
  if (first && !first.startsWith("-")) {
    args.command = rest.shift();
    if (args.command === "buddy") {
      const subcommand = rest[0];
      if (subcommand && !subcommand.startsWith("-")) args.subcommand = rest.shift();
      else args.subcommand = "connect";
    }
  }

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (key === "help") {
      args.help = true;
      continue;
    }
    if (key === "version") {
      args.version = true;
      continue;
    }
    if (key === "once") {
      args.once = true;
      continue;
    }
    if (key === "lan") {
      args.lanListener = true;
      continue;
    }
    if (key === "share") {
      args.share = true;
      continue;
    }
    if (key === "noCoding") {
      args.noCoding = true;
      continue;
    }
    if (key === "noAcp") {
      args.noAcp = true;
      continue;
    }
    if (key === "fullCliContext") {
      args.fullCliContext = true;
      continue;
    }
    if (key === "syncMemory") {
      args.syncMemory = true;
      continue;
    }
    if (key === "noSyncSkills") {
      args.syncSkills = false;
      continue;
    }
    if (key === "cursorbuddyBridge") {
      args.cursorBuddyBridge = true;
      continue;
    }
    if (key === "noCursorbuddyBridge") {
      args.cursorBuddyBridge = false;
      continue;
    }
    if (key === "noAutoUpdate") {
      args.autoUpdate = false;
      continue;
    }
    if (key === "yolo" || key === "noSandbox") {
      args.permissionMode = "yolo";
      continue;
    }
    if (key === "acceptEdits") {
      args.permissionMode = "accept_edits";
      continue;
    }
    if (key === "hostFolder" || key === "hostFolders" || key === "addDir") {
      const folderValue = inlineValue !== undefined ? inlineValue : rest[++i];
      if (folderValue == null || folderValue.startsWith("--")) {
        throw new Error(`Missing value for --${rawKey}`);
      }
      args.hostFolders = [...(args.hostFolders || []), folderValue];
      continue;
    }
    const value = inlineValue !== undefined ? inlineValue : rest[++i];
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }
    args[key] = value;
  }
  return args;
}

function usage() {
  return `agensis agent daemon

Usage:
  agensis --url <workspace-url> --token <token> --workspace <id> --agent <id> [options]
  agensis connect --url <workspace-url> --token <token> --workspace <id> --agent <id> [options]
  agensis connect [--profile <name>]
  agensis setup [--url <agensis-url>] [--profile <name>] [--handle <name>]
  agensis supervise [--profile <name>]
  agensis buddy connect --key <cbk_...> [--url <agensis-url>] [options]

Required:
  --url <url>             agensis app/backend URL, for example https://agensis.io or http://localhost:5173
  --token <token>         Agent connection token from agensis
  --workspace <id>        Workspace id
  --agent <id>            Workspace agent id
  --key <cbk_...>         One-time CursorBuddy connection key for buddy connect

Options:
  --handle <name>         Mention handle used in channels
  --name <name>           Display name
  --cwd <path>            Folder where the coding CLI runs
  --runtime <runtime>     Executor runtime: claude, codex, or amp
  --acp-harness <id>      Prefer this ACP harness when available (claude, codex,
                          hermes, grok, goose, …). Default: from agent metadata
                          or --runtime / coding family
  --no-acp                Disable ACP; always use classic CLI/SDK execution
  --host-folder <path>    Extra folder the coding CLI may read/write (repeatable; passed as --add-dir)
  --coding-cmd <command>  Command used for jobs, default: claude -p
  --amp-cmd <path>        Amp CLI executable, default: amp
  --no-coding             Disable coding jobs; keep presence/shared inference only
  --full-cli-context      Load all user CLI skills, plugins, hooks, memory, and MCPs
                          (default isolates Claude/Codex to project + Agensis context)
  --sync-memory           Opt in to mirroring this project's Claude memory files
                          to the connected Agensis workspace (default: off)
  --no-sync-skills        Stop mirroring the text of this machine's skills to the
                          workspace; only their names are advertised (default: on)
  --model <id>            Default model to pass to supported coding CLIs
  --permission-mode <m>   default, accept_edits, or yolo
  --yolo                  Alias for --permission-mode yolo
  --no-sandbox            Alias for --permission-mode yolo
  --timeout-ms <ms>       Hard ceiling on one job, default: 1800000
  --idle-timeout-ms <ms>  Stop a job that produces NOTHING for this long,
                          default: 540000 (9m). 0 disables it.
  --heartbeat-ms <ms>     Local terminal heartbeat interval, default: 15000
  --max-concurrency <n>   Maximum simultaneous coding CLI jobs, default: 2
  --session-slots <n>     Warm sessions per workspace+agent, default: 1.
                          1 keeps today's behaviour (all conversations share one
                          session). Raising it is what lets --max-concurrency
                          actually run jobs in parallel, and stops separate
                          conversations sharing one runtime history.
  --cursorbuddy-port <n>  Local CursorBuddy discovery/chat port, default: 8787
  --cursorbuddy-bridge    Enable local CursorBuddy discovery/chat bridge
  --no-cursorbuddy-bridge Disable local CursorBuddy discovery/chat bridge
  --once                  Run one queued job then exit
  --lan                   Opt in to the agent-mesh LAN listener for direct
                          daemon-to-daemon job handoff (default: off)
  --share                 Advertise local inference models to this workspace
  --shared-models-file <path>
                          JSON config for loopback OpenAI-compatible models
  --profile <name>        Save/reuse a local daemon profile, default: default
  --version               Print the CLI version
  --help                  Show this help

agensis supervise [--profile <name>] [--poll-ms <ms>] [--no-auto-update] [--auto-check-ms <ms>]
  Runs the daemon as a supervised child instead of in this process, so an agent
  can request a self-update (writing update-request.json into its own state
  dir) with automatic install + health-check + rollback to the last-known-good
  version on failure. Requires a saved profile (run "agensis setup" or
  "agensis connect" once first). Recommended under a process manager with its
  own restart policy (systemd Restart=always, launchd KeepAlive, pm2) so the
  supervisor itself is recovered if it's ever killed.
`;
}

async function daemonArgsForConnect(args) {
  const hasExplicitProfile = args.profile !== undefined;
  const profileHint = args.handle || args.name;
  const profile = daemonProfileName(args.profile || (hasCompleteDaemonConnection(args) && profileHint ? profileHint : "default"));
  if (!hasDaemonConnectionMaterial(args)) {
    const cached = await readDaemonProfile(profile);
    if (!cached) throw new Error(daemonProfileSetupMessage(profile));
    return mergeDaemonProfile(cached, args);
  }

  if (!hasCompleteDaemonConnection(args)) {
    return args;
  }

  return {
    ...args,
    cursorBuddyBridge: args.cursorBuddyBridge === true,
    onRegistered: async (config) => {
      await writeDaemonProfile(profile, config);
      const restart = hasExplicitProfile || profile !== "default" ? `agensis connect --profile ${profile}` : "agensis connect";
      process.stdout.write(`[agensis] Saved daemon profile "${profile}". Restart with: ${restart}\n`);
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (args.version) {
    process.stdout.write(`${AGENSIS_CLI_VERSION}\n`);
    return;
  }
  if (args.command === "buddy") {
    if (args.subcommand !== "connect") {
      throw new Error(`Unknown buddy command "${args.subcommand || ""}". Use "agensis buddy connect --key <cbk_...>".`);
    }
    const daemonArgs = await claimCursorBuddyConnectionKey(args);
    daemonArgs.cursorBuddyBridge = args.cursorBuddyBridge !== false;
    daemonArgs.cursorBuddyRuntime = true;
    daemonArgs.exitOnOnce = true;
    await runAgensisDaemon(daemonArgs);
    if (daemonArgs.once) process.exit(0);
    return;
  }
  if (args.command === "supervise") {
    const profile = daemonProfileName(args.profile || "default");
    const cached = await readDaemonProfile(profile);
    if (!cached) throw new Error(daemonProfileSetupMessage(profile));
    const { runSupervisor } = await import("../src/supervise.mjs");
    const pollIntervalMs = args.pollMs ? Number(args.pollMs) : undefined;
    // Automatic updates are ON for `agensis supervise` — supervising is the act of
    // asking for a managed daemon, and a managed daemon that silently rots on an
    // old version is the thing this command exists to prevent. `--no-auto-update`
    // for an operator who pins versions deliberately.
    const autoUpdate = args.autoUpdate !== false;
    const autoCheckIntervalMs = args.autoCheckMs ? Number(args.autoCheckMs) : undefined;
    await runSupervisor({
      config: cached, runningVersion: AGENSIS_CLI_VERSION, profileName: profile,
      pollIntervalMs, autoUpdate, autoCheckIntervalMs,
    });
    return;
  }
  if (args.command === "setup") {
    const daemonArgs = await runSetupFlow(args);
    daemonArgs.exitOnOnce = true;
    await runAgensisDaemon({ ...args, ...daemonArgs });
    if (daemonArgs.once) process.exit(0);
    return;
  }
  if (args.command !== "connect") {
    throw new Error(`Unknown command "${args.command}". Use "agensis setup", "agensis connect --url ...", "agensis supervise", or "agensis buddy connect --key ...".`);
  }
  const daemonArgs = await daemonArgsForConnect(args);
  daemonArgs.exitOnOnce = true;
  await runAgensisDaemon(daemonArgs);
  if (daemonArgs.once) {
    process.exit(0);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
});
