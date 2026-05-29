// Session logger + token-efficiency benchmarking.
// Every LLM call is appended as one JSONL record to ~/.pi/agent/logs/<session>.jsonl.
// Each record carries the real token usage from llama-server's `usage` field, the
// active extension config, and (unless LOG_MESSAGES=0) the messages sent + reply —
// which makes every line an SFT-ready (input → output) sample for post-training the
// model later. `/logs` summarizes token efficiency for the session and over time.
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = process.env.PI_LOG_DIR ?? join(homedir(), ".pi", "agent", "logs");

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface LlmRec {
  type: "llm";
  trace_id: string;
  ts: string; session: string; config: string; tag: string; turn: number; step: number; model: string;
  prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens: number;
  system_chars: number; injected_chars: number; latency_ms: number;
  streaming?: boolean; ttft_ms?: number; reasoning_chars?: number;
  messages?: { role: string; content: string }[];
  reply?: string;
}

interface SpanRec {
  type: "span";
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  ts: string;
  session: string;
  config: string;
  turn: number;
  step: number;
  span: string;
  status: "ok" | "error" | "skipped";
  latency_ms: number;
  error_class?: string;
  metadata: Record<string, unknown>;
}

interface ObservationRec {
  type: "observation";
  trace_id: string;
  span_id: string;
  ts: string;
  session: string;
  config: string;
  turn: number;
  step: number;
  tool: string;
  status: "ok" | "error";
  chars: number;
  preview: string;
}

interface SessionStartRec {
  type: "session_start";
  trace_id: string;
  ts: string;
  session: string;
  config: string;
  system_prompt: string;
  tool_specs: { name: string; args: string; description: string }[];
}

type LogRec = LlmRec | SpanRec | ObservationRec | SessionStartRec;

export class SessionLogger {
  readonly session = new Date().toISOString().replace(/[:.]/g, "-");
  readonly traceId = randomBytes(16).toString("hex");
  private file = join(LOG_DIR, `${this.session}.jsonl`);
  private recs: LlmRec[] = [];
  private spans: SpanRec[] = [];
  private withMessages = process.env.LOG_MESSAGES !== "0"; // default ON → post-training data

  constructor(private extensions: string[]) {}
  get config(): string { return this.extensions.length ? this.extensions.join("+") : "none"; }

  newSpanId(): string { return randomBytes(8).toString("hex"); }

  traceparent(spanId: string): string { return `00-${this.traceId}-${spanId}-01`; }

  traceEnv(spanId: string, parentSpanId?: string): Record<string, string> {
    const env: Record<string, string> = {
      SMOLPI_TRACE_ID: this.traceId,
      SMOLPI_SPAN_ID: spanId,
      TRACEPARENT: this.traceparent(spanId),
    };
    if (parentSpanId) env.SMOLPI_PARENT_SPAN_ID = parentSpanId;
    return env;
  }

  async log(p: {
    turn: number; step: number; model: string; usage: Usage; latencyMs: number;
    systemChars: number; baseChars: number;
    streaming?: boolean; ttftMs?: number; reasoningChars?: number;
    messages: { role: string; content: string }[]; reply: string; tag?: string;
  }): Promise<void> {
    const rec: LlmRec = {
      type: "llm",
      trace_id: this.traceId,
      ts: new Date().toISOString(), session: this.session, config: this.config,
      tag: p.tag ?? "main",
      turn: p.turn, step: p.step, model: p.model,
      prompt_tokens: p.usage.prompt_tokens ?? 0,
      completion_tokens: p.usage.completion_tokens ?? 0,
      total_tokens: p.usage.total_tokens ?? 0,
      cached_tokens: p.usage.prompt_tokens_details?.cached_tokens ?? 0,
      system_chars: p.systemChars,
      injected_chars: Math.max(0, p.systemChars - p.baseChars),
      latency_ms: Math.round(p.latencyMs),
    };
    if (typeof p.streaming === "boolean") rec.streaming = p.streaming;
    if (typeof p.ttftMs === "number") rec.ttft_ms = Math.round(p.ttftMs);
    if (typeof p.reasoningChars === "number") rec.reasoning_chars = p.reasoningChars;
    if (this.withMessages) { rec.messages = p.messages; rec.reply = p.reply; }
    this.recs.push(rec);
    await this.append(rec);
  }

  async logSpan(p: {
    turn: number;
    step: number;
    span: string;
    spanId?: string;
    parentSpanId?: string;
    status?: "ok" | "error" | "skipped";
    latencyMs?: number;
    errorClass?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const rec: SpanRec = {
      type: "span",
      trace_id: this.traceId,
      span_id: p.spanId ?? this.newSpanId(),
      ts: new Date().toISOString(),
      session: this.session,
      config: this.config,
      turn: p.turn,
      step: p.step,
      span: p.span,
      status: p.status ?? "ok",
      latency_ms: Math.max(0, Math.round(p.latencyMs ?? 0)),
      metadata: p.metadata ?? {},
    };
    if (p.parentSpanId) rec.parent_span_id = p.parentSpanId;
    if (p.errorClass) rec.error_class = p.errorClass;
    this.spans.push(rec);
    await this.append(rec);
  }

  // Checkpoint the tool observation immediately after execution so a crash-recovered
  // session can determine exactly which step was in flight. The preview (first 200
  // chars) is enough for debugging without bloating the log with full tool outputs.
  async logObservation(p: {
    turn: number; step: number; spanId: string;
    tool: string; status: "ok" | "error"; chars: number; preview: string;
  }): Promise<void> {
    const rec: ObservationRec = {
      type: "observation",
      trace_id: this.traceId,
      span_id: p.spanId,
      ts: new Date().toISOString(),
      session: this.session,
      config: this.config,
      turn: p.turn,
      step: p.step,
      tool: p.tool,
      status: p.status,
      chars: p.chars,
      preview: p.preview,
    };
    await this.append(rec);
  }

  // Write a session_start record as the first line of the JSONL file, embedding
  // the resolved system prompt and tool definitions. Replay evals use these to
  // validate against the schema that was actually active, not the current one.
  async logSessionStart(systemPrompt: string, toolSpecs: { name: string; args: string; description: string }[]): Promise<void> {
    const rec: SessionStartRec = {
      type: "session_start",
      trace_id: this.traceId,
      ts: new Date().toISOString(),
      session: this.session,
      config: this.config,
      system_prompt: systemPrompt,
      tool_specs: toolSpecs,
    };
    await this.append(rec);
  }

  private async append(rec: LogRec): Promise<void> {
    try {
      await mkdir(LOG_DIR, { recursive: true });
      await appendFile(this.file, JSON.stringify(rec) + "\n");
    } catch {
      // Logging must never break the agent.
    }
  }

  sessionSummary(): string {
    if (!this.recs.length) return "no LLM calls logged this session";
    const n = this.recs.length;
    const sum = (k: "prompt_tokens" | "completion_tokens" | "latency_ms") =>
      this.recs.reduce((a, r) => a + r[k], 0);
    const p = sum("prompt_tokens"), c = sum("completion_tokens"), lat = sum("latency_ms");
    const inj = this.recs[0].injected_chars;
    const ttfts = this.recs.map((r) => r.ttft_ms).filter((v): v is number => typeof v === "number");
    const streaming = this.recs.filter((r) => r.streaming).length;
    return [
      `── /logs · session ${this.session} · config: ${this.config} ──`,
      `LLM calls:         ${n}`,
      `prompt tokens:     ${p} total  (${Math.round(p / n)} avg/call)`,
      `completion tokens: ${c} total  (${Math.round(c / n)} avg/call)`,
      `injected memory:   ~${inj} chars in system prompt (~${Math.round(inj / 4)} tokens)`,
      `avg latency:       ${Math.round(lat / n)} ms/call`,
      `streaming calls:   ${streaming}/${n}${ttfts.length ? `  (avg TTFT ${Math.round(ttfts.reduce((a, v) => a + v, 0) / ttfts.length)} ms)` : ""}`,
      `span events:       ${this.spans.length}`,
      `log file:          ${this.file}`,
    ].join("\n");
  }

  /** Aggregate avg prompt tokens per call grouped by extension config, across
   *  all logged sessions — the token-efficiency trend over time. */
  static async allTimeSummary(): Promise<string> {
    let files: string[] = [];
    try { files = (await readdir(LOG_DIR)).filter((f) => f.endsWith(".jsonl")); }
    catch { return "no logs yet"; }

    const byConfig = new Map<string, { calls: number; prompt: number; completion: number; sessions: Set<string> }>();
    for (const f of files) {
      let lines: string[] = [];
      try { lines = (await readFile(join(LOG_DIR, f), "utf8")).trim().split("\n").filter(Boolean); }
      catch { continue; }
      for (const line of lines) {
        let r: LogRec | (Partial<LlmRec> & { type?: undefined });
        try { r = JSON.parse(line) as LogRec; } catch { continue; }
        if (r.type === "span") continue;
        const g = byConfig.get(r.config ?? "none") ?? { calls: 0, prompt: 0, completion: 0, sessions: new Set<string>() };
        g.calls++; g.prompt += r.prompt_tokens ?? 0; g.completion += r.completion_tokens ?? 0; g.sessions.add(r.session ?? "unknown");
        byConfig.set(r.config ?? "none", g);
      }
    }
    if (!byConfig.size) return "no logs yet";
    const rows = [...byConfig.entries()]
      .sort((a, b) => a[1].prompt / a[1].calls - b[1].prompt / b[1].calls)
      .map(([cfg, g]) =>
        `  ${cfg.padEnd(26)} ${String(g.calls).padStart(4)} calls  ` +
        `${String(Math.round(g.prompt / g.calls)).padStart(5)} avg prompt-tok  ` +
        `${String(Math.round(g.completion / g.calls)).padStart(4)} avg compl-tok  (${g.sessions.size} sessions)`);
    return [
      "── token efficiency over time · avg prompt tokens/call by config ──",
      ...rows,
      "(lower avg prompt-tok for the same task = more ctx-efficient; each JSONL line is an SFT-ready record)",
    ].join("\n");
  }
}
