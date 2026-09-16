import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installSkillAdapter, removeSkillAdapter, skillAdapterStatus } from "./access.js";

const distributionId = "creator_distribution_0123456789abcdef01234567";
const manifestUrl = `https://app.frely.cloud/api/public/virtual-models/${distributionId}`;
const modelId = "user/vm-0123456789abcdef0123456789abcdef/v1";

function manifest() {
  return {
    schemaVersion: "frely.virtual-model.public.v1",
    id: distributionId,
    modelId,
    version: "v1",
    name: "TripReady",
    description: "Checks travel weather, exchange rates, and public holidays.",
    capabilities: [
      { id: "weather-forecast", level: "base", entrypoints: ["model", "mcp", "a2a"], description: "Read forecasts." },
    ],
    urls: {
      manifest: manifestUrl,
      mcp: `https://api.frely.cloud/mcp/${encodeURIComponent(modelId)}`,
    },
  };
}

function fetchManifest(payload = manifest()): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}

async function tempRoot(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "frely-skill-")));
}

test("installs a managed trigger Skill without installing the remote Agent", async () => {
  const root = await tempRoot();
  try {
    const result = await installSkillAdapter({ manifestUrl, host: "pi", scope: "global", home: root, fetchFn: fetchManifest() });
    assert.equal(result.distributionId, distributionId);
    assert.match(result.skillPath, /\.pi\/agent\/skills\/frely-tripready-[a-f0-9]{8}\/SKILL\.md$/u);
    const text = await readFile(result.skillPath, "utf8");
    assert.match(text, /frely agent invoke creator_distribution_/u);
    assert.doesNotMatch(text, /api\.frely\.cloud\/mcp/u);
    const status = await skillAdapterStatus(distributionId, root);
    assert.equal(status.state, "managed");
    assert.equal(status.installed, true);
    const removed = await removeSkillAdapter(distributionId, root);
    assert.equal(removed.removed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses project Agent Skills path for generic compatible hosts", async () => {
  const root = await tempRoot();
  const project = join(root, "project");
  try {
    const result = await installSkillAdapter({ manifestUrl, host: "generic", scope: "project", home: root, cwd: project, fetchFn: fetchManifest() });
    assert.match(result.skillPath, /project\/\.agents\/skills\/frely-tripready-[a-f0-9]{8}\/SKILL\.md$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to overwrite a user-modified managed Skill", async () => {
  const root = await tempRoot();
  try {
    const result = await installSkillAdapter({ manifestUrl, host: "pi", scope: "global", home: root, fetchFn: fetchManifest() });
    await writeFile(result.skillPath, `${await readFile(result.skillPath, "utf8")}\nuser edit\n`, "utf8");
    await assert.rejects(
      () => installSkillAdapter({ manifestUrl, host: "pi", scope: "global", home: root, fetchFn: fetchManifest() }),
      /modified/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects non-Frely manifest URLs before fetching", async () => {
  let called = false;
  const fetchFn = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
  await assert.rejects(
    () => installSkillAdapter({ manifestUrl: "https://example.com/model.json", host: "generic", scope: "global", fetchFn }),
    /Frely URL/u,
  );
  assert.equal(called, false);
});


test("rejects an MCP URL that does not match the published model identity", async () => {
  const root = await tempRoot();
  try {
    const payload = manifest();
    payload.urls.mcp = "https://api.frely.cloud/mcp/user%2Fother%2Fv1";
    await assert.rejects(
      () => installSkillAdapter({ manifestUrl, host: "generic", scope: "global", home: root, fetchFn: fetchManifest(payload) }),
      /does not match/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
