import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  daemonProfileName,
  daemonProfileSetupMessage,
  readDaemonProfile,
} from "./connectProfiles.mjs";

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const CONTROL_CHARACTER_RE = /[\0\r\n]/;

function safeServiceValue(value, label) {
  const text = String(value ?? "");
  if (!text || CONTROL_CHARACTER_RE.test(text)) {
    throw new Error(`${label} must be a non-empty value without control characters.`);
  }
  return text;
}

function safeAbsolutePath(value, label) {
  const resolved = path.resolve(safeServiceValue(value, label));
  if (!path.isAbsolute(resolved)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return resolved;
}

function xmlEscape(value) {
  return safeServiceValue(value, "LaunchAgent value")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * systemd parses ExecStart itself; no shell is involved. Quote each argv item
 * independently, escape its quote/expansion characters, and double `%` so a
 * path cannot be interpreted as a systemd specifier.
 */
export function systemdQuote(value) {
  const text = safeServiceValue(value, "systemd argument")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", () => "$$")
    .replaceAll("%", "%%");
  return `"${text}"`;
}

function systemdDirectiveQuote(value) {
  const text = safeServiceValue(value, "systemd directive value")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
  return `"${text}"`;
}

export function supervisorServiceDescriptor({
  platform = process.platform,
  profileName = "default",
  homedir = os.homedir(),
  uid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  const profile = daemonProfileName(profileName);
  const home = safeAbsolutePath(homedir, "Home directory");
  const logDir = path.join(home, ".agensis", "services", profile);
  const stdoutPath = path.join(logDir, "stdout.log");
  const stderrPath = path.join(logDir, "stderr.log");

  if (platform === "darwin") {
    if (!Number.isInteger(uid) || uid < 0) {
      throw new Error("A numeric user id is required to install a macOS LaunchAgent.");
    }
    const label = `io.agensis.agent.${profile}`;
    const domain = `gui/${uid}`;
    return {
      platform,
      profile,
      kind: "launchd",
      serviceName: label,
      managerDomain: domain,
      managerTarget: `${domain}/${label}`,
      definitionPath: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
      logDir,
      stdoutPath,
      stderrPath,
    };
  }

  if (platform === "linux") {
    const unit = `agensis-agent-${profile}.service`;
    return {
      platform,
      profile,
      kind: "systemd",
      serviceName: unit,
      managerDomain: "user",
      managerTarget: unit,
      definitionPath: path.join(home, ".config", "systemd", "user", unit),
      logDir,
      stdoutPath,
      stderrPath,
    };
  }

  if (platform === "win32") {
    throw new Error(
      `Agensis background services are not supported on Windows yet. ` +
      `No service was changed; run "agensis supervise --profile ${profile}" ` +
      "in a terminal or a process manager you already trust.",
    );
  }

  throw new Error(`Agensis background services are not supported on platform "${platform}".`);
}

export function renderLaunchAgent({
  label,
  executablePath,
  profileName,
  stdoutPath,
  stderrPath,
  pathEnv = DEFAULT_PATH,
}) {
  const argv = [
    safeAbsolutePath(executablePath, "Agensis executable"),
    "supervise",
    "--profile",
    daemonProfileName(profileName),
  ];
  const argumentRows = argv.map((argument) => `      <string>${xmlEscape(argument)}</string>`).join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    `    <string>${xmlEscape(label)}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    argumentRows,
    "    </array>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <true/>",
    "    <key>ProcessType</key>",
    "    <string>Background</string>",
    "    <key>EnvironmentVariables</key>",
    "    <dict>",
    "      <key>PATH</key>",
    `      <string>${xmlEscape(pathEnv || DEFAULT_PATH)}</string>`,
    "    </dict>",
    "    <key>StandardOutPath</key>",
    `    <string>${xmlEscape(safeAbsolutePath(stdoutPath, "stdout log path"))}</string>`,
    "    <key>StandardErrorPath</key>",
    `    <string>${xmlEscape(safeAbsolutePath(stderrPath, "stderr log path"))}</string>`,
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function renderSystemdUserUnit({
  executablePath,
  profileName,
  stdoutPath,
  stderrPath,
  pathEnv = DEFAULT_PATH,
}) {
  const profile = daemonProfileName(profileName);
  const argv = [
    safeAbsolutePath(executablePath, "Agensis executable"),
    "supervise",
    "--profile",
    profile,
  ];
  return [
    "[Unit]",
    `Description=Agensis agent supervisor (profile: ${profile})`,
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${argv.map(systemdQuote).join(" ")}`,
    "Restart=always",
    "RestartSec=5",
    "NoNewPrivileges=true",
    `Environment=${systemdDirectiveQuote(`PATH=${pathEnv || DEFAULT_PATH}`)}`,
    `StandardOutput=${systemdDirectiveQuote(`append:${safeAbsolutePath(stdoutPath, "stdout log path")}`)}`,
    `StandardError=${systemdDirectiveQuote(`append:${safeAbsolutePath(stderrPath, "stderr log path")}`)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function supervisorServiceSpec({
  platform = process.platform,
  profileName = "default",
  homedir = os.homedir(),
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  executablePath = process.argv[1],
  pathEnv = process.env.PATH || DEFAULT_PATH,
} = {}) {
  const descriptor = supervisorServiceDescriptor({ platform, profileName, homedir, uid });
  const executable = safeAbsolutePath(executablePath, "Agensis executable");
  const content = descriptor.kind === "launchd"
    ? renderLaunchAgent({
      label: descriptor.serviceName,
      executablePath: executable,
      profileName: descriptor.profile,
      stdoutPath: descriptor.stdoutPath,
      stderrPath: descriptor.stderrPath,
      pathEnv,
    })
    : renderSystemdUserUnit({
      executablePath: executable,
      profileName: descriptor.profile,
      stdoutPath: descriptor.stdoutPath,
      stderrPath: descriptor.stderrPath,
      pathEnv,
    });
  return { ...descriptor, executablePath: executable, content };
}

export async function defaultServiceCommandRunner(command, args, options = {}) {
  const stdio = options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { shell: false, stdio });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", error });
      return;
    }

    if (options.stdio === "inherit") {
      child.on("error", (error) => resolve({ code: null, stdout: "", stderr: "", error }));
      child.on("close", (code, signal) => resolve({ code, signal, stdout: "", stderr: "" }));
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: null, stdout, stderr, error }));
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function execute(runner, command, args, { allowFailure = false, stdio } = {}) {
  const result = await runner(command, args, { allowFailure, stdio });
  const failed = result?.error || result?.code !== 0;
  if (failed && !allowFailure) {
    const detail = String(result?.stderr || result?.error?.message || "unknown service-manager error").trim();
    throw new Error(`${path.basename(command)} failed: ${detail}`);
  }
  return result || { code: 0, stdout: "", stderr: "" };
}

async function atomicWrite(filePath, content, { mode = 0o600, fsImpl = fs } = {}) {
  await fsImpl.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    const current = await fsImpl.readFile(filePath, "utf8");
    if (current === content) {
      await fsImpl.chmod(filePath, mode).catch(() => {});
      return false;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fsImpl.writeFile(tmpPath, content, { mode, flag: "wx" });
    await fsImpl.rename(tmpPath, filePath);
    await fsImpl.chmod(filePath, mode).catch(() => {});
  } finally {
    await fsImpl.unlink(tmpPath).catch(() => {});
  }
  return true;
}

async function prepareLogFiles(descriptor, fsImpl = fs) {
  await fsImpl.mkdir(descriptor.logDir, { recursive: true, mode: 0o700 });
  for (const filePath of [descriptor.stdoutPath, descriptor.stderrPath]) {
    const handle = await fsImpl.open(filePath, "a", 0o600);
    await handle.close();
    await fsImpl.chmod(filePath, 0o600).catch(() => {});
  }
}

async function pathExists(filePath, fsImpl = fs) {
  try {
    await fsImpl.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function publicServiceInfo(descriptor) {
  return {
    platform: descriptor.platform,
    profile: descriptor.profile,
    serviceName: descriptor.serviceName,
    definitionPath: descriptor.definitionPath,
    stdoutPath: descriptor.stdoutPath,
    stderrPath: descriptor.stderrPath,
  };
}

export async function installSupervisorService({
  platform = process.platform,
  profileName = "default",
  homedir = os.homedir(),
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  executablePath = process.argv[1],
  pathEnv = process.env.PATH || DEFAULT_PATH,
  runner = defaultServiceCommandRunner,
  readProfile = readDaemonProfile,
  fsImpl = fs,
} = {}) {
  const profile = daemonProfileName(profileName);
  const cached = await readProfile(profile, { homedir });
  if (!cached) {
    throw new Error(
      `Cannot install a service for incomplete daemon profile "${profile}".\n\n` +
      daemonProfileSetupMessage(profile),
    );
  }

  const spec = supervisorServiceSpec({
    platform,
    profileName: profile,
    homedir,
    uid,
    executablePath,
    pathEnv,
  });
  try {
    await fsImpl.access(spec.executablePath, fsConstants.X_OK);
  } catch {
    throw new Error(
      `Cannot install the Agensis service because its executable is not available: ${spec.executablePath}`,
    );
  }

  await prepareLogFiles(spec, fsImpl);
  const changed = await atomicWrite(spec.definitionPath, spec.content, { fsImpl });

  if (spec.kind === "launchd") {
    // bootout + bootstrap makes repeat installs deterministic, including when a
    // prior definition is already loaded. `enable` clears a persisted disabled
    // bit left by uninstall before RunAtLoad takes effect.
    await execute(runner, "launchctl", ["bootout", spec.managerTarget], { allowFailure: true });
    await execute(runner, "launchctl", ["enable", spec.managerTarget]);
    await execute(runner, "launchctl", ["bootstrap", spec.managerDomain, spec.definitionPath]);
  } else {
    await execute(runner, "systemctl", ["--user", "daemon-reload"]);
    await execute(runner, "systemctl", ["--user", "enable", "--now", spec.serviceName]);
  }

  return { ...publicServiceInfo(spec), installed: true, changed };
}

export async function uninstallSupervisorService({
  platform = process.platform,
  profileName = "default",
  homedir = os.homedir(),
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  runner = defaultServiceCommandRunner,
  fsImpl = fs,
} = {}) {
  const descriptor = supervisorServiceDescriptor({ platform, profileName, homedir, uid });
  const existed = await pathExists(descriptor.definitionPath, fsImpl);

  if (descriptor.kind === "launchd") {
    await execute(runner, "launchctl", ["bootout", descriptor.managerTarget], { allowFailure: true });
    await execute(runner, "launchctl", ["disable", descriptor.managerTarget], { allowFailure: true });
    await fsImpl.unlink(descriptor.definitionPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  } else {
    await execute(runner, "systemctl", ["--user", "disable", "--now", descriptor.serviceName], { allowFailure: true });
    await fsImpl.unlink(descriptor.definitionPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await execute(runner, "systemctl", ["--user", "daemon-reload"]);
    await execute(runner, "systemctl", ["--user", "reset-failed", descriptor.serviceName], { allowFailure: true });
  }

  return { ...publicServiceInfo(descriptor), installed: false, removed: existed };
}

function launchdOutputIsRunning(output) {
  return /\bstate\s*=\s*running\b/i.test(String(output || "")) ||
    /\bpid\s*=\s*\d+\b/i.test(String(output || ""));
}

export async function supervisorServiceStatus({
  platform = process.platform,
  profileName = "default",
  homedir = os.homedir(),
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  runner = defaultServiceCommandRunner,
  fsImpl = fs,
} = {}) {
  const descriptor = supervisorServiceDescriptor({ platform, profileName, homedir, uid });
  const installed = await pathExists(descriptor.definitionPath, fsImpl);
  if (!installed) {
    return { ...publicServiceInfo(descriptor), installed: false, running: false };
  }

  if (descriptor.kind === "launchd") {
    const result = await execute(runner, "launchctl", ["print", descriptor.managerTarget], { allowFailure: true });
    return {
      ...publicServiceInfo(descriptor),
      installed: true,
      running: result.code === 0 && launchdOutputIsRunning(result.stdout),
    };
  }

  const result = await execute(runner, "systemctl", ["--user", "is-active", descriptor.serviceName], { allowFailure: true });
  return {
    ...publicServiceInfo(descriptor),
    installed: true,
    running: result.code === 0 && String(result.stdout || "").trim() === "active",
  };
}

export async function supervisorServiceLogs({
  platform = process.platform,
  profileName = "default",
  homedir = os.homedir(),
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  follow = false,
  runner = defaultServiceCommandRunner,
  output = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const descriptor = supervisorServiceDescriptor({ platform, profileName, homedir, uid });
  output(`stdout: ${descriptor.stdoutPath}`);
  output(`stderr: ${descriptor.stderrPath}`);

  if (follow === true) {
    await execute(
      runner,
      "tail",
      ["-n", "100", "-F", descriptor.stdoutPath, descriptor.stderrPath],
      { stdio: "inherit" },
    );
  }

  return publicServiceInfo(descriptor);
}
