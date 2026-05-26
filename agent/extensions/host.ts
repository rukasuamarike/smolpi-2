// pi-compat extension host (scaffold)
// -----------------------------------
// smolpi is NOT the pi.dev runtime; it's the ~167-line agent in ../index.ts.
// The six vendored extensions (../../extensions/*) are written against the pi.dev
// `ExtensionAPI`. This module implements the SUBSET of that API the extensions
// actually call (observed by reading their source), reads the deny-by-default
// toggle registry (../../.pi/extensions.json), and loads only permitted ones.
//
// STATUS: contract + loader are real and compilable. Actually executing the
// vendored extension code additionally requires (a) their peer deps
// (`@mariozechner/pi-ai`, `pi-coding-agent`, `pi-tui`, `better-sqlite3`,
// `@sinclair/typebox`) present in the guest, and (b) adapters for the richer
// ctx fields (model registry, sessionManager, createAgentSession). Those are
// flagged as TODO and fail soft — a missing dep disables that extension, it
// does not crash the agent. index.ts is intentionally NOT wired to this yet
// (see docs/EXTENSION_PLAN.md "when we implement").

import { readFile } from "node:fs/promises";
import { existsSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

/** Normalize a pi tool's return value into observation text. */
function toolResultText(r: unknown): string {
  if (r == null) return "(no result)";
  if (typeof r === "string") return r;
  const o = r as Record<string, unknown>;
  if (Array.isArray(o.content)) {
    return (o.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n").trim();
  }
  if (typeof o.message === "string") return o.message;
  if (typeof o.text === "string") return o.text;
  try { return JSON.stringify(r).slice(0, 2000); } catch { return String(r); }
}

// ── The pi.dev ExtensionAPI subset every vendored extension uses ──────────────
export type HookName =
  | "session_start"
  | "before_agent_start"
  | "session_before_compact"
  | "session_shutdown"
  | "resources_discover"
  | "tool_call"
  | "turn_end";

export interface ToolDef {
  name: string;
  description?: string;
  parameters?: unknown; // Typebox schema in the originals
  execute: (...args: unknown[]) => Promise<unknown> | unknown;
}

export interface ExtensionAPI {
  on(hook: HookName, handler: (event: unknown, ctx: unknown) => unknown): void;
  registerTool(tool: ToolDef): void;
  registerCommand(name: string, spec: unknown): void;
  exec(cmd: string, args: string[], opts?: unknown): Promise<unknown>;
  ui: { setStatus(key: string, text: string): void };
  // TODO(adapter): originals also read pi.model / pi.modelRegistry /
  // pi.sessionManager and call createAgentSession(); provide these to enable
  // delegate + hermes consolidation. Left undefined here → those features no-op.
}

type Tier = "stable" | "experimental" | "egress";
interface ExtEntry {
  path: string;
  tier: Tier;
  enabled: boolean;
  commandOnly?: boolean;
  options?: Record<string, unknown>;
  note?: string;
}
interface ExtConfig {
  policy: {
    denyByDefault: boolean;
    allowExperimental: boolean;
    allowEgress: boolean;
    maxInjectedContextChars: number;
  };
  extensions: Record<string, ExtEntry>;
}

interface LoadedExt {
  name: string;
  tools: ToolDef[];
  hooks: Map<HookName, Array<(e: unknown, c: unknown) => unknown>>;
  commands: string[];
}

const CONFIG_PATH =
  process.env.PI_EXTENSIONS_CONFIG ?? "/app/.pi/extensions.json";

export class ExtensionHost {
  private loaded: LoadedExt[] = [];
  private cfg!: ExtConfig;
  private cfgDir = "";

  /** Load config, enforce policy, dynamically import each permitted extension. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(CONFIG_PATH, "utf8");
      this.cfg = JSON.parse(raw) as ExtConfig;
      this.cfgDir = dirname(CONFIG_PATH);
    } catch {
      // No registry → no extensions. Baseline agent behaves exactly as before.
      this.cfg = {
        policy: { denyByDefault: true, allowExperimental: false, allowEgress: false, maxInjectedContextChars: 6000 },
        extensions: {},
      };
      return;
    }

    for (const [name, ext] of Object.entries(this.cfg.extensions)) {
      const verdict = this.permit(ext);
      if (verdict !== "ok") {
        if (ext.enabled) console.error(`[ext] skip ${name}: ${verdict}`);
        continue;
      }
      await this.loadOne(name, ext);
    }
  }

  /** Deny-by-default policy gate (rubric #8). */
  private permit(ext: ExtEntry): string {
    if (!ext.enabled) return "disabled";
    if (ext.tier === "experimental" && !this.cfg.policy.allowExperimental)
      return "experimental tier blocked (policy.allowExperimental=false)";
    if (ext.tier === "egress" && !this.cfg.policy.allowEgress)
      return "egress tier blocked (policy.allowEgress=false)";
    return "ok";
  }

  private async loadOne(name: string, ext: ExtEntry): Promise<void> {
    const dir = resolve(this.cfgDir, ext.path);
    let entry: string;
    try {
      entry = await this.resolveEntry(dir);
    } catch (e) {
      console.error(`[ext] ${name}: cannot resolve entrypoint (${(e as Error).message})`);
      return;
    }

    const rec: LoadedExt = { name, tools: [], hooks: new Map(), commands: [] };
    const api: ExtensionAPI = {
      on: (hook, handler) => {
        const list = rec.hooks.get(hook) ?? [];
        list.push(handler);
        rec.hooks.set(hook, list);
      },
      registerTool: (t) => rec.tools.push(t),
      registerCommand: (n) => rec.commands.push(n),
      exec: async () => ({ code: 0, stdout: "", stderr: "" }), // TODO(adapter): wire Bun.spawn
      ui: { setStatus: () => {} },
    };

    try {
      const mod = await import(entry);
      const register = mod.default ?? mod.register;
      if (typeof register !== "function")
        throw new Error("no default/register export");
      await register(api);
      this.loaded.push(rec);
      console.error(`[ext] loaded ${name}: ${rec.tools.length} tools, ${rec.hooks.size} hooks`);
    } catch (e) {
      // Most common cause: missing peer dep in the guest. Fail soft.
      console.error(`[ext] ${name} failed to load (likely missing peer dep): ${(e as Error).message}`);
    }
  }

  /** Read the extension's package.json to find its entrypoint (Bun runs .ts).
   *  Handles the `pi.extension(s)` field, which may be a file OR a directory
   *  (e.g. llm-wiki's `["./extensions"]` → extensions/llm-wiki/index.ts). */
  private async resolveEntry(dir: string): Promise<string> {
    const pkg = JSON.parse(await readFile(resolve(dir, "package.json"), "utf8"));
    const piExt = pkg.pi?.extension ?? pkg.pi?.extensions;
    const declaredList: string[] = Array.isArray(piExt) ? piExt : piExt ? [piExt] : [];
    const indexIn = (d: string): string | null => {
      for (const f of ["index.ts", "index.js"]) if (existsSync(resolve(d, f))) return resolve(d, f);
      return null;
    };
    for (const d of declaredList) {
      const p = resolve(dir, d);
      if (!existsSync(p)) continue;
      if (statSync(p).isDirectory()) {
        const direct = indexIn(p);
        if (direct) return direct;
        for (const sub of readdirSync(p)) {
          const nested = indexIn(resolve(p, sub));
          if (nested) return nested;
        }
      } else return p;
    }
    const declared = pkg.exports?.["."] ?? pkg.module ?? pkg.main ?? null;
    const candidates = [
      typeof declared === "string" ? declared : declared?.import ?? declared?.default,
      "index.ts", "index.js", "src/index.ts", "src/index.js",
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      const p = resolve(dir, c);
      if (existsSync(p)) return p;
    }
    throw new Error(`no entrypoint for ${pkg.name}`);
  }

  /** Minimal ExtensionContext. memctx & friends keep their own state in module
   *  scope, so a fresh ctx per call is fine. */
  private buildCtx() {
    return {
      cwd: process.cwd(),
      hasUI: false,
      ui: { notify() {}, setStatus() {}, async confirm() { return false; }, async select() { return undefined; } },
      signal: new AbortController().signal,
      sessionManager: { getSessionId: () => "smol", getBranch: () => [] as unknown[] },
      model: undefined,
      modelRegistry: undefined,
    };
  }

  /** Run `session_start` for all loaded extensions (pack detection, indexing). */
  async sessionStart(): Promise<void> {
    const ctx = this.buildCtx();
    for (const ext of this.loaded)
      for (const h of ext.hooks.get("session_start") ?? []) {
        try { await h({}, ctx); }
        catch (e) { console.error(`[ext] ${ext.name} session_start: ${(e as Error).message}`); }
      }
  }

  /** Chain `before_agent_start` injections for this prompt; returns the
   *  augmented system prompt, capped by the policy's injected-context budget. */
  async beforeAgentStart(prompt: string, systemPrompt: string): Promise<string> {
    const ctx = this.buildCtx();
    let sys = systemPrompt;
    for (const ext of this.loaded)
      for (const h of ext.hooks.get("before_agent_start") ?? []) {
        try {
          const out = (await h({ prompt, systemPrompt: sys }, ctx)) as { systemPrompt?: string } | undefined;
          if (out?.systemPrompt) sys = out.systemPrompt;
        } catch (e) {
          console.error(`[ext] ${ext.name} before_agent_start: ${(e as Error).message}`);
        }
      }
    const cap = systemPrompt.length + this.cfg.policy.maxInjectedContextChars;
    return sys.length > cap ? sys.slice(0, cap) : sys;
  }

  /** Tools contributed by enabled, non-command-only extensions. */
  tools(): ToolDef[] {
    return this.loaded.flatMap((e) => e.tools);
  }

  summary(): string {
    if (!this.loaded.length) return "no extensions loaded";
    return this.loaded.map((e) => `${e.name}(${e.tools.length}t/${e.commands.length}c)`).join(", ");
  }

  /** Names of successfully loaded extensions (for logging/telemetry). */
  names(): string[] {
    return this.loaded.map((e) => e.name);
  }

  /** Model-facing tool catalog: name + arg names + one-line description. */
  toolSpecs(): { name: string; args: string; description: string }[] {
    return this.loaded.flatMap((e) =>
      e.tools.map((t) => {
        const td = t as {
          name: string; description?: string; promptSnippet?: string;
          parameters?: { properties?: Record<string, unknown>; required?: string[] };
        };
        const desc = (td.description ?? td.promptSnippet ?? "").toString().split("\n")[0];
        const props = td.parameters?.properties ?? {};
        const req = td.parameters?.required ?? [];
        const args = Object.keys(props).map((k) => (req.includes(k) ? k : `${k}?`)).join(", ");
        return { name: td.name, args, description: desc.slice(0, 140) };
      }),
    );
  }

  /** Invoke a registered tool by name with the standard pi signature
   *  execute(toolCallId, params, signal, onUpdate, ctx). Returns observation text. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    for (const ext of this.loaded) {
      const tool = ext.tools.find((t) => t.name === name);
      if (!tool) continue;
      const ctx = this.buildCtx();
      try {
        const r = await (tool.execute as (...a: unknown[]) => unknown)(
          `call-${Date.now()}`, args, ctx.signal, () => {}, ctx,
        );
        return toolResultText(r);
      } catch (e) {
        return `ERROR calling ${name}: ${(e as Error).message}`;
      }
    }
    const avail = this.tools().map((t) => t.name).join(", ") || "none";
    return `ERROR: unknown tool "${name}". Available: ${avail}`;
  }

  /** Run `turn_end` hooks (e.g. llm-wiki rebuilds its metadata after writes). */
  async runTurnEnd(): Promise<void> {
    const ctx = this.buildCtx();
    for (const ext of this.loaded)
      for (const h of ext.hooks.get("turn_end") ?? []) {
        try { await h({}, ctx); }
        catch (e) { console.error(`[ext] ${ext.name} turn_end: ${(e as Error).message}`); }
      }
  }
}
