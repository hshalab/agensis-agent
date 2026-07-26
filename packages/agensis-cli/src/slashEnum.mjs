import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Enumerate the slash commands and skills THIS machine exposes, so the daemon can
// push them up with its capability sync. The web composer can only see the fly
// server's filesystem via /backend/system/capabilities — never the user's — so the
// real `.claude/commands` and skills have to ride the daemon's capability push.
//
// Layout (grounded in a real ~/.claude):
//   ~/.claude/commands/*.md            → loose command      (parent: null)
//   ~/.claude/commands/<ns>/*.md       → namespaced command (parent: "<ns>")  ← the parent:child case
//   <cwd>/.claude/commands/**          → same, project-scoped
//   ~/.claude/skills/<name>/           → skill (a directory)
//   ~/.claude/skills/<name>.md         → skill (a single file)
// Symlinked .md files (common — e.g. a command symlinked out of a skill repo) are
// treated as commands.

function safeIsDir(fullPath) {
  try {
    return fs.statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

function safeIsFile(fullPath) {
  try {
    return fs.statSync(fullPath).isFile();
  } catch {
    return false;
  }
}

function readDirents(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist / not readable — skip.
    return [];
  }
}

// [{ name, parent }] — parent null for loose commands, the folder name for the
// one-level-namespaced ones. Deduped across roots (home wins first-seen order).
export function detectCommandEntries({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const roots = [
    home && path.join(home, ".claude", "commands"),
    cwd && path.join(cwd, ".claude", "commands"),
  ].filter(Boolean);

  const seen = new Set();
  const entries = [];
  const add = (name, parent) => {
    if (!name) return;
    const key = parent ? `${parent}:${name}` : name;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ name, parent: parent || null });
  };

  for (const root of roots) {
    for (const ent of readDirents(root)) {
      if (ent.name.startsWith(".")) continue;
      if (ent.name.endsWith(".md")) {
        // File or symlink-to-.md → a loose command.
        add(ent.name.slice(0, -3), null);
        continue;
      }
      const full = path.join(root, ent.name);
      if (ent.isDirectory() || (ent.isSymbolicLink() && safeIsDir(full))) {
        // One level of namespacing: each *.md inside becomes <dir>:<file>.
        for (const child of readDirents(full)) {
          if (child.name.startsWith(".")) continue;
          if (child.name.endsWith(".md")) add(child.name.slice(0, -3), ent.name);
        }
      }
    }
  }
  return entries;
}

// Skill entries — directories OR single .md files under the skills roots, each
// paired with the markdown file its BODY lives in (`file`, "" when there isn't one).
//
// One walk behind both halves of skill sync: the names the daemon advertises in
// `capabilities.skills` and the bodies it pushes on `agent_skill_sync` (see
// skills.mjs). If those came from two separate scans they could disagree, and the
// Skills browser would show one agent's skill under another's text — or claim a
// body for a name that has none. Deduped across roots, first seen wins.
export function detectSkillEntries({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const roots = [
    home && path.join(home, ".claude", "skills"),
    home && path.join(home, ".codex", "skills"),
    cwd && path.join(cwd, ".claude", "skills"),
  ].filter(Boolean);

  const byName = new Map();
  const add = (name, file) => {
    if (!name || byName.has(name)) return;
    byName.set(name, { name, file: file || "" });
  };

  for (const root of roots) {
    for (const ent of readDirents(root)) {
      if (ent.name.startsWith(".")) continue;
      const full = path.join(root, ent.name);
      if (ent.name.endsWith(".md")) {
        add(ent.name.slice(0, -3), full);
      } else if (ent.isDirectory() || ent.isSymbolicLink()) {
        // agentskills.io layout: the body is <skill>/SKILL.md. A folder without one
        // is still a skill NAME — it always has been — it just has no body to sync.
        const skillMd = path.join(full, "SKILL.md");
        add(ent.name, safeIsFile(skillMd) ? skillMd : "");
      }
    }
  }
  // Plain code-unit order, matching what `[...names].sort()` produced before, so the
  // advertised array (and therefore the capabilities hash) is unchanged by this.
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Skill names — directories OR single .md files under the skills roots. The old
// detector only matched *.md, so directory-style skills (the common case) were
// invisible; this fixes that.
export function detectSkillNames(options = {}) {
  return detectSkillEntries(options).map((entry) => entry.name);
}
