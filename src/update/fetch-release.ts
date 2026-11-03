import { NPM_REGISTRIES } from "./release.js";

/** Hosts a release download may be served from, including the redirect targets GitHub and the npm registries use. */
export const DOWNLOAD_HOSTS = ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", ...NPM_REGISTRIES.map((url) => new URL(url).hostname), "cdn.npmmirror.com"];

/** Opens a release URL, following up to five redirects and refusing any location that is not https on an allowed host. The one place that rule lives. */
export async function openRelease(url: string, options: { signal: AbortSignal; headers?: Record<string, string>; request?: typeof fetch }): Promise<Response> {
  const request = options.request ?? fetch;
  let response: Response | undefined;
  for (let redirects = 0; redirects < 5; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !DOWNLOAD_HOSTS.includes(parsed.hostname)) throw new Error("Unsupported release download location.");
    response = await request(url, { signal: options.signal, redirect: "manual", ...(options.headers ? { headers: options.headers } : {}) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Missing release redirect.");
      url = new URL(location, url).toString();
    } else return response;
  }
  throw new Error("Too many release redirects.");
}
