import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createNativeCredentialStore } from "./credential-native.js";
import { createEncryptedCredentialStore } from "./credential-file.js";
import { createSystemCredentialStore } from "./credential-system.js";
import type { CredentialCommand } from "./credential-command.js";

export interface CredentialStore {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}
interface StoreOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: CredentialCommand;
}

export function credentialStoreBackend(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const mode = env.FRELY_CREDENTIAL_STORE ?? "auto";
  if (!["auto", "system", "encrypted-file"].includes(mode)) throw new Error("FRELY_CREDENTIAL_STORE must be auto, system, or encrypted-file. Plaintext storage is not supported.");
  if (mode === "encrypted-file" || (mode === "auto" && env.FRELY_CREDENTIAL_KEY !== undefined)) return "encrypted-file";
  if (platform === "darwin") return "macOS Keychain";
  if (platform === "win32") return "Windows Credential Manager";
  if (platform === "linux") return "Linux Secret Service";
  throw new Error("Unsupported OS credential store. Configure encrypted-file storage with an injected FRELY_CREDENTIAL_KEY.");
}

/** Backend selection and OS access happen at credential use, not module import. */
export function createCredentialStore(options: StoreOptions = {}): CredentialStore {
  const select = (): CredentialStore => {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    if (credentialStoreBackend(env, platform) === "encrypted-file") {
      const root = resolve(join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "credentials-v1"));
      return createEncryptedCredentialStore(root, env.FRELY_CREDENTIAL_KEY ?? "");
    }
    const root = resolve(join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "system-credentials-v1"));
    return createSystemCredentialStore(root, createNativeCredentialStore(platform, options.run));
  };
  const validate = (service: string, account: string): void => {
    if (!service || !account || /[\x00-\x1f\x7f]/u.test(service + account)) throw new Error("Credential service and account must be non-empty and contain no control characters.");
  };
  return {
    async getPassword(service, account) { validate(service, account); return select().getPassword(service, account); },
    async setPassword(service, account, password) {
      validate(service, account);
      if (!password || Buffer.byteLength(password, "utf8") > 1024 * 1024) throw new Error("Credential must contain between 1 byte and 1 MiB.");
      await select().setPassword(service, account, password);
    },
    async deletePassword(service, account) { validate(service, account); return select().deletePassword(service, account); },
  };
}

/** Tests replace this narrow adapter without contacting the user's credential store. */
export const credentialStore: CredentialStore = createCredentialStore();
