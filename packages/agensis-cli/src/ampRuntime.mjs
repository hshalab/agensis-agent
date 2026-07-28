import fs from 'node:fs/promises';
import path from 'node:path';
import { runCli } from './cli.mjs';

export const AMP_RUNTIME_ID = 'amp';
const AMP_THREAD_RE = /^T-[A-Za-z0-9-]{20,100}$/;

const FAILURE_MESSAGES = {
  amp_not_installed: 'Amp CLI is not installed on the connected machine. Install Amp, then reconnect this agent.',
  amp_version_unsupported: 'The installed Amp CLI does not support orb execute streaming. Update Amp, then reconnect this agent.',
  amp_not_authenticated: 'Amp is not signed in on the connected machine. Run `amp login` there, then try again.',
  amp_auth_expired: 'The Amp sign-in on the connected machine has expired. Run `amp login` there, then try again.',
  amp_project_not_found: 'This repository is not an Amp project. Create or join its Amp project, then try again.',
  amp_project_forbidden: 'The connected Amp account cannot access this repository project.',
  amp_repo_not_allowed: 'This repository is not allowed by the connected Agensis daemon profile.',
  amp_insufficient_credit: 'The connected Amp account does not have enough credit to start or continue this orb.',
  amp_orb_provision_failed: 'Amp could not provision the orb for this turn.',
  amp_setup_failed: 'The repository `.agents/setup` script exists but is not executable.',
  amp_thread_not_found: 'The Amp thread linked to this conversation no longer exists. Start a new Agensis conversation to create a new thread.',
  amp_stream_invalid: 'Amp completed without returning a valid thread stream.',
  amp_cli_crashed: 'The Amp CLI stopped unexpectedly on the connected machine.',
  amp_turn_cancelled: 'The Amp turn was cancelled.',
  amp_turn_timed_out: 'The Amp turn timed out on the connected machine.',
};

export function createAmpError(code, detail = '') {
  const error = new Error(FAILURE_MESSAGES[code] || FAILURE_MESSAGES.amp_cli_crashed);
  error.code = code;
  if (detail) error.detail = String(detail).slice(0, 1000);
  return error;
}

export function isAmpJob(job) {
  return String(job?.agent?.metadata?.runtime || '').trim().toLowerCase() === AMP_RUNTIME_ID;
}

export function validAmpThreadId(value) {
  const id = String(value || '').trim();
  return AMP_THREAD_RE.test(id) ? id : '';
}

export function ampThreadUrl(threadId) {
  const id = validAmpThreadId(threadId);
  return id ? `https://ampcode.com/threads/${id}` : '';
}

export function buildAmpCommand({ prompt, threadId = '', executable = 'amp' } = {}) {
  const id = validAmpThreadId(threadId);
  return id
    ? { cmd: executable, args: ['threads', 'continue', id, '-x', String(prompt || ''), '--stream-json'] }
    : { cmd: executable, args: ['-o', '-x', String(prompt || ''), '--stream-json', '--no-archive-after-execute'] };
}

export function createAmpStreamTracker() {
  let buffer = '';
  let threadId = '';

  const parseLine = (line) => {
    try {
      const event = JSON.parse(String(line).trim());
      const candidate = validAmpThreadId(event?.session_id || event?.sessionId || event?.thread_id || event?.threadId);
      if (candidate) threadId = candidate;
    } catch {
      // Amp's stdout should be NDJSON, but text noise must not crash the daemon.
    }
  };

  return {
    feed(chunk) {
      buffer += String(chunk || '');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        parseLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    },
    end() {
      if (buffer) parseLine(buffer);
      buffer = '';
    },
    get threadId() {
      return threadId;
    },
    get threadUrl() {
      return ampThreadUrl(threadId);
    },
  };
}

export function classifyAmpFailure(result = {}) {
  const text = `${result?.error?.message || ''}\n${result?.stderr || ''}\n${result?.stdout || ''}`.trim();
  let code = 'amp_cli_crashed';
  if (result?.error?.code === 'ENOENT' || /spawn\s+amp\s+ENOENT|command not found/i.test(text)) code = 'amp_not_installed';
  else if (result?.aborted === true || /^cancelled$/i.test(String(result?.error?.message || '').trim())) code = 'amp_turn_cancelled';
  else if (/timed out|timeout/i.test(text)) code = 'amp_turn_timed_out';
  else if (/(?:auth(?:entication)?|session|token|credential)[^\n]*(?:expired|invalid|revoked)/i.test(text)) code = 'amp_auth_expired';
  else if (/not (?:logged|signed) in|not authenticated|please (?:log|sign) ?in|(?:log|sign) ?in (?:to|required)|authentication required|unauthenticated|unauthorized/i.test(text)) code = 'amp_not_authenticated';
  else if (/insufficient[^\n]*(?:credit|balance)|(?:credit|balance)[^\n]*(?:exhausted|too low|not enough|run out|out of)|(?:run )?out of[^\n]*(?:credit|balance)|(?:usage|spend)[^\n]*limit[^\n]*(?:exceeded|reached)/i.test(text)) code = 'amp_insufficient_credit';
  else if (/thread[^\n]*(?:not found|does not exist|unknown)/i.test(text)) code = 'amp_thread_not_found';
  else if (/project[^\n]*(?:forbidden|permission|access denied|not allowed)/i.test(text)) code = 'amp_project_forbidden';
  else if (/project[^\n]*(?:not found|does not exist|unmatched)/i.test(text)) code = 'amp_project_not_found';
  else if (/\.agents\/setup|setup script/i.test(text)) code = 'amp_setup_failed';
  else if (/provision|creating orb|start(?:ing)? orb/i.test(text)) code = 'amp_orb_provision_failed';
  return { code, message: FAILURE_MESSAGES[code], detail: text.slice(0, 1000) };
}

export async function assertAmpRepo({ cwd, allowedRoots = [] } = {}) {
  const resolved = path.resolve(String(cwd || ''));
  const allowed = allowedRoots
    .map(root => String(root || '').trim())
    .filter(Boolean)
    .map(root => path.resolve(root));
  if (!allowed.includes(resolved)) throw createAmpError('amp_repo_not_allowed');

  try {
    await fs.access(path.join(resolved, '.git'));
  } catch {
    throw createAmpError('amp_repo_not_allowed', 'cwd is not a Git repository root');
  }

  const setup = path.join(resolved, '.agents', 'setup');
  try {
    const stat = await fs.stat(setup);
    if (stat.isFile() && (stat.mode & 0o111) === 0) throw createAmpError('amp_setup_failed');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return resolved;
}

function runtimeUnavailable(version, reason) {
  return { id: AMP_RUNTIME_ID, available: false, version, reason, project: null };
}

function safeProject(project) {
  if (!project || typeof project !== 'object') return null;
  return {
    id: String(project.id || '').slice(0, 160),
    name: String(project.name || project.slug || '').slice(0, 200),
    repository: String(project.repository || project.repo || project.repositoryUrl || '').slice(0, 500),
  };
}

export async function probeAmpRuntime({ cwd, executable = 'amp', run = runCli, signal } = {}) {
  const invoke = (args, timeoutMs = 10_000) => run({
    cmd: executable,
    args,
    cwd,
    timeoutMs,
    heartbeatMs: 0,
    label: 'checking Amp',
    signal,
  });

  const versionResult = await invoke(['version'], 5_000);
  if (versionResult?.status !== 0) {
    const failure = classifyAmpFailure(versionResult);
    return runtimeUnavailable('', failure.code);
  }
  const version = String(versionResult.stdout || versionResult.stderr || '').trim().split(/\r?\n/).at(-1)?.slice(0, 120) || '';

  const helpResult = await invoke(['--help'], 5_000);
  const help = `${helpResult?.stdout || ''}\n${helpResult?.stderr || ''}`;
  if (helpResult?.status !== 0 || !/--stream-json/.test(help) || !/threads[\s\S]*continue/i.test(help) || !/\borb\b/i.test(help)) {
    return runtimeUnavailable(version, 'amp_version_unsupported');
  }

  // `threads list` has no JSON flag in current Amp releases. `usage` is a
  // read-only authenticated operation and fails cleanly when the account token
  // is missing/expired, without opening a thread or spending orb credit.
  const accountResult = await invoke(['usage']);
  if (accountResult?.status !== 0) {
    const failure = classifyAmpFailure(accountResult);
    return runtimeUnavailable(version, failure.code);
  }

  const projectResult = await invoke(['projects', 'status', '--json']);
  if (projectResult?.status !== 0) {
    const failure = classifyAmpFailure(projectResult);
    return runtimeUnavailable(version, failure.code);
  }
  let status;
  try {
    status = JSON.parse(String(projectResult.stdout || ''));
  } catch {
    return runtimeUnavailable(version, 'amp_version_unsupported');
  }
  if (['forbidden', 'permission_denied', 'access_denied'].includes(String(status?.status || '').toLowerCase())) {
    return runtimeUnavailable(version, 'amp_project_forbidden');
  }
  if (status?.status !== 'matched' || !status?.project) return runtimeUnavailable(version, 'amp_project_not_found');
  return { id: AMP_RUNTIME_ID, available: true, version, reason: null, project: safeProject(status.project) };
}

export function ampFailureError(result) {
  const failure = classifyAmpFailure(result);
  return createAmpError(failure.code, failure.detail);
}

export function ampFailureMessage(code) {
  return FAILURE_MESSAGES[code] || FAILURE_MESSAGES.amp_cli_crashed;
}
