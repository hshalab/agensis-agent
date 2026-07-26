import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSupervisor } from '../../packages/agensis-cli/src/supervise.mjs';
import { resolveInstallRoot, resolveVersionDir, resolveDaemonEntry, resolveCurrentLink } from '../../packages/agensis-cli/src/selfUpdate.mjs';
import { writeUpdateRequest, readUpdateRequest, readUpdateState } from '../../packages/agensis-cli/src/state.mjs';

let home: string;
let root: string;
let config: { workspace: string; agent: string; homedir: string };

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-supervise-'));
  root = resolveInstallRoot({ homedir: home });
  config = { workspace: 'ws-1', agent: 'agent-1', homedir: home };
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function fakeInstall({ root: installRoot, version }: { root: string; version: string }) {
  const dir = resolveVersionDir(installRoot, version);
  const entry = resolveDaemonEntry(dir);
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(entry, '// fake daemon entry\n');
  return dir;
}

function fakeChild() {
  const listeners: Record<string, Function[]> = {};
  return {
    pid: Math.floor(Math.random() * 100000),
    exitCode: null,
    killed: false,
    on(event: string, fn: Function) { (listeners[event] ||= []).push(fn); return this; },
  } as any;
}

describe('runSupervisor', () => {
  it('bootstraps the running version into the versioned layout and spawns it', async () => {
    const spawned: string[] = [];
    await runSupervisor({
      config,
      runningVersion: '0.1.0',
      root,
      pollIntervalMs: 5,
      maxIterations: 0,
      installFn: fakeInstall,
      spawnFn: ({ entry }) => { spawned.push(entry); return fakeChild(); },
      stopFn: async () => true,
      log: () => {},
    });

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toBe(resolveDaemonEntry(resolveVersionDir(root, '0.1.0')));
    const link = resolveCurrentLink(root);
    expect(await fs.readlink(link)).toBe(resolveVersionDir(root, '0.1.0'));
    const state = await readUpdateState(config);
    expect(state?.currentVersion).toBe('0.1.0');
  });

  it('does not re-bootstrap (or overwrite `current`) when a version is already linked', async () => {
    const link = resolveCurrentLink(root);
    const priorDir = await fakeInstall({ root, version: '0.0.9' });
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(priorDir, link);

    let installCalls = 0;
    await runSupervisor({
      config,
      runningVersion: '0.1.0', // the "actually running" version differs from what's linked
      root,
      pollIntervalMs: 5,
      maxIterations: 0,
      installFn: async (...args: any[]) => { installCalls += 1; return fakeInstall(args[0]); },
      spawnFn: () => fakeChild(),
      stopFn: async () => true,
      log: () => {},
    });

    expect(installCalls).toBe(0);
    expect(await fs.readlink(link)).toBe(priorDir);
  });

  it('picks up an update-request.json, applies it, and clears the request', async () => {
    const spawnedEntries: string[] = [];
    await writeUpdateRequest(config, { targetVersion: '0.2.0', note: 'agent asked for it' });

    const result = await runSupervisor({
      config,
      runningVersion: '0.1.0',
      root,
      pollIntervalMs: 5,
      maxIterations: 1,
      installFn: fakeInstall,
      spawnFn: ({ entry }) => { spawnedEntries.push(entry); return fakeChild(); },
      stopFn: async () => true,
      healthCheckFn: async () => true,
      log: () => {},
    });

    expect(result.state.currentVersion).toBe('0.2.0');
    expect(await readUpdateRequest(config)).toBeNull();
    expect(spawnedEntries).toContain(resolveDaemonEntry(resolveVersionDir(root, '0.2.0')));
    const state = await readUpdateState(config);
    expect(state?.lastAttempt.result).toBe('ok');
  });

  it('ignores a request that just restates the already-current version', async () => {
    await writeUpdateRequest(config, { targetVersion: '0.1.0' });
    let installCalls = 0;

    const result = await runSupervisor({
      config,
      runningVersion: '0.1.0',
      root,
      pollIntervalMs: 5,
      maxIterations: 1,
      installFn: async (...args: any[]) => { installCalls += 1; return fakeInstall(args[0]); },
      spawnFn: () => fakeChild(),
      stopFn: async () => true,
      log: () => {},
    });

    // Only the bootstrap install (for the running version) should happen — the
    // stale/no-op request must not trigger a second install attempt.
    expect(installCalls).toBe(1);
    expect(result.state.currentVersion).toBe('0.1.0');
    // The request is left alone (not a real update), so a future genuinely-different
    // request isn't masked by an early clear.
    expect(await readUpdateRequest(config)).not.toBeNull();
  });
});
