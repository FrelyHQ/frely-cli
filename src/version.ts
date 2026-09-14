import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const FRELY_BUILD_VERSION: string | undefined;

function sourceVersion(): string {
  const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const metadata = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof metadata.version !== "string" || !metadata.version) throw new Error("Package version is missing.");
  return metadata.version;
}

export const VERSION = typeof FRELY_BUILD_VERSION === "string" ? FRELY_BUILD_VERSION : sourceVersion();
