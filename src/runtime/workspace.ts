import { exec as execCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCallback);
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;

export class Workspace {
  private constructor(readonly root: string) {}

  static async open(input: string): Promise<Workspace> {
    const root = await realpath(resolve(input));
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Workspace must be a real directory.");
    return new Workspace(root);
  }

  info() {
    return { root: this.root };
  }

  async listDirectory(input = ".") {
    const path = await this.existingPath(input, "directory");
    const entries = await readdir(path, { withFileTypes: true });
    return entries.slice(0, 500).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
    }));
  }

  async statPath(input: string) {
    const path = await this.existingPath(input);
    const stat = await lstat(path);
    return {
      path: relative(this.root, path) || ".",
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      size: stat.size,
      mode: stat.mode & 0o777,
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  async findFiles(input: string, pattern: string, maxResults: number) {
    const base = await this.existingPath(input || ".", "directory");
    if (!pattern) throw new Error("pattern is required.");
    const matcher = globMatcher(pattern);
    const results: string[] = [];
    await this.walkFiles(base, async (full) => {
      const rel = relative(base, full);
      const candidate = pattern.includes("/") || pattern.includes("\\") ? rel.split(sep).join("/") : basename(full);
      if (matcher.test(candidate)) results.push(relative(this.root, full));
      return results.length < maxResults;
    });
    return results;
  }

  async searchFiles(input: string, query: string, options: { regex: boolean; caseSensitive: boolean; maxResults: number; contextLines: number }) {
    const base = await this.existingPath(input || ".", "directory");
    if (!query) throw new Error("query is required.");
    const matcher = options.regex ? new RegExp(query, options.caseSensitive ? "u" : "iu") : null;
    const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
    const results: Array<{ path: string; line: number; text: string; before: string[]; after: string[] }> = [];
    await this.walkFiles(base, async (full) => {
      const stat = await lstat(full);
      if (stat.size > MAX_FILE_BYTES) return true;
      const content = await readFile(full, "utf8").catch(() => null);
      if (content === null || content.includes("\0")) return true;
      const lines = content.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        const haystack = options.caseSensitive ? line : line.toLocaleLowerCase();
        if (!(matcher ? matcher.test(line) : haystack.includes(needle))) continue;
        results.push({
          path: relative(this.root, full),
          line: index + 1,
          text: line,
          before: lines.slice(Math.max(0, index - options.contextLines), index),
          after: lines.slice(index + 1, index + 1 + options.contextLines),
        });
        if (results.length >= options.maxResults) return false;
      }
      return true;
    });
    return results;
  }

  async readFile(input: string): Promise<string> {
    const path = await this.existingPath(input, "file");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Only regular files are readable.");
      if (stat.size > MAX_FILE_BYTES) throw new Error("File exceeds 1 MiB limit.");
      return await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  }

  async readFileLines(input: string, startLine: number, endLine?: number) {
    const content = await this.readFile(input);
    const lines = content.split(/\r?\n/u);
    const resolvedEnd = endLine ?? Math.min(lines.length, startLine + 199);
    if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(resolvedEnd) || resolvedEnd < startLine) {
      throw new Error("Invalid line range.");
    }
    return {
      path: input,
      startLine,
      endLine: Math.min(resolvedEnd, lines.length),
      totalLines: lines.length,
      content: lines.slice(startLine - 1, resolvedEnd).join("\n"),
    };
  }

  async writeFile(input: string, content: string, overwrite: boolean) {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("Content exceeds 1 MiB limit.");
    const path = await this.createPath(input);
    const existing = await lstat(path).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error("Refusing to replace a symbolic link.");
    if (existing?.isDirectory()) throw new Error("Refusing to replace a directory.");
    if (existing && existing.nlink > 1) throw new Error("Refusing to replace a file with multiple hard links.");
    if (existing && !overwrite) throw new Error("File exists; set overwrite=true.");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await this.assertCanonicalInside(await realpath(dirname(path)));
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path).catch(async (error) => {
      await rm(tmp, { force: true });
      throw error;
    });
    await chmod(path, 0o600).catch(() => undefined);
    return { path: relative(this.root, path), bytes: Buffer.byteLength(content) };
  }

  async applyPatch(input: string, edits: unknown[], expectedSha256?: string) {
    const content = await this.readFile(input);
    if (expectedSha256 && sha256(content) !== expectedSha256) throw new Error("File changed since it was inspected.");
    const lines = content.split("\n");
    const parsed = edits.map((value) => {
      if (!value || typeof value !== "object") throw new Error("Invalid edit.");
      const item = value as Record<string, unknown>;
      const startLine = Number(item.startLine);
      const endLine = Number(item.endLine);
      if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) {
        throw new Error("Invalid edit range.");
      }
      if (typeof item.replacement !== "string") throw new Error("replacement must be a string.");
      return { startLine, endLine, replacement: item.replacement };
    }).sort((a, b) => b.startLine - a.startLine);
    for (let index = 1; index < parsed.length; index += 1) {
      const previous = parsed[index - 1]!;
      const current = parsed[index]!;
      if (current.endLine >= previous.startLine) throw new Error("Patch edits overlap.");
    }
    for (const edit of parsed) {
      lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...edit.replacement.split("\n"));
    }
    return this.writeFile(input, lines.join("\n"), true);
  }

  async createDirectory(input: string) {
    const path = await this.createPath(input);
    if (path === this.root) return { path: "." };
    await mkdir(path, { recursive: true, mode: 0o700 });
    await this.assertCanonicalInside(await realpath(path));
    return { path: relative(this.root, path) };
  }

  async deletePath(input: string, recursive: boolean) {
    const path = await this.existingPath(input);
    if (path === this.root) throw new Error("Workspace root cannot be deleted.");
    const stat = await lstat(path);
    if (stat.isDirectory() && !recursive && (await readdir(path)).length > 0) {
      throw new Error("Directory is not empty; set recursive=true.");
    }
    await rm(path, { recursive, force: false });
    return { path: relative(this.root, path), deleted: true };
  }

  async movePath(fromInput: string, toInput: string, overwrite: boolean) {
    const from = await this.existingPath(fromInput);
    if (from === this.root) throw new Error("Workspace root cannot be moved.");
    const to = await this.createPath(toInput);
    const target = await lstat(to).catch(() => null);
    if (target?.isSymbolicLink()) throw new Error("Refusing to replace a symbolic link.");
    if (target && !overwrite) throw new Error("Destination exists; set overwrite=true.");
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await this.assertCanonicalInside(await realpath(dirname(to)));
    if (target) await rm(to, { recursive: true, force: false });
    await rename(from, to);
    return { from: relative(this.root, from), to: relative(this.root, to) };
  }

  async runCommand(command: string, cwdInput: string, timeoutMs: number) {
    if (!command.trim()) throw new Error("command is required.");
    const cwd = await this.existingPath(cwdInput || ".", "directory");
    const { stdout, stderr } = await exec(command, { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, env: safeEnv() });
    return { stdout: truncate(stdout), stderr: truncate(stderr) };
  }

  async processCwd(cwdInput: string): Promise<string> {
    return this.existingPath(cwdInput || ".", "directory");
  }

  private async walkFiles(base: string, visitor: (full: string) => Promise<boolean>): Promise<void> {
    const stack = [base];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const full = resolve(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && !(await visitor(full))) return;
      }
    }
  }

  private async existingPath(input: string, expected?: "file" | "directory"): Promise<string> {
    const target = this.lexicalPath(input);
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed.");
    await this.assertCanonicalInside(await realpath(target));
    if (expected === "file" && !stat.isFile()) throw new Error("Expected a regular file.");
    if (expected === "directory" && !stat.isDirectory()) throw new Error("Expected a directory.");
    return target;
  }

  private async createPath(input: string): Promise<string> {
    const target = this.lexicalPath(input);
    let cursor = dirname(target);
    while (true) {
      const canonical = await realpath(cursor).catch(() => null);
      if (canonical) {
        await this.assertCanonicalInside(canonical);
        break;
      }
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error("Write parent is unavailable.");
      cursor = parent;
    }
    return target;
  }

  private lexicalPath(input: string): string {
    if (!input || input.includes("\0")) throw new Error("Invalid path.");
    const target = resolve(this.root, input);
    const rel = relative(this.root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Path escapes workspace.");
    return target;
  }

  private async assertCanonicalInside(target: string): Promise<void> {
    const rel = relative(this.root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Path escapes workspace.");
  }
}

export function safeEnv(): NodeJS.ProcessEnv {
  const keys = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SHELL", "SystemRoot"];
  return Object.fromEntries(keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv;
}

function truncate(value: string): string {
  return Buffer.byteLength(value) <= MAX_OUTPUT_BYTES ? value : `${value.slice(0, MAX_OUTPUT_BYTES)}\n[truncated]`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function globMatcher(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}
