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
import type { McpBridge } from "./mcp/bridge"; // type-only: erased at compile time, no SDK at runtime
import { SessionLogger } from "./logger";
import { llmWithOptionalStream, browse, shell, errorClass, MODEL, LLM_URL, type LlmResult } from "./llm";
import { assembleSystemForTask, runDelegate, runConsolidateMemory } from "./delegate";

const APPEND_PATH = process.env.APPEND_SYSTEM_PATH ?? "/app/.pi/APPEND_SYSTEM.md";
// AGENT_RULES.md is injected into baseSystem (never the sliding-window history)
// so its content is pinned across all context compaction. Put load-bearing rules here.
const AGENT_RULES_PATH = process.env.AGENT_RULES_PATH ?? `${process.cwd()}/.pi/AGENT_RULES.md`;
const PROGRESS_PATH = process.env.PROGRESS_PATH ?? `${process.cwd()}/.pi/progress.md`;

const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 12);
const CTX_CHAR_BUDGET = Number(process.env.CTX_CHAR_BUDGET ?? 16_000);
// MODEL_CTX_TOKENS should match --ctx-size passed to llama-server (default now 8192).
// Warn if the prompt budget leaves less than 15% headroom for completion tokens.
// TODO(context-memory): split budgets into RESERVED_COMPLETION_TOKENS + MAX_PROMPT_CHARS and derive CTX_CHAR_BUDGET = (MODEL_CTX_TOKENS - reserve)*~4 with 20-30% headroom — the completion reserve (LLM_MAX_TOKENS in llm.ts) is never subtracted today. (plan Root issue #2 / Task 7)
const MODEL_CTX_TOKENS = Number(process.env.MODEL_CTX_TOKENS ?? 8192);
// TODO(observability): this guard compares a startup CONSTANT to MODEL_CTX_TOKENS*4 and ignores the completion reserve; add a request-time check of the ASSEMBLED prompt size vs (MODEL_CTX_TOKENS - reserve) so real overflow is actually caught. (plan Root issue #2)
if (CTX_CHAR_BUDGET / (MODEL_CTX_TOKENS * 4) > 0.85) {
  console.warn(`⚠ CTX_CHAR_BUDGET (${CTX_CHAR_BUDGET}) is >85% of MODEL_CTX_TOKENS*4 (${MODEL_CTX_TOKENS * 4}) — raise MODEL_CTX_TOKENS or lower CTX_CHAR_BUDGET`);
}
const EXPERIMENTAL = process.env.AGENT_EXPERIMENTAL === "1";

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
  // TODO(portability): gate the git-first guidance below on `git` being on PATH (add a git capability using the capabilities.ts isAvailable/`which` pattern) so prompt and runtime stay in sync — git can be absent on a minimal/iPhone guest. (README near-term #2 native primitives; north-star hyperportable)
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
    // TODO(ux): add an altitude/escalation rule — answer general knowledge directly, else memory/wiki, else fetch/browse a page (web search once it exists), and reach for interactive browser39 (mcp) ONLY for click/fill/submit. Today this headlines interactive browsing with no cheaper-first ordering. (README near-term #1 boring happy path)
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
  const memTool = toolSpecs.find((s) => s.name !== "mcp");
  if (memTool) {
    // Use a REAL registered tool name — never advertise a tool the dispatcher
    // lacks (the `mcp` proxy alone must not conjure a memctx_search example).
    lines.push("- Call a memory/knowledge tool (arguments as JSON):");
    lines.push(`  <tool name="${memTool.name}">{"query":"how is auth handled"}</tool>`);
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
  // TODO(reliability): Current Time is frozen at startup inside baseSystem (the cached KV prefix) so it goes stale across a long session; move volatile time to a per-turn tail user message (out of the prefix) to stay accurate without churning the ~93% prefix hit. (README latency + reliability)
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
  // TODO(ux): grow .pi/AGENT_RULES.md (pinned here, survives compaction) with one concrete recovery recipe per common failure — command-not-found → check the capability list; [exit N] → read stderr then retry or explain; never emit <done/> on an unresolved error — to steer the small model toward recovery. (README near-term #5 actionable tool errors)
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

// One user task → autonomous multi-step loop. Returns to the REPL on completion,
// LLM failure, or step-budget exhaustion. Tool errors are fed back as
// observations (the model can recover) and never crash the process.
async function runTask(messages: Message[], logger: SessionLogger, turn: number, baseSystem: string, host: ExtensionHost): Promise<void> {
  const baseChars = baseSystem.length;
  try {
  for (let step = 1; step <= MAX_STEPS; step++) {
    const stepSpanId = logger.newSpanId();
    const stepT0 = performance.now();
    // TODO(observability): this proactive elision pass runs every step with NO span — add a context.compact span (latency, elided count, chars saved) mirroring context.trim so the cost is attributable before optimizing it. (README local span observability / measure before optimizing)
    // Proactively elide old large observations to pointers before the trim runs.
    if (step > 1) {
      const { messages: compacted, elided } = compactLargeObservations(messages);
      if (elided > 0) messages.splice(0, messages.length, ...compacted);
    }
    const trimT0 = performance.now();
    // TODO(performance): messageChars is an O(n) full-history scan run multiple times per step (here + after-trim + inside trimContext); keep a running char total incrementally so per-step cost stops growing ~O(n^2) as history grows (4-step ~2203ms is context-growth bound). (README latency axis)
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
      return;
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
      metadata: { action_kind: action?.kind ?? "none", reply_chars: reply.length },
    });
    if (!action || action.kind === "done") {
      if (action?.kind === "done") console.log("✓ done");
      await logger.logSpan({
        turn,
        step,
        span: "agent.step",
        spanId: stepSpanId,
        latencyMs: performance.now() - stepT0,
        // TODO(ux): the no_action branch returns with no terminal marker (asymmetric with the "✓ done" print above) — print an explicit line like "(stopped: no action parsed — treating reply as final answer)" so the user knows the turn ended. (README near-term #1 boring happy path)
        metadata: { stop_reason: action?.kind === "done" ? "done" : "no_action" },
      });
      return;
    }

    const permT0 = performance.now();
    const actionRisk = classifyActionRisk(action);
    // TODO(permission): risk is classified but every action is auto_allow; for high-risk classes (secret_access/filesystem_delete/network_write) add a sparse risk-triggered interactive checkpoint (approve/deny/modify) and feed the decision record back as an observation + trace data. (plan Task 8 "later"; README near-term #8 permission checkpoints as alignment data)
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
      obs = `ERROR: ${(e as Error).message}`;
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
        arg_chars: action.arg.length,
        output_chars: obs.length,
        trace_context_env: true,
        traceparent: toolTraceEnv.TRACEPARENT,
      },
    });
    // Checkpoint observation metadata before mutating messages (crash recovery).
    await logger.logObservation({
      turn, step,
      spanId: toolSpanId,
      tool: action.kind === "tool" ? action.name : action.kind,
      status: toolStatus,
      chars: obs.length,
      preview: obs.slice(0, 200),
    });
    console.log(obs.length > 600 ? obs.slice(0, 600) + " …" : obs);
    const toolKind = action.kind === "tool" ? action.name : action.kind;
    messages.push({ role: "user", content: `Observation:\n${formatObservation(obs, toolKind)}` });
    await host.runTurnEnd();
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
    await host.runTurnEnd();
  }
}

// TODO(observability): emit separate startup spans (Bun/module load, host.load extension import, mcp.load manifest, first llm.request) so boot cost is attributable — initHost/agentLoop currently log no startup spans, and the logger is even constructed after initHost(). (plan Task 5 / Root issue #5)
async function initHost(): Promise<ExtensionHost> {
  const host = new ExtensionHost();
  await host.load();
  await host.sessionStart();

  try {
    const { McpBridge } = await import("./mcp/bridge");
    const mcp: McpBridge = new McpBridge();
    mcp.load();
    if (mcp.serverCount > 0) {
      const tools = mcp.proxyEnabled ? [mcp.proxyTool()] : [];
      tools.push(...(await mcp.directTools()));
      host.registerNative("mcp-bridge", tools);
      console.error(`[mcp] ${mcp.summary()}`);
      const shutdown = async (code: number) => {
        try { await mcp.shutdownAll(); } catch {}
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
  const diag = host.diagnostics();
  console.log(`Connecting to LLM at: ${LLM_URL}`);
  // TODO(ux): probe LLM_BASE/v1/models at startup and print reachable + served-model id here, instead of letting the first task fail with "⚠ LLM error" after the user already typed it. (README near-term #1 make the happy path boring; reliability)
  console.log(`Model: ${MODEL}  |  max steps/turn: ${MAX_STEPS}  |  ctx budget: ${CTX_CHAR_BUDGET} chars`);
  // TODO(context-memory): also surface base system-prompt size vs CTX_CHAR_BUDGET here (e.g. "system ~Nk / budget Mk") so the user sees at a glance how much working room a task has — baseSystem.length is in scope. (README near-term #4 richer context WITH measurement)
  console.log(`Capabilities (${active.length}): ${active.map((c) => c.name).join(", ")}`);
  console.log(`Extensions: ${host.summary()}`);
  // TODO(observability): when diag.failed is non-empty, add a remediation hint (likely missing peer dep / unmounted volume → how to fix) AND surface the degraded state into the system prompt so the model knows a memory/wiki tool is unavailable — today it is a quiet one-liner the model never sees. (README near-term #7 observability + #1 ease of use)
  console.log(`Extension config: ${diag.configPath}${diag.failed.length ? `  ⚠ failed: ${diag.failed.join(", ")}` : ""}`);
  console.log("pi-agent-smol ready. Type a task, /logs for token stats, or 'exit'.");
  // TODO(ux): add a /help (and /caps or /tools) REPL command listing capabilities + registered tools + failed extensions in-session — today only /logs and 'exit' are handled, so users cannot discover what the agent can do without restarting. Data is already in activeCapabilities()/host.summary()/host.diagnostics(). (README near-term #1 ease of use)

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
    const currentTurn = turn + 1;
    messages[0] = { role: "system", content: await assembleSystemForTask(input, baseSystem, host, logger, currentTurn, 0) };
    messages.push({ role: "user", content: input });
    try {
      await runTask(messages, logger, ++turn, baseSystem, host);
    } catch (e) {
      console.error(`⚠ unexpected: ${(e as Error).message}`);
    }
  }
  reader.close();
}

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
  // TODO(ux): one-shot banner omits LLM_URL, max-steps, ctx budget and the host.diagnostics() failed-extension line the REPL prints — give one-shot (the scripted/eval path) the same at-a-glance health line so non-interactive failures are diagnosable. (README near-term #1 ease of use; observability)
  console.log(`Model: ${MODEL}  | capabilities: ${active.map((c) => c.name).join(", ")}`);
  console.log(`Extensions: ${host.summary()}`);
  console.log(`[task] ${task}\n`);
  messages.push({ role: "user", content: task });
  await runTask(messages, logger, 1, baseSystem, host);
  console.log("\n" + logger.sessionSummary());
}

const oneShot = (process.env.AGENT_TASK ?? process.argv.slice(2).join(" ")).trim();
(oneShot ? runOneShot(oneShot) : agentLoop()).catch(console.error);
