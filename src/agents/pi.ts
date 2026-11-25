import type { AgentAdapter } from "./types.js";

/** Pi (`pi -p`): the task text comes on stdin, the answer is what it prints. Pi keeps its own login and model settings. */
export const piAdapter: AgentAdapter = {
  id: "pi",
  kind: "coding-agent",
  title: "Pi",
  binary: "pi",
  installHint: "Install Pi from https://pi.dev, then run `pi` once to sign in.",
  capabilities: { run: true, skillHost: true, gateway: false },
  skillHost: "pi",
  hosts: [],
  runArguments: ({ model }) => ["-p", "--no-session", ...(model === undefined ? [] : ["--model", model])],
  parseOutput: (output) => ({ answer: output.split("\n").filter((line) => !line.startsWith("[frely] ")).join("\n").trim() }),
};
