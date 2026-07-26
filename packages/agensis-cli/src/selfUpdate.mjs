// Self-update + automatic rollback for the daemon's own connection (Change 2 of the
// "Agent Sandbox Permissions & Yolo" runbook). An agent asks for an update by writing
// update-request.json into its own state dir (state.mjs, enabled by Change 1's
// --add-dir grant); `agensis supervise` polls for that file and calls
// performSelfUpdate() here.
//
// Install layout: ~/.agensis/versions/<version>/ each holds an independent
// `npm install --prefix` of @agensis/agensis-agent@<version>, and
// ~/.agensis/versions/current is a symlink to whichever version dir the supervisor
// should be running. Rollback is a symlink flip + relaunch, never a second install —
// a broken new version can never block recovering the last-known-good one, because
// recovering it doesn't depend on any code from the broken version running at all.
//
// Every side-effecting step (install/spawn/stop/health-check) is injectable so the
// orchestration here can be exercised with fakes, without hitting the real npm
// registry or leaking real daemon processes in tests. The exported `default*`
// functions are the real implementations used in production.
//
// This module intentionally does NOT decide *when* to update or *what* counts as an
// authorized request — that's the supervisor's job (reading update-request.json and
// deciding whether to act on it). This module only knows how to carry out one update
// attempt safely once asked.

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveStateDir, readUpdateState, writeUpdateState } from "./state.mjs";

const execFileAsync = promisify(execFile);

const PACKAGE_NAME = "@agensis/agensis-agent";
const CURRENT_LINK = "current";

// "Registered + heartbeating" is the health bar, not "claimed a job within N seconds" —
// an idle agent with no queued work would never pass a job-claim bar and could never
// roll forward. Generous default: real npm installs + Claude Code cold starts can take
// a few seconds even on a healthy host.
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 1_000;
// A heartbeat must be newer than "now minus this" to count as live — generous enough
// for a slow filesystem, tight enough to reject a stale file left by a dead process.
const HEALTH_FRESHNESS_MS = 10_000;

export function resolveInstallRoot({ homedir = os.homedir() } = {}) {
  return path.join(homedir, ".agensis", "versions");
}

export function resolveVersionDir(root, version) {
  return path.join(root, version);
}

export function resolveCurrentLink(root) {
  return path.join(root, CURRENT_LINK);
}

// Where the versioned install's daemon entrypoint lives, given a real
// `npm install --prefix <versionDir> @agensis/agensis-agent@<version>`.
export function resolveDaemonEntry(versionDir) {
  return path.join(versionDir, "node_modules", PACKAGE_NAME, "bin", "agensis.mjs");
}

async function linkCurrent(currentLink, targetDir) {
  await fsp.mkdir(path.dirname(currentLink), { recursive: true });
  await fsp.rm(currentLink, { force: true });
  await fsp.symlink(targetDir, currentLink);
}

// Real installer: fetch one version into its own directory. Idempotent — if the entry
// already exists (e.g. a retried request, or re-adopting the running version on
// bootstrap), skip the network call entirely.
export async function defaultInstallVersion({ root, version, log = () => {} }) {
  const versionDir = resolveVersionDir(root, version);
  const entry = resolveDaemonEntry(versionDir);
  if (fs.existsSync(entry)) {
    log(`[self-update] ${version} already installed at ${versionDir}`);
    return versionDir;
  }
  await fsp.mkdir(versionDir, { recursive: true });
  log(`[self-update] installing ${PACKAGE_NAME}@${version} into ${versionDir}`);
  await execFileAsync("npm", [
    "install", "--prefix", versionDir,
    `${PACKAGE_NAME}@${version}`,
    "--no-audit", "--no-fund", "--no-save", "--omit=dev",
  ]);
  if (!fs.existsSync(entry)) {
    throw new Error(`npm install reported success but ${entry} is missing`);
  }
  return versionDir;
}

// Real "spawn the daemon": runs `node <entry> connect --profile <name>` detached so it
// outlives this call, and unref'd so it never keeps the supervisor's own event loop
// alive on its own account. Returns the child so the caller can stop() it later.
export function defaultSpawnDaemon({ entry, profileName, extraArgs = [], env = process.env }) {
  const args = ["connect", "--profile", profileName, ...extraArgs];
  const child = spawn(process.execPath, [entry, ...args], {
    detached: true,
    stdio: "inherit",
    env,
  });
  child.unref();
  return child;
}

// Ask nicely (SIGTERM), then escalate (SIGKILL) if it hasn't exited within `graceMs`.
// Never throws — a process that's already gone counts as successfully stopped.
export async function defaultStopDaemon(child, { graceMs = 5_000 } = {}) {
  if (!child || child.exitCode !== null || child.killed) return true;
  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(escalate);
      resolve();
    };
    const escalate = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, graceMs);
    escalate.unref?.();
    child.once("exit", done);
    try { child.kill("SIGTERM"); } catch { done(); }
  });
  return true;
}

// Health = "registered and heartbeating": poll this agent's own heartbeat.json (the
// DAEMON-OWNED liveness file — state.mjs) for a fresh, connected beat, optionally
// pinned to a specific child pid so a health pass can't be satisfied by a stale beat
// left over from the process we just replaced.
export async function defaultHealthCheck({ config, pid, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS }) {
  const file = path.join(resolveStateDir(config), "heartbeat.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fsp.readFile(file, "utf8");
      const beat = JSON.parse(raw);
      const fresh = Number.isFinite(beat.ts) && Date.now() - beat.ts <= HEALTH_FRESHNESS_MS;
      if (fresh && beat.connected && (pid == null || beat.pid === pid)) return true;
    } catch {
      // Not written yet, or a stat/read race against writeFileAtomic's rename —
      // keep polling rather than treating either as a failure.
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

// Orchestrates one update attempt with automatic rollback:
//   install target -> stop running child -> flip `current` -> spawn target ->
//   health-check -> healthy? keep it : flip `current` back + respawn previous + report.
//
// All side-effecting steps are injectable (installFn/spawnFn/stopFn/healthCheckFn) so
// this can be exercised against fakes; the exported `default*` functions above are the
// real implementations. Always writes update.json (state.mjs) with the outcome, so an
// agent that requested the update can read back whether it landed or was rolled back.
export async function performSelfUpdate({
  config,
  targetVersion,
  currentVersion,
  root = resolveInstallRoot({}),
  profileName = "default",
  runningChild = null,
  installFn = defaultInstallVersion,
  spawnFn = defaultSpawnDaemon,
  stopFn = defaultStopDaemon,
  healthCheckFn = defaultHealthCheck,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  log = () => {},
} = {}) {
  const priorState = (await readUpdateState(config)) || {};
  const previousVersion = currentVersion || priorState.currentVersion || null;
  const currentLink = resolveCurrentLink(root);
  const attempt = { version: targetVersion, startedAt: new Date().toISOString() };

  if (targetVersion === previousVersion) {
    const result = { currentVersion: previousVersion, previousVersion: priorState.previousVersion || null,
      lastAttempt: { ...attempt, result: "noop_already_current" } };
    await writeUpdateState(config, result);
    return { ...result, child: runningChild };
  }

  let newVersionDir;
  try {
    newVersionDir = await installFn({ root, version: targetVersion, log });
  } catch (error) {
    const result = {
      currentVersion: previousVersion,
      previousVersion: priorState.previousVersion || null,
      lastAttempt: { ...attempt, result: "install_failed", error: String(error?.message || error) },
    };
    await writeUpdateState(config, result);
    return { ...result, child: runningChild };
  }

  if (runningChild) await stopFn(runningChild);
  await linkCurrent(currentLink, newVersionDir);

  const entry = resolveDaemonEntry(newVersionDir);
  const child = spawnFn({ entry, profileName });
  const healthy = await healthCheckFn({ config, pid: child.pid, timeoutMs: healthTimeoutMs });

  if (healthy) {
    const result = { currentVersion: targetVersion, previousVersion, lastAttempt: { ...attempt, result: "ok" } };
    await writeUpdateState(config, result);
    return { ...result, child };
  }

  log(`[self-update] ${targetVersion} failed its health check within ${healthTimeoutMs}ms — rolling back to ${previousVersion || "(no known previous version)"}`);
  await stopFn(child);

  let rolledBack = false;
  let fallbackChild = null;
  if (previousVersion) {
    const previousDir = resolveVersionDir(root, previousVersion);
    if (fs.existsSync(resolveDaemonEntry(previousDir))) {
      await linkCurrent(currentLink, previousDir);
      fallbackChild = spawnFn({ entry: resolveDaemonEntry(previousDir), profileName });
      rolledBack = true;
    }
  }

  const result = {
    currentVersion: rolledBack ? previousVersion : (priorState.currentVersion || previousVersion),
    previousVersion,
    lastAttempt: { ...attempt, result: rolledBack ? "rolled_back" : "failed_no_fallback" },
  };
  await writeUpdateState(config, result);
  return { ...result, child: fallbackChild };
}
