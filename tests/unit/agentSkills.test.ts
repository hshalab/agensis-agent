import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_SKILL_BYTES,
  skillSummary,
  skillsFingerprint,
  snapshotSkills,
} from '../../packages/agensis-cli/src/skills.mjs';
import { detectSkillEntries, detectSkillNames } from '../../packages/agensis-cli/src/slashEnum.mjs';

let home: string;
let cwd: string;
let empty: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-skillbody-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-skillbody-cwd-'));
  empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-skillbody-empty-'));

  const skills = path.join(home, '.claude', 'skills');
  // Folder skill with frontmatter.
  fs.mkdirSync(path.join(skills, 'agent-browser'), { recursive: true });
  fs.writeFileSync(
    path.join(skills, 'agent-browser', 'SKILL.md'),
    '---\nname: agent-browser\ndescription: Drives a browser for QA.\n---\n\n# Agent browser\n\nSteps go here.\n',
  );
  // Folder skill with a block-scalar description.
  fs.mkdirSync(path.join(skills, 'block-desc'), { recursive: true });
  fs.writeFileSync(
    path.join(skills, 'block-desc', 'SKILL.md'),
    '---\nname: block-desc\ndescription: >-\n  First half of the description\n  and the second half.\n---\n\nBody.\n',
  );
  // Single-file skill, no frontmatter.
  fs.writeFileSync(path.join(skills, 'quick.md'), '# Quick\n\nDo the quick thing.\n');
  // A folder that is a skill NAME but has no SKILL.md — no body to sync.
  fs.mkdirSync(path.join(skills, 'bodyless'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'bodyless', 'notes.txt'), 'not a skill body');
  // Oversized body: must be truncated AND marked.
  fs.mkdirSync(path.join(skills, 'huge'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'huge', 'SKILL.md'), 'x'.repeat(MAX_SKILL_BYTES * 2));

  // Project-scoped skill, so both roots are exercised.
  const projectSkills = path.join(cwd, '.claude', 'skills');
  fs.mkdirSync(path.join(projectSkills, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(projectSkills, 'deploy', 'SKILL.md'), '---\ndescription: Ship it.\n---\n\nDeploy steps.\n');
});

afterAll(() => {
  for (const dir of [home, cwd, empty]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('detectSkillEntries', () => {
  it('pairs every advertised name with the file its body lives in', () => {
    const entries = detectSkillEntries({ home, cwd });
    const byName = Object.fromEntries(entries.map((e: { name: string; file: string }) => [e.name, e.file]));
    expect(byName['agent-browser']).toBe(path.join(home, '.claude', 'skills', 'agent-browser', 'SKILL.md'));
    expect(byName.quick).toBe(path.join(home, '.claude', 'skills', 'quick.md'));
    expect(byName.deploy).toBe(path.join(cwd, '.claude', 'skills', 'deploy', 'SKILL.md'));
  });

  it('keeps a folder with no SKILL.md as a name with no body', () => {
    const entries = detectSkillEntries({ home, cwd });
    expect(entries).toContainEqual({ name: 'bodyless', file: '' });
  });

  // The whole point of one walk: a name that has no matching body (or vice versa)
  // would show one agent's skill under another's text in the Skills browser.
  it('advertises exactly the names it can resolve entries for', () => {
    const names = detectSkillNames({ home, cwd });
    expect(names).toEqual(detectSkillEntries({ home, cwd }).map((e: { name: string }) => e.name));
    expect(names).toEqual([...names].sort());
  });
});

describe('skillSummary', () => {
  it('reads an inline frontmatter description', () => {
    expect(skillSummary('---\nname: x\ndescription: Drives a browser.\n---\n\nBody')).toBe('Drives a browser.');
  });

  it('folds a block-scalar description into one line', () => {
    expect(skillSummary('---\ndescription: >-\n  one\n  two\n---\n\nBody')).toBe('one two');
  });

  it('falls back to the first line of prose when there is no frontmatter', () => {
    expect(skillSummary('# Quick\n\nDo the quick thing.')).toBe('Quick');
  });

  it('never throws on junk', () => {
    expect(skillSummary('')).toBe('');
    expect(skillSummary(undefined)).toBe('');
  });
});

describe('snapshotSkills', () => {
  it('returns the fields the server stores, with the real body', async () => {
    const docs = await snapshotSkills({ home, cwd });
    const browser = docs.find((d: { skill: string }) => d.skill === 'agent-browser');
    expect(browser).toBeTruthy();
    expect(Object.keys(browser).sort()).toEqual(['content', 'path', 'skill', 'summary', 'truncated']);
    expect(browser.content).toContain('Steps go here.');
    expect(browser.summary).toBe('Drives a browser for QA.');
    expect(browser.truncated).toBe(false);
  });

  it('omits skills that have no body rather than inventing an empty one', async () => {
    const docs = await snapshotSkills({ home, cwd });
    expect(docs.some((d: { skill: string }) => d.skill === 'bodyless')).toBe(false);
  });

  it('caps an oversized body at the server ceiling and MARKS the truncation', async () => {
    const docs = await snapshotSkills({ home, cwd });
    const huge = docs.find((d: { skill: string }) => d.skill === 'huge');
    expect(huge.truncated).toBe(true);
    expect(huge.content).toContain('truncated by agensis-agent');
    // Never more than the server will keep — a bigger push is bytes it drops.
    expect(Buffer.byteLength(huge.content)).toBeLessThanOrEqual(MAX_SKILL_BYTES);
  });

  it('is empty, not thrown, when there are no skill roots at all', async () => {
    await expect(snapshotSkills({ home: empty, cwd: empty })).resolves.toEqual([]);
  });

  it('degrades to no body when a file cannot be read', async () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'agensis-skillbody-broken-'));
    const skillMd = path.join(broken, '.claude', 'skills', 'locked', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillMd), { recursive: true });
    fs.writeFileSync(skillMd, 'secret steps');
    fs.chmodSync(skillMd, 0o000);
    try {
      const docs = await snapshotSkills({ home: broken, cwd: broken });
      // Root can read anything, so only assert the contract that matters everywhere:
      // it resolves, and an unreadable file is absent rather than fatal.
      expect(Array.isArray(docs)).toBe(true);
      if (process.getuid?.() !== 0) {
        expect(docs.some((d: { skill: string }) => d.skill === 'locked')).toBe(false);
      }
    } finally {
      fs.chmodSync(skillMd, 0o600);
      fs.rmSync(broken, { recursive: true, force: true });
    }
  });
});

describe('skillsFingerprint', () => {
  it('is stable across calls and changes when a body changes', async () => {
    const before = await skillsFingerprint({ home, cwd });
    expect(await skillsFingerprint({ home, cwd })).toBe(before);

    const file = path.join(home, '.claude', 'skills', 'agent-browser', 'SKILL.md');
    await fsp.writeFile(file, '---\ndescription: Drives a browser for QA.\n---\n\nDifferent steps entirely.\n');
    // Same-second writes can leave size+mtime unchanged; bump mtime explicitly so the
    // test asserts the drift signal, not the filesystem's timestamp resolution.
    const future = new Date(Date.now() + 60_000);
    await fsp.utimes(file, future, future);
    expect(await skillsFingerprint({ home, cwd })).not.toBe(before);
  });

  it('changes when a skill loses its body', async () => {
    const before = await skillsFingerprint({ home, cwd });
    const file = path.join(home, '.claude', 'skills', 'block-desc', 'SKILL.md');
    const saved = await fsp.readFile(file, 'utf8');
    await fsp.rm(file);
    try {
      expect(await skillsFingerprint({ home, cwd })).not.toBe(before);
    } finally {
      await fsp.writeFile(file, saved);
    }
  });

  it('is empty, not thrown, with no skills on the machine', async () => {
    await expect(skillsFingerprint({ home: empty, cwd: empty })).resolves.toBe('');
  });
});
