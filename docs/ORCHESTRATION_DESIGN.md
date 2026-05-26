# Design: learned, token-efficient parallel orchestration (FUTURE / experimental)

Captures the next milestone. **Not built yet** — flagged experimental (tier-gated like thread-engine).

## Goal
Run independent work in parallel (explore + skill-chains, like Claude's parallel sub-agents), and — the
key idea — **learn which tool/skill combos to use for a given task type, ranked by token efficiency**,
improving over time from real session data.

## Why this is now feasible here
Three pieces already exist on this branch:
1. **A working multi-step loop** (`runTask`) that takes actions to `<done/>` with error isolation.
2. **Model-callable tools** (18 across memctx / hermes-memory / llm-wiki) via `host.callTool` + the
   `<tool>` action, plus `host.toolSpecs()` for discovery.
3. **`/logs` token telemetry** — every call logs `{config, prompt_tokens, completion_tokens, messages,
   reply}` to JSONL. This is the training signal *and* the post-training substrate.

## The learning loop
```
task → pick a combo (which tools/skills, sequential vs parallel)
     → run it (logged: tokens, steps, success)
     → /logs aggregates avg tokens & success per (task-type, combo)
     → next time, prefer the combo with best tokens-per-success for that task-type
```
- **Task-type key**: cheap classifier or embedding bucket of the prompt (e.g. "debug", "research",
  "lookup").
- **Combo**: an ordered/parallel set of tools+skills (e.g. `[wiki_recall ∥ memctx_search] → sh:test`).
- **Reward**: success ÷ total_tokens (efficiency), already derivable from the JSONL logs.
- **Policy**: start with a hand-seeded prior per task-type; update from logged outcomes (bandit / simple
  argmax over logged efficiency). Later: distill the winning (prompt → combo) pairs into post-training
  data for gemma so the *model itself* learns the efficient combos.

## Parallelism substrate
- Reuse the **pi-delegate** pattern (vendored): fresh child loop, returns only a distilled result —
  matches the rubric's subagent-isolation. P-thread = N delegates in parallel; join results.
- Borrow **thread-engine's** P/C-thread *concepts only* (parallel + checkpoint); do **not** vendor it
  (dead repo, no tests, ungated autonomy — see EXTENSION_REVIEW.md). Build native, behind the
  `experimental` toggle, deny-by-default.

## Phasing
1. ✅ **DONE** — Native parallel delegate (`<tool name="delegate">{"tasks":[…]}</tool>` fan-out + join),
   gated behind `AGENT_EXPERIMENTAL=1`. Fresh isolated child context per task, parallel via `Promise.all`,
   distilled results only, nested delegation blocked, each child's tokens logged with `tag=delegate:N`.
   Verified: 2 children ran concurrently (~2.5s) and the parent composed their answers.
2. Per-(task-type, combo) efficiency table built from `/logs` (now has `tag` + `config` + token columns);
   expose via `/logs combos`.
3. Combo selection policy (argmax efficiency, ε-explore).
4. Export winning (prompt → combo/trajectory) pairs as SFT data → fine-tune gemma.

## Guardrails (rubric #8)
Parallel + autonomous = higher blast radius. Keep deny-by-default, step/token budgets per child, no
auto-deploy, and the shell permission gate before this ships.
