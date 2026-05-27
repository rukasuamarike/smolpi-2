# smolpi — Pi-Agent Weakness Audit

Scored against [`HARNESS_RUBRIC.md`](~/study/notes/HARNESS_RUBRIC.md) (the 10-dimension ladder distilled
from `~/study/notes`). Focus axes you named: **latency**, **complex coding/debug**, **high-level research
organization**. Evidence cites the actual source (`agent/index.ts`, `agent/capabilities.ts`,
`browser39` (the in-guest Rust browser binary, formerly `browser/browser_skill.go`), `scripts/run-brain.sh`, `Smolfile`).

> Framing: *the model is the engine; the harness is the car.* smolpi is a deliberately minimal car
> (~167-line `index.ts`). The point of this audit is not "it's small" — it's to locate the specific
> structural gaps that cap a fixed Gemma-4-E4B on real work, ranked by leverage.

## Scorecard

| # | Dimension | Level | Signal | Top gap |
|---|-----------|:-----:|--------|---------|
| 1 | Latency | **L1** | no caching directives; serial; no TTFT stream | volatile `Current Time` in system prompt; no streaming |
| 2 | Quality / correctness | **L0** | no stop predicate, no verification | single tool-call per turn; `[done]` never checked; crash-on-error |
| 3 | Context / memory | **L0** | 4096 ctx; unbounded `messages[]`; nothing persists | no compaction, no memory, no retrieval |
| 4 | Tool design | **L0/L1** | free-text regex; 2 tools | non-greedy `(.*?)` parse; opaque thrown errors |
| 5 | Planning | **L0** | none | no plan artifact, no decomposition |
| 6 | Verification & evals | **L0** | none | no eval suite, no in-loop test gates |
| 7 | Observability | **L0** | `console.log` of final text only | no spans, no error classification |
| 8 | Permissions & safety | **L0** | unrestricted `[sh:]` + net + browse | full lethal trifecta; policy only in prompt |
| 9 | Orchestration | **L0** | single agent/context/VM | no subagents, no checkpoints |
| 10 | Skills & MCP | **L1** | hardcoded `capabilities.ts` | no versioning, no MCP, no code-exec tool |

**Overall readiness: not shippable for autonomous work** — the L0 in #8 (safety) caps it regardless, and
#2/#3 mean it cannot complete a multi-step task without the human driving every turn.

---

## Axis 1 — Latency (rubric #1: ~L1)

- **No streaming.** `llm()` (`index.ts:66`) posts without `stream:true`; time-to-first-token = full
  generation of up to `max_tokens:2048` (`index.ts:70`). Perceived latency is worst-case every turn.
- **Cache-hostile system prompt.** `generatePrompt()` injects `Current Time: ${new Date().toISOString()}`
  (`index.ts:48`) into the system message. It's fixed within a session but differs every run, so the
  stable-prefix cache never carries across sessions — the notes' "caching a prefix that isn't stable"
  anti-pattern, applied to the most cacheable block.
- **Small context starves throughput.** `run-brain.sh` sets `--ctx-size 4096`; the growing `messages[]`
  array (`index.ts:117,136,138,155,157`) is re-sent every call with no compaction, so latency *climbs*
  through a session until the window overflows.
- **No span tracing.** Only final text is logged (`index.ts:158,160`); you cannot see whether wall-clock
  is model vs tool vs wait — so there's nothing to optimize against. **This is the cheapest L1→L2 win.**
- **Unbounded shell wait.** `shell()` (`index.ts:94`) has **no timeout** (unlike `browse()`'s 30 s, now
  enforced by the in-guest `browser39` binary, formerly `browser/browser_skill.go`); a command that blocks on stdin hangs the whole agent indefinitely.

## Axis 2 — Complex coding / debug (rubric #2,4,5: ~L0)

This is the most damaging cluster for your stated goal.

- **The loop does ONE tool call, then ONE follow-up, then waits for the human** (`index.ts:140–161`).
  After a single `[browse:]` *or* `[sh:]` and one follow-up LLM turn, control returns to the `> ` prompt.
  There is **no autonomous multi-step loop** — a real debug task (read → edit → run tests → read failure →
  fix) is impossible unless the user manually prompts each step.
- **`[done]` is a dead instruction.** The prompt says "Respond with one action per turn, or `[done]` when
  finished" (`index.ts:45`) but nothing ever checks for `[done]` — an "expired assumption" / no real stop
  predicate (rubric #2).
- **Brittle free-text parsing.** `reply.match(/\[browse:(.*?)\]/)` and `/\[sh:(.*?)\]/` (`index.ts:140–141`)
  are non-greedy and `.` excludes newlines, so any command containing `]` or a newline is silently
  truncated (`[sh:jq '.a[0]']` → `jq '.a[0`), and only the **first** match runs. Only one tool fires per
  turn (browse checked before sh). This is the textbook "free-text where a schema was needed" anti-pattern.
- **Crash-on-error, no recovery.** Tool/LLM failures throw; the only catch is `agentLoop().catch(...)` at
  the top (`index.ts:167`). One failed browse or one LLM 500 **terminates the entire session** — no error
  classification, no retry, no deny-and-continue (rubric #2,#7).
- **No verification sensor.** No test/lint/type gate between increments; the agent gets no feedback signal
  to self-correct (rubric #2,#6).
- **Debug output silently lost.** `shell()` truncates to 4000 chars (`index.ts:107`); a long stack trace —
  exactly what debugging needs — is cut with `…[truncated]` and no paging/continuation.

## Axis 3 — High-level research organization (rubric #3,9: ~L0)

- **No memory or state across sessions.** State is the in-process `messages[]` array only; on exit it's
  gone. Nothing is consolidated, indexed, or retrievable — the "treating the full transcript as memory"
  and "never consolidating" anti-patterns (rubric #3).
- **No compaction, no retrieval.** A long research thread simply grows `messages[]` until it exceeds the
  4096-token window. There is no proactive compaction, no tiered (core/archival/recall) memory, no
  pointer/AST reads, no agentic RAG.
- **No decomposition or subagents.** One monolithic context handles everything (rubric #5,#9); no plan
  artifact survives compaction; no way to fan a research task into isolated sub-tasks that return distilled
  results.

## Axis 4 — Safety & observability (rubric #7,8: L0 — flagged, gates shipping)

- **Full lethal trifecta in one agent:** `[browse:]` ingests **untrusted web content**, `[sh:]` gives
  **unrestricted code execution**, and `Smolfile` sets `net = true` for **external communication** — the
  exact combination the notes call out as enabling exfiltration. The only "control" is prompt text.
- **No permission layer at all** — no hooks/deny/allow, no risk annotations on tools, no approval gate
  (rubric #8 L0). The MicroVM sandbox limits host blast radius, which is the one real mitigation present.
- **Observability is `console.log`** of final text (rubric #7 L0): no structured spans, no error classes,
  nothing replayable into an eval set.

---

## How the chosen extensions map to these gaps
(Full analysis in [`EXTENSION_PLAN.md`](./EXTENSION_PLAN.md).)

| Weakness | Extension that targets it |
|----------|---------------------------|
| #3 no memory / ctx bloat (Axis 3) | **pi-memctx** (local-md retrieval injection), **pi-hermes-memory** (cross-session facts) |
| #9 research organization | **@zosmaai/pi-llm-wiki** (Obsidian knowledge vault) |
| #5/#9 decomposition & isolation (Axis 2/3) | **pi-delegate** (subagent), **pi-thread-engine** (parallel/checkpoint) |
| persona / interaction quality | **Umi soul** (`.pi/APPEND_SYSTEM.md`) |
| #6 trace-driven evals (Axis 4) | **pi-share-redacted-gist** (session → dataset) |

**Caveat the extensions do *not* fix** (and that this audit ranks higher-leverage than any of them):
the **single-tool-call-per-turn loop** (#2) and **crash-on-error** (#2/#7). Bolting memory/persona onto a
loop that can't take more than one autonomous step won't unlock complex coding/debug — the loop itself
(`index.ts:132–162`) needs to iterate to `[done]` and isolate tool failures first.
