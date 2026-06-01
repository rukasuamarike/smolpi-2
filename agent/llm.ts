import { parseSseBuffer } from "./sse";
import type { Message } from "./context";
import type { Usage } from "./logger";

const LLM_BASE = process.env.LLM_URL ?? "http://127.0.0.1:8080";
export const LLM_URL = LLM_BASE.replace(/\/+$/, "") + "/v1/chat/completions";
export const MODEL = process.env.LLM_MODEL ?? "gemma-4";
const BROWSER_BIN = process.env.BROWSER_BIN ?? "browser39";
const SHELL_TIMEOUT_MS = Number(process.env.SHELL_TIMEOUT_MS ?? 60_000);
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 1024);
export const OUT_CAP = Number(process.env.TOOL_OUTPUT_CAP ?? 4_000);
const LLM_STREAM = process.env.LLM_STREAM !== "0";

export interface LlmResult {
  content: string;
  usage: Usage;
  latencyMs: number;
  streaming?: boolean;
  ttftMs?: number;
  reasoningChars?: number;
}

export async function llm(messages: Message[]): Promise<LlmResult> {
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

export async function llmStream(messages: Message[], onDelta?: (delta: string) => void): Promise<LlmResult> {
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
        // Thinking-model reasoning tracked for observability, not appended to action
        // content — executing hidden-chain tool calls would be a footgun.
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

export async function llmWithOptionalStream(messages: Message[], onDelta?: (delta: string) => void): Promise<LlmResult> {
  if (!LLM_STREAM) return { ...(await llm(messages)), streaming: false };
  try {
    return await llmStream(messages, onDelta);
  } catch (e) {
    console.error(`⚠ streaming failed; falling back to non-streaming: ${(e as Error).message}`);
    return { ...(await llm(messages)), streaming: false };
  }
}

// TODO(tool-design): add search(query) mirroring browse() via `browser39 search` (+ a WEB/SEARCH capability and a <search> action) — knowledge questions like "creator of linux" currently have no path short of interactively driving browser39 via the mcp proxy. (README near-term #5 tool use that feels real; #2 native primitives)
export async function browse(url: string): Promise<string> {
  // browser39 `fetch` runs JS (V8), follows the page, and emits token-efficient
  // Markdown directly — no Chromium, no separate readability pass.
  const proc = Bun.spawn([BROWSER_BIN, "fetch", url], { stdout: "pipe", stderr: "pipe" });
  // TODO(performance): browse buffers the ENTIRE browser39 stdout before truncating to OUT_CAP — bound the read to ~OUT_CAP so large pages don't spike memory/latency in the smol guest. (README "infrastructure headroom before protocol cleverness")
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

export async function shell(cmd: string, traceEnv: Record<string, string> = {}): Promise<string> {
  // TODO(tool-design): non-interactive `bash -c` does not source ~/.bashrc.smol, so guest PATH additions, the zoxide `z` function, and aliases (cat→bat, find→fd) are inactive — either source ~/.bashrc.smol here or document that <sh> sees only the base PATH so advertised tools match runtime. (README near-term #5 tool use that feels real)
  const proc = Bun.spawn(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...traceEnv } });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch {}
  }, SHELL_TIMEOUT_MS);

  // TODO(performance): shell reads the FULL stdout/stderr into memory before slicing to OUT_CAP — a runaway command can buffer unbounded RAM; cap the read stream at OUT_CAP+margin and stop reading early. (README "infrastructure headroom before protocol cleverness")
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);

  let out = stdout.trim();
  if (stderr.trim()) out += `\n[stderr]\n${stderr.trim()}`;
  if (timedOut) out = `[timed out after ${SHELL_TIMEOUT_MS}ms]\n${out}`;
  // TODO(ux): on non-zero exit, append a terse prescriptive hint (e.g. "— fix the command or explain the failure; do NOT emit <done/> yet") so the small model stops terminating silently on errors. (README "Known model behaviours": bare <done/> on [exit 1]; near-term #5 actionable errors)
  else if (code !== 0) out = `[exit ${code}]\n${out}`;
  // TODO(context-memory): OUT_CAP truncation slices mid-line/mid-UTF8 and discards the tail entirely — use a line-aware head+tail (first N + last M lines on a code-point boundary) so the model still sees the END of long output. (README near-term #4 richer context windows)
  if (out.length > OUT_CAP) out = out.slice(0, OUT_CAP) + "\n…[truncated]";
  return out.trim() || "(no output)";
}

export function errorClass(e: unknown): string {
  return (e as Error)?.name || "Error";
}
