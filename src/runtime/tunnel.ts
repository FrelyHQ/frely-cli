import { createServer, type Server, type Socket } from "node:net";
import { sshProxyConnect } from "./ssh-proxy.js";

/**
 * `frely tunnel <host>:<port> [--local-port N]`: a TCP port on 127.0.0.1 that forwards every connection to `host:port` through the
 * command sandbox's proxy (the HTTP_PROXY it exports; HTTP CONNECT with the proxy's credentials, the same relay `frely ssh-proxy`
 * uses). The sandbox only lets HTTP(S) and SOCKS traffic out, so a database or redis client cannot connect to its server directly;
 * started in the same command, the tunnel lets it connect to 127.0.0.1 instead. Everything stays inside the sandbox's network rules:
 * the proxy applies the same checks to the destination as to any other connection.
 */
export interface TunnelTarget { host: string; port: number }

const validPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65535;

/** `host:port`, `[v6]:port` or `v6-literal` forms are accepted as `host:port` / `[host]:port`. */
export function parseTunnelTarget(value: string): TunnelTarget {
  const match = /^\[([^\]]+)\]:(\d+)$/u.exec(value) ?? /^([^:\s\[\]]+):(\d+)$/u.exec(value);
  const port = Number(match?.[2]);
  if (!match || !match[1] || !validPort(port) || /[\s\0/\\@]/u.test(match[1])) throw new Error("Usage: frely tunnel <host>:<port> [--local-port N]");
  return { host: match[1], port };
}

export function tunnelUsage(): string {
  return "Usage: frely tunnel <host>:<port> [--local-port N]  (run inside the command sandbox; HTTP_PROXY must name the sandbox proxy)";
}

/** Parse `[<host>:<port>, --local-port N]` (after the `tunnel` word). */
export function parseTunnelArguments(args: readonly string[]): TunnelTarget & { localPort: number } {
  const rest: string[] = [];
  let localPort: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--local-port" || arg.startsWith("--local-port=")) {
      const value = arg === "--local-port" ? args[++i] : arg.slice("--local-port=".length);
      localPort = Number(value);
      if (!value || !validPort(localPort)) throw new Error("--local-port must be a port number from 1 to 65535.");
    } else rest.push(arg);
  }
  if (rest.length !== 1) throw new Error(tunnelUsage());
  const target = parseTunnelTarget(rest[0]!);
  return { ...target, localPort: localPort ?? target.port };
}

/** Listen on 127.0.0.1 and relay each connection to `target` through the proxy. Resolves once listening. */
export function startTunnel(options: { proxyUrl: string; host: string; port: number; localPort: number; onError?: (error: Error) => void }): Promise<{ server: Server; address: string }> {
  const server = createServer((client: Socket) => {
    const controller = new AbortController();
    client.on("error", () => controller.abort());
    client.once("close", () => controller.abort());
    sshProxyConnect({ proxyUrl: options.proxyUrl, host: options.host, port: options.port, input: client, output: client, signal: controller.signal })
      .then(() => client.end(), (error: unknown) => {
        if (!controller.signal.aborted) options.onError?.(error instanceof Error ? error : new Error(String(error)));
        client.destroy();
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => reject(new Error(error.code === "EADDRINUSE" ? `127.0.0.1:${options.localPort} is already in use; pick another with --local-port.` : error.message)));
    server.listen(options.localPort, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, address: `127.0.0.1:${typeof address === "object" && address ? address.port : options.localPort}` });
    });
  });
}
