// Agent skill bodies: the markdown behind each skill NAME this daemon advertises.
//
// `capabilities.skills` (slashEnum.detectSkillNames) is a list of names, so a skill
// was unusable unless an agent happened to be running on the machine that had it.
// This is the other half: the BODIES ride up on `agent_skill_sync` and are mirrored
// into `agent_skill_documents`, so another agent can read a skill's text while the
// machine that owns it is offline.
//
// Deliberately the same shape as memory.mjs (enumerate -> fingerprint -> snapshot),
// so there is ONE pattern for "a daemon pushed files up", not two. The fingerprint is
// stat-only and rides every heartbeat as a hash; bodies only move when the server sees
// that hash drift and nudges `agent_skills_refresh`.
//
// SECURITY: the only files read are the ones detectSkillEntries already resolved —
// inside the three skill roots slashEnum scans, nothing caller-supplied, nothing else
// on the machine. No env, no credentials, no arbitrary paths.
//
// NOTHING HERE THROWS. A skills directory that doesn't exist, a file that can't be
// read, a permission error: each degrades to "this skill has no body" and the caller
// carries on. A daemon dropping its connection — and its agent going offline — over an
// unreadable SKILL.md would be far worse than the missing text.

import fs from "node:fs/promises";

import { detectSkillEntries } from "./slashEnum.mjs";

// The server keeps 64 KiB per document (SKILL_CONTENT_MAX_BYTES in
// server/skill-content.cjs) and at most 200 documents per push
// (SKILL_DOCUMENT_MAX_FILES). Matched exactly: anything past these is bytes we put on
// the wire for the server to drop on arrival.
export const MAX_SKILL_BYTES = 64 * 1024;
export const MAX_SKILLS = 200;

// Whole-push ceiling. Ours, not the server's: 200 x 64 KiB is a ~12 MB frame on
// whatever link this daemon happens to have, and it would be re-sent every time the
// server nudged a refresh. A pathological skills directory must not wedge the socket.
export const MAX_SYNC_BYTES = 4 * 1024 * 1024;

/** Most characters of a description we keep (the server slices to 2000 as well). */
const MAX_SUMMARY_CHARS = 2000;

/** Below this there is no room for a useful prefix, so send the marker alone. */
const MIN_PARTIAL_BYTES = 512;

/**
 * Append a visible truncation marker, cutting the body so the WHOLE result still fits
 * `limit` bytes.
 *
 * Truncation is marked, never silent, in both channels: this marker (what a human or
 * an agent reads) and the `truncated` flag on the document (what the server stores and
 * `fenceSkillContent` re-states). A body that just stops mid-sentence reads like the
 * skill itself is broken.
 */
function withTruncationMark(text, reason, limit = MAX_SKILL_BYTES) {
  const note = `\n\n... [truncated by agensis-agent: ${reason}]\n`;
  const room = Math.max(0, limit - Buffer.byteLength(note));
  // Byte-sliced because bytes are what the cap protects; a trailing replacement char
  // from a multi-byte sequence cut at the boundary is dropped rather than shown.
  const body = Buffer.from(String(text || "")).subarray(0, room).toString("utf8").replace(/\uFFFD+$/, "");
  return `${body}${note}`;
}

/**
 * The `description:` from a SKILL.md's frontmatter, else its first line of prose.
 *
 * Block scalars (`description: >-` followed by indented lines) are handled because
 * real skills in the wild use them; anything unparseable just yields "".
 */
export function skillSummary(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  let summary = "";
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length && i < 200; i += 1) {
      if (lines[i].trim() === "---") break;
      const match = /^description:\s*(.*)$/i.exec(lines[i]);
      if (!match) continue;
      const inline = match[1].trim();
      if (inline && !/^[|>][-+]?$/.test(inline)) {
        summary = inline.replace(/^["']|["']$/g, "");
        break;
      }
      // Block scalar: the value is the indented lines that follow.
      const parts = [];
      for (let j = i + 1; j < lines.length && j < 200; j += 1) {
        if (lines[j].trim() === "---") break;
        if (lines[j].trim() && !/^\s/.test(lines[j])) break; // next key
        parts.push(lines[j].trim());
      }
      summary = parts.join(" ").trim();
      break;
    }
  }
  if (!summary) {
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    const body = lines[0]?.trim() === "---" && close > 0 ? lines.slice(close + 1) : lines;
    const first = body.find((line) => line.trim() && line.trim() !== "---");
    summary = String(first || "").replace(/^#+\s*/, "").trim();
  }
  return summary.slice(0, MAX_SUMMARY_CHARS);
}

/** Entries for this machine's skills. Never throws — an unscannable root is []. */
function safeEntries(options) {
  try {
    return detectSkillEntries(options).slice(0, MAX_SKILLS);
  } catch {
    return [];
  }
}

/**
 * Read at most MAX_SKILL_BYTES + 1 bytes of a file.
 *
 * The extra byte is how "exactly at the ceiling" is told apart from "over it" without
 * ever loading a huge file into this process. Returns null when the file can't be
 * opened or read — the caller treats that as "no body".
 */
async function readCapped(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** One document, or null when this skill has no readable body. */
async function readSkillDocument(entry, budget) {
  const raw = await readCapped(entry.file);
  if (!raw) return null;
  const text = raw.toString("utf8");
  const summary = skillSummary(text);

  const overCap = raw.length > MAX_SKILL_BYTES;
  const limit = Math.min(MAX_SKILL_BYTES, Math.max(0, budget));
  const overBudget = Buffer.byteLength(text) > limit;
  if (!overCap && !overBudget) {
    return { skill: entry.name, path: entry.file, summary, content: text, truncated: false };
  }

  const size = overCap ? await fileSize(entry.file) : 0;
  const reason = overCap && !overBudget
    ? `the file is ${size ? `${size} bytes` : `over ${MAX_SKILL_BYTES} bytes`}; only the first ${MAX_SKILL_BYTES} were synced`
    : `this sync reached its ${MAX_SYNC_BYTES}-byte ceiling`;
  const content = limit < MIN_PARTIAL_BYTES
    ? withTruncationMark("", reason, Number.MAX_SAFE_INTEGER)
    : withTruncationMark(text, reason, limit);
  return { skill: entry.name, path: entry.file, summary, content, truncated: true };
}

async function fileSize(file) {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return 0;
  }
}

/**
 * Cheap drift fingerprint: every advertised skill with the size and mtime of its body
 * (stat only, no reads), in a stable canonical order. The daemon hashes this and sends
 * the hash on every heartbeat; the server compares it against the last hash a real
 * sync stored and nudges a re-push when they differ.
 *
 * Names with no body are included as `name:-` so a SKILL.md appearing or disappearing
 * is drift, not silence.
 */
export async function skillsFingerprint(options = {}) {
  const parts = [];
  for (const entry of safeEntries(options)) {
    if (!entry.file) {
      parts.push(`${entry.name}:-`);
      continue;
    }
    try {
      const stat = await fs.stat(entry.file);
      parts.push(`${entry.name}:${entry.file}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
    } catch {
      // Vanished or unreadable between the scan and the stat — still a state worth
      // hashing, so recovering from it counts as drift.
      parts.push(`${entry.name}:-`);
    }
  }
  return parts.join("|");
}

/**
 * The full set of documents to push: `{ skill, path, summary, content, truncated }`,
 * exactly the fields `normalizeSkillDocument` on the server keeps.
 *
 * `path` is advisory — where the file lives on THIS machine. The server stores it as a
 * label and never opens it.
 */
export async function snapshotSkills(options = {}) {
  const documents = [];
  let spent = 0;
  for (const entry of safeEntries(options)) {
    if (!entry.file) continue; // a skill name with no SKILL.md — nothing to send
    try {
      const doc = await readSkillDocument(entry, MAX_SYNC_BYTES - spent);
      if (!doc) continue; // unreadable — this skill simply has no body
      spent += Buffer.byteLength(doc.content);
      documents.push(doc);
    } catch {
      // Belt and braces: one bad file never costs the other skills their bodies.
    }
  }
  return documents;
}
