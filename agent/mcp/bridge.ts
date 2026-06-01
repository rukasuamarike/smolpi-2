// Minimal native MCP bridge — a "smol" reimplementation of pi-mcp-adapter's core,
// built on the OFFICIAL Model Context Protocol SDK (@modelcontextprotocol/sdk).
// -----------------------------------------------------------------------------
// MCP is the open standard; @modelcontextprotocol/sdk is Anthropic's reference
// implementation. We do NOT hand-roll the wire protocol — the SDK owns the
// handshake, transports (stdio + StreamableHTTP), version negotiation, and
// pagination. This module is only the smolpi-specific glue:
//   • read .pi/mcp.json (the SAME config format as pi-mcp-adapter), and
//   • open an SDK Client per configured server (lazy, with idle disconnect), and
//   • expose ONE ~200-token `mcp` proxy tool (list/search/describe/call/connect)
//     plus optional direct tools — the token-efficient discovery pattern.
//
// smolpi is NOT the pi.dev runtime, so the upstream pi-mcp-adapter (vendored at
// ../../extensions/pi-mcp-adapter for reference) can't run here — it needs pi
// APIs our compat host stubs out (OAuth/UI/sampling/model-registry). This keeps
// only the load-bearing slice, on the same standard SDK it uses.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_IDLE_MIN = 10;

// ── Config (mirrors pi-mcp-adapter/types.ts ServerEntry/McpSettings) ──────────
export interface ServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string; // HTTP transport (StreamableHTTP)
  headers?: Record<string, string>;
  lifecycle?: "keep-alive" | "lazy" | "eager";
  idleTimeout?: number; // minutes; 0 disables
  directTools?: boolean | string[];
  excludeTools?: string[];
  debug?: boolean; // surface server stderr
}
export interface McpSettings {
  toolPrefix?: "server" | "none" | "short";
  idleTimeout?: number; // minutes, default 10, 0 disables
  directTools?: boolean;
  disableProxyTool?: boolean;
}
export interface McpConfig {
  settings?: McpSettings;
  mcpServers?: Record<string, ServerEntry>;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

// pi-style tool the compat host understands (see agent/extensions/host.ts).
export interface ToolDef {
  name: string;
  description?: string;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  execute: (...args: unknown[]) => Promise<unknown> | unknown;
}

// Expand ${VAR} from the environment in strings, and ~ at the start of a path.
const interpolate = (s: string): string =>
  s.replace(/\$\{(\w+)\}/g, (_, k) => {
    const v = process.env[k];
    if (v === undefined) console.error(`[mcp] warning: env var \${${k}} referenced in config is not set`);
    return v ?? "";
  });
const expandHome = (p: string): string => (p.startsWith("~") ? (process.env.HOME ?? "") + p.slice(1) : p);

// ── One MCP server, via the official SDK Client ───────────────────────────────
class ServerConn {
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  connected = false;
  tools: McpTool[] = [];
  lastError = "";

  constructor(public name: string, public entry: ServerEntry, private idleMin: number) {}

  /** Lazy, idempotent connect: build a transport, hand it to an SDK Client. */
  async connect(): Promise<void> {
    if (this.connected) { this.touch(); return; }
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect()
      .then(() => { this.connected = true; this.lastError = ""; this.touch(); })
      .catch((e) => { this.lastError = (e as Error).message; throw e; })
      .finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const client = new Client({ name: "smolpi-mcp-bridge", version: "0.1.0" }, { capabilities: {} });

    if (this.entry.url) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(this.entry.headers ?? {})) headers[k] = interpolate(v);
      const transport = new StreamableHTTPClientTransport(new URL(interpolate(this.entry.url)), {
        requestInit: { headers },
      });
      await client.connect(transport);
    } else {
      if (!this.entry.command) throw new Error(`server "${this.name}" has neither command nor url`);
      const env: Record<string, string> = { ...getDefaultEnvironment() };
      for (const [k, v] of Object.entries(this.entry.env ?? {})) env[k] = interpolate(v);
      const transport = new StdioClientTransport({
        command: interpolate(this.entry.command),
        args: (this.entry.args ?? []).map(interpolate),
        env,
        cwd: this.entry.cwd ? expandHome(interpolate(this.entry.cwd)) : undefined,
        stderr: this.entry.debug ? "inherit" : "ignore",
      });
      await client.connect(transport);
    }

    this.client = client;
    await this.refreshTools();
  }

  /** tools/list, following cursor pagination, minus excludeTools. */
  async refreshTools(): Promise<void> {
    if (!this.client) return;
    const all: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools ?? []) all.push(t as unknown as McpTool);
      cursor = page.nextCursor;
    } while (cursor);
    const excl = new Set(this.entry.excludeTools ?? []);
    this.tools = all.filter((t) => !excl.has(t.name));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    this.touch();
    return this.client!.callTool({ name, arguments: args ?? {} });
  }

  /** Reset the idle-disconnect timer (keep-alive servers never idle out). */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.entry.lifecycle === "keep-alive" || this.idleMin <= 0) return;
    this.idleTimer = setTimeout(() => this.close(), this.idleMin * 60_000);
    (this.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  async close(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.connected = false;
    const c = this.client;
    this.client = null;
    try { await c?.close(); } catch { /* already gone */ }
  }
}

// ── Bridge: manages servers + builds the agent-facing tools ───────────────────
export class McpBridge {
  private servers = new Map<string, ServerConn>();
  private settings: McpSettings = {};
  private loadedFrom: string[] = [];

  /** Read + merge config from the standard locations (project .pi wins). */
  load(): void {
    const fs = require("node:fs");
    const sources: string[] = [];
    const home = process.env.HOME ?? "";
    if (process.env.MCP_CONFIG) sources.push(process.env.MCP_CONFIG);
    else {
      if (home) sources.push(`${home}/.config/mcp/mcp.json`); // global (lowest precedence)
      const extCfg = process.env.PI_EXTENSIONS_CONFIG ?? "/app/.pi/extensions.json";
      sources.push(extCfg.replace(/extensions\.json$/, "mcp.json"));
      sources.push(`${process.cwd()}/.pi/mcp.json`); // project (highest precedence)
    }
    const seen = new Set<string>();
    for (const path of sources) {
      if (seen.has(path)) continue; // same resolved path can appear twice (e.g. /app/.pi/mcp.json)
      seen.add(path);
      let txt: string;
      try { txt = fs.readFileSync(path, "utf8"); } catch { continue; } // missing → skip
      let cfg: McpConfig;
      try { cfg = JSON.parse(txt) as McpConfig; } catch { console.error(`[mcp] invalid JSON in ${path}`); continue; }
      this.settings = { ...this.settings, ...(cfg.settings ?? {}) };
      const idleMin = this.settings.idleTimeout ?? DEFAULT_IDLE_MIN;
      for (const [name, entry] of Object.entries(cfg.mcpServers ?? {})) {
        this.servers.set(name, new ServerConn(name, entry, entry.idleTimeout ?? idleMin));
      }
      this.loadedFrom.push(path);
    }
  }

  get serverCount(): number { return this.servers.size; }
  get proxyEnabled(): boolean { return !this.settings.disableProxyTool; }
  summary(): string {
    if (!this.servers.size) return "no MCP servers";
    return `${this.servers.size} server(s): ${[...this.servers.keys()].join(", ")} (from ${this.loadedFrom.join(", ")})`;
  }

  /** server prefix applied to a raw tool name for the agent-facing namespace. */
  private prefixed(server: string, raw: string): string {
    switch (this.settings.toolPrefix ?? "server") {
      case "none": return raw;
      case "short": return `${server.slice(0, 6)}_${raw}`;
      default: return `${server}_${raw}`;
    }
  }

  /** Map an agent-facing tool name back to {server, rawName}. */
  private resolveTool(name: string): { conn: ServerConn; raw: string } | null {
    for (const conn of this.servers.values())
      for (const t of conn.tools)
        if (this.prefixed(conn.name, t.name) === name || t.name === name) return { conn, raw: t.name };
    return null;
  }

  /** Ensure every server is connected so search/list see all tools. */
  private async connectAll(): Promise<string[]> {
    const errs: string[] = [];
    await Promise.all([...this.servers.values()].map(async (c) => {
      try { await c.connect(); } catch (e) { errs.push(`${c.name}: ${(e as Error).message}`); }
    }));
    return errs;
  }

  /** The single proxy tool the agent sees (≈200 tokens vs. all schemas upfront). */
  proxyTool(): ToolDef {
    const names = [...this.servers.keys()].join(", ") || "none";
    return {
      name: "mcp",
      description:
        `Bridge to MCP servers (configured: ${names}; e.g. browser39 interactive browsing — click/fill/submit/dom_query). ` +
        `Verbs: {} lists servers+tools; {"search":"keywords"} finds tools; {"describe":"toolName"} shows a tool's schema; ` +
        `{"tool":"toolName","args":"{...json...}"} CALLS a tool (args is a JSON STRING); {"connect":"server"} (re)connects.`,
      parameters: {
        properties: {
          search: { type: "string", description: "keyword search across tool names/descriptions" },
          describe: { type: "string", description: "tool name to show full input schema for" },
          tool: { type: "string", description: "tool name to call" },
          args: { type: "string", description: "JSON string of arguments for the called tool" },
          connect: { type: "string", description: "server name to (re)connect" },
        },
        required: [],
      },
      execute: async (..._a: unknown[]) => this.runProxy((_a[1] ?? {}) as Record<string, unknown>),
    };
  }

  private async runProxy(p: Record<string, unknown>): Promise<unknown> {
    // (re)connect a single server
    if (typeof p.connect === "string") {
      const c = this.servers.get(p.connect);
      if (!c) return `unknown server "${p.connect}". Configured: ${[...this.servers.keys()].join(", ") || "none"}`;
      await c.close();
      try { await c.connect(); } catch (e) { return `connect failed: ${(e as Error).message}`; }
      return `connected ${c.name} (${c.tools.length} tools): ${c.tools.map((t) => this.prefixed(c.name, t.name)).join(", ")}`;
    }

    // call a tool
    if (typeof p.tool === "string") {
      let args: Record<string, unknown> = {};
      if (p.args != null) {
        if (typeof p.args === "string") { try { args = JSON.parse(p.args); } catch { return `args must be a valid JSON string; got: ${p.args}`; } }
        else if (typeof p.args === "object") args = p.args as Record<string, unknown>; // tolerate object form
      }
      let hit = this.resolveTool(p.tool);
      if (!hit) { await this.connectAll(); hit = this.resolveTool(p.tool); }
      if (!hit) return `unknown tool "${p.tool}". Use {"search":"..."} or {} to list tools.`;
      try {
        const res = await hit.conn.callTool(hit.raw, args); // {content:[...]} normalized by host
        if (res && typeof res === "object" && (res as { isError?: unknown }).isError === true) {
          const text = ((res as { content?: Array<{ text?: string }> }).content ?? [])
            .map((c) => c?.text).filter(Boolean).join("\n");
          return `ERROR (tool reported failure): ${text}`;
        }
        return res;
      }
      catch (e) { return `ERROR calling ${p.tool}: ${(e as Error).message}`; }
    }

    // describe a tool
    if (typeof p.describe === "string") {
      await this.connectAll();
      const hit = this.resolveTool(p.describe);
      if (!hit) return `unknown tool "${p.describe}".`;
      const t = hit.conn.tools.find((x) => x.name === hit.raw)!;
      return [
        `# ${this.prefixed(hit.conn.name, t.name)}  (server: ${hit.conn.name})`,
        t.description ?? "(no description)",
        "## input schema",
        JSON.stringify(t.inputSchema ?? {}, null, 2),
      ].join("\n");
    }

    // search / list
    // TODO(performance): every search/list (and describe) verb calls connectAll() across ALL servers, re-incurring lazy-connect latency on each discovery call (esp. after idle-disconnect); cache enumerated tools and (re)connect only on demand. (README latency axis; token-efficient tool design)
    const errs = await this.connectAll();
    const kw = typeof p.search === "string" ? p.search.toLowerCase().split(/\s+/).filter(Boolean) : [];
    const lines: string[] = [];
    for (const c of this.servers.values()) {
      // TODO(tool-design): classify lastError before rendering — spawn ENOENT (binary not installed → name it + "run guest-setup") vs crash-after-connect (-32000 Connection closed → "server started then exited; try {\"connect\":\"name\"} or check stderr") so the model gets an actionable fix, not opaque "-32000". (README near-term #5 actionable tool errors)
      const status = c.connected ? `${c.tools.length} tools` : `OFFLINE${c.lastError ? ` (${c.lastError})` : ""}`;
      lines.push(`## ${c.name} — ${status}`);
      const matches = c.tools.filter((t) => {
        if (!kw.length) return true;
        const hay = `${t.name} ${t.description ?? ""}`.toLowerCase();
        return kw.every((k) => hay.includes(k));
      });
      for (const t of matches.slice(0, kw.length ? 40 : 60))
        lines.push(`- ${this.prefixed(c.name, t.name)} — ${(t.description ?? "").split("\n")[0].slice(0, 120)}`);
      if (!matches.length) lines.push(kw.length ? "  (no matching tools)" : "  (no tools)");
    }
    if (errs.length) lines.push(`\n[connect errors] ${errs.join("; ")}`);
    lines.push(`\nCall one with {"tool":"<name>","args":"{...}"}.`);
    return lines.join("\n");
  }

  /** Direct tool defs for servers configured with directTools (requires a
   *  connect to enumerate). Returns [] for the default proxy-only setup. */
  async directTools(): Promise<ToolDef[]> {
    const out: ToolDef[] = [];
    for (const c of this.servers.values()) {
      const want = c.entry.directTools ?? this.settings.directTools ?? false;
      if (!want) continue;
      try { await c.connect(); } catch { continue; }
      const allow = Array.isArray(want) ? new Set(want) : null;
      for (const t of c.tools) {
        if (allow && !allow.has(t.name)) continue;
        out.push({
          name: this.prefixed(c.name, t.name),
          description: t.description,
          parameters: t.inputSchema,
          execute: async (..._a: unknown[]) => c.callTool(t.name, (_a[1] ?? {}) as Record<string, unknown>),
        });
      }
    }
    return out;
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.servers.values()].map((c) => c.close()));
  }
}
