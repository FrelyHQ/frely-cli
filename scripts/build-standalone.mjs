import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const targets = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl", "windows-x64", "windows-arm64"]);
const target = process.argv[2] ?? `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
if (!targets.has(target)) throw new Error(`Unsupported standalone target: ${target}`);
const metadata = JSON.parse(await readFile("package.json", "utf8"));
// iroh ships one prebuilt native module per platform. The single file embeds the target's (not the build machine's), and
// there is none for darwin-x64: that build simply has no direct transfers.
const irohPackages = { "darwin-arm64": "iroh-darwin-arm64", "linux-x64": "iroh-linux-x64-gnu", "linux-arm64": "iroh-linux-arm64-gnu", "linux-x64-musl": "iroh-linux-x64-musl", "linux-arm64-musl": "iroh-linux-arm64-musl", "windows-x64": "iroh-win32-x64-msvc", "windows-arm64": "iroh-win32-arm64-msvc" };
const irohNative = "src/runtime/iroh-native.ts";
const irohDefault = await readFile(irohNative, "utf8");
const irohVersion = JSON.parse(await readFile("node_modules/@number0/iroh/package.json", "utf8")).version;
const filename = `frely-${target}${target.startsWith("windows") ? ".exe" : ""}`;
const output = join("artifacts", filename);
await mkdir("artifacts", { recursive: true });
async function embedIroh() {
  const name = irohPackages[target];
  if (!name) return;
  const directory = join("node_modules", "@number0", name);
  await access(directory).catch(() => run("npm", ["install", "--no-save", "--no-package-lock", "--force", "--ignore-scripts", `@number0/${name}@${irohVersion}`]));
  const file = (await readdir(directory)).find((entry) => entry.endsWith(".node"));
  if (!file) throw new Error(`No iroh native module in @number0/${name}`);
  await writeFile(irohNative, `import native from "@number0/${name}/${file}";\nexport const embeddedIroh: unknown = native;\n`);
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${code}`)));
  });
}
try {
  await embedIroh();
  await new Promise((resolve, reject) => {
    const child = spawn("bun", ["build", "src/index.ts", "--compile", `--target=bun-${target}`, "--minify",
      "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig", "--no-compile-autoload-package-json",
      "--define", `FRELY_BUILD_VERSION=${JSON.stringify(metadata.version)}`, "--define", "FRELY_STANDALONE=true", "--define", `FRELY_BUILD_TARGET=${JSON.stringify(target)}`, "--outfile", output], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Standalone compilation failed: ${code}`)));
  });
} finally {
  await writeFile(irohNative, irohDefault);
}
const hash = createHash("sha256").update(await readFile(output)).digest("hex");
await writeFile(`${output}.sha256`, `${hash}  ${filename}\n`);
console.log(`Standalone artifact: ${output}`);
