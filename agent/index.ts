import {
  activeCapabilities,
  GROUP_ORDER,
  GROUP_TITLES,
  type Capability,
} from "./capabilities";
import { ExtensionHost } from "./extensions/host";
import type { McpBridge } from "./mcp/bridge"; // type-only: erased at compile time, no SDK at runtime
import { SessionLogger, type Usage } from "./logger";

const LLM_BASE = process.env.LLM_URL ?? "http://127.0.0.1:8080";
const LLM_URL = LLM_BASE.replace(/\/+$/, "") + "/v1/chat/completions";
const MODEL = process.env.LLM_MODEL ?? "gemma-4";
const BROWSER_BIN = process.env.BROWSER_BIN ?? "browser39"; // Rust single binary, no Chromium
const APPEND_PATH = process.env.APPEND_SYSTEM_PATH ?? "/app/.pi/APPEND_SYSTEM.md";
const PROGRESS_PATH = process.env.PROGRESS_PATH ?? `${process.cwd()}/.pi/progress.md`;

// Loop controls (env-overridable).
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 12); // stop predicate (rubric #2)
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 1024);
const SHELL_TIMEOUT_MS = Number(process.env.SHELL_TIMEOUT_MS ?? 60_000); // fixes the no-timeout hang
const CTX_CHAR_BUDGET = Number(process.env.CTX_CHAR_BUDGET ?? 16_000); // sliding-window trim (rubric #3)
const OUT_CAP = Number(process.env.TOOL_OUTPUT_CAP ?? 4_000);
const EXPERIMENTAL = process.env.AGENT_EXPERIMENTAL === "1"; // gates native delegate (deny-by-default)
const DELEGATE_MAX_STEPS = Number(process.env.DELEGATE_MAX_STEPS ?? 5);

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

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
    }
    lines.push("");
  }

  lines.push("## Acting — one action per step");
  lines.push("Emit EXACTLY ONE action per reply, then stop and wait for its `Observation:`. Do not invent observations.");
  lines.push("- Shell (RUNS the command; may span multiple lines):");
  lines.push("  <sh>grep -rn TODO src/</sh>");
  lines.push("- Fetch a URL as Markdown:");
  lines.push("  <browse>https://example.com</browse>");
  if (toolSpecs.length || EXPERIMENTAL) {
    lines.push("- Call a memory/knowledge tool (arguments as JSON):");
    lines.push('  <tool name="memctx_search">{"query":"how is auth handled"}</tool>');
  }
  if (EXPERIMENTAL) {
    lines.push("- Fan out independent work in parallel, then compose the results:");
    lines.push('  <tool name="delegate">{"tasks":["research X","research Y"]}</tool>');
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

interface LlmResult { content: string; usage: Usage; latencyMs: number; }

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

async function shell(cmd: string): Promise<string> {
  const proc = Bun.spawn(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
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

type Action =
  | { kind: "sh" | "browse"; arg: string }
  | { kind: "tool"; name: string; arg: string }
  | { kind: "done" }
  | null;

// Robust parse: tag form (multiline, tolerant of inner `]`) preferred; legacy
// [sh:]/[browse:] kept as a fallback. Earliest action wins (one per step), so a
// reply with both a shell and a browse no longer silently drops the first.
function parseAction(reply: string): Action {
  // `<done/>` is TERMINAL. The model signals completion with it, and its final
  // answer often contains example commands in <sh> tags for documentation — we
  // must NOT execute those. Done wins over any trailing action.
  if (/<done\s*\/?>|\[done\]/i.test(reply)) return { kind: "done" };

  const cands: { idx: number; kind: "sh" | "browse" | "tool"; arg: string; name?: string }[] = [];
  const first = (re: RegExp, kind: "sh" | "browse") => {
    const m = re.exec(reply);
    if (m && m[1].trim()) cands.push({ idx: m.index, kind, arg: m[1].trim() });
  };

  // Accept both <tool name="X">{json}</tool> and self-closing <tool name="X"/>.
  const mTool = /<tool\s+name="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/tool>)/i.exec(reply);
  if (mTool) cands.push({ idx: mTool.index, kind: "tool", name: mTool[1], arg: (mTool[2] ?? "").trim() });
  first(/<sh>([\s\S]*?)<\/sh>/i, "sh");
  first(/<browse>([\s\S]*?)<\/browse>/i, "browse");
  if (!cands.length) {
    // legacy fallback
    first(/\[browse:\s*([^\]\n]+)\]/i, "browse");
    first(/\[sh:([\s\S]+)\]/i, "sh"); // greedy to last ] — tolerates inner ]
  }

  if (cands.length) {
    cands.sort((a, b) => a.idx - b.idx);
    const e = cands[0]; // earliest action wins (one per step)
    return e.kind === "tool"
      ? { kind: "tool", name: e.name!, arg: e.arg }
      : { kind: e.kind, arg: e.arg };
  }
  return null; // no action and no done → treat the reply as a final answer
}

// Sliding-window trim so a long multi-step run doesn't overflow the context
// window. Always keeps the system prompt and the original task (rubric #3:
// re-inject load-bearing instructions); drops oldest observations first.
function trimContext(messages: Message[]): Message[] {
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total <= CTX_CHAR_BUDGET) return messages;

  const system = messages[0];
  const firstUserIdx = messages.findIndex((m, i) => i > 0 && m.role === "user");
  const firstUser = firstUserIdx >= 0 ? messages[firstUserIdx] : null;

  let used = system.content.length + (firstUser?.content.length ?? 0);
  const tail: Message[] = [];
  for (let i = messages.length - 1; i >= 1; i--) {
    if (i === firstUserIdx) continue;
    const m = messages[i];
    if (used + m.content.length > CTX_CHAR_BUDGET) break;
    used += m.content.length;
    tail.unshift(m);
  }
  const head: Message[] = [system];
  if (firstUser) head.push(firstUser);
  return head.concat(tail);
}

// One user task → autonomous multi-step loop. Returns to the REPL on completion,
// LLM failure, or step-budget exhaustion. Tool errors are fed back as
// observations (the model can recover) and never crash the process.
// ── Native delegate (experimental). Run a sub-task in a FRESH, isolated context
// (subagent isolation, rubric #9) and return only its distilled final answer.
// Nested delegation is blocked; children are step-budgeted; calls are logged
// with a `delegate:N` tag so their token cost is tracked separately. ──
async function runChild(subtask: string, baseSystem: string, host: ExtensionHost, logger: SessionLogger, parentTurn: number, idx: number): Promise<string> {
  const childSystem = await host.beforeAgentStart(subtask, baseSystem);
  const messages: Message[] = [
    { role: "system", content: childSystem },
    { role: "user", content: subtask },
  ];
  let final = "(no answer)";
  for (let step = 1; step <= DELEGATE_MAX_STEPS; step++) {
    const sendable = trimContext(messages);
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
    tasks.map((t, i) => runChild(t, baseSystem, host, logger, parentTurn, i + 1)),
  );
  const ms = Math.round(performance.now() - t0);
  const head = `(ran ${tasks.length} delegate${tasks.length > 1 ? "s in parallel" : ""} in ${ms}ms)`;
  return [head, ...tasks.map((t, i) => `### Delegate ${i + 1}: ${t}\n${results[i]}`)].join("\n\n");
}

async function runTask(messages: Message[], logger: SessionLogger, turn: number, baseSystem: string, host: ExtensionHost): Promise<void> {
  const baseChars = baseSystem.length;
  try {
  for (let step = 1; step <= MAX_STEPS; step++) {
    const sendable = trimContext(messages);
    let reply: string;
    try {
      const r = await llm(sendable);
      reply = r.content;
      await logger.log({
        turn, step, model: MODEL, usage: r.usage, latencyMs: r.latencyMs,
        systemChars: messages[0].content.length, baseChars, messages: sendable, reply, tag: "main",
      });
    } catch (e) {
      console.error(`⚠ LLM error: ${(e as Error).message}`);
      return; // back to prompt; do not kill the REPL
    }
    messages.push({ role: "assistant", content: reply });
    console.log(reply.trim());

    const action = parseAction(reply);
    if (!action || action.kind === "done") {
      if (action?.kind === "done") console.log("✓ done");
      return;
    }

    let obs: string;
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
        } else {
          console.log(`  ↳ tool ${action.name} ${action.arg}`);
          obs = await host.callTool(action.name, toolArgs);
        }
      } else {
        console.log(`  ↳ $ ${action.arg.replace(/\n/g, " ⏎ ")}`);
        obs = await shell(action.arg);
      }
    } catch (e) {
      obs = `ERROR: ${(e as Error).message}`; // recoverable: the model sees it next step
    }
    console.log(obs.length > 600 ? obs.slice(0, 600) + " …" : obs);
    messages.push({ role: "user", content: `Observation:\n${obs}` });
    await host.runTurnEnd(); // rebuild wiki metadata so writes are recallable next step
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
    messages[0] = { role: "system", content: await host.beforeAgentStart(input, baseSystem) };
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
  const system = await host.beforeAgentStart(task, baseSystem);
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
