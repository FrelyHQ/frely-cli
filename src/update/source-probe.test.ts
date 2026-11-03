import test from "node:test";
import assert from "node:assert/strict";
import { rankSources } from "./source-probe.js";
import type { ReleaseSource } from "./release.js";

const sources: ReleaseSource[] = [
  { kind: "github", baseUrl: "https://github.com/FrelyHQ/frely-cli/releases/download/v1.0.0" },
  { kind: "npm", registry: "https://registry.npmmirror.com", tarballUrl: "https://registry.npmmirror.com/@frelyhq/cli-linux-x64/-/cli-linux-x64-1.0.0.tgz" },
  { kind: "npm", registry: "https://registry.npmjs.org", tarballUrl: "https://registry.npmjs.org/@frelyhq/cli-linux-x64/-/cli-linux-x64-1.0.0.tgz" },
];
const order = (list: ReleaseSource[]) => list.map((source) => source.kind === "github" ? "github" : new URL(source.registry).hostname.includes("mirror") ? "npmmirror" : "npmjs");

/** A fake fetch: per host, the bytes served and how long (real milliseconds) each chunk takes. */
function fakeNetwork(behaviour: Record<string, { bytes: number; ms: number } | "fail" | { redirect: string }>) {
  const requested: string[] = [];
  const request = (async (input: string | URL | Request) => {
    const url = String(input), host = new URL(url).hostname;
    requested.push(url);
    const plan = behaviour[host];
    if (!plan || plan === "fail") throw new Error("connection failed");
    if ("redirect" in plan) return new Response(null, { status: 302, headers: { location: plan.redirect } });
    let sent = 0;
    return new Response(new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, plan.ms));
        if (sent >= plan.bytes) return controller.close();
        const size = Math.min(500_000, plan.bytes - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size));
      },
    }), { status: 206 });
  }) as typeof fetch;
  return { request, now: () => performance.now(), requested };
}

test("rankSources puts the faster of github and npmmirror first and npmjs last", async () => {
  const slowGithub = fakeNetwork({ "github.com": { bytes: 2_000_000, ms: 80 }, "registry.npmmirror.com": { bytes: 2_000_000, ms: 2 } });
  assert.deepEqual(order(await rankSources(sources, "frely-linux-x64", slowGithub.request, slowGithub.now)), ["npmmirror", "github", "npmjs"]);
  const fastGithub = fakeNetwork({ "github.com": { bytes: 2_000_000, ms: 2 }, "registry.npmmirror.com": { bytes: 2_000_000, ms: 80 } });
  assert.deepEqual(order(await rankSources(sources, "frely-linux-x64", fastGithub.request, fastGithub.now)), ["github", "npmmirror", "npmjs"]);
  assert.ok(!fastGithub.requested.some((url) => url.includes("registry.npmjs.org")), "npmjs is never probed");
});

test("rankSources counts a source that delivered nothing as failed", async () => {
  const empty = fakeNetwork({ "github.com": { bytes: 0, ms: 5 }, "registry.npmmirror.com": { bytes: 2_000_000, ms: 40 } });
  assert.deepEqual(order(await rankSources(sources, "frely-linux-x64", empty.request, empty.now)), ["npmmirror", "github", "npmjs"]);
  const unreachable = fakeNetwork({ "github.com": "fail", "registry.npmmirror.com": { bytes: 2_000_000, ms: 40 } });
  assert.deepEqual(order(await rankSources(sources, "frely-linux-x64", unreachable.request, unreachable.now)), ["npmmirror", "github", "npmjs"]);
});

test("rankSources keeps the given order when every probe fails", async () => {
  const down = fakeNetwork({});
  assert.deepEqual(order(await rankSources(sources, "frely-linux-x64", down.request, down.now)), ["github", "npmmirror", "npmjs"]);
});

test("rankSources refuses a redirect to a host outside the allowlist", async () => {
  const evil = fakeNetwork({ "github.com": { redirect: "https://evil.example/frely" }, "registry.npmmirror.com": { bytes: 1_000_000, ms: 40 }, "evil.example": { bytes: 2_000_000, ms: 1 } });
  assert.deepEqual(order(await rankSources(sources, "frely-linux-x64", evil.request, evil.now)), ["npmmirror", "github", "npmjs"]);
  assert.ok(!evil.requested.some((url) => url.startsWith("https://evil.example")), "the redirect target must not be contacted");
});
