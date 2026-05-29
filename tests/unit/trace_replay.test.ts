import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAction } from "../../agent/action";
import { classifyActionRisk } from "../../agent/policy";
import { trimContext, type Message } from "../../agent/context";

// ── Trace record types (mirror logger.ts shapes) ─────────────────────────────

type SpanRec = {
  type: "span";
  trace_id: string;
  turn: number;
  step: number;
  span: string;
  status: "ok" | "error" | "skipped";
  latency_ms: number;
  metadata: Record<string, unknown>;
};

type LlmRec = {
  type: "llm";
  trace_id: string;
  turn: number;
  step: number;
  model: string;
  streaming?: boolean;
  ttft_ms?: number;
  reasoning_chars?: number;
  reply?: string;
};

type AnyRec = SpanRec | LlmRec | { type: string; [k: string]: unknown };

// ── Helpers ──────────────────────────────────────────────────────────────────

const FIXTURES = join(import.meta.dir, "../fixtures/traces");

function loadTrace(name: string): AnyRec[] {
  return readFileSync(join(FIXTURES, name), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AnyRec);
}

function spansNamed(recs: AnyRec[], spanName: string): SpanRec[] {
  return recs.filter((r): r is SpanRec => r.type === "span" && r.span === spanName);
}

function llms(recs: AnyRec[]): LlmRec[] {
  return recs.filter((r): r is LlmRec => r.type === "llm");
}

// ── Invariant tests ───────────────────────────────────────────────────────────

describe("trace replay invariants", () => {
  test("no tool.call at the same step as a done action.parse", () => {
    const recs = loadTrace("successful_shell_task.jsonl");
    const doneKeys = new Set(
      spansNamed(recs, "action.parse")
        .filter((s) => s.metadata.action_kind === "done")
        .map((s) => `${s.turn}:${s.step}`),
    );
    for (const s of spansNamed(recs, "tool.call")) {
      expect(doneKeys.has(`${s.turn}:${s.step}`)).toBe(false);
    }
  });

  test("permission.decide spans carry intent taxonomy on all fixtures", () => {
    const fixtures = ["successful_shell_task.jsonl", "tool_error_recovery.jsonl", "streaming_fallback.jsonl"];
    for (const fixture of fixtures) {
      const recs = loadTrace(fixture);
      for (const s of spansNamed(recs, "permission.decide")) {
        expect(typeof s.metadata.intent).toBe("string");
        expect(typeof s.metadata.risk_class).toBe("string");
        expect(typeof s.metadata.policy_reason).toBe("string");
        expect(s.metadata.latency_source).toBe("measured");
      }
    }
  });

  test("parseAction(recorded_reply) matches action.parse span metadata", () => {
    const recs = loadTrace("successful_shell_task.jsonl");
    const parseSpans = spansNamed(recs, "action.parse");
    for (const llm of llms(recs)) {
      if (!llm.reply) continue;
      const span = parseSpans.find((s) => s.turn === llm.turn && s.step === llm.step);
      if (!span) continue;
      const action = parseAction(llm.reply);
      expect(span.metadata.action_kind).toBe(action?.kind ?? "none");
    }
  });

  test("classifyActionRisk on recorded reply matches permission.decide intent", () => {
    const recs = loadTrace("successful_shell_task.jsonl");
    const permSpans = spansNamed(recs, "permission.decide");
    for (const llm of llms(recs)) {
      if (!llm.reply) continue;
      const perm = permSpans.find((s) => s.turn === llm.turn && s.step === llm.step);
      if (!perm) continue;
      const action = parseAction(llm.reply);
      if (!action || action.kind === "done") continue;
      const risk = classifyActionRisk(action);
      expect(perm.metadata.intent).toBe(risk.intent);
      expect(perm.metadata.risk_class).toBe(risk.riskClass);
    }
  });

  test("tool error in step N means loop continues: LLM record exists at step N+1", () => {
    const recs = loadTrace("tool_error_recovery.jsonl");
    const errorCalls = spansNamed(recs, "tool.call").filter((s) => s.status === "error");
    expect(errorCalls.length).toBeGreaterThan(0);
    for (const err of errorCalls) {
      const nextLlm = llms(recs).find((r) => r.turn === err.turn && r.step === err.step + 1);
      expect(nextLlm).toBeDefined();
    }
  });

  test("streaming=false path produces the same span structure as streaming=true", () => {
    const recs = loadTrace("streaming_fallback.jsonl");
    expect(llms(recs).every((r) => r.streaming === false)).toBe(true);
    expect(spansNamed(recs, "action.parse").length).toBeGreaterThan(0);
    expect(spansNamed(recs, "permission.decide").length).toBeGreaterThan(0);
    expect(spansNamed(recs, "tool.call").length).toBeGreaterThan(0);
  });

  test("context.trim span reports trimmed=false when no observations dropped", () => {
    for (const fixture of ["successful_shell_task.jsonl", "tool_error_recovery.jsonl"]) {
      const recs = loadTrace(fixture);
      for (const s of spansNamed(recs, "context.trim")) {
        expect(s.metadata.trimmed).toBe(false);
        expect(s.metadata.dropped_count).toBe(0);
      }
    }
  });

  test("trim anchor invariant: system and first user always survive compaction", () => {
    // Test the real trimContext function against a tight budget.
    const sys = "system ".repeat(300);
    const task = "user task";
    const msgs: Message[] = [
      { role: "system", content: sys },
      { role: "user", content: task },
      { role: "assistant", content: "step1 ".repeat(200) },
      { role: "user", content: "obs1 ".repeat(200) },
      { role: "assistant", content: "step2 ".repeat(200) },
    ];
    const budget = sys.length + task.length + 5;
    const { messages: trimmed, droppedCount } = trimContext(msgs, budget);
    expect(trimmed[0].role).toBe("system");
    expect(trimmed[0].content).toBe(sys);
    expect(trimmed[1].role).toBe("user");
    expect(trimmed[1].content).toBe(task);
    expect(droppedCount).toBeGreaterThan(0);
  });

  test("session_start record carries system_prompt and tool_specs", () => {
    for (const fixture of ["successful_shell_task.jsonl", "tool_error_recovery.jsonl", "streaming_fallback.jsonl"]) {
      const recs = loadTrace(fixture);
      const starts = recs.filter((r) => r.type === "session_start") as Array<Record<string, unknown>>;
      expect(starts.length).toBe(1);
      expect(typeof starts[0].system_prompt).toBe("string");
      expect(Array.isArray(starts[0].tool_specs)).toBe(true);
    }
  });
});
