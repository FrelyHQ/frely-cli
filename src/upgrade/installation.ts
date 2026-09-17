import { execFile as execFileCallback } from "node:child_process";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { IS_STANDALONE } from "../cli-launch.js";

const execFile = promisify(execFileCallback);
export type InstallMethod = "standalone" | "npm" | "bun" | "source" | "unknown";
export interface Installation {
  method: InstallMethod;
  entry: string;
  platform: NodeJS.Platform;
  manager?: string;
  prefix?: string;
  reason?: string;
}
export type CommandRunner = (file: string, args: string[]) => Promise<string>;
export const runCommand: CommandRunner = async (file, args) => {
  // npm's Windows shim is not an executable. Invoke the packaged npm CLI with Node.
  if (process.platform === "win32" && /npm\.cmd$/iu.test(file)) {
    const cli = join(dirname(file), "node_modules", "npm", "bin", "npm-cli.js");
    return (await execFile(process.execPath, [cli, ...args], { cwd: homedir(), timeout: 5000, maxBuffer: 1024 * 1024 })).stdout.trim();
  }
  return (await execFile(file, args, { cwd: homedir(), timeout: 5000, maxBuffer: 1024 * 1024 })).stdout.trim();
};

export async function findExecutable(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ""] : [""]) {
      const path = resolve(directory, name + suffix);
      if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
    }
  }
  return undefined;
}

export async function inspectInstallation(options: {
  entry?: string; executable?: string; standalone?: boolean; platform?: NodeJS.Platform;
  find?: typeof findExecutable; run?: CommandRunner;
} = {}): Promise<Installation> {
  const platform = options.platform ?? process.platform;
  const standalone = options.standalone ?? IS_STANDALONE;
  const original = standalone ? options.executable ?? process.execPath : options.entry ?? process.argv[1] ?? "";
  const entry = await realpath(original).catch(() => resolve(original));
  const base = { entry, platform };
  if (standalone) {
    if ((await lstat(original)).isSymbolicLink()) return { ...base, method: "unknown", reason: "The executable is managed through a symbolic link. Update it using its owner." };
    return { ...base, method: "standalone" };
  }
  const root = dirname(dirname(entry));
  const metadata = await readFile(join(root, "package.json"), "utf8").then((raw) => JSON.parse(raw) as { name?: string }, () => null).catch(() => null);
  if (metadata?.name !== "frely-cli") return { ...base, method: "unknown", reason: "Cannot identify this installation's package root." };
  if (await lstat(join(root, ".git")).then(() => true, () => false)) return { ...base, method: "source", reason: "Source checkout or local link. Update and build the checkout using its development workflow." };
  const find = options.find ?? findExecutable, run = options.run ?? runCommand;
  const candidates: Installation[] = [];
  const npm = await find("npm");
  if (npm) {
    try {
      const globalRoot = await run(npm, ["root", "--global"]);
      const expected = join(globalRoot, "frely-cli");
      if (!(await lstat(expected)).isSymbolicLink() && await realpath(expected) === root) {
        const prefix = await run(npm, ["prefix", "--global"]);
        candidates.push({ ...base, method: "npm", manager: npm, prefix });
      }
    } catch { /* A missing/broken manager is not proof of ownership. */ }
    if (!candidates.length && basename(dirname(root)) === "node_modules") {
      // An explicit `npm install -g --prefix ...` need not be the manager's current default.
      const prefix = platform === "win32" ? dirname(dirname(root)) : basename(dirname(dirname(root))) === "lib" ? dirname(dirname(dirname(root))) : undefined;
      if (prefix) try {
        const wrapper = platform === "win32" ? join(prefix, "frely.cmd") : join(prefix, "bin", "frely");
        const wrapperMatches = platform === "win32"
          ? /node_modules[\\/]+frely-cli[\\/]+dist[\\/]+index\.js/iu.test(await readFile(wrapper, "utf8"))
          : await realpath(wrapper) === entry;
        const globalRoot = await run(npm, ["root", "--global", "--prefix", prefix]);
        const expected = join(globalRoot, "frely-cli");
        if (wrapperMatches && !(await lstat(expected)).isSymbolicLink() && await realpath(expected) === root) {
          candidates.push({ ...base, method: "npm", manager: npm, prefix });
        }
      } catch { /* No matching global wrapper: leave project dependencies untouched. */ }
    }
  }
  const bun = await find("bun");
  if (bun) {
    try {
      const bin = await run(bun, ["pm", "bin", "--global"]);
      let linkedEntry: string;
      if (platform === "win32") {
        // Bun uses an executable shim on Windows. Recognize its standard global tree;
        // an unrecognized custom layout stays manual rather than guessing ownership.
        const expected = join(process.env.BUN_INSTALL || join(homedir(), ".bun"), "install", "global", "node_modules", "frely-cli");
        if (await realpath(expected) !== root || !(await lstat(join(bin, "frely.exe"))).isFile()) throw new Error("Unknown Bun shim.");
        linkedEntry = entry;
      } else linkedEntry = await realpath(join(bin, "frely"));
      // Bun links its global bin to dist/index.js on POSIX. A source/file dependency is not a registry install.
      const globalMetadata = JSON.parse(await readFile(join(dirname(dirname(root)), "package.json"), "utf8")) as { dependencies?: Record<string, string> };
      const spec = globalMetadata.dependencies?.["frely-cli"];
      if (linkedEntry === entry && spec && /^(?:[~^]?[0-9]|latest$|next$)/u.test(spec) && !(await lstat(root)).isSymbolicLink()) {
        candidates.push({ ...base, method: "bun", manager: bun });
      }
    } catch { /* Never guess Bun ownership from the runtime or PATH alone. */ }
  }
  return candidates.length === 1 ? candidates[0]! : { ...base, method: "unknown", reason: "This is a project, temporary runner, local link, or unrecognized global installation. Update it with the original installer." };
}

export function packageArguments(installation: Installation, version: string): string[] {
  return installation.method === "npm"
    ? ["install", "--global", "--ignore-scripts", "--prefix", installation.prefix!, `frely-cli@${version}`]
    : ["add", "--global", "--ignore-scripts", `frely-cli@${version}`];
}

export function shellQuote(value: string, windows = false): string {
  return "'" + value.replace(/'/gu, windows ? "''" : "'\\''") + "'";
}

/** Copyable instructions only: no self-replacement process on Windows. */
export function manualUpgradeCommand(installation: Installation, version: string, serviceActive = false): string {
  const windows = installation.platform === "win32";
  const quote = (s: string) => shellQuote(s, windows);
  let command: string;
  if (installation.method === "npm" || installation.method === "bun") {
    command = `${windows ? "& " : ""}${quote(installation.manager!)} ${packageArguments(installation, version).map(quote).join(" ")}`;
    if (windows) command += "; if ($LASTEXITCODE -ne 0) { throw 'Frely installation failed' }";
  } else if (installation.method === "standalone") {
    const base = `https://github.com/FrelyHQ/frely-cli/releases/download/v${version}`;
    command = windows
      ? `$env:FRELY_CLI_VERSION = ${quote(version)}; $env:FRELY_INSTALL_DIR = ${quote(dirname(installation.entry))}; $env:FRELY_INSTALL_NO_PROFILE = '1'; & ([scriptblock]::Create((Invoke-WebRequest ${quote(base + "/install.ps1")} -UseBasicParsing).Content))`
      : `curl -fsSL ${quote(base + "/install.sh")} | FRELY_CLI_VERSION=${quote(version)} FRELY_INSTALL_DIR=${quote(dirname(installation.entry))} FRELY_INSTALL_NO_PROFILE=1 sh`;
  } else return installation.reason ?? "Update this installation using its original installer.";
  if (windows) {
    const frely = installation.method === "standalone" ? `& ${quote(installation.entry)}` : `& ${quote(process.execPath)} ${quote(installation.entry)}`;
    const body = serviceActive
      ? `${frely} mcp service stop; if ($LASTEXITCODE -ne 0) { throw 'Could not stop Frely service' }; try { ${command} } finally { ${frely} mcp service start }`
      : command;
    // Child PowerShell keeps installer environment changes out of the user's shell.
    return `powershell -NoProfile -Command ${quote(`$ErrorActionPreference = 'Stop'; ${body}`)}`;
  }
  return command;
}
