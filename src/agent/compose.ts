/**
 * Composition root for the agent stack: builds an AgentService wired to the
 * real app install, capsule verification, and the agent host supervisor.
 * Failures (e.g. app not installed) surface lazily on first host use so the
 * device relay daemon keeps serving MCP traffic.
 */
import { AgentService } from "./agent-service.js";
import { readAppInstall, verifyCapsule, type CapsuleFacts } from "./app-install.js";
import { AgentHostSupervisor } from "./supervisor.js";
import { TaskStore } from "./task-store.js";
import type { DiagnosticLog } from "../runtime/diagnostics.js";

export type CreateAgentServiceOptions = {
  log?: DiagnosticLog;
  env?: NodeJS.ProcessEnv;
  defaultWorkspace: string;
  modelCredentials?: () => { apiKey: string; baseUrl: string; model: string } | null;
  fullIntegrityVerification?: boolean;
  store?: TaskStore;
};

export function createAgentService(options: CreateAgentServiceOptions): AgentService {
  const env = options.env ?? process.env;
  const store = options.store ?? TaskStore.open(undefined, env);
  const resolveFacts = async (): Promise<CapsuleFacts> => {
    const install = await readAppInstall(undefined, env);
    return verifyCapsule(install);
  };
  let service: AgentService | null = null;
  const supervisor = new AgentHostSupervisor({
    resolveFacts,
    fullIntegrityVerification: options.fullIntegrityVerification ?? true,
    appInstall: () => readAppInstall(undefined, env),
    isIdle: () => {
      if (!service) return true;
      return service.listTasks().then((tasks) => tasks.every((task) => task.status !== "queued" && task.status !== "running" && task.status !== "waiting_input")).catch(() => true);
    },
    onEvent: (taskId, event) => service?.onTaskEvent(taskId, event),
    onToolRequest: (request, args, taskId) => service!.onToolRequest(request, args, taskId),
    onHostLost: (error) => service?.onHostLost(error),
    log: options.log,
  });
  service = new AgentService({
    store,
    resolveSupervisor: () => supervisor,
    ...(options.modelCredentials ? { modelCredentials: options.modelCredentials } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  return service;
}

export { AgentService };
