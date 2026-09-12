import { rm } from "node:fs/promises";

const allowedTargets = new Set(["dist", ".test-dist"]);
const targets = process.argv.slice(2);
if (targets.length === 0 || targets.some((target) => !allowedTargets.has(target))) {
  throw new Error(`Expected one or more cleanup targets: ${[...allowedTargets].join(", ")}`);
}
await Promise.all(targets.map((target) => rm(target, { force: true, recursive: true })));
