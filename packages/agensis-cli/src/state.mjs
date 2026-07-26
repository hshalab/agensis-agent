// Agent local state files: the daemon writes a small on-disk mirror of this agent's
// runtime under ~/.agensis/<workspace>/<agent>/ so an external watchdog, the human, or
// the agent's own coding subprocess can read/observe live state without the server.
//
// Files (all JSON except soul.md):
//   heartbeat.json  — DAEMON-OWNED liveness. Refreshed on an interval that runs for the
//                     whole process lifetime (independent of the socket) so a watchdog
//                     can tell "daemon dead" (stale ts) from "server unreachable"
//                     (fresh ts, connected:false).
//   soul.md         — DAEMON-OWNED mirror of the server-authoritative soul text.
//   agent.json      — DAEMON-OWNED mirror of the agent config (model, permission, tools…).
//   status.json     — AGENT-OWNED write-back. The coding subprocess overwrites this to
//                     report its own status; the daemon reads it each beat and folds it
//                     into the heartbeat it sends up. The daemon NEVER writes this file,
//                     so there is no self-write feedback loop.
//   identity.json   — OPERATOR/AGENT-OWNED self-declared identity (avatar, description,
//                     soul, voice…). Read fresh on every connect and sent as `identity`
//                     on agent_register; the daemon NEVER writes it (agent.json is
//                     daemon-owned and rewritten wholesale on every register, so this
//                     lives in its own file). Absent or malformed = nothing is sent.
//   update-request.json — AGENT-OWNED trigger. The coding subprocess writes this to ask
//                     the supervisor (see selfUpdate.mjs) to update+reload the daemon's
//                     own connection. The supervisor clears it once picked up, so it is
//                     never re-run on a stale request.
//   update.json     — SUPERVISOR-OWNED version/rollback record: current + previous
//                     version, and the result of the last attempt (including an
//                     automatic rollback). Read-only from the agent/daemon side; only
//                     selfUpdate.mjs's performSelfUpdate() writes it.
//
// Everything here is best-effort: a failure to create the dir or write a file is logged
// by the caller and never fatal to the agent.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const STATUS_FILE = "status.json";
const IDENTITY_FILE = "identity.json";
const HEARTBEAT_FILE = "heartbeat.json";
const HEARTBEAT_MD_FILE = "heartbeat.md";
const AGENT_FILE = "agent.json";
const SOUL_FILE = "soul.md";
const UPDATE_REQUEST_FILE = "update-request.json";
const UPDATE_STATE_FILE = "update.json";

// Caps so a runaway agent can't write a giant update request/state blob.
const MAX_UPDATE_REQUEST_BYTES = 4 * 1024;
const MAX_UPDATE_STATE_BYTES = 16 * 1024;
// Versions are npm semver-ish strings; keep the accepted charset narrow since
// this value is later interpolated into an `npm install pkg@<version>` argv.
const VERSION_RE = /^[a-zA-Z0-9._+-]{1,64}$/;

// Cap on how much heartbeat.md we read back into the prompt — it's human/agent-editable,
// so a runaway edit shouldn't be able to balloon every job's prompt.
const MAX_HEARTBEAT_MD_BYTES = 16 * 1024;

// Seed text written to heartbeat.md the first time an agent's state dir is created. It is
// meant to be edited (by the human or the agent) — the daemon never overwrites an existing
// file, so edits survive restarts. Its contents are injected into every job prompt.
const DEFAULT_HEARTBEAT_MD = `# Heartbeat

This file tells you what to do on each heartbeat — the recurring "still here, still
working" moment. Edit it freely; the daemon reads it but never overwrites your edits.

On each heartbeat:

- Keep \`status.json\` fresh — overwrite it with \`{"status":"...","note":"..."}\` so your
  card reflects what you're actually doing right now.
- If you're blocked, say so in the note rather than going silent.
- If you've finished and there's nothing to do, a short idle note is fine.

Add your own recurring checks below.
`;

// Caps so an agent can't write a giant status blob that we then ship on every beat.
const MAX_STATUS_BYTES = 8 * 1024;
const MAX_STATUS_FIELD = 400;

// UUIDs in practice, but never trust config blindly: keep path segments to a safe
// charset so a crafted workspace/agent id can't escape the base dir.
function safeSegment(value, fallback) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".") // collapse any dot-run so no ".." can survive in a segment
    .replace(/^[.-]+/, "")
    .slice(0, 96);
  return cleaned || fallback;
}

// Resolve (but do not create) the per-agent state directory.
export function resolveStateDir({ workspace, agent, homedir = os.homedir() } = {}) {
  return path.join(
    homedir,
    ".agensis",
    safeSegment(workspace, "workspace"),
    safeSegment(agent, "agent"),
  );
}

export function statusFilePath(config) {
  return path.join(resolveStateDir(config), STATUS_FILE);
}

export function heartbeatMdPath(config) {
  return path.join(resolveStateDir(config), HEARTBEAT_MD_FILE);
}

// Create the state dir if needed. Returns the dir, or null if it can't be created.
async function ensureStateDir(config) {
  const dir = resolveStateDir(config);
  try {
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

// Atomic write: tmp file + rename, so a reader (watchdog) never observes a half-written
// file. Best-effort — swallows errors and reports success as a boolean.
async function writeFileAtomic(target, contents) {
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    await fsp.writeFile(tmp, contents);
    await fsp.rename(tmp, target);
    return true;
  } catch {
    try {
      await fsp.rm(tmp, { force: true });
    } catch {
      // ignore cleanup failure
    }
    return false;
  }
}

// Write the daemon-owned config mirror (agent.json + soul.md) from the full agent
// payload the server sends on register / config. Fire-and-forget from the caller.
export async function writeAgentMirror(config, agent) {
  if (!agent || typeof agent !== "object") return false;
  const dir = await ensureStateDir(config);
  if (!dir) return false;
  const mirror = {
    id: agent.id ?? config.agent ?? "",
    workspace: agent.workspace_id ?? config.workspace ?? "",
    name: agent.name ?? config.name ?? "",
    handle: agent.handle ?? config.handle ?? "",
    model: agent.model ?? config.model ?? "",
    permissionMode: agent.permissionMode ?? agent.permission_mode ?? config.permissionMode ?? "",
    description: agent.description ?? "",
    instructions: agent.instructions ?? "",
    systemPrompt: agent.system_prompt ?? agent.systemPrompt ?? "",
    tools: Array.isArray(agent.tools) ? agent.tools : [],
    skills: Array.isArray(agent.skills) ? agent.skills : [],
    memoryDir: agent.memory_dir ?? agent.memoryDir ?? "",
    version: Number(agent.version || 0),
    updatedAt: new Date().toISOString(),
  };
  const okAgent = await writeFileAtomic(
    path.join(dir, AGENT_FILE),
    `${JSON.stringify(mirror, null, 2)}\n`,
  );
  const soul = String(agent.soul ?? "");
  const okSoul = await writeFileAtomic(path.join(dir, SOUL_FILE), soul);
  return okAgent && okSoul;
}

// Write the daemon-owned liveness file. `beat` is the current liveness snapshot; we add
// a timestamp so a stale file is detectable. Async atomic write for regular beats.
export async function writeHeartbeatFile(config, beat = {}) {
  const dir = await ensureStateDir(config);
  if (!dir) return false;
  return writeFileAtomic(path.join(dir, HEARTBEAT_FILE), heartbeatContents(config, beat));
}

// Synchronous variant for the final "stopped" beat written during shutdown, so it lands
// before the process exits (an async write can be cut off by process.exit).
export function writeHeartbeatFileSync(config, beat = {}) {
  const dir = resolveStateDir(config);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, HEARTBEAT_FILE), heartbeatContents(config, beat));
    return true;
  } catch {
    return false;
  }
}

function heartbeatContents(config, beat) {
  const now = Date.now();
  const payload = {
    ts: now,
    iso: new Date(now).toISOString(),
    status: beat.status || (beat.busy ? "busy" : "online"),
    busy: Boolean(beat.busy),
    active: Number(beat.active || 0),
    queueSize: Number(beat.queueSize || 0),
    connected: Boolean(beat.connected),
    model: config.model || "",
    permissionMode: config.permissionMode || "",
    handle: config.handle || "",
    agent: config.agent || "",
    workspace: config.workspace || "",
    pid: process.pid,
    heartbeatMs: config.heartbeatMs,
    ...(beat.agentStatus ? { agentStatus: beat.agentStatus } : {}),
    ...(beat.agentNote ? { agentNote: beat.agentNote } : {}),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

// Read the AGENT-OWNED status.json. Returns { status, note, ts } or null when the file is
// absent, unreadable, too big, or malformed. Never throws. Fields are clamped so a
// runaway agent can't bloat the heartbeat we ship upstream.
export async function readAgentStatus(config) {
  const file = path.join(resolveStateDir(config), STATUS_FILE);
  let raw;
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > MAX_STATUS_BYTES) return null;
    raw = await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const status = clampField(parsed.status);
  const note = clampField(parsed.note ?? parsed.message);
  if (!status && !note) return null;
  const out = {};
  if (status) out.status = status;
  if (note) out.note = note;
  if (parsed.ts != null && Number.isFinite(Number(parsed.ts))) out.ts = Number(parsed.ts);
  return out;
}

function clampField(value) {
  if (value == null) return "";
  const text = String(value).trim().replace(/\s+/g, " ");
  return text.slice(0, MAX_STATUS_FIELD);
}

// Cap so a runaway identity.json edit can't ship a giant blob on every reconnect. The
// server bounds each field far tighter (shared/agentIdentity.cjs FIELD_LIMITS); this
// only bounds the file read, deliberately NOT duplicating those caps.
const MAX_IDENTITY_BYTES = 16 * 1024;

// The fields the server's normalizeIdentityDeclaration understands. This is a
// shape-only filter: lengths, the colour format, the emotion whitelist and the
// human-set precedence rule are all enforced server-side.
const IDENTITY_TEXT_FIELDS = ["name", "avatar", "accent_color", "description", "soul"];
const IDENTITY_VOICE_FIELDS = ["cartesia_voice_id", "voice_id", "id", "speed", "emotion", "attitude"];

export function identityFilePath(config) {
  return path.join(resolveStateDir(config), IDENTITY_FILE);
}

// Read the OPERATOR/AGENT-OWNED identity.json declaration. Returns a sparse object of
// only the fields the server accepts, or null when the file is absent, unreadable, too
// big, malformed, or carries nothing recognisable — in which case the register frame
// simply has no identity key, exactly the pre-identity behaviour. Never throws: a
// broken identity file must never be the reason a daemon cannot come online.
export async function readAgentIdentity(config) {
  const file = identityFilePath(config);
  let raw;
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > MAX_IDENTITY_BYTES) return null;
    raw = await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out = {};
  for (const field of IDENTITY_TEXT_FIELDS) {
    // `profile` is a natural alias for description; the wire name stays canonical.
    const value = field === "description" && parsed.description == null ? parsed.profile : parsed[field];
    if (typeof value !== "string" || !value.trim()) continue;
    out[field] = value.trim();
  }
  const voice = voiceShape(parsed.voice, parsed.attitude);
  if (voice) out.voice = voice;
  return Object.keys(out).length > 0 ? out : null;
}

// Shape-only pass over the voice block. A top-level `attitude` folds into the voice —
// the server only reads attitude as an alias of `voice.emotion`, never top-level.
function voiceShape(rawVoice, topLevelAttitude) {
  const source = rawVoice && typeof rawVoice === "object" && !Array.isArray(rawVoice) ? rawVoice : {};
  const out = {};
  for (const field of IDENTITY_VOICE_FIELDS) {
    const value = source[field];
    if (typeof value === "string" && value.trim()) out[field] = value.trim();
    else if (field === "speed" && typeof value === "number" && Number.isFinite(value)) out.speed = value;
  }
  if (!out.emotion && !out.attitude && typeof topLevelAttitude === "string" && topLevelAttitude.trim()) {
    out.attitude = topLevelAttitude.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function updateRequestFilePath(config) {
  return path.join(resolveStateDir(config), UPDATE_REQUEST_FILE);
}

export function updateStateFilePath(config) {
  return path.join(resolveStateDir(config), UPDATE_STATE_FILE);
}

// Write the AGENT-OWNED update request: the coding subprocess (or any tool acting on
// its behalf) asks the supervisor to update+reload to `targetVersion`. Requires Change
// 1's --add-dir grant for this agent's own state dir to actually land on disk.
export async function writeUpdateRequest(config, { targetVersion, note } = {}) {
  const version = String(targetVersion || "").trim();
  if (!VERSION_RE.test(version)) return false;
  const dir = await ensureStateDir(config);
  if (!dir) return false;
  const payload = {
    targetVersion: version,
    note: clampField(note),
    requestedAt: new Date().toISOString(),
  };
  return writeFileAtomic(path.join(dir, UPDATE_REQUEST_FILE), `${JSON.stringify(payload, null, 2)}\n`);
}

// Read the AGENT-OWNED update request. Returns { targetVersion, note?, requestedAt? } or
// null when absent, unreadable, too big, malformed, or the version fails validation.
// Never throws.
export async function readUpdateRequest(config) {
  const file = updateRequestFilePath(config);
  let raw;
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > MAX_UPDATE_REQUEST_BYTES) return null;
    raw = await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const targetVersion = String(parsed.targetVersion || "").trim();
  if (!VERSION_RE.test(targetVersion)) return null;
  const out = { targetVersion };
  const note = clampField(parsed.note);
  if (note) out.note = note;
  if (typeof parsed.requestedAt === "string") out.requestedAt = parsed.requestedAt;
  return out;
}

// Clear a picked-up (or invalid) update request so it is never re-run on a stale file.
// Best-effort — a missing file is not an error.
export async function clearUpdateRequest(config) {
  try {
    await fsp.rm(updateRequestFilePath(config), { force: true });
    return true;
  } catch {
    return false;
  }
}

// Read the SUPERVISOR-OWNED version/rollback record. Returns the parsed object, or null
// when absent, unreadable, too big, or malformed. Never throws.
export async function readUpdateState(config) {
  const file = updateStateFilePath(config);
  let raw;
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > MAX_UPDATE_STATE_BYTES) return null;
    raw = await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Write the SUPERVISOR-OWNED version/rollback record. Only performSelfUpdate()
// (selfUpdate.mjs) should call this — it is the single source of truth for what
// version is current, what the fallback is, and how the last attempt went.
export async function writeUpdateState(config, state = {}) {
  const dir = await ensureStateDir(config);
  if (!dir) return false;
  const payload = { ...state, updatedAt: new Date().toISOString() };
  return writeFileAtomic(path.join(dir, UPDATE_STATE_FILE), `${JSON.stringify(payload, null, 2)}\n`);
}

// Seed heartbeat.md with the default text ONLY if it doesn't already exist. This file is
// editable by the human and the agent; the daemon must never clobber those edits, so an
// existing file (even empty) is left untouched. Best-effort — never throws.
export async function ensureHeartbeatMd(config) {
  const dir = await ensureStateDir(config);
  if (!dir) return false;
  const file = path.join(dir, HEARTBEAT_MD_FILE);
  try {
    await fsp.access(file);
    return true; // already present — leave the human's/agent's edits alone
  } catch {
    // not present — seed it
  }
  return writeFileAtomic(file, DEFAULT_HEARTBEAT_MD);
}

// Read heartbeat.md back for prompt injection. Returns the trimmed contents, or null when
// absent, unreadable, empty, or oversized. Never throws.
export async function readHeartbeatMd(config) {
  const file = path.join(resolveStateDir(config), HEARTBEAT_MD_FILE);
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > MAX_HEARTBEAT_MD_BYTES) return null;
    const raw = (await fsp.readFile(file, "utf8")).trim();
    return raw || null;
  } catch {
    return null;
  }
}
