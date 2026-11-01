import assert from "node:assert/strict";
import test from "node:test";
import { sessionStore, layeredSessionStore } from "./session.js";
import { credentialStore } from "../credential-store.js";
import type { CredentialStore } from "../credential-store.js";

/** A store that really keeps values, so the layering contract is pinned without any OS keyring. Broken (throwing) variants simulate an unavailable store. */
function store(log: string[], broken: { get?: boolean; set?: boolean; delete?: boolean } = {}): CredentialStore & { saved: Map<string, string> } {
  const saved = new Map<string, string>();
  return {
    saved,
    async getPassword(_service, account) { log.push(`get:${account}`); if (broken.get) throw new Error("store unavailable"); return saved.get(account) ?? null; },
    async setPassword(_service, account, password) { log.push(`set:${account}`); if (broken.set) throw new Error("store unavailable"); saved.set(account, password); },
    async deletePassword(_service, account) { log.push(`delete:${account}`); if (broken.delete) throw new Error("store unavailable"); return saved.delete(account); },
  };
}

test("a healthy OS store keeps the session and the vault stays empty", async () => {
  const log: string[] = [];
  const system = store(log), vault = store(log);
  await layeredSessionStore(system, vault).setPassword("s", "a", "session-1");
  assert.equal(system.saved.get("a"), "session-1");
  assert.equal(vault.saved.size, 0);
  assert.equal(await layeredSessionStore(system, vault).getPassword("s", "a"), "session-1");
});

test("an OS store that cannot be written lands in the encrypted vault and is read back from there", async () => {
  const log: string[] = [];
  const system = store(log, { get: true, set: true }), vault = store(log);
  const layered = layeredSessionStore(system, vault);
  await layered.setPassword("s", "a", "session-vault");
  assert.equal(vault.saved.get("a"), "session-vault");
  assert.equal(await layered.getPassword("s", "a"), "session-vault");
});

test("a value already in the vault is rewritten in place, never split across the two stores", async () => {
  const systemLog: string[] = [], vaultLog: string[] = [];
  const system = store(systemLog), vault = store(vaultLog);
  vault.saved.set("a", "old-vault");
  system.saved.set("a", "old-system");
  await layeredSessionStore(system, vault).setPassword("s", "a", "new-vault");
  assert.equal(vault.saved.get("a"), "new-vault");
  assert.equal(system.saved.get("a"), "old-system");
  assert.equal(systemLog.includes("set:a"), false);
  assert.deepEqual(vaultLog, ["get:a", "set:a"]);
});

test("an empty vault and a broken keyring read answer null instead of failing the command", async () => {
  const layered = layeredSessionStore(store([], { get: true }), store([]));
  assert.equal(await layered.getPassword("s", "a"), null);
});

test("delete removes the session from both stores and a broken keyring delete cannot keep it", async () => {
  const system = store([], { delete: true }), vault = store([]);
  vault.saved.set("a", "session-vault");
  assert.equal(await layeredSessionStore(system, vault).deletePassword("s", "a"), true);
  assert.equal(vault.saved.size, 0);
});

test("only the automatic store is layered: an explicit mode or an operator key stays strict", () => {
  assert.equal(sessionStore({ FRELY_CREDENTIAL_STORE: "system" } as NodeJS.ProcessEnv), credentialStore);
  assert.equal(sessionStore({ FRELY_CREDENTIAL_STORE: "encrypted-file" } as NodeJS.ProcessEnv), credentialStore);
  assert.equal(sessionStore({ FRELY_CREDENTIAL_KEY: "ab".repeat(32) } as NodeJS.ProcessEnv), credentialStore);
  assert.notEqual(sessionStore({} as NodeJS.ProcessEnv), credentialStore);
});
