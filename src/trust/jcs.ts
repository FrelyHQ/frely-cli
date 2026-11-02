/** RFC 8785 JSON canonicalization for the value shapes Frely signs (objects, arrays, strings, safe integers, booleans, null). */
export function jcs(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Only safe integers can be canonicalized.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => jcs(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // JCS sorts member names by UTF-16 code units, which is the default string comparison of JavaScript.
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`).join(",")}}`;
  }
  throw new Error("Value cannot be canonicalized.");
}
