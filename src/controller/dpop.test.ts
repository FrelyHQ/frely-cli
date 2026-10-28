import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import test from "node:test";
import { createDpopProof, dpopKeyFromPem, generateDpopKey } from "./dpop.js";

test("a proof is signed by the key, names the request and the token, and loses the query", () => {
  const key = generateDpopKey();
  assert.equal(dpopKeyFromPem(key.privateKeyPem).jkt, key.jkt);
  assert.match(key.jkt, /^[A-Za-z0-9_-]{43}$/u);
  const proof = createDpopProof(key, { method: "post", url: "https://mcp.example.test/mcp?x=1#y", accessToken: "fmcp_at_abc" });
  const [header, payload, signature] = proof.split(".") as [string, string, string];
  const head = JSON.parse(Buffer.from(header, "base64url").toString()) as { typ: string; alg: string; jwk: { kty: "OKP"; crv: "Ed25519"; x: string } };
  const body = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
  assert.deepEqual({ typ: head.typ, alg: head.alg, jwk: head.jwk }, { typ: "dpop+jwt", alg: "EdDSA", jwk: key.jwk });
  assert.equal(body.htm, "POST");
  assert.equal(body.htu, "https://mcp.example.test/mcp");
  assert.equal(body.ath, createHash("sha256").update("fmcp_at_abc").digest("base64url"));
  assert.equal(verify(null, Buffer.from(`${header}.${payload}`), createPublicKey({ key: head.jwk, format: "jwk" }), Buffer.from(signature, "base64url")), true);
  assert.notEqual(createDpopProof(key, { method: "GET", url: "https://mcp.example.test/mcp" }), createDpopProof(key, { method: "GET", url: "https://mcp.example.test/mcp" }));
});
