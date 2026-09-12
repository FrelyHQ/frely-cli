import keytar from "keytar";

export interface CredentialStore {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

/**
 * Production credential storage backed by the operating system's secure store.
 * Tests replace the methods on this narrow adapter with an in-memory store.
 */
export const credentialStore: CredentialStore = {
  getPassword: (service, account) => keytar.getPassword(service, account),
  setPassword: (service, account, password) => keytar.setPassword(service, account, password),
  deletePassword: (service, account) => keytar.deletePassword(service, account),
};
