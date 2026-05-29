import {
  activeCapabilities,
  GROUP_ORDER,
  GROUP_TITLES,
  type Capability,
} from "./capabilities";
import { ExtensionHost } from "./extensions/host";
import { parseAction, type Action } from "./action";
import { insertCompactionNotice, messageChars, trimContext, type Message } from "./context";
import { compactLargeObservations, formatObservation } from "./observation";
import { classifyActionRisk } from "./policy";
import { parseSseBuffer } from "./sse";
import type { McpBridge } from "./mcp/bridge"; // type-only: erased at compile time, no SDK at runtime
import { SessionLogger, type Usage } from "./logger";

const LLM_BASE = process.env.LLM_URL ?? "http://127.0.0.1:8080";
const LLM_URL = LLM_BASE.replace(/\/+$/, "") + "/v1/chat/completions";
const MODEL = process.env.LLM_MODEL ?? "gemma-4";
const BROWSER_BIN = process.env.BROWSER_BIN ?? "browser39"; // Rust single binary, no Chromium
const APPEND_PATH = process.env.APPEND_SYSTEM_PATH ?? "/app/.pi/APPEND_SYSTEM.md";
// AGENT_RULES.md is injected into baseSystem (never the sliding-window history)
// so its content is pinned across all context compaction. Put load-bearing rules here.
const AGENT_RULES_PATH = process.env.AGENT_RULES_PATH ?? `${process.cwd()}/.pi/AGENT_RULES.md`;
const PROGRESS_PATH = process.env.PROGRESS_PATH ?? `${process.cwd()}/.pi/progress.md`;

// Loop controls (env-overridable).
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 12); // stop predicate (rubric #2)
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 1024);
const SHELL_TIMEOUT_MS = Number(process.env.SHELL_TIMEOUT_MS ?? 60_000); // fixes the no-timeout hang
const CTX_CHAR_BUDGET = Number(process.env.CTX_CHAR_BUDGET ?? 16_000); // sliding-window trim (rubric #3)
const OUT_CAP = Number(process.env.TOOL_OUTPUT_CAP ?? 4_000);
const EXPERIMENTAL = process.env.AGENT_EXPERIMENTAL === "1"; // gates native delegate (deny-by-default)
const DELEGATE_MAX_STEPS = Number(process.env.DELEGATE_MAX_STEPS ?? 5);
const LLM_STREAM = process.env.LLM_STREAM !== "0";
const LLM_CONCURRENCY = Number(process.env.LLM_CONCURRENCY ?? 1);

// Thin semaphore so delegate Promise.all can't fire more concurrent LLM calls
// than the backend has slots. Default LLM_CONCURRENCY=1 serialises delegates;
// raise it to match llama.cpp --parallel N once you've configured the backend.
class Semaphore {
  private queue: (() => void)[] = [];
  private running = 0;
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.running < this.max) { this.running++; return; }
    await new Promise<void>((res) => this.queue.push(res));
    this.running++;
  }
  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}
const llmSemaphore = new Semaphore(LLM_CONCURRENCY);

async function generatePrompt(host: ExtensionHost): Promise<string> {
  const active = await activeCapabilities();

  const groups = new Map<string, Capability[]>();
  for (const cap of active) {
    const list = groups.get(cap.group) ?? [];
    list.push(cap);
    groups.set(cap.group, list);
  }

  const lines: string[] = [];
  lines.push("You are a Pi Coding Agent running inside a Debian MicroVM.");
  lines.push(
    "You work AUTONOMOUSLY across multiple steps: reason, take ONE action, read its result, then continue — until the task is done.",
  );
  lines.push("You have a high-performance Linux toolkit. Prefer these over basic ls/cat for speed.");
  lines.push("Use native workspace state before inventing custom scaffolding: start substantial repo tasks with `git status --short`, inspect recent work with `git diff` and `git log --oneline -5`, and use `.pi/progress.md` for milestone notes when context may span multiple turns.");
  lines.push("Update `.pi/progress.md` after meaningful milestones with goal, current state, last commands, open risks, and next step; this assumes small models lose task state, so delete/ignore it if evals prove native git history is enough.");
  lines.push("");

  for (const g of GROUP_ORDER) {
    const caps = groups.get(g);
    if (!caps?.length) continue;
    lines.push(`### ${GROUP_TITLES[g]}`);
    for (const cap of caps) {
      if (cap.name === "browse") {
        lines.push("- Fetch a web page as Markdown via the <browse> action (see Acting).");
      } else if (cap.name === "sh") {
        lines.push("- Any other shell command runs via the <sh> action (see Acting).");
      } else {
        lines.push(`- ${cap.snippet}`);
      }
    }
    lines.push("");
  }

  const toolSpecs = host.toolSpecs();
  if (toolSpecs.length || EXPERIMENTAL) {
    lines.push("## Memory, knowledge & MCP tools");
    lines.push("Call ONE to recall/search prior knowledge, consult the wiki, save a durable fact, or reach an MCP server (the `mcp` tool — e.g. browser39 interactive browsing: click/fill/submit). Skip the memory tools if the answer is already in the context above.");
    for (const s of toolSpecs) lines.push(`- ${s.name}(${s.args}) — ${s.description}`);
    if (EXPERIMENTAL) {
      lines.push('- delegate(task, tasks) — run independent sub-task(s) in FRESH isolated contexts; pass tasks:["a","b"] to run them IN PARALLEL. Returns only their distilled results. Use for independent research/exploration that would otherwise bloat this context.');
      lines.push('- consolidate_memory() — summarize work history into a compact Knowledge Block; call between major subtasks when context is growing long.');
    }
    lines.push("");
  }

  lines.push("## Acting — one action per step");
  lines.push("Emit EXACTLY ONE action per reply, then stop and wait for its `Observation:`. Do not invent observations.");
  lines.push("- Shell (RUNS the command; may span multiple lines):");
  lines.push("  <sh>grep -rn TODO src/</sh>");
  if (active.some((c) => c.name === "browse")) {
    lines.push("- Fetch a URL as Markdown:");
    lines.push("  <browse>https://example.com</browse>");
  }
  if (toolSpecs.length || EXPERIMENTAL) {
    lines.push("- Call a memory/knowledge tool (arguments as JSON):");
    lines.push('  <tool name="memctx_search">{"query":"how is auth handled"}</tool>');
  }
  if (EXPERIMENTAL) {
    lines.push("- Fan out independent work in parallel, then compose the results:");
    lines.push('  <tool name="delegate">{"tasks":["research X","research Y"]}</tool>');
    lines.push("- Compact growing history into a Knowledge Block:");
    lines.push('  <tool name="consolidate_memory"/>');
  }
  lines.push("- When the task is complete, give your final answer and end with <done/> on its own.");
  lines.push("");
  lines.push("IMPORTANT:");
  lines.push("- <sh> and <browse> EXECUTE. To merely SHOW a command in your answer without running it, use plain `backticks`, never <sh>.");
  lines.push("- Never put an action and <done/> in the same reply — <done/> means you are finished and nothing more will run.");
  lines.push("- Do several commands one-per-step across turns, not all at once.");
  lines.push("");
  lines.push("## Examples");
  lines.push('Task: "Which files mention retry?"');
  lines.push("  step 1 →  <sh>rg -l retry</sh>");
  lines.push("  step 2 (after the Observation) →  The matches are in `a.ts` and `b.ts`. <done/>");
  lines.push('Task: "How do I run the tests?"  (you already know / memory says so)');
  lines.push("  →  Run the suite with `bun test`. <done/>");
  lines.push("(Note: the second answer SHOWS the command in backticks and runs nothing.)");
  lines.push("");
  lines.push("---");
  lines.push(`Current Time: ${new Date().toISOString()}`);
  lines.push(`PWD: ${process.cwd()}`);
  lines.push(`OS: ${process.platform} ${process.arch}`);

  const progressFile = Bun.file(PROGRESS_PATH);
  if (await progressFile.exists()) {
    const progress = (await progressFile.text()).trim();
    if (progress) {
      lines.push("");
      lines.push("## Workspace progress (.pi/progress.md)");
      lines.push(progress.length > 4_000 ? progress.slice(0, 4_000) + "\n…[truncated]" : progress);
    }
  }

  // Pinned rules — loaded from AGENT_RULES_PATH (.pi/AGENT_RULES.md by default).
  // Lives in baseSystem so it is NEVER subject to sliding-window trim. Any rule
  // that must survive a long multi-step session belongs here, not in messages[].
  const rulesFile = Bun.file(AGENT_RULES_PATH);
  if (await rulesFile.exists()) {
    const rules = (await rulesFile.text()).trim();
    if (rules) {
      lines.push("");
      lines.push("## Persistent Rules (survive context compaction)");
      lines.push(rules);
    }
  }

  // Project-specific override (e.g. the Umi soul).
  const appendFile = Bun.file(APPEND_PATH);
  if (await appendFile.exists()) {
    const extra = (await appendFile.text()).trim();
    if (extra) {
      lines.push("");
      lines.push("---");
      lines.push(extra);
    }
  }

  return lines.join("\n");
}

interface LlmResult {
  content: string;
  usage: Usage;
  latencyMs: number;
  streaming?: boolean;
  ttftMs?: number;
  reasoningChars?: number;
}

async function llm(messages: Message[]): Promise<LlmResult> {
  const t0 = performance.now();
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: MAX_TOKENS }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    usage: data.usage ?? {},
    latencyMs: performance.now() - t0,
  };
}

async function llmStream(messages: Message[], onDelta?: (delta: string) => void): Promise<LlmResult> {
  const t0 = performance.now();
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: MAX_TOKENS, stream: true }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`stream rejected ${res.status}: ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoningContent = "";
  let usage: Usage = {};
  let ttftMs: number | undefined;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    const parsed = parseSseBuffer(buf);
    buf = parsed.rest;
    for (const event of parsed.events) {
      if (event.trim() === "[DONE]") continue;
      let data: any;
      try { data = JSON.parse(event); } catch { continue; }
      if (data.usage) usage = data.usage;
      if (!usage.prompt_tokens && data.timings) {
        const prompt = Number(data.timings.prompt_n ?? 0);
        const completion = Number(data.timings.predicted_n ?? 0);
        usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
      }
      const reasoning = data.choices?.[0]?.delta?.reasoning_content ?? "";
      if (reasoning) {
        if (ttftMs === undefined) ttftMs = performance.now() - t0;
        // Thinking-model reasoning is tracked for observability, but not appended
        // to visible/action content. Executing hidden-chain tool calls would be a
        // footgun; only explicit visible actions are parsed.
        reasoningContent += reasoning;
      }
      const delta = data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? "";
      if (delta) {
        if (ttftMs === undefined) ttftMs = performance.now() - t0;
        content += delta;
        onDelta?.(delta);
      }
    }
  }

  buf += decoder.decode();
  const parsed = parseSseBuffer(buf);
  for (const event of parsed.events) {
    if (event.trim() === "[DONE]") continue;
    try {
      const data = JSON.parse(event);
      if (data.usage) usage = data.usage;
      if (!usage.prompt_tokens && data.timings) {
        const prompt = Number(data.timings.prompt_n ?? 0);
        const completion = Number(data.timings.predicted_n ?? 0);
        usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
      }
    } catch {}
  }
  return { content, usage, latencyMs: performance.now() - t0, streaming: true, ttftMs, reasoningChars: reasoningContent.length };
}

async function llmWithOptionalStream(messages: Message[], onDelta?: (delta: string) => void): Promise<LlmResult> {
  if (!LLM_STREAM) return { ...(await llm(messages)), streaming: false };
  try {
    return await llmStream(messages, onDelta);
  } catch (e) {
    console.error(`⚠ streaming failed; falling back to non-streaming: ${(e as Error).message}`);
    return { ...(await llm(messages)), streaming: false };
  }
}

async function browse(url: string): Promise<string> {
  // browser39 `fetch` runs JS (V8), follows the page, and emits token-efficient
  // Markdown directly — no Chromium, no separate readability pass.
  const proc = Bun.spawn([BROWSER_BIN, "fetch", url], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`browser39 fetch failed (${exitCode}): ${stderr.trim()}`);
  }
  let out = stdout.trim();
  if (out.length > OUT_CAP) out = out.slice(0, OUT_CAP) + "\n…[truncated]";
  return out || "(no output)";
}

async function shell(cmd: string, traceEnv: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...traceEnv } });
  // Hard timeout: a command blocking on stdin must not hang the agent forever.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch {}
  }, SHELL_TIMEOUT_MS);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);

  let out = stdout.trim();
  if (stderr.trim()) out += `\n[stderr]\n${stderr.trim()}`;
  if (timedOut) out = `[timed out after ${SHELL_TIMEOUT_MS}ms]\n${out}`;
  else if (code !== 0) out = `[exit ${code}]\n${out}`;
  if (out.length > OUT_CAP) out = out.slice(0, OUT_CAP) + "\n…[truncated]";
  return out.trim() || "(no output)";
}

function errorClass(e: unknown): string {
  return (e as Error)?.name || "Error";
}

async function assembleSystemForTask(
  task: string,
  baseSystem: string,
  host: ExtensionHost,
  logger: SessionLogger,
  turn: number,
  step = 0,
): Promise<string> {
  const t0 = performance.now();
  const system = await host.beforeAgentStart(task, baseSystem, async (s) => {
    await logger.logSpan({
      turn,
      step,
      span: "extension.before_agent_start",
      status: s.status,
      latencyMs: s.latencyMs,
      errorClass: s.errorClass,
      metadata: {
        extension: s.extension,
        input_chars: s.inputChars,
        output_chars: s.outputChars,
      },
    });
  });
  await logger.logSpan({
    turn,
    step,
    span: "prompt.assemble",
    latencyMs: performance.now() - t0,
    metadata: {
      base_system_chars: baseSystem.length,
      system_chars: system.length,
      injected_chars: Math.max(0, system.length - baseSystem.length),
      extension_count: host.names().length,
    },
  });
  return system;
}

// One user task → autonomous multi-step loop. Returns to the REPL on completion,
// LLM failure, or step-budget exhaustion. Tool errors are fed back as
// observations (the model can recover) and never crash the process.
// ── Native delegate (experimental). Run a sub-task in a FRESH, isolated context
// (subagent isolation, rubric #9) and return only its distilled final answer.
// Nested delegation is blocked; children are step-budgeted; calls are logged
// with a `delegate:N` tag so their token cost is tracked separately. ──
async function runChild(subtask: string, baseSystem: string, host: ExtensionHost, logger: SessionLogger, parentTurn: number, idx: number): Promise<string> {
  const childSystem = await assembleSystemForTask(subtask, baseSystem, host, logger, parentTurn, 0);
  const messages: Message[] = [
    { role: "system", content: childSystem },
    { role: "user", content: subtask },
  ];
  let final = "(no answer)";
  for (let step = 1; step <= DELEGATE_MAX_STEPS; step++) {
    const { messages: sendable } = trimContext(messages, CTX_CHAR_BUDGET);
    let r: LlmResult;
    try { r = await llm(sendable); }
    catch (e) { return `[delegate ${idx} LLM error: ${(e as Error).message}]`; }
    await logger.log({
      turn: parentTurn, step, model: MODEL, usage: r.usage, latencyMs: r.latencyMs,
      systemChars: messages[0].content.length, baseChars: baseSystem.length,
      messages: sendable, reply: r.content, tag: `delegate:${idx}`,
    });
    messages.push({ role: "assistant", content: r.content });
    final = r.content;
    const action = parseAction(r.content);
    if (!action || action.kind === "done") break;
    let obs: string;
    try {
      if (action.kind === "tool" && action.name === "delegate") {
        obs = "ERROR: nested delegation is not allowed.";
      } else if (action.kind === "tool") {
        let a: Record<string, unknown> = {};
        try { a = action.arg ? JSON.parse(action.arg) : {}; } catch { a = {}; }
        obs = await host.callTool(action.name, a);
      } else if (action.kind === "browse") {
        obs = await browse(action.arg);
      } else {
        obs = await shell(action.arg);
      }
    } catch (e) { obs = `ERROR: ${(e as Error).message}`; }
    messages.push({ role: "user", content: `Observation:\n${obs}` });
    await host.runTurnEnd();
  }
  return final.replace(/<done\s*\/?>/gi, "").trim() || "(no answer)";
}

async function runDelegate(args: Record<string, unknown>, baseSystem: string, host: ExtensionHost, logger: SessionLogger, parentTurn: number): Promise<string> {
  const raw = args as { task?: unknown; tasks?: unknown };
  const tasks: string[] = Array.isArray(raw.tasks)
    ? raw.tasks.map(String)
    : raw.task ? [String(raw.task)] : [];
  if (!tasks.length) return 'ERROR: delegate needs {"task":"..."} or {"tasks":["...","..."]}.';
  const t0 = performance.now();
  const results = await Promise.all(
    tasks.map((t, i) => async () => {
      await llmSemaphore.acquire();
      try { return await runChild(t, baseSystem, host, logger, parentTurn, i + 1); }
      finally { llmSemaphore.release(); }
    }).map((f) => f()),
  );
  const ms = Math.round(performance.now() - t0);
  const serial = LLM_CONCURRENCY === 1 && tasks.length > 1;
  const head = `(ran ${tasks.length} delegate${tasks.length > 1 ? (serial ? "s sequentially" : "s in parallel") : ""} in ${ms}ms${serial ? "; set LLM_CONCURRENCY>1 only if backend has slots" : ""})`;
  return [head, ...tasks.map((t, i) => `### Delegate ${i + 1}: ${t}\n${results[i]}`)].join("\n\n");
}

// Summarize the current message history into a compact Knowledge Block and splice
// it into the messages array in place. Allows the agent to proactively compact
// between subtasks rather than waiting for reactive sliding-window trim.
async function runConsolidateMemory(messages: Message[], step: number): Promise<string> {
  const historySlice = messages.slice(2, -1); // skip sys + first_user + keep current assistant
  if (historySlice.length < 4) {
    return "[consolidate_memory: nothing to compact — fewer than 4 messages in history]";
  }
  const summaryMessages: Message[] = [
    {
      role: "system",
      content: "Summarize the agent work log below into a compact Knowledge Block under 400 words. Preserve: goal, key findings, files touched, decisions made, current state, open risks, next step. Discard verbose tool outputs.",
    },
    {
      role: "user",
      content: historySlice.map((m) => `[${m.role.toUpperCase()}]\n${m.content}`).join("\n\n---\n\n"),
    },
  ];
  let summary: string;
  try {
    const r = await llm(summaryMessages);
    summary = r.content.trim();
  } catch (e) {
    return `[consolidate_memory: LLM summarization failed — ${(e as Error).message}]`;
  }
  messages.splice(2, historySlice.length, {
    role: "user",
    content: `[Knowledge Block — step ${step}, ${historySlice.length} messages compacted]\n${summary}`,
  });
  return `[consolidate_memory: compacted ${historySlice.length} messages → 1 Knowledge Block (${summary.length} chars)]`;
}

async function runTask(messages: Message[], logger: SessionLogger, turn: number, baseSystem: string, host: ExtensionHost): Promise<void> {
  const baseChars = baseSystem.length;
  try {
  for (let step = 1; step <= MAX_STEPS; step++) {
    const stepSpanId = logger.newSpanId();
    const stepT0 = performance.now();
    // Proactively elide old large observations to pointers before the trim runs.
    // Preserves the most recent observation verbatim (skipTail=1).
    if (step > 1) {
      const { messages: compacted, elided } = compactLargeObservations(messages);
      if (elided > 0) messages.splice(0, messages.length, ...compacted);
    }
    const trimT0 = performance.now();
    const beforeChars = messageChars(messages);
    const { messages: trimmed, droppedCount } = trimContext(messages, CTX_CHAR_BUDGET);
    const sendable = droppedCount > 0 ? insertCompactionNotice(trimmed, droppedCount) : trimmed;
    await logger.logSpan({
      turn,
      step,
      span: "context.trim",
      parentSpanId: stepSpanId,
      latencyMs: performance.now() - trimT0,
      metadata: {
        before_chars: beforeChars,
        after_chars: messageChars(trimmed),
        before_messages: messages.length,
        after_messages: trimmed.length,
        budget_chars: CTX_CHAR_BUDGET,
        trimmed: droppedCount > 0,
        dropped_count: droppedCount,
      },
    });
    let reply: string;
    let streamed = false;
    try {
      const r = await llmWithOptionalStream(sendable, (delta) => process.stdout.write(delta));
      streamed = r.streaming === true;
      reply = r.content;
      await logger.log({
        turn, step, model: MODEL, usage: r.usage, latencyMs: r.latencyMs,
        systemChars: messages[0].content.length, baseChars, messages: sendable, reply, tag: "main",
        streaming: r.streaming, ttftMs: r.ttftMs, reasoningChars: r.reasoningChars,
      });
      await logger.logSpan({
        turn,
        step,
        span: "llm.request",
        parentSpanId: stepSpanId,
        latencyMs: r.latencyMs,
        metadata: {
          "gen_ai.system": "openai",
          "gen_ai.request.model": MODEL,
          "gen_ai.response.model": MODEL,
          "gen_ai.usage.input_tokens": r.usage.prompt_tokens ?? 0,
          "gen_ai.usage.output_tokens": r.usage.completion_tokens ?? 0,
          streaming: r.streaming === true,
          ttft_ms: r.ttftMs,
          reasoning_chars: r.reasoningChars ?? 0,
        },
      });
    } catch (e) {
      await logger.logSpan({
        turn,
        step,
        span: "agent.step",
        spanId: stepSpanId,
        status: "error",
        latencyMs: performance.now() - stepT0,
        errorClass: errorClass(e),
        metadata: { stop_reason: "llm_error" },
      });
      console.error(`⚠ LLM error: ${(e as Error).message}`);
      return; // back to prompt; do not kill the REPL
    }
    messages.push({ role: "assistant", content: reply });
    if (streamed) console.log("");
    else console.log(reply.trim());

    const parseT0 = performance.now();
    const action = parseAction(reply);
    await logger.logSpan({
      turn,
      step,
      span: "action.parse",
      parentSpanId: stepSpanId,
      latencyMs: performance.now() - parseT0,
      metadata: {
        action_kind: action?.kind ?? "none",
        reply_chars: reply.length,
      },
    });
    if (!action || action.kind === "done") {
      if (action?.kind === "done") console.log("✓ done");
      await logger.logSpan({
        turn,
        step,
        span: "agent.step",
        spanId: stepSpanId,
        latencyMs: performance.now() - stepT0,
        metadata: { stop_reason: action?.kind === "done" ? "done" : "no_action" },
      });
      return;
    }

    const permT0 = performance.now();
    const actionRisk = classifyActionRisk(action);
    await logger.logSpan({
      turn,
      step,
      span: "permission.decide",
      parentSpanId: stepSpanId,
      latencyMs: performance.now() - permT0,
      metadata: {
        action_kind: action.kind,
        policy: actionRisk.policy,
        intent: actionRisk.intent,
        risk_class: actionRisk.riskClass,
        policy_reason: actionRisk.policyReason,
        latency_source: "measured",
      },
    });

    let obs: string;
    let toolStatus: "ok" | "error" = "ok";
    let toolErr: string | undefined;
    const toolSpanId = logger.newSpanId();
    const toolTraceEnv = logger.traceEnv(toolSpanId, stepSpanId);
    const toolT0 = performance.now();
    try {
      if (action.kind === "browse") {
        console.log(`  ↳ browse ${action.arg}`);
        obs = await browse(action.arg);
      } else if (action.kind === "tool") {
        let toolArgs: Record<string, unknown> = {};
        try { toolArgs = action.arg ? JSON.parse(action.arg) : {}; } catch { toolArgs = {}; }
        if (action.name === "delegate") {
          if (!EXPERIMENTAL) obs = "ERROR: delegate is experimental; start with AGENT_EXPERIMENTAL=1.";
          else { console.log(`  ↳ delegate ${action.arg}`); obs = await runDelegate(toolArgs, baseSystem, host, logger, turn); }
        } else if (action.name === "consolidate_memory") {
          if (!EXPERIMENTAL) obs = "ERROR: consolidate_memory is experimental; start with AGENT_EXPERIMENTAL=1.";
          else { console.log("  ↳ consolidate memory"); obs = await runConsolidateMemory(messages, step); }
        } else {
          console.log(`  ↳ tool ${action.name} ${action.arg}`);
          obs = await host.callTool(action.name, toolArgs);
        }
      } else {
        console.log(`  ↳ $ ${action.arg.replace(/\n/g, " ⏎ ")}`);
        obs = await shell(action.arg, toolTraceEnv);
      }
      if (obs.startsWith("ERROR") || obs.startsWith("[exit ") || obs.startsWith("[timed out")) toolStatus = "error";
    } catch (e) {
      toolStatus = "error";
      toolErr = errorClass(e);
      obs = `ERROR: ${(e as Error).message}`; // recoverable: the model sees it next step
    }
    await logger.logSpan({
      turn,
      step,
      span: "tool.call",
      spanId: toolSpanId,
      parentSpanId: stepSpanId,
      status: toolStatus,
      latencyMs: performance.now() - toolT0,
      errorClass: toolErr,
      metadata: {
        "tool.kind": action.kind,
        tool_name: action.kind === "tool" ? action.name : action.kind,
        arg_chars: action.kind === "tool" ? action.arg.length : action.arg.length,
        output_chars: obs.length,
        trace_context_env: true,
        traceparent: toolTraceEnv.TRACEPARENT,
      },
    });
    // Checkpoint: flush observation metadata to JSONL before mutating messages.
    // A session resumed after a crash can determine exactly which step was in flight.
    await logger.logObservation({
      turn, step,
      spanId: toolSpanId,
      tool: action.kind === "tool" ? action.name : action.kind,
      status: toolStatus,
      chars: obs.length,
      preview: obs.slice(0, 200),
    });
    console.log(obs.length > 600 ? obs.slice(0, 600) + " …" : obs);
    // Wrap external content in a neutral delimiter to resist indirect prompt injection.
    const toolKind = action.kind === "tool" ? action.name : action.kind;
    messages.push({ role: "user", content: `Observation:\n${formatObservation(obs, toolKind)}` });
    await host.runTurnEnd(); // rebuild wiki metadata so writes are recallable next step
    await logger.logSpan({
      turn,
      step,
      span: "agent.step",
      spanId: stepSpanId,
      status: toolStatus,
      latencyMs: performance.now() - stepT0,
      errorClass: toolErr,
      metadata: { stop_reason: "continue", action_kind: action.kind },
    });
  }
  console.log(`(stopped: hit ${MAX_STEPS}-step budget — refine the task or raise AGENT_MAX_STEPS)`);
  } finally {
    await host.runTurnEnd(); // e.g. llm-wiki rebuilds metadata after writes
  }
}

// Load enabled extensions once (deny-by-default via .pi/extensions.json).
async function initHost(): Promise<ExtensionHost> {
  const host = new ExtensionHost();
  await host.load();
  await host.sessionStart();

  // Native MCP bridge — deny-by-default: only active if .pi/mcp.json declares
  // servers (e.g. browser39's `browser39 mcp`). Registers ONE proxy tool plus any
  // configured direct tools. Connections are lazy, so boot stays fast.
  // Loaded lazily so a missing/broken @modelcontextprotocol/sdk degrades
  // gracefully (no MCP) instead of crashing the whole agent at startup.
  try {
    const { McpBridge } = await import("./mcp/bridge");
    const mcp: McpBridge = new McpBridge();
    mcp.load();
    if (mcp.serverCount > 0) {
      const tools = mcp.proxyEnabled ? [mcp.proxyTool()] : [];
      tools.push(...(await mcp.directTools()));
      host.registerNative("mcp-bridge", tools);
      console.error(`[mcp] ${mcp.summary()}`);
      // `exit` handlers are synchronous and can't await, so stdio MCP children
      // could be orphaned. Use signal handlers that await shutdown, then exit.
      const shutdown = async (code: number) => {
        try { await mcp.shutdownAll(); } catch { /* best-effort child cleanup */ }
        process.exit(code);
      };
      process.once("SIGINT", () => { void shutdown(130); });
      process.once("SIGTERM", () => { void shutdown(143); });
    }
  } catch (e) {
    console.error("[mcp] bridge unavailable: " + (e as Error).message);
  }
  return host;
}

async function agentLoop() {
  const host = await initHost();
  const baseSystem = await generatePrompt(host);
  const messages: Message[] = [{ role: "system", content: baseSystem }];
  const logger = new SessionLogger(host.names());
  await logger.logSessionStart(baseSystem, host.toolSpecs());
  let turn = 0;

  const reader = (await import("readline")).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const prompt = (q: string): Promise<string> =>
    new Promise((res) => reader.question(q, res));

  const active = await activeCapabilities();
  console.log(`Connecting to LLM at: ${LLM_URL}`);
  console.log(`Model: ${MODEL}  | max steps/turn: ${MAX_STEPS}  | shell timeout: ${SHELL_TIMEOUT_MS}ms`);
  console.log(`Capabilities (${active.length}): ${active.map((c) => c.name).join(", ")}`);
  console.log(`Extensions: ${host.summary()}`);
  console.log("pi-agent-smol ready. Type a task, /logs for token stats, or 'exit'.");

  while (true) {
    const input = await prompt("> ");
    const trimmed = input.trim();
    if (trimmed === "exit") break;
    if (!trimmed) continue;
    if (trimmed === "/logs") {
      console.log(logger.sessionSummary());
      console.log(await SessionLogger.allTimeSummary());
      continue;
    }
    // Per-prompt memory injection (memctx Memory Gateway, hermes-memory, etc.).
    const currentTurn = turn + 1;
    messages[0] = { role: "system", content: await assembleSystemForTask(input, baseSystem, host, logger, currentTurn, 0) };
    messages.push({ role: "user", content: input });
    try {
      await runTask(messages, logger, ++turn, baseSystem, host); // never throws
    } catch (e) {
      console.error(`⚠ unexpected: ${(e as Error).message}`);
    }
  }
  reader.close();
}

// One-shot/batch mode (set AGENT_TASK or pass the task as argv) — runs a single
// task to completion and exits. Used for scripted/non-interactive testing.
async function runOneShot(task: string) {
  const host = await initHost();
  const baseSystem = await generatePrompt(host);
  const logger = new SessionLogger(host.names());
  if (task.trim() === "/logs") {
    console.log(await SessionLogger.allTimeSummary());
    return;
  }
  const system = await assembleSystemForTask(task, baseSystem, host, logger, 1, 0);
  await logger.logSessionStart(system, host.toolSpecs());
  if (process.env.DUMP_SYSTEM_PROMPT === "1") {
    console.log(system);
    return;
  }
  const messages: Message[] = [{ role: "system", content: system }];
  const active = await activeCapabilities();
  console.log(`Model: ${MODEL}  | capabilities: ${active.map((c) => c.name).join(", ")}`);
  console.log(`Extensions: ${host.summary()}`);
  console.log(`[task] ${task}\n`);
  messages.push({ role: "user", content: task });
  await runTask(messages, logger, 1, baseSystem, host);
  console.log("\n" + logger.sessionSummary());
}

const oneShot = (process.env.AGENT_TASK ?? process.argv.slice(2).join(" ")).trim();
(oneShot ? runOneShot(oneShot) : agentLoop()).catch(console.error);
