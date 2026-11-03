import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Content search through ripgrep, used by `Workspace.searchFiles` when `rg` is on PATH (the sandbox already requires it on
 * Linux and macOS). The caller filters every hit through the workspace's own path checks; ripgrep only finds candidates.
 */

export interface RipgrepHit {
  /** Path as ripgrep printed it, relative to the search directory. */
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface RipgrepOptions {
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  /** Skip files ignored by .gitignore / .ignore. Off keeps the walk's old reach (ignored files are searched too). */
  readonly gitignore: boolean;
  readonly maxFileBytes: number;
  /** Called per hit; return false to stop the search. */
  readonly accept: (hit: RipgrepHit) => boolean;
}

/** ripgrep could not run or rejected the pattern: the caller falls back to its own walk. */
export class RipgrepUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RipgrepUnavailableError";
  }
}

let missing = false;

/** Test hook: forget a previous "rg is not installed" result. */
export function resetRipgrepProbe(): void {
  missing = false;
}

export function ripgrepArguments(query: string, options: Pick<RipgrepOptions, "regex" | "caseSensitive" | "gitignore" | "maxFileBytes">): string[] {
  return [
    "--no-config",
    "--no-messages",
    "--line-number",
    "--with-filename",
    "--no-heading",
    "--null",
    "--color", "never",
    "--hidden",
    "--sort", "path",
    "--max-filesize", String(options.maxFileBytes),
    "--max-columns", "4096",
    "--glob", "!.git",
    "--glob", "!node_modules",
    ...(options.gitignore ? [] : ["--no-ignore"]),
    ...(options.regex ? [] : ["--fixed-strings"]),
    ...(options.caseSensitive ? ["--case-sensitive"] : ["--ignore-case"]),
    "--regexp", query,
    "--",
    ".",
  ];
}

/** Run ripgrep in `cwd`. Resolves when it ends or `accept` stops it; rejects with RipgrepUnavailableError to request the fallback. */
export function ripgrepSearch(cwd: string, query: string, options: RipgrepOptions): Promise<void> {
  if (missing || process.env.FRELY_DISABLE_RIPGREP === "1") return Promise.reject(new RipgrepUnavailableError("ripgrep is not available."));
  return new Promise((resolvePromise, reject) => {
    const child = spawn("rg", ripgrepArguments(query, options), { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stopped = false;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 4096) stderr += chunk; });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") missing = true;
      reject(new RipgrepUnavailableError(error.message));
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (raw) => {
      if (stopped) return;
      const hit = parseLine(raw);
      if (hit === null) return;
      if (!options.accept(hit)) {
        stopped = true;
        lines.close();
        child.kill();
      }
    });
    child.once("close", (code) => {
      // 0 = matches, 1 = no match, 2 = error (bad pattern or an unreadable file; partial output is still valid unless nothing ran).
      if (stopped || code === 0 || code === 1) resolvePromise();
      else if (/regex|parse error|error parsing/iu.test(stderr)) reject(new RipgrepUnavailableError(stderr.trim()));
      else resolvePromise();
    });
  });
}

function parseLine(raw: string): RipgrepHit | null {
  const nul = raw.indexOf("\0");
  if (nul <= 0) return null;
  const rest = raw.slice(nul + 1);
  const colon = rest.indexOf(":");
  if (colon <= 0) return null;
  const line = Number(rest.slice(0, colon));
  if (!Number.isSafeInteger(line) || line < 1) return null;
  const path = raw.slice(0, nul).replace(/^\.[\\/]/u, "");
  return { path, line, text: rest.slice(colon + 1).replace(/\r$/u, "") };
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * One line-oriented pattern for common definition forms (TS/JS, Python, Go, Rust, Java/C#/Kotlin, Swift, Ruby, PHP), valid in both
 * ripgrep's and JavaScript's regex syntax. It favours recall over precision: the Agent reads the hits it wants.
 */
export function definitionPattern(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error("name must be a plain identifier (letters, digits, underscore).");
  const keywords = "function\\*?|class|interface|type|enum|struct|trait|impl|def|fn|func|const|let|var|val|module|namespace|object|record|protocol|extension|macro_rules!|typealias";
  return [
    `\\b(?:${keywords})\\s+${name}\\b`,
    `\\bfunc\\s*\\([^)]*\\)\\s*${name}\\s*\\(`,
    `\\b${name}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_][A-Za-z0-9_]*\\s*=>)`,
    `^\\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|export|default|readonly)\\s+)+[A-Za-z0-9_<>\\[\\],.? ]*\\b${name}\\s*[(<]`,
    `^\\s*(?:async\\s+|static\\s+|get\\s+|set\\s+)*${name}\\s*\\([^)]*\\)\\s*(?::[^={;]+)?\\{`,
  ].map((part) => `(?:${part})`).join("|");
}
