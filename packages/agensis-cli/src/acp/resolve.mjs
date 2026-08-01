// Resolve a bare command name to an absolute path on this host.
// Mirrors agensis shared/local-agent-discovery resolve order (PATH + common dirs).

import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

function isExecutableFile(filePath) {
  try {
    const st = statSync(filePath);
    if (!st.isFile() && !st.isSymbolicLink()) return false;
    if (process.platform === "win32") return true;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function basenames(command) {
  if (process.platform === "win32" && !command.includes(".")) {
    return [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`];
  }
  return [command];
}

function findInDirs(command, dirs) {
  const names = basenames(command);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const full = join(dir, name);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

function commonBinaryDirs(home) {
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".grok", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, "bin"),
  ];
  // nvm: ~/.nvm/versions/node/*/bin
  try {
    const nvmRoot = join(home, ".nvm", "versions", "node");
    if (existsSync(nvmRoot)) {
      for (const tag of readdirSync(nvmRoot)) {
        if (tag === ".." || tag.includes("..")) continue;
        dirs.push(join(nvmRoot, tag, "bin"));
      }
    }
  } catch {
    // ignore
  }
  return dirs;
}

function pathDirs(pathEnv) {
  return String(pathEnv || "").split(delimiter).filter(Boolean);
}

/**
 * @param {string} command
 * @param {{ pathEnv?: string, home?: string, skipLoginShell?: boolean }} [options]
 * @returns {string | null}
 */
export function resolveCommandPath(command, options = {}) {
  if (!command || typeof command !== "string") return null;
  const trimmed = command.trim();
  if (!trimmed) return null;

  if (isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
    return isExecutableFile(trimmed) ? trimmed : null;
  }

  const home = options.home || homedir();
  const processPath = options.pathEnv !== undefined ? options.pathEnv : (process.env.PATH || "");

  const fromProcess = findInDirs(trimmed, pathDirs(processPath));
  if (fromProcess) return fromProcess;

  const fromCommon = findInDirs(trimmed, commonBinaryDirs(home));
  if (fromCommon) return fromCommon;

  if (options.skipLoginShell || process.platform === "win32") return null;
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const r = spawnSync(shell, ["-lc", `command -v ${JSON.stringify(trimmed)}`], {
      encoding: "utf8",
      timeout: 3000,
    });
    const line = String(r.stdout || "").trim().split("\n")[0];
    if (line && isExecutableFile(line)) return line;
  } catch {
    // ignore
  }
  return null;
}
