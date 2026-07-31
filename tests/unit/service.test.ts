import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  installSupervisorService,
  renderLaunchAgent,
  renderSystemdUserUnit,
  supervisorServiceDescriptor,
  supervisorServiceLogs,
  supervisorServiceSpec,
  supervisorServiceStatus,
  uninstallSupervisorService,
} from "../../packages/agensis-cli/src/service.mjs";
import { writeDaemonProfile } from "../../packages/agensis-cli/src/connectProfiles.mjs";

let home: string;
let executablePath: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "agensis-service-"));
  executablePath = path.join(home, "bin", "agensis");
  await fs.mkdir(path.dirname(executablePath), { recursive: true });
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function saveCompleteProfile(name = "default") {
  await writeDaemonProfile(name, {
    url: "https://agensis.test",
    token: "aga_service_test_secret",
    workspace: "workspace-private-id",
    agent: "agent-private-id",
    cwd: "/work/secret-project",
  }, { homedir: home });
}

function fakeRunner(results: Array<Record<string, unknown>> = []) {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const runner = async (command: string, args: string[], options: Record<string, unknown> = {}) => {
    calls.push({ command, args, options });
    return results.shift() || { code: 0, stdout: "", stderr: "" };
  };
  return { calls, runner };
}

describe("service definition helpers", () => {
  it("derives stable profile-specific service names and paths", () => {
    const mac = supervisorServiceDescriptor({
      platform: "darwin",
      profileName: "coder.one",
      homedir: "/Users/example",
      uid: 501,
    });
    expect(mac.serviceName).toBe("io.agensis.agent.coder.one");
    expect(mac.definitionPath).toBe("/Users/example/Library/LaunchAgents/io.agensis.agent.coder.one.plist");
    expect(mac.stdoutPath).toBe("/Users/example/.agensis/services/coder.one/stdout.log");

    const linux = supervisorServiceDescriptor({
      platform: "linux",
      profileName: "coder.one",
      homedir: "/home/example",
    });
    expect(linux.serviceName).toBe("agensis-agent-coder.one.service");
    expect(linux.definitionPath).toBe("/home/example/.config/systemd/user/agensis-agent-coder.one.service");
  });

  it("renders a launchd KeepAlive service with argv entries instead of a shell command", () => {
    const content = renderLaunchAgent({
      label: "io.agensis.agent.coder",
      executablePath: "/Applications/Agensis & Tools/agensis",
      profileName: "coder",
      stdoutPath: "/Users/Test & Co/.agensis/services/coder/stdout.log",
      stderrPath: "/Users/Test & Co/.agensis/services/coder/stderr.log",
      pathEnv: "/opt/homebrew/bin:/usr/bin",
    });
    expect(content).toContain("<key>RunAtLoad</key>");
    expect(content).toContain("<key>KeepAlive</key>");
    expect(content).toContain("<key>ProgramArguments</key>");
    expect(content).toContain("<string>/Applications/Agensis &amp; Tools/agensis</string>");
    expect(content).toContain("<string>--profile</string>");
    expect(content).toContain("<string>coder</string>");
    expect(content).not.toContain("/bin/sh");
  });

  it("renders a systemd user unit with safely quoted argv and restart policy", () => {
    const content = renderSystemdUserUnit({
      executablePath: "/home/test $user/bin/agensis",
      profileName: "coder",
      stdoutPath: "/home/test user/100% logs/stdout.log",
      stderrPath: "/home/test user/100% logs/stderr.log",
      pathEnv: "/home/test user/bin:/usr/bin",
    });
    expect(content).toContain('ExecStart="/home/test $$user/bin/agensis" "supervise" "--profile" "coder"');
    expect(content).toContain("Restart=always");
    expect(content).toContain("NoNewPrivileges=true");
    expect(content).toContain('Environment="PATH=/home/test user/bin:/usr/bin"');
    expect(content).toContain('StandardOutput="append:/home/test user/100%% logs/stdout.log"');
    expect(content).not.toContain("sh -c");
  });

  it("never accepts profile values that could escape a service file name", () => {
    expect(() => supervisorServiceDescriptor({
      platform: "linux",
      profileName: "../../other",
      homedir: "/home/example",
    })).toThrow(/profile names may only contain/i);
  });

  it("fails clearly on Windows without claiming to install a service", () => {
    expect(() => supervisorServiceDescriptor({
      platform: "win32",
      profileName: "default",
      homedir: "C:\\Users\\example",
    })).toThrow(/not supported on Windows yet.*No service was changed/s);
  });
});

describe("service lifecycle", () => {
  it("refuses installation until the named profile is complete", async () => {
    const commands = fakeRunner();
    await expect(installSupervisorService({
      platform: "linux",
      profileName: "missing",
      homedir: home,
      executablePath,
      runner: commands.runner,
    })).rejects.toThrow(/incomplete daemon profile "missing"/);
    expect(commands.calls).toEqual([]);
    const descriptor = supervisorServiceDescriptor({
      platform: "linux",
      profileName: "missing",
      homedir: home,
    });
    await expect(fs.access(descriptor.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs an idempotent macOS LaunchAgent without copying profile secrets", async () => {
    await saveCompleteProfile("coder");
    const commands = fakeRunner();
    const options = {
      platform: "darwin",
      profileName: "coder",
      homedir: home,
      uid: 501,
      executablePath,
      pathEnv: `${path.dirname(executablePath)}:/usr/bin`,
      runner: commands.runner,
    };

    const first = await installSupervisorService(options);
    const second = await installSupervisorService(options);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(first.installed).toBe(true);

    const content = await fs.readFile(first.definitionPath, "utf8");
    expect(content).toContain("<key>RunAtLoad</key>");
    expect(content).toContain("<key>KeepAlive</key>");
    expect(content).toContain(executablePath);
    expect(content).not.toContain("aga_service_test_secret");
    expect(content).not.toContain("workspace-private-id");
    expect(content).not.toContain("agent-private-id");
    expect(content).not.toContain("/work/secret-project");

    expect((await fs.stat(first.definitionPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(first.stdoutPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(first.stderrPath)).mode & 0o777).toBe(0o600);
    expect(commands.calls.map(({ command, args }) => [command, ...args])).toEqual([
      ["launchctl", "bootout", "gui/501/io.agensis.agent.coder"],
      ["launchctl", "enable", "gui/501/io.agensis.agent.coder"],
      ["launchctl", "bootstrap", "gui/501", first.definitionPath],
      ["launchctl", "bootout", "gui/501/io.agensis.agent.coder"],
      ["launchctl", "enable", "gui/501/io.agensis.agent.coder"],
      ["launchctl", "bootstrap", "gui/501", first.definitionPath],
    ]);
    expect(JSON.stringify(commands.calls)).not.toContain("aga_service_test_secret");
    expect(JSON.stringify(commands.calls)).not.toContain("workspace-private-id");
    expect(JSON.stringify(commands.calls)).not.toContain("agent-private-id");
  });

  it("installs, reports, and removes only the exact Linux user unit", async () => {
    await saveCompleteProfile("linux-coder");
    const installCommands = fakeRunner();
    const installed = await installSupervisorService({
      platform: "linux",
      profileName: "linux-coder",
      homedir: home,
      executablePath,
      runner: installCommands.runner,
    });
    expect(installCommands.calls.map(({ command, args }) => [command, ...args])).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "agensis-agent-linux-coder.service"],
    ]);

    const statusCommands = fakeRunner([{ code: 0, stdout: "active\n", stderr: "" }]);
    const status = await supervisorServiceStatus({
      platform: "linux",
      profileName: "linux-coder",
      homedir: home,
      runner: statusCommands.runner,
    });
    expect(status).toMatchObject({ installed: true, running: true });

    const neighbor = path.join(path.dirname(installed.definitionPath), "agensis-agent-neighbor.service");
    await fs.writeFile(neighbor, "keep me\n");
    const uninstallCommands = fakeRunner();
    const removed = await uninstallSupervisorService({
      platform: "linux",
      profileName: "linux-coder",
      homedir: home,
      runner: uninstallCommands.runner,
    });
    expect(removed).toMatchObject({ installed: false, removed: true });
    await expect(fs.access(installed.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(neighbor, "utf8")).toBe("keep me\n");
    expect(uninstallCommands.calls.map(({ command, args }) => [command, ...args])).toEqual([
      ["systemctl", "--user", "disable", "--now", "agensis-agent-linux-coder.service"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "reset-failed", "agensis-agent-linux-coder.service"],
    ]);
  });

  it("reports an installed, running LaunchAgent without exposing profile material", async () => {
    const spec = supervisorServiceSpec({
      platform: "darwin",
      profileName: "coder",
      homedir: home,
      uid: 501,
      executablePath,
    });
    await fs.mkdir(path.dirname(spec.definitionPath), { recursive: true });
    await fs.writeFile(spec.definitionPath, spec.content);
    const commands = fakeRunner([{
      code: 0,
      stdout: "io.agensis.agent.coder = {\n  state = running\n  pid = 1234\n}\n",
      stderr: "",
    }]);
    const status = await supervisorServiceStatus({
      platform: "darwin",
      profileName: "coder",
      homedir: home,
      uid: 501,
      runner: commands.runner,
    });
    expect(status).toMatchObject({
      installed: true,
      running: true,
      serviceName: "io.agensis.agent.coder",
    });
    expect(JSON.stringify(status)).not.toContain("token");
    expect(JSON.stringify(status)).not.toContain("workspace");
  });

  it("does not invoke tail unless logs are explicitly followed", async () => {
    const commands = fakeRunner();
    const lines: string[] = [];
    const base = {
      platform: "linux",
      profileName: "coder",
      homedir: home,
      runner: commands.runner,
      output: (line: string) => lines.push(line),
    };

    await supervisorServiceLogs(base);
    expect(commands.calls).toEqual([]);
    expect(lines).toEqual([
      `stdout: ${home}/.agensis/services/coder/stdout.log`,
      `stderr: ${home}/.agensis/services/coder/stderr.log`,
    ]);

    await supervisorServiceLogs({ ...base, follow: true });
    expect(commands.calls).toHaveLength(1);
    expect(commands.calls[0]).toMatchObject({
      command: "tail",
      args: [
        "-n",
        "100",
        "-F",
        `${home}/.agensis/services/coder/stdout.log`,
        `${home}/.agensis/services/coder/stderr.log`,
      ],
      options: { stdio: "inherit" },
    });
  });

  it("can uninstall after the saved daemon profile has already been removed", async () => {
    const descriptor = supervisorServiceDescriptor({
      platform: "darwin",
      profileName: "orphan",
      homedir: home,
      uid: 501,
    });
    await fs.mkdir(path.dirname(descriptor.definitionPath), { recursive: true });
    await fs.writeFile(descriptor.definitionPath, "old service\n");
    const commands = fakeRunner();

    const result = await uninstallSupervisorService({
      platform: "darwin",
      profileName: "orphan",
      homedir: home,
      uid: 501,
      runner: commands.runner,
    });
    expect(result.removed).toBe(true);
    await expect(fs.access(descriptor.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
