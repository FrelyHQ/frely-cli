import { ensureDevice } from "../device/control.js";
import { accountRelayCaller, type ShareHeartbeat } from "./control.js";
import { parseServiceGrant, parseServiceRecord, type ServiceGrant, type ServiceShareRecord, type ServiceType } from "./service-config.js";

const SERVICES_PATH = "/api/user/device-relay/services";

export interface ServiceControl {
  register(input: { type: ServiceType; label: string }): Promise<ServiceShareRecord>;
  list(): Promise<ServiceShareRecord[]>;
  remove(serviceShareId: string): Promise<void>;
  session(serviceShareId: string): Promise<ServiceGrant>;
  heartbeat(sessionId: string): Promise<ShareHeartbeat>;
  revoke(sessionId: string): Promise<void>;
}

/** Calls Frely's service route as the signed-in user. Only the type and label are registered; the local port never leaves this computer. */
export async function accountServiceControl(): Promise<ServiceControl> {
  const call = await accountRelayCaller(SERVICES_PATH);
  return {
    async register(input) {
      const device = await ensureDevice();
      return parseServiceRecord(await call({ action: "register", deviceId: device.deviceId, type: input.type, label: input.label }));
    },
    async list() {
      const value = await call({ action: "list" });
      const items = value && typeof value === "object" ? (value as { items?: unknown }).items : undefined;
      if (!Array.isArray(items)) throw new Error("Frely returned an invalid service list.");
      return items.map(parseServiceRecord);
    },
    async remove(serviceShareId) { await call({ action: "remove", serviceShareId }); },
    async session(serviceShareId) { return parseServiceGrant(await call({ action: "session", serviceShareId })); },
    async heartbeat(sessionId) {
      const value = await call({ action: "heartbeat", sessionId });
      if (!value || typeof value !== "object" || typeof (value as { active?: unknown }).active !== "boolean") throw new Error("Frely returned an invalid service status.");
      return value as ShareHeartbeat;
    },
    async revoke(sessionId) { await call({ action: "revoke", sessionId }); },
  };
}
