import type { AgentAdapter } from "./types.js";

/**
 * Claude Code (`claude -p`): the task text comes on stdin, the result is the last JSON object it prints.
 * Permission prompts cannot be answered in a headless run; the Frely sandbox is the boundary instead.
 */
export const claudeCodeAdapter: AgentAdapter = {
  id: "claude-code",
  kind: "coding-agent",
  title: "Claude Code",
  binary: "claude",
  installHint: "Install Claude Code from https://claude.com/claude-code, then run `claude` once to sign in.",
  capabilities: { run: true, skillHost: true, gateway: true },
  skillHost: "claude-code",
  hosts: ["api.anthropic.com"],
  runArguments: ({ model, resume }) => [
    "-p", "--output-format", "json", "--dangerously-skip-permissions", ...(model === undefined ? [] : ["--model", model]), ...(resume === undefined ? [] : ["--resume", resume]),
  ],
  parseOutput: (output) => {
    for (const line of output.split("\n").reverse()) {
      const text = line.trim();
      if (!text.startsWith("{")) continue;
      try {
        const value = JSON.parse(text) as { result?: unknown; session_id?: unknown; type?: unknown };
        if (typeof value.result === "string") return { answer: value.result.trim(), ...(typeof value.session_id === "string" ? { sessionId: value.session_id } : {}) };
      } catch { /* not the result line */ }
    }
    return { answer: output.split("\n").filter((line) => !line.startsWith("[frely] ")).join("\n").trim() };
  },
};
