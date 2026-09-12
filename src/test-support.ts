import { credentialStore, type CredentialStore } from "./credential-store.js";

export function useMemoryCredentialStore(): () => void {
  const values = new Map<string, string>();
  const previous: CredentialStore = { ...credentialStore };
  Object.assign(credentialStore, {
    getPassword: async (service: string, account: string) => values.get(key(service, account)) ?? null,
    setPassword: async (service: string, account: string, password: string) => {
      values.set(key(service, account), password);
    },
    deletePassword: async (service: string, account: string) => values.delete(key(service, account)),
  } satisfies CredentialStore);
  return () => Object.assign(credentialStore, previous);
}

function key(service: string, account: string): string {
  return `${service}\u0000${account}`;
}
