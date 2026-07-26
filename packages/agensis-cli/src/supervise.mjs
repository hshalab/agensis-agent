// `agensis supervise` — a small, separate long-lived process that owns the
// install/health/rollback lifecycle from selfUpdate.mjs and spawns the actual daemon
// (`agensis connect`) as its child, instead of running the daemon directly.
//
// Why a separate process at all: the daemon being updated can't safely update itself
// in place (it would be replacing its own running code), and it must not be the one
// deciding "was that update healthy" about itself. This process is deliberately dumb
// and stable — install/spawn/health-check/rollback, nothing else — so it keeps running
// across daemon restarts, crashes, and updates. It is expected to be run under a
// process manager with its own auto-restart (systemd `Restart=always`, launchd
// `KeepAlive`, pm2, …) so that even if this process itself is killed, the OS brings
// it back; on restart it re-derives everything it needs (running version, profile)
// from disk rather than in-memory state, so a restart is not a state loss.
//
// Update trigger: the coding subprocess (or anything acting on its behalf) writes
// update-request.json into this agent's own state dir (state.mjs) — the same dir
// Change 1 already grants the coding CLI --add-dir access to. This process polls for
// that file; it does not expose a new network surface.
//
// All side-effecting steps (install/spawn/stop/health-check) are injectable, same
// convention as selfUpdate.mjs, so the polling loop itself can be exercised with fakes
// in tests instead of leaking real processes or hitting npm.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  resolveInstallRoot,
  resolveCurrentLink,
  resolveDaemonEntry,
  resolveVersionDir,
  defaultInstallVersion,
  defaultSpawnDaemon,
  defaultStopDaemon,
  defaultHealthCheck,
  performSelfUpdate,
} from "./selfUpdate.mjs";
import { readUpdateRequest, clearUpdateRequest, readUpdateState, writeUpdateState } from "./state.mjs";

const DEFAULT_POLL_MS = 5_000;
// A crashed daemon is respawned, but with backoff — a version that dies immediately on
// every launch (not merely "fails its health check once") must not spin the host.
const RESPAWN_BACKOFF_MS = [1_000, 5_000, 15_000, 30_000];

// Adopt the version currently running this very process into the versioned-install
// layout, on first run under supervision. Idempotent: if `current` already points
// somewhere, this is a no-op — we never overwrite an operator's/prior supervisor's
// choice of running version.
async function bootstrapCurrentVersion({ root, runningVersion, installFn, log }) {
  const currentLink = resolveCurrentLink(root);
  if (fs.existsSync(currentLink)) return;
  log(`[supervise] no current version linked yet — adopting the running version ${runningVersion}`);
  const versionDir = await installFn({ root, version: runningVersion, log });
  await fsp.mkdir(path.dirname(currentLink), { recursive: true });
  await fsp.rm(currentLink, { force: true });
  await fsp.symlink(versionDir, currentLink);
}

export async function runSupervisor({
  config,
  runningVersion,
  profileName = "default",
  pollIntervalMs = DEFAULT_POLL_MS,
  root = resolveInstallRoot({}),
  log = (msg) => process.stdout.write(`${msg}\n`),
  signal,
  // Injectable for tests; production callers should leave these as the real defaults.
  installFn = defaultInstallVersion,
  spawnFn = defaultSpawnDaemon,
  stopFn = defaultStopDaemon,
  healthCheckFn = defaultHealthCheck,
  // Caps the loop to a fixed number of poll iterations — production never sets this
  // (runs forever); tests use it so a run terminates deterministically instead of
  // needing a real abort race.
  maxIterations = Infinity,
} = {}) {
  if (!config?.workspace || !config?.agent) {
    throw new Error("supervise requires a resolved profile with workspace + agent (run `agensis setup`/`agensis connect` first).");
  }

  await bootstrapCurrentVersion({ root, runningVersion, installFn, log });
  let state = await readUpdateState(config);
  if (!state?.currentVersion) {
    state = { currentVersion: runningVersion, previousVersion: null, lastAttempt: null };
    await writeUpdateState(config, state);
  }

  let child = null;
  let stopped = false;
  let respawnAttempt = 0;

  const spawnCurrent = () => {
    const currentDir = resolveVersionDir(root, state.currentVersion);
    child = spawnFn({ entry: resolveDaemonEntry(currentDir), profileName });
    child.on?.("exit", (code, sig) => {
      if (stopped) return;
      log(`[supervise] daemon (version ${state.currentVersion}) exited (code=${code} signal=${sig}); respawning`);
      const delay = RESPAWN_BACKOFF_MS[Math.min(respawnAttempt, RESPAWN_BACKOFF_MS.length - 1)];
      respawnAttempt += 1;
      setTimeout(() => { if (!stopped) spawnCurrent(); }, delay).unref?.();
    });
    child.on?.("spawn", () => { respawnAttempt = 0; });
    return child;
  };

  spawnCurrent();

  const stop = async () => {
    stopped = true;
    if (child) await stopFn(child);
  };
  signal?.addEventListener("abort", () => { void stop(); });
  process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });
  process.once("SIGINT", () => { void stop().then(() => process.exit(0)); });

  let iterations = 0;
  while (!stopped && !signal?.aborted && iterations < maxIterations) {
    iterations += 1;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    if (stopped || signal?.aborted) break;
    const request = await readUpdateRequest(config);
    if (!request || request.targetVersion === state.currentVersion) continue;
    log(`[supervise] update requested: ${state.currentVersion} -> ${request.targetVersion}${request.note ? ` (${request.note})` : ""}`);
    const result = await performSelfUpdate({
      config,
      targetVersion: request.targetVersion,
      currentVersion: state.currentVersion,
      root,
      profileName,
      runningChild: child,
      installFn,
      spawnFn,
      stopFn,
      healthCheckFn,
      log,
    });
    await clearUpdateRequest(config);
    state = result;
    child = result.child || child;
    respawnAttempt = 0;
    log(`[supervise] update attempt "${request.targetVersion}" -> ${result.lastAttempt?.result} (running ${result.currentVersion})`);
  }

  return { state, child };
}
