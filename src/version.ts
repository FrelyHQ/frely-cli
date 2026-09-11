import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };

if (typeof packageMetadata.version !== "string" || !packageMetadata.version) throw new Error("Package version is missing.");

export const VERSION = packageMetadata.version;
