import { assertAppAllowed, ComputerBlockedError, normalizeApp, redactBlockedAppLines } from "./guard.js";
import { downscalePng, pngSize } from "./image.js";
import type { OcuBackend, OcuContent, OcuResult, OcuTool } from "./ocu.js";
import { appendComputerAudit, type ComputerAuditEntry } from "./state.js";

/** Only these open-computer-use tools are ever exposed; a future upstream tool stays hidden until reviewed. */
const ALLOWED_TOOLS = new Set(["list_apps", "get_app_state", "click", "perform_secondary_action", "scroll", "drag", "type_text", "press_key", "set_value"]);
const COORDINATE_ARGS: Record<string, string[]> = { click: ["x", "y"], drag: ["from_x", "from_y", "to_x", "to_y"] };
/** A relay frame is capped at 8 MiB including JSON and base64 overhead; stay well under it. */
const MAX_RESULT_BYTES = 6 * 1024 * 1024;

export interface ComputerToolsetOptions {
  backend: OcuBackend;
  /** Local key of the two-key rule (the registered local MCP entry); checked on every list and call so `frely computer disable` takes effect at once. */
  isLocallyEnabled: () => Promise<boolean>;
  audit?: (entry: ComputerAuditEntry) => Promise<void>;
}

export class ComputerToolset {
  private readonly backend: OcuBackend;
  private readonly isLocallyEnabled: () => Promise<boolean>;
  private readonly audit: (entry: ComputerAuditEntry) => Promise<void>;
  /** original / sent size per app, from its latest screenshot, to map model coordinates back to device pixels. */
  private readonly scales = new Map<string, number>();

  constructor(options: ComputerToolsetOptions) {
    this.backend = options.backend;
    this.isLocallyEnabled = options.isLocallyEnabled;
    this.audit = options.audit ?? appendComputerAudit;
  }

  async available(): Promise<boolean> {
    return this.isLocallyEnabled().catch(() => false);
  }

  async listTools(): Promise<OcuTool[]> {
    if (!(await this.available())) return [];
    const tools = await this.backend.listTools();
    return tools.filter((tool) => ALLOWED_TOOLS.has(tool.name)).map((tool) => ({
      ...tool,
      description: `${(tool.description ?? "").replace(/\s*This tool is part of plugin `Computer Use`\./u, "")} Controls the user's real desktop on this device.`.trim(),
    }));
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<OcuResult> {
    const started = performance.now();
    const tool = name;
    const app = typeof args.app === "string" ? args.app : undefined;
    const finish = (result: OcuResult, reason?: string): OcuResult => {
      void this.audit({ ts: new Date().toISOString(), tool, ...(app ? { app } : {}), ok: !result.isError, ms: Math.round(performance.now() - started), ...(reason ? { reason } : {}) });
      return result;
    };
    const fail = (message: string, reason: string) => finish({ isError: true, content: [{ type: "text", text: message }] }, reason);
    if (!ALLOWED_TOOLS.has(tool)) return fail(`Unknown tool: ${name}`, "unknown_tool");
    if (!(await this.available())) return fail("Computer use is turned off on this device. Run `frely computer enable` on it first.", "locally_disabled");
    try {
      if (tool !== "list_apps") {
        try { assertAppAllowed(args.app); } catch (error) {
          if (error instanceof ComputerBlockedError) throw error;
          return fail(error instanceof Error ? error.message : "Invalid app.", "invalid_app");
        }
      }
      const sent = this.scaleCoordinates(tool, args);
      const result = await this.backend.callTool(tool, sent, signal);
      const shaped = tool === "list_apps" ? redactList(result) : this.shapeScreenshots(result, app);
      return finish(shaped);
    } catch (error) {
      if (error instanceof ComputerBlockedError) return fail(error.message, "blocked");
      return fail(error instanceof Error ? error.message : "Computer use failed.", "backend_error");
    }
  }

  async close(): Promise<void> {
    await this.backend.close();
  }

  private scaleCoordinates(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    const keys = COORDINATE_ARGS[tool];
    const scale = typeof args.app === "string" ? this.scales.get(normalizeApp(args.app)) : undefined;
    if (!keys || !scale || scale === 1) return args;
    const out = { ...args };
    for (const key of keys) if (typeof out[key] === "number") out[key] = Math.round((out[key] as number) * scale);
    return out;
  }

  private shapeScreenshots(result: OcuResult, app: string | undefined): OcuResult {
    let total = 0;
    const content = result.content.map((item): OcuContent => {
      if (item.type !== "image" || typeof item.data !== "string") return item;
      const original = Buffer.from(item.data, "base64");
      const scaled = downscalePng(original);
      if (scaled) {
        if (app) this.scales.set(normalizeApp(app), scaled.scale);
        return { ...item, data: scaled.data.toString("base64"), mimeType: "image/png" };
      }
      // Not a plain PNG we can decode: keep it only if it is already small and not oversized in pixels.
      const size = pngSize(original);
      if (app) this.scales.set(normalizeApp(app), 1);
      if (original.length > 1.5 * 1024 * 1024 || (size && Math.max(size.width, size.height) > 2560)) {
        return { type: "text", text: "Screenshot omitted: it is too large and could not be resized." };
      }
      return item;
    });
    for (const item of content) total += (item.data?.length ?? 0) + (item.text?.length ?? 0);
    if (total > MAX_RESULT_BYTES) return { isError: true, content: [{ type: "text", text: "The result was too large to send. Try a smaller window or lower max_tree_nodes." }] };
    return { ...result, content };
  }
}

function redactList(result: OcuResult): OcuResult {
  return { ...result, content: result.content.map((item) => item.type === "text" && typeof item.text === "string" ? { ...item, text: redactBlockedAppLines(item.text) } : item) };
}
