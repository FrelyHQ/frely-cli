import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [artifact, version, sha] = process.argv.slice(2);
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version || "") || !/^[0-9a-f]{40}$/.test(sha || "")) throw new Error("Invalid release identity");
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
throw new Error("CLI and Pages execute through publish.yml/site.yml; use --validate-tag inside those workflows");
