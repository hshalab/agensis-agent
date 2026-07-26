import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  resolveInstallRoot,
  resolveVersionDir,
  resolveCurrentLink,
  resolveDaemonEntry,
  performSelfUpdate,
  defaultStopDaemon,
  defaultHealthCheck,
} from '../../packages/agensis-cli/src/selfUpdate.mjs';
import { resolveStateDir, readUpdateState } from '../../packages/agensis-cli/src/state.mjs';

let home: string;
let root: string;
let config: { workspace: string; agent: string; homedir: string };

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-selfupdate-'));
  root = resolveInstallRoot({ homedir: home });
  config = { workspace: 'ws-1', agent: 'agent-1', homedir: home };
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

// A fake "install": just materializes the entry file a real `npm install --prefix`
// would have produced, so performSelfUpdate's real fs.existsSync rollback-availability
// check (which is NOT injectable — it's the one thing this module refuses to fake, since
// "is the fallback actually on disk" must be a real check) behaves the same as production.
async function fakeInstall({ root: installRoot, version }: { root: string; version: string }) {
  const dir = resolveVersionDir(installRoot, version);
  const entry = resolveDaemonEntry(dir);
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(entry, '// fake daemon entry\n');
  return dir;
}

function fakeChild(pid: number) {
  return { pid, exitCode: null, killed: false } as any;
}

describe('performSelfUpdate', () => {
  it('lands the new version and records it when the health check passes', async () => {
    const stopped: any[] = [];
    const spawned: string[] = [];
    const result = await performSelfUpdate({
      config,
      targetVersion: '0.2.0',
      currentVersion: '0.1.0',
      root,
      installFn: fakeInstall,
      spawnFn: ({ entry }) => { spawned.push(entry); return fakeChild(111); },
      stopFn: async (child) => { stopped.push(child); return true; },
      healthCheckFn: async () => true,
      runningChild: fakeChild(100),
    });

    expect(result.currentVersion).toBe('0.2.0');
    expect(result.previousVersion).toBe('0.1.0');
    expect(result.lastAttempt.result).toBe('ok');
    expect(stopped).toEqual([fakeChild(100)]);
    expect(spawned[0]).toContain(path.join('0.2.0', 'node_modules'));

    const link = resolveCurrentLink(root);
    const target = await fs.readlink(link);
    expect(target).toBe(resolveVersionDir(root, '0.2.0'));

    const persisted = await readUpdateState(config);
    expect(persisted?.currentVersion).toBe('0.2.0');
  });

  it('rolls back to the previous version when the new one fails its health check', async () => {
    // Simulate the previous version already being on disk (as it would be, having
    // been the one running before this attempt).
    await fakeInstall({ root, version: '0.1.0' });

    const spawnedEntries: string[] = [];
    const stoppedPids: number[] = [];
    let healthCalls = 0;

    const result = await performSelfUpdate({
      config,
      targetVersion: '0.2.0',
      currentVersion: '0.1.0',
      root,
      installFn: fakeInstall,
      spawnFn: ({ entry }) => { spawnedEntries.push(entry); return fakeChild(200 + spawnedEntries.length); },
      stopFn: async (child) => { stoppedPids.push(child.pid); return true; },
      healthCheckFn: async () => { healthCalls += 1; return false; },
      runningChild: fakeChild(100),
    });

    expect(healthCalls).toBe(1);
    expect(result.currentVersion).toBe('0.1.0');
    expect(result.previousVersion).toBe('0.1.0');
    expect(result.lastAttempt.result).toBe('rolled_back');
    // stopped: the originally-running child, then the unhealthy new child.
    expect(stoppedPids).toEqual([100, 201]);
    // spawned: the (unhealthy) new version, then the rollback respawn of the old one.
    expect(spawnedEntries).toHaveLength(2);
    expect(spawnedEntries[0]).toContain(path.join('0.2.0', 'node_modules'));
    expect(spawnedEntries[1]).toContain(path.join('0.1.0', 'node_modules'));

    const link = resolveCurrentLink(root);
    expect(await fs.readlink(link)).toBe(resolveVersionDir(root, '0.1.0'));

    const persisted = await readUpdateState(config);
    expect(persisted?.lastAttempt.result).toBe('rolled_back');
  });

  it('reports failed_no_fallback and leaves `current` on the broken version when no previous install exists on disk', async () => {
    // Deliberately do NOT pre-install '0.1.0' — its entry is not on disk, so the
    // rollback-availability check must refuse to "roll back" to it.
    const result = await performSelfUpdate({
      config,
      targetVersion: '0.2.0',
      currentVersion: '0.1.0',
      root,
      installFn: fakeInstall,
      spawnFn: ({ entry }) => fakeChild(1),
      stopFn: async () => true,
      healthCheckFn: async () => false,
    });

    expect(result.lastAttempt.result).toBe('failed_no_fallback');
    expect(result.child).toBeNull();
  });

  it('reports install_failed and does not touch `current` when the installer throws', async () => {
    const link = resolveCurrentLink(root);
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(resolveVersionDir(root, '0.1.0'), link);

    const result = await performSelfUpdate({
      config,
      targetVersion: '0.2.0',
      currentVersion: '0.1.0',
      root,
      installFn: async () => { throw new Error('registry unreachable'); },
      spawnFn: () => { throw new Error('must not be called'); },
      stopFn: async () => true,
      healthCheckFn: async () => { throw new Error('must not be called'); },
    });

    expect(result.lastAttempt.result).toBe('install_failed');
    expect(result.currentVersion).toBe('0.1.0');
    expect(await fs.readlink(link)).toBe(resolveVersionDir(root, '0.1.0'));
  });

  it('is a no-op when the requested version is already current', async () => {
    let installCalls = 0;
    const result = await performSelfUpdate({
      config,
      targetVersion: '0.1.0',
      currentVersion: '0.1.0',
      root,
      installFn: async (...args) => { installCalls += 1; return fakeInstall(...(args as [any])); },
    });
    expect(installCalls).toBe(0);
    expect(result.lastAttempt.result).toBe('noop_already_current');
    expect(result.currentVersion).toBe('0.1.0');
  });
});

describe('defaultStopDaemon (real child process)', () => {
  it('terminates a cooperative child with SIGTERM', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const started = new Promise<void>((resolve) => child.once('spawn', () => resolve()));
    await started;
    const ok = await defaultStopDaemon(child, { graceMs: 2000 });
    expect(ok).toBe(true);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)']);
    const started = new Promise<void>((resolve) => child.once('spawn', () => resolve()));
    await started;
    // Give the child time to actually register its SIGTERM handler — spawn() firing
    // only means the OS process exists, not that node has finished executing the -e
    // script yet. Without this, SIGTERM can arrive before the handler is installed and
    // the child dies immediately on the default signal disposition, which would make
    // this test pass for the wrong reason (no real escalation exercised).
    await new Promise((resolve) => setTimeout(resolve, 200));
    const before = Date.now();
    const ok = await defaultStopDaemon(child, { graceMs: 300 });
    expect(ok).toBe(true);
    expect(Date.now() - before).toBeGreaterThanOrEqual(300);
    expect(child.signalCode).toBe('SIGKILL');
  }, 10_000);

  it('treats an already-exited child as successfully stopped', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(await defaultStopDaemon(child)).toBe(true);
  });
});

describe('defaultHealthCheck (real heartbeat.json)', () => {
  it('passes once a fresh, connected beat from the right pid is on disk', async () => {
    const dir = resolveStateDir(config);
    await fs.mkdir(dir, { recursive: true });
    const write = () => fs.writeFile(
      path.join(dir, 'heartbeat.json'),
      JSON.stringify({ ts: Date.now(), connected: true, pid: 4242 }),
    );
    await write();
    expect(await defaultHealthCheck({ config, pid: 4242, timeoutMs: 500 })).toBe(true);
  });

  it('fails on timeout when the beat never appears', async () => {
    expect(await defaultHealthCheck({ config, pid: 4242, timeoutMs: 300 })).toBe(false);
  });

  it('fails on a stale timestamp even if connected:true', async () => {
    const dir = resolveStateDir(config);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'heartbeat.json'),
      JSON.stringify({ ts: Date.now() - 60_000, connected: true, pid: 4242 }),
    );
    expect(await defaultHealthCheck({ config, pid: 4242, timeoutMs: 300 })).toBe(false);
  });

  it('fails when the beat is from a different pid (the process we just replaced)', async () => {
    const dir = resolveStateDir(config);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'heartbeat.json'),
      JSON.stringify({ ts: Date.now(), connected: true, pid: 1 }),
    );
    expect(await defaultHealthCheck({ config, pid: 4242, timeoutMs: 300 })).toBe(false);
  });
});
