import type { AgentAdapter } from "./types.js";

/**
 * Codex (`codex exec`): the task text comes on stdin (`-`), the last message is written to the output file.
 * The Frely sandbox is the boundary of a run, so Codex's own sandbox (which cannot nest inside it) is off.
 */
export const codexAdapter: AgentAdapter = {
  id: "codex",
  kind: "coding-agent",
  title: "Codex",
  binary: "codex",
  installHint: "Install Codex with `npm i -g @openai/codex` (or `brew install codex`), then run `codex login`.",
  capabilities: { run: true, skillHost: true, gateway: true },
  skillHost: "codex",
  hosts: ["api.openai.com", "chatgpt.com"],
  usesOutputFile: true,
  runArguments: ({ model, resume, outputFile }) => [
    "exec", ...(resume === undefined ? [] : ["resume", resume]), "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
    "-o", outputFile, ...(model === undefined ? [] : ["-m", model]), "-",
  ],
  parseOutput: (output, fileText) => {
    const session = /"thread_id"\s*:\s*"([^"]+)"/u.exec(output)?.[1];
    const answer = (fileText ?? "").trim();
    return { answer, ...(session === undefined ? {} : { sessionId: session }) };
  },
};
