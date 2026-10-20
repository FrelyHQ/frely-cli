import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { P2pTransfers } from "./p2p.js";
import { Workspace } from "./workspace.js";

async function setup() {
  const [a, b] = await Promise.all([mkdtemp(join(tmpdir(), "frely-p2p-a-")), mkdtemp(join(tmpdir(), "frely-p2p-b-"))]);
  return { a, b, wa: await Workspace.open(a), wb: await Workspace.open(b), sender: new P2pTransfers(), receiver: new P2pTransfers(),
    cleanup: async (...nodes: P2pTransfers[]) => { await Promise.all(nodes.map((node) => node.close())); await rm(a, { recursive: true, force: true }); await rm(b, { recursive: true, force: true }); } };
}

async function waitFor(node: P2pTransfers, jobId: string) {
  for (let i = 0; i < 100; i += 1) { const job = node.status(jobId); if (job.status !== "running") return job; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error("job did not finish");
}

test("a file goes device to device over iroh and lands only after size and sha256 match", async (t) => {
  const f = await setup();
  if (!(await f.sender.supported())) { t.skip("no iroh build on this platform"); await f.cleanup(); return; }
  try {
    const data = Buffer.alloc(3 * 1024 * 1024 + 17, "frely");
    await writeFile(join(f.a, "big.bin"), data);
    const sha256 = createHash("sha256").update(data).digest("hex");
    await f.receiver.info();
    const me = await f.sender.info();
    const listening = await f.receiver.listen(f.wb, { path: "in/big.bin", bytes: data.length, sha256, overwrite: false, from: me.id });
    const sent = await f.sender.send(f.wa, { path: "big.bin", bytes: data.length, sha256, to: listening.address! });
    assert.equal(sent.status, "done", sent.error);
    assert.equal(sent.relayBytes, 0);
    const received = await waitFor(f.receiver, listening.jobId);
    assert.equal(received.status, "done", received.error);
    assert.deepEqual(await readFile(join(f.b, "in/big.bin")), data);
  } finally { await f.cleanup(f.sender, f.receiver); }
});

test("the receiver refuses a sender it did not expect and a file other than the one announced", async (t) => {
  const f = await setup();
  if (!(await f.sender.supported())) { t.skip("no iroh build on this platform"); await f.cleanup(); return; }
  try {
    await writeFile(join(f.a, "a.bin"), "hello world");
    const sha256 = createHash("sha256").update("hello world").digest("hex");
    await f.receiver.info();
    const me = await f.sender.info();
    const wrongPeer = await f.receiver.listen(f.wb, { path: "x.bin", bytes: 11, sha256, overwrite: false, from: "a".repeat(52) });
    const refused = await f.sender.send(f.wa, { path: "a.bin", bytes: 11, sha256, to: wrongPeer.address! });
    assert.equal(refused.status, "failed");
    assert.equal(f.receiver.status(wrongPeer.jobId).status, "running");
    await f.receiver.close();
    const other = new P2pTransfers();
    await other.info();
    const wrongFile = await other.listen(f.wb, { path: "y.bin", bytes: 11, sha256: "0".repeat(64), overwrite: false, from: me.id });
    const mismatch = await f.sender.send(f.wa, { path: "a.bin", bytes: 11, sha256, to: wrongFile.address! });
    assert.equal(mismatch.status, "failed");
    await assert.rejects(readFile(join(f.b, "y.bin")));
    await other.close();
  } finally { await f.cleanup(f.sender, f.receiver); }
});

test("relay URLs must be https", async () => {
  const node = new P2pTransfers();
  await node.info();
  await assert.rejects(node.listen(await Workspace.open(tmpdir()), { path: "x", bytes: 1, sha256: "0".repeat(64), overwrite: false, from: "a", relayUrl: "http://example.com" }), /https/u);
  await node.close();
});
