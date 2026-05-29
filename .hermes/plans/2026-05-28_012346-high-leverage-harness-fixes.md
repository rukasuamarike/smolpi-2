# High-Leverage Harness Fixes Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Bring smolpi to at least L1 across every harness rubric category, then push toward L2 on the user-prioritized axes: reliability/ease-of-use, tool use, streaming outputs, richer context windows, eval/alignment feedback at permission points, complex coding/debug, and research organization.

**Architecture:** Keep smolpi small, but move invariants out of prompt vibes and into harness code. Tonight's pass prioritizes bootability, streaming, tool reliability, traceability, and an eval loop before speculative goals like LoRA/SFT.

**Tech Stack:** Bun + TypeScript agent (`agent/index.ts`), llama.cpp/LMStudio OpenAI-compatible chat API, smolvm MicroVM, browser39, MCP SDK, JSONL traces.

---

## Current context

- The agent already has an autonomous multi-step loop, timeout-bounded shell, extension host, MCP proxy bridge, and JSONL LLM-call logs.
- `make doctor` currently fails on runnable brain readiness in this checkout: no built `llama-server`, no `.gguf` in `./models`, no LLM responding on `127.0.0.1:8080`, and no VM yet.
- The README now frames permission points as alignment/evaluation opportunities: the model should explain intent, uncertainty, and alternatives, and the user's feedback should compound into policy/evals.
- Quantifiable target: reach at least L1 on all categories in `~/study/notes/HARNESS_RUBRIC.md`; then target L2 first for latency, quality/reliability, context/memory, tool design, verification/evals, observability, and permissions-as-feedback.

## Tonight's north star

Do not build training pipelines yet. Make the harness pleasant, observable, and reliable. Default to primitives the model already knows and add scaffolding only after evals prove it is necessary:

1. It boots or clearly tells the user what external brain to point at.
2. It gives the model a robust native workspace substrate: bash, git, text progress file, and visible resource headroom.
3. It streams model output as a thin UX layer, while keeping non-streaming fallback simple.
4. It uses tools through the simplest validated action path that measurably reduces failures.
5. It captures enough trace data to evaluate every permission/tool decision.
6. It has a tiny repeatable eval suite proving L1 behavior across all rubric categories.

## Harness obsolescence guardrail

Every new harness component must declare the model limitation it assumes. If a stronger model or eval run shows the component is no longer needed, delete it. Prefer bash/git/text files over bespoke state machines; prefer resource/headroom fixes over protocol cleverness when infrastructure is the real bottleneck.

---

## Task 1: Make brain readiness easy and non-annoying

**Objective:** Ensure first-run setup supports either an external OpenAI-compatible brain or a local llama.cpp brain without blocking the user behind irrelevant failures.

**Files:**
- Modify: `scripts/doctor.sh`
- Modify: `.env.example`
- Modify: `README.md`
- Test: run `make doctor` under local-brain-missing and external-LLM configurations.

**Steps:**
1. Add an explicit `BRAIN_MODE` or equivalent convention:
   - `BRAIN_MODE=external` means doctor should require only `LLM_URL` reachability.
   - `BRAIN_MODE=local` means doctor checks llama.cpp binary + models.
   - Default can remain local, but README should recommend external for fastest iteration.
2. Update doctor output so missing local llama.cpp/model is a warning, not a failure, when external mode is configured.
3. Add `.env.example` comments for LMStudio (`LLM_URL=http://127.0.0.1:1234`, `LLM_MODEL=...`).
4. Verify:
   - `make doctor` clearly distinguishes local vs external readiness.
   - No false failure when an external server is configured and reachable.

**Expected result:** L1 ease-of-use: the harness is diagnosable and does not punish the user for using LMStudio or another brain.

---

## Task 2: Add native workspace progress and resource checks

**Objective:** Prefer primitives the model already knows — bash, git, text files — before custom orchestration or memory machinery.

**Files:**
- Modify: `agent/index.ts`
- Modify: `scripts/doctor.sh`
- Modify: `README.md`
- Create: `.pi/progress.md.example` or similar template
- Test: a startup prompt includes progress/git guidance; doctor reports resource headroom.

**Steps:**
1. Add a lightweight progress-file convention, e.g. `.pi/progress.md`, with sections for goal, current state, last commands, open risks, next step.
2. Update the system prompt to tell the model to consult `git status`, `git diff`, `git log --oneline -5`, and `.pi/progress.md` before inventing custom state.
3. Add doctor checks for host-visible resource headroom (`nproc`, memory, disk) and Smolfile guest CPU/RAM limits.
4. Keep progress-file updates model-visible but not mandatory every turn; use it after meaningful milestones.
5. Verify:
   - Doctor prints CPU/RAM/disk and Smolfile limits.
   - The prompt mentions git/text progress as the first state mechanism.
   - No new dependencies.

**Expected result:** L1 ease-of-use and context continuity with low obsolescence risk.

---

## Task 3: Add streaming chat completions

**Objective:** Reduce perceived latency and make the REPL feel alive by streaming assistant tokens when the backend supports OpenAI-compatible SSE.

**Files:**
- Modify: `agent/index.ts`
- Modify: `agent/logger.ts` if needed to record streaming metadata.
- Test: one-shot and interactive runs against llama.cpp or LMStudio.

**Steps:**
1. Add env var `LLM_STREAM=1` defaulting to on for interactive REPL, off only if broken.
2. Implement `llmStream(messages)` using `stream: true` and parsing `data: ...` SSE chunks.
3. Print deltas as they arrive while accumulating the final content for parsing/logging.
4. Fall back to non-streaming `llm()` if the server rejects streaming.
5. Log `streaming: true/false`, TTFT if feasible, and total latency.
6. Verify:
   - Interactive mode prints tokens before full completion.
   - The final accumulated reply is still parsed correctly for `<sh>`, `<browse>`, `<tool>`, and `<done/>`.
   - `/logs` still reports complete usage when the backend provides it; otherwise logs zeros plus latency.

**Expected result:** Latency moves to solid L1 and starts toward L2.

---

## Task 4: Harden action parsing with validated structured actions

**Objective:** Stop relying on regex tags as the only protocol; introduce a strict JSON action object while keeping legacy tags as a compatibility fallback.

**Files:**
- Modify: `agent/index.ts`
- Create: `agent/action.ts` or `agent/protocol.ts`
- Test: create small unit-like script or Bun test for parser cases.

**Steps:**
1. Define an action shape:
   ```json
   {"action":{"kind":"sh","cmd":"pwd"}}
   {"action":{"kind":"browse","url":"https://example.com"}}
   {"action":{"kind":"tool","name":"mcp","args":{"search":"click"}}}
   {"action":{"kind":"done","final":"..."}}
   ```
2. Update the system prompt to prefer JSON action blocks over XML tags.
3. Validate action objects deterministically:
   - required fields present
   - `kind` enum valid
   - `tool.args` object only
   - no command for done
4. If validation fails, feed a structured `Observation: ACTION_VALIDATION_ERROR ...` back to the model instead of guessing.
5. Keep existing XML parsing as fallback for current small-model behavior.
6. Verify cases from `docs/BREAK_LOG.md`:
   - jq brackets do not truncate
   - multiline shell commands work
   - done does not execute example commands
   - malformed JSON produces a corrective observation

**Expected result:** Tool design and quality reach L1 everywhere and begin L2 migration.

---

## Task 5: Turn permission points into alignment/eval checkpoints

**Objective:** Add a permission decision layer that starts as feedback/evaluation infrastructure, not bureaucracy.

**Files:**
- Create: `agent/permissions.ts`
- Modify: `agent/index.ts`
- Modify: `agent/logger.ts`
- Docs: update `README.md` if behavior changes.

**Steps:**
1. Before every shell/tool action, classify the proposed action:
   - `read_only`
   - `write_workspace`
   - `network_read`
   - `network_write`
   - `destructive`
   - `credential_or_secret_risk`
   - `unknown`
2. Auto-allow benign/read-only classes initially.
3. For risky classes, ask the model to provide a compact decision record:
   - intended outcome
   - why this action is needed
   - uncertainty / knowledge gaps
   - safer alternative considered
4. In interactive mode, present that record to the user and ask for approve/deny/modify only for risky classes.
5. Log the decision record and user feedback as structured JSONL spans.
6. Feed denied/modified permission feedback back to the model as an observation so it learns to push back/replan.
7. Verify:
   - `rg`, `fd`, `bat`, `pwd`, `wc` auto-allow.
   - `rm -rf`, credential reads, upload/publish commands require approval or are denied.
   - User denial becomes model-visible feedback.

**Expected result:** Permissions reach L1 while creating the dataset needed for alignment and later policy improvements.

---

## Task 6: Add loop-level span tracing

**Objective:** Make failures localizable: prompt assembly, model, parser, permission, tool, observation, compaction, and extension injection should each be visible.

**Files:**
- Modify: `agent/logger.ts`
- Modify: `agent/index.ts`
- Modify: `agent/extensions/host.ts`

**Steps:**
1. Add a generic `logSpan()` method writing JSONL records with fields:
   - `ts`, `session`, `turn`, `step`, `span`, `status`, `latency_ms`, `error_class`, `metadata`
2. Log spans for:
   - `prompt.assemble`
   - `extension.before_agent_start` per extension
   - `llm.request`
   - `action.parse`
   - `permission.decide`
   - `tool.call`
   - `context.trim`
   - `delegate.child`
3. Keep message logging optional via `LOG_MESSAGES=0`.
4. Add `/logs spans` summary if cheap.
5. Verify one sample task produces spans that identify every step.

**Expected result:** Observability reaches L1/L2 boundary.

---

## Task 7: Replace blunt injected-context slicing with budgeted context assembly

**Objective:** Stop `sys.slice(0, cap)` from randomly truncating extension output; preserve structured high-value context under budget.

**Files:**
- Modify: `agent/extensions/host.ts`
- Modify: `.pi/extensions.json` if budgets become per-extension.
- Test: prompt assembly with memctx + hermes-memory + llm-wiki enabled.

**Steps:**
1. Require each injected block to be wrapped with a label/header.
2. Allocate a budget per extension or per block type.
3. If over budget, drop lower-priority blocks whole or summarize them; do not slice arbitrary characters.
4. Log dropped block names and sizes.
5. Verify:
   - System prompt remains syntactically intact.
   - Injected chars stay under the configured global budget.
   - No closing tags/sections are cut mid-block.

**Expected result:** Context/memory reaches a cleaner L1 and positions for semantic compaction.

---

## Task 8: Add minimal semantic task-state compaction

**Objective:** Preserve task progress when old observations are dropped.

**Files:**
- Modify: `agent/index.ts`
- Possibly create: `agent/task_state.ts`

**Steps:**
1. Maintain a compact task state object:
   - goal
   - current plan
   - files inspected/touched
   - commands run
   - failures/errors
   - current hypothesis
   - next suggested step
2. When context exceeds budget, ask the model or a deterministic extractor to update task state before trimming.
3. Re-inject task state after system prompt and original task.
4. Verify with a multi-step task that old command output can be dropped while file paths and failure state remain.

**Expected result:** Context/memory crosses L1 and starts toward L2 for complex coding/debug.

---

## Task 9: Add a tiny eval suite from the break log

**Objective:** Stop tuning by vibes. Lock in L1 behavior with repeatable checks.

**Files:**
- Create: `tests/harness/` or `scripts/eval-harness.ts`
- Modify: `package.json` scripts if useful.
- Use: `docs/BREAK_LOG.md` cases as fixtures.

**Initial eval cases:**
1. No-tool answer does not execute example commands.
2. jq command containing brackets parses correctly.
3. Multiline shell command runs.
4. Missing file error is fed back and recovered from.
5. Shell timeout triggers and loop continues.
6. Memory recall answers without repo exploration when seeded memory exists.
7. MCP proxy can list browser39 tools.
8. Risky shell action produces permission checkpoint.
9. Max step budget stops cleanly.
10. Streaming path accumulates final parseable content.

**Metrics:**
- pass/fail
- steps
- prompt tokens
- completion tokens
- latency
- tool errors
- permission outcomes

**Expected result:** Verification/evals reaches L1 and becomes the basis for L2 work.

---

## Task 10: Add a command/batch execution primitive after permissions exist

**Objective:** Reduce one-action-per-step overhead for mechanical tool sequences.

**Files:**
- Modify: action protocol files
- Modify: `agent/index.ts`
- Modify: permission gate to classify each batch member

**Steps:**
1. Add a `batch` action for independent read-only commands first.
2. Execute read-only batch members concurrently.
3. Return a compact combined observation with per-command exit code/stdout/stderr cap.
4. Do not allow destructive/network-write batch actions until permission policy matures.
5. Verify code-inspection tasks complete in fewer LLM calls.

**Expected result:** Latency/tool design improve toward L2.

---

## Tonight's suggested execution order

1. Task 1: brain readiness / ease of use.
2. Task 2: native workspace substrate — bash/git/progress file/resource checks.
3. Task 3: streaming outputs as a thin UX improvement.
4. Task 6: span logging foundation, including resource and tool timing spans.
5. Task 9: tiny eval suite.
6. Task 4/5: action protocol + permission checkpoint v0 only where evals show failures or risk.

Do **not** start LoRA/SFT tonight. The logs are only useful for training once the harness produces reliable trajectories and labeled feedback.

## Definition of done for L1 across all categories

- Latency: streaming or clear TTFT metric; context not exploding every turn.
- Quality: explicit loop budget, stop condition, recoverable tool errors, validated action parsing.
- Context/memory: context trim preserves original task and task state; memory injection budgeted.
- Tool design: tool actions validated; errors actionable.
- Planning: plan/task state externalized for nontrivial tasks.
- Verification/evals: at least 10 repeatable harness evals.
- Observability: JSONL spans for model/tool/parse/permission/context.
- Permissions/safety: read-only auto-allow plus risky-action checkpoints with user feedback logged.
- Orchestration/sandboxing: MicroVM verified; delegate remains gated until permission/logging are in place.
- Skills/MCP: MCP proxy and extension registry verified by evals, not just docs.

## Risks / tradeoffs

- Richer context windows can hide memory bloat. Measure tokens per turn before increasing `CTX_SIZE` blindly.
- Permission checkpoints can become annoying. Keep them sparse: only risky/uncertain actions, and use them to collect high-value alignment feedback.
- Streaming complicates parser/logging. Always accumulate the final reply and parse only after completion.
- Structured JSON may be harder for the small model than XML tags. Keep XML fallback until evals prove JSON reliability.
- Batch execution improves latency but increases blast radius. Restrict to read-only until permission classification is proven.
