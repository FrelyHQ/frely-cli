import test from "node:test";
import assert from "node:assert/strict";
import { runVaultCommand } from "./command.js";

test("vault login runs bw config server and bw login in the owner's terminal, then locks the session bw printed", async () => {
  const attached: string[][] = [];
  const ran: string[][] = [];
  const out: string[] = [];
  const code = await runVaultCommand(["login", "--server", "https://vault.example.com"], {
    out: (text) => out.push(text),
    interactive: async (args, env) => { attached.push(args); assert.match(env.BITWARDENCLI_APPDATA_DIR ?? "", /frely[\\/]bitwarden$/u); return 0; },
    run: async (args) => { ran.push(args); return { code: 0, stdout: "", stderr: "" }; },
  });
  assert.equal(code, 0);
  assert.deepEqual(attached, [["config", "server", "https://vault.example.com"], ["login"]]);
  assert.deepEqual(ran, [["lock", "--nointeraction"]]);
});

test("vault login refuses a non-https server and says how to install bw when it is missing", async () => {
  await assert.rejects(runVaultCommand(["login", "--server", "http://vault.example.com"], { out: () => undefined }), /https/u);
  await assert.rejects(runVaultCommand(["login", "--server"], { out: () => undefined }), /needs a URL/u);
  const out: string[] = [];
  assert.equal(await runVaultCommand(["login"], { out: (text) => out.push(text), interactive: async () => null }), 1);
  assert.match(out.join(""), /brew install bitwarden-cli/u);
});

test("vault status reports bw's own state and vault lock says it is not available yet", async () => {
  const out: string[] = [];
  const run = async () => ({ code: 0, stdout: JSON.stringify({ status: "unauthenticated" }), stderr: "" });
  assert.equal(await runVaultCommand(["status"], { out: (text) => out.push(text), run }), 0);
  assert.match(out.join(""), /not logged in/u);
  out.length = 0;
  assert.equal(await runVaultCommand(["lock"], { out: (text) => out.push(text) }), 1);
  assert.match(out.join(""), /locks itself 8 hours/u);
});
