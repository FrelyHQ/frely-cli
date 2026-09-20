export type DeviceTransportKind = "cloudflare_do" | "relay";

export interface DeviceTransportGrant {
  kind: DeviceTransportKind;
  websocketUrl: string;
  accessToken: string;
  expiresAt: string;
}

export function isDeviceTransportKind(value: unknown): value is DeviceTransportKind {
  return value === "cloudflare_do" || value === "relay";
}

export function selectDeviceTransport(
  transports: readonly DeviceTransportGrant[],
  preferred?: DeviceTransportKind,
): DeviceTransportGrant {
  if (transports.length === 0) throw new Error("Frely returned no supported Device transport.");
  if (preferred) {
    const selected = transports.find((transport) => transport.kind === preferred);
    if (selected) return selected;
  }
  return transports[0]!;
}

export function nextDeviceTransportKind(
  transports: readonly DeviceTransportGrant[],
  current: DeviceTransportKind,
): DeviceTransportKind | undefined {
  const index = transports.findIndex((transport) => transport.kind === current);
  if (index < 0) return undefined;
  for (let i = index + 1; i < transports.length; i++) {
    if (transports[i]!.kind !== current) return transports[i]!.kind;
  }
  return undefined;
}
