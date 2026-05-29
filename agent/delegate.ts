import { llm, browse, shell, errorClass, MODEL } from "./llm";
import { trimContext, type Message } from "./context";
import { parseAction } from "./action";
import { ExtensionHost } from "./extensions/host";
import { SessionLogger } from "./logger";

const DELEGATE_MAX_STEPS = Number(process.env.DELEGATE_MAX_STEPS ?? 5);
const CTX_CHAR_BUDGET = Number(process.env.CTX_CHAR_BUDGET ?? 16_000);
const LLM_CONCURRENCY = Number(process.env.LLM_CONCURRENCY ?? 1);

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

// Inject per-task memory from enabled extensions and log the assembly span.
// Also emits extension config diagnostics (resolved path, loaded/failed names)
// into the prompt.assemble span for Task 6 observability.
export async function assembleSystemForTask(
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
  const diag = host.diagnostics();
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
      config_path: diag.configPath,
      loaded_extensions: diag.loaded,
      failed_extensions: diag.failed,
    },
  });
  return system;
}

export async function runChild(
  subtask: string,
  baseSystem: string,
  host: ExtensionHost,
  logger: SessionLogger,
  parentTurn: number,
  idx: number,
): Promise<string> {
  const childSystem = await assembleSystemForTask(subtask, baseSystem, host, logger, parentTurn, 0);
  const messages: Message[] = [
    { role: "system", content: childSystem },
    { role: "user", content: subtask },
  ];
  let final = "(no answer)";
  for (let step = 1; step <= DELEGATE_MAX_STEPS; step++) {
    const { messages: sendable } = trimContext(messages, CTX_CHAR_BUDGET);
    let r;
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
    } catch (e) { obs = `ERROR: ${errorClass(e)} — ${(e as Error).message}`; }
    messages.push({ role: "user", content: `Observation:\n${obs}` });
    await host.runTurnEnd();
  }
  return final.replace(/<done\s*\/?>/gi, "").trim() || "(no answer)";
}

export async function runDelegate(
  args: Record<string, unknown>,
  baseSystem: string,
  host: ExtensionHost,
  logger: SessionLogger,
  parentTurn: number,
): Promise<string> {
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

// Proactive autonomous compaction: summarize history into a Knowledge Block
// and splice it in place. Agent calls this between major subtasks when it
// senses context growing long, rather than waiting for reactive trim.
export async function runConsolidateMemory(messages: Message[], step: number): Promise<string> {
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
