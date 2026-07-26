import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  resolveStateDir,
  statusFilePath,
  writeAgentMirror,
  writeHeartbeatFile,
  writeHeartbeatFileSync,
  readAgentStatus,
  readAgentIdentity,
  identityFilePath,
  ensureHeartbeatMd,
  heartbeatMdPath,
  readHeartbeatMd,
  writeUpdateRequest,
  readUpdateRequest,
  clearUpdateRequest,
  updateRequestFilePath,
  readUpdateState,
  writeUpdateState,
  updateStateFilePath,
} from '../../packages/agensis-cli/src/state.mjs';

let home: string;
let config: {
  workspace: string;
  agent: string;
  homedir: string;
  name: string;
  handle: string;
  model: string;
  permissionMode: string;
  heartbeatMs: number;
};

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-state-'));
  config = {
    workspace: 'ws-123',
    agent: 'agent-abc',
    homedir: home,
    name: 'Coder',
    handle: 'coder',
    model: 'claude-opus-4-8',
    permissionMode: 'yolo',
    heartbeatMs: 15000,
  };
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('resolveStateDir / statusFilePath', () => {
  it('roots under ~/.agensis/<workspace>/<agent>/', () => {
    const dir = resolveStateDir(config);
    expect(dir).toBe(path.join(home, '.agensis', 'ws-123', 'agent-abc'));
    expect(statusFilePath(config)).toBe(path.join(dir, 'status.json'));
  });

  it('sanitizes path segments so a crafted id cannot escape the base dir', () => {
    const dir = resolveStateDir({ workspace: '../../etc', agent: 'a/b/../c', homedir: home });
    const base = path.join(home, '.agensis');
    expect(dir.startsWith(base + path.sep)).toBe(true);
    expect(dir.includes('..')).toBe(false);
    expect(path.relative(base, dir).split(path.sep).length).toBe(2);
  });

  it('falls back to placeholder segments when ids are empty', () => {
    const dir = resolveStateDir({ workspace: '', agent: '', homedir: home });
    expect(dir).toBe(path.join(home, '.agensis', 'workspace', 'agent'));
  });
});

describe('heartbeat.md (ensure / read)', () => {
  it('seeds a default heartbeat.md when absent and returns its contents', async () => {
    const ok = await ensureHeartbeatMd(config);
    expect(ok).toBe(true);
    const seeded = await fs.readFile(heartbeatMdPath(config), 'utf8');
    expect(seeded).toContain('# Heartbeat');
    const read = await readHeartbeatMd(config);
    expect(read).toContain('status.json');
  });

  it('never overwrites an existing heartbeat.md (human/agent edits survive)', async () => {
    await ensureHeartbeatMd(config);
    await fs.writeFile(heartbeatMdPath(config), 'my custom heartbeat plan');
    const ok = await ensureHeartbeatMd(config);
    expect(ok).toBe(true);
    expect(await fs.readFile(heartbeatMdPath(config), 'utf8')).toBe('my custom heartbeat plan');
    expect(await readHeartbeatMd(config)).toBe('my custom heartbeat plan');
  });

  it('readHeartbeatMd returns null when the file is missing or empty', async () => {
    expect(await readHeartbeatMd(config)).toBeNull();
    await fs.mkdir(resolveStateDir(config), { recursive: true });
    await fs.writeFile(heartbeatMdPath(config), '   \n  ');
    expect(await readHeartbeatMd(config)).toBeNull();
  });
});

describe('writeAgentMirror', () => {
  it('writes agent.json + soul.md from the server payload', async () => {
    const ok = await writeAgentMirror(config, {
      id: 'agent-abc',
      workspace_id: 'ws-123',
      name: 'Coder',
      handle: 'coder',
      model: 'claude-opus-4-8',
      permission_mode: 'yolo',
      description: 'Coding agent',
      soul: 'Be direct. Quantify.',
      system_prompt: 'You are Coder.',
      tools: ['a', 'b'],
      skills: ['x'],
      version: 3,
    });
    expect(ok).toBe(true);
    const dir = resolveStateDir(config);
    const agentJson = JSON.parse(await fs.readFile(path.join(dir, 'agent.json'), 'utf8'));
    expect(agentJson.handle).toBe('coder');
    expect(agentJson.model).toBe('claude-opus-4-8');
    expect(agentJson.permissionMode).toBe('yolo');
    expect(agentJson.tools).toEqual(['a', 'b']);
    expect(agentJson.version).toBe(3);
    const soul = await fs.readFile(path.join(dir, 'soul.md'), 'utf8');
    expect(soul).toBe('Be direct. Quantify.');
  });

  it('returns false on a non-object payload and writes nothing', async () => {
    expect(await writeAgentMirror(config, null)).toBe(false);
    await expect(fs.stat(path.join(resolveStateDir(config), 'agent.json'))).rejects.toThrow();
  });
});

describe('writeHeartbeatFile', () => {
  it('writes a fresh, parseable liveness snapshot', async () => {
    const before = Date.now();
    const ok = await writeHeartbeatFile(config, { busy: true, active: 1, queueSize: 2, connected: true });
    expect(ok).toBe(true);
    const beat = JSON.parse(await fs.readFile(path.join(resolveStateDir(config), 'heartbeat.json'), 'utf8'));
    expect(beat.status).toBe('busy');
    expect(beat.busy).toBe(true);
    expect(beat.active).toBe(1);
    expect(beat.queueSize).toBe(2);
    expect(beat.connected).toBe(true);
    expect(beat.handle).toBe('coder');
    expect(beat.pid).toBe(process.pid);
    expect(beat.ts).toBeGreaterThanOrEqual(before);
  });

  it('derives status online when not busy, and carries agentStatus when provided', async () => {
    await writeHeartbeatFile(config, { busy: false, connected: false, agentStatus: 'thinking', agentNote: 'planning' });
    const beat = JSON.parse(await fs.readFile(path.join(resolveStateDir(config), 'heartbeat.json'), 'utf8'));
    expect(beat.status).toBe('online');
    expect(beat.connected).toBe(false);
    expect(beat.agentStatus).toBe('thinking');
    expect(beat.agentNote).toBe('planning');
  });

  it('sync variant lands a stopped beat for shutdown', () => {
    const ok = writeHeartbeatFileSync(config, { status: 'stopped', connected: false });
    expect(ok).toBe(true);
  });
});

describe('readAgentStatus', () => {
  async function writeStatus(contents: string) {
    const dir = resolveStateDir(config);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'status.json'), contents);
  }

  it('returns null when the file is absent', async () => {
    expect(await readAgentStatus(config)).toBeNull();
  });

  it('reads status + note and clamps overlong fields', async () => {
    await writeStatus(JSON.stringify({ status: 'working', note: 'x'.repeat(1000) }));
    const status = await readAgentStatus(config);
    expect(status?.status).toBe('working');
    expect(status?.note?.length).toBe(400);
  });

  it('accepts message as an alias for note', async () => {
    await writeStatus(JSON.stringify({ message: 'refactoring the queue' }));
    expect((await readAgentStatus(config))?.note).toBe('refactoring the queue');
  });

  it('returns null on malformed JSON', async () => {
    await writeStatus('{ not json');
    expect(await readAgentStatus(config)).toBeNull();
  });

  it('returns null on a JSON array (not an object)', async () => {
    await writeStatus('["nope"]');
    expect(await readAgentStatus(config)).toBeNull();
  });

  it('returns null when neither status nor note is present', async () => {
    await writeStatus(JSON.stringify({ unrelated: true }));
    expect(await readAgentStatus(config)).toBeNull();
  });

  it('ignores an oversized status file', async () => {
    await writeStatus(JSON.stringify({ status: 'ok', pad: 'y'.repeat(9000) }));
    expect(await readAgentStatus(config)).toBeNull();
  });
});

describe('identity.json (operator/agent-owned self-declared identity)', () => {
  async function writeIdentity(contents: string) {
    const dir = resolveStateDir(config);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'identity.json'), contents);
  }

  it('identityFilePath points into the state dir', () => {
    expect(identityFilePath(config)).toBe(path.join(resolveStateDir(config), 'identity.json'));
  });

  it('returns null when the file is absent', async () => {
    expect(await readAgentIdentity(config)).toBeNull();
  });

  it('passes through the fields the server accepts and drops unknown keys', async () => {
    await writeIdentity(JSON.stringify({
      name: 'Fox',
      avatar: 'FX',
      accent_color: '#ff6600',
      description: 'A cunning coding agent',
      soul: 'Be direct.',
      voice: { cartesia_voice_id: 'voice-abc-12345', speed: 1.2, emotion: 'calm', junk: 'x' },
      unrelated: 'dropped',
    }));
    expect(await readAgentIdentity(config)).toEqual({
      name: 'Fox',
      avatar: 'FX',
      accent_color: '#ff6600',
      description: 'A cunning coding agent',
      soul: 'Be direct.',
      voice: { cartesia_voice_id: 'voice-abc-12345', speed: 1.2, emotion: 'calm' },
    });
  });

  it('accepts profile as an alias for description', async () => {
    await writeIdentity(JSON.stringify({ profile: 'Reviewer of last resort' }));
    expect(await readAgentIdentity(config)).toEqual({ description: 'Reviewer of last resort' });
  });

  it('folds a top-level attitude into the voice block', async () => {
    await writeIdentity(JSON.stringify({ avatar: '🤖', attitude: 'sarcastic' }));
    expect(await readAgentIdentity(config)).toEqual({ avatar: '🤖', voice: { attitude: 'sarcastic' } });
  });

  it('drops blank and non-string text fields without duplicating server caps', async () => {
    await writeIdentity(JSON.stringify({
      name: '   ',
      avatar: 42,
      description: 'kept even when very long '.repeat(40), // length caps are server-side
      voice: 'not-an-object',
    }));
    const identity = await readAgentIdentity(config);
    expect(identity?.description?.length).toBeGreaterThan(500);
    expect(identity && 'name' in identity).toBe(false);
    expect(identity && 'avatar' in identity).toBe(false);
    expect(identity && 'voice' in identity).toBe(false);
  });

  it('keeps a string speed for the server to coerce', async () => {
    await writeIdentity(JSON.stringify({ voice: { speed: '1.1' } }));
    expect(await readAgentIdentity(config)).toEqual({ voice: { speed: '1.1' } });
  });

  it('returns null on malformed JSON, an array, or nothing recognisable', async () => {
    await writeIdentity('{ not json');
    expect(await readAgentIdentity(config)).toBeNull();
    await writeIdentity('["nope"]');
    expect(await readAgentIdentity(config)).toBeNull();
    await writeIdentity(JSON.stringify({ unrelated: true, voice: {} }));
    expect(await readAgentIdentity(config)).toBeNull();
  });

  it('ignores an oversized identity file', async () => {
    await writeIdentity(JSON.stringify({ avatar: 'FX', pad: 'y'.repeat(17 * 1024) }));
    expect(await readAgentIdentity(config)).toBeNull();
  });
});

describe('update-request.json (agent-owned self-update trigger)', () => {
  it('returns null when no request has been written', async () => {
    expect(await readUpdateRequest(config)).toBeNull();
  });

  it('writes and reads back a valid request', async () => {
    const ok = await writeUpdateRequest(config, { targetVersion: '0.1.31', note: 'testing rollback' });
    expect(ok).toBe(true);
    const request = await readUpdateRequest(config);
    expect(request?.targetVersion).toBe('0.1.31');
    expect(request?.note).toBe('testing rollback');
    expect(typeof request?.requestedAt).toBe('string');
  });

  it('rejects a version with an unsafe charset (never reaches an npm install argv)', async () => {
    expect(await writeUpdateRequest(config, { targetVersion: '0.1.31; rm -rf /' })).toBe(false);
    expect(await readUpdateRequest(config)).toBeNull();
  });

  it('treats a hand-edited malformed version the same way on read', async () => {
    await fs.mkdir(resolveStateDir(config), { recursive: true });
    await fs.writeFile(updateRequestFilePath(config), JSON.stringify({ targetVersion: '../../etc' }));
    expect(await readUpdateRequest(config)).toBeNull();
  });

  it('clearUpdateRequest removes the file and is a no-op when already absent', async () => {
    await writeUpdateRequest(config, { targetVersion: '0.1.31' });
    expect(await clearUpdateRequest(config)).toBe(true);
    expect(await readUpdateRequest(config)).toBeNull();
    expect(await clearUpdateRequest(config)).toBe(true);
  });
});

describe('update.json (supervisor-owned version/rollback record)', () => {
  it('returns null when absent', async () => {
    expect(await readUpdateState(config)).toBeNull();
  });

  it('round-trips currentVersion/previousVersion/lastAttempt', async () => {
    const ok = await writeUpdateState(config, {
      currentVersion: '0.1.31',
      previousVersion: '0.1.30',
      lastAttempt: { version: '0.1.31', result: 'ok' },
    });
    expect(ok).toBe(true);
    const state = await readUpdateState(config);
    expect(state?.currentVersion).toBe('0.1.31');
    expect(state?.previousVersion).toBe('0.1.30');
    expect(state?.lastAttempt).toEqual({ version: '0.1.31', result: 'ok' });
    expect(typeof state?.updatedAt).toBe('string');
    expect(updateStateFilePath(config)).toBe(path.join(resolveStateDir(config), 'update.json'));
  });
});
