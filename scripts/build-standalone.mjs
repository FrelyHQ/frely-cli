import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const targets = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl", "windows-x64", "windows-arm64"]);
const target = process.argv[2] ?? `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
if (!targets.has(target)) throw new Error(`Unsupported standalone target: ${target}`);
const metadata = JSON.parse(await readFile("package.json", "utf8"));
const filename = `frely-${target}${target.startsWith("windows") ? ".exe" : ""}`;
const output = join("artifacts", filename);
await mkdir("artifacts", { recursive: true });
await new Promise((resolve, reject) => {
  const child = spawn("bun", ["build", "src/index.ts", "--compile", `--target=bun-${target}`, "--minify",
    "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig", "--no-compile-autoload-package-json",
    "--define", `FRELY_BUILD_VERSION=${JSON.stringify(metadata.version)}`, "--define", "FRELY_STANDALONE=true", "--outfile", output], { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Standalone compilation failed: ${code}`)));
});
const hash = createHash("sha256").update(await readFile(output)).digest("hex");
await writeFile(`${output}.sha256`, `${hash}  ${filename}\n`);
console.log(`Standalone artifact: ${output}`);
