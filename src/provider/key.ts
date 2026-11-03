import { credentialStore as secureCredentialStore, type CredentialStore } from "../credential-store.js";

/** The upstream key of a local Provider (a NewAPI, vLLM or other gateway that wants one). Kept with the CLI's other secrets; never in local-providers.json, never uploaded. */
export const PROVIDER_KEY_SERVICE = "frely-cli-local-provider-key-v1";

export async function readProviderKey(providerId: string, store: CredentialStore = secureCredentialStore): Promise<string | undefined> {
  return (await store.getPassword(PROVIDER_KEY_SERVICE, providerId).catch(() => null)) ?? undefined;
}

export async function saveProviderKey(providerId: string, key: string, store: CredentialStore = secureCredentialStore): Promise<void> {
  if (Buffer.byteLength(key, "utf8") < 1 || Buffer.byteLength(key, "utf8") > 8192 || /[\x00-\x20\x7f]/u.test(key)) throw new Error("The upstream key is invalid.");
  await store.setPassword(PROVIDER_KEY_SERVICE, providerId, key);
}

export async function deleteProviderKey(providerId: string, store: CredentialStore = secureCredentialStore): Promise<void> {
  await store.deletePassword(PROVIDER_KEY_SERVICE, providerId).catch(() => undefined);
}
