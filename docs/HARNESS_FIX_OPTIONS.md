# Harness Fix Options — Ideal Solutions & Dependency Tradeoffs

This document turns the high-level plan into implementation options. Bias: smallest reliable change first, then pull open-source code only when it clearly buys reliability or reduces maintenance.

## Constraints / operating assumptions

- Keep smolpi smol: prefer stdlib/Bun primitives and tiny focused deps over framework gravity wells.
- The agent runs in a smolvm guest; the brain can be local llama.cpp or external OpenAI-compatible server.
- Immediate target is L1 across every `~/study/notes/HARNESS_RUBRIC.md` category.
- L2 focus areas: latency, reliability/ease-of-use, tool design, context/memory, evals, observability, permission/alignment feedback.
- Permission checkpoints are alignment/eval data, not approval theater.
- LoRA/SFT waits until traces are reliable and labeled.
- **Harness obsolescence rule:** every component must state the model limitation it assumes. Prefer native primitives (bash, git, text files) and delete scaffolding when evals show the model no longer needs it.
- **Infrastructure before protocol cleverness:** measure sandbox CPU/RAM/headroom and tool-process reliability before attributing latency or task failure to parsing/transport.

---

## Step 1 — Ease of use / brain readiness

### Ideal solution

A first-run path that never forces the user into the wrong brain mode.

- `BRAIN_MODE=local`: doctor checks local `llama-server`, model files, GPU backend, and reachability.
- `BRAIN_MODE=external`: doctor skips local llama.cpp/model checks and requires only `/v1/models` reachability.
- README and `.env.example` make LMStudio/external mode explicit.
- Later: `make doctor` can auto-detect an already reachable external server and suggest `BRAIN_MODE=external`.

### Implemented first slice

- Added `BRAIN_MODE=local|external` to `scripts/doctor.sh`.
- Added regression test: `tests/test_doctor_external_brain.sh`.
- Updated `.env.example` and README.

### Dependencies

None. Shell + Python stdlib in test only.

### Why not pull OSS here?

The problem is project-specific diagnosis. A generic CLI framework would add weight without improving correctness.

---

## Step 2 — Native workspace substrate: bash, git, progress file, resource headroom

### Ideal solution

Before adding orchestration, give the model the boring primitives it already knows.

- A robust sandboxed bash terminal with clear cwd/env behavior and timeouts.
- Git as rollback/checkpoint mechanism, not a custom undo state machine.
- A plain progress file (for example `.pi/progress.md`) read at session start and updated after meaningful tasks.
- Doctor/resource checks for guest CPU/RAM and host/brain headroom so failures are not misattributed to prompt/protocol issues.
- README prompt guidance: prefer `git status`, `git diff`, `git log`, and `.pi/progress.md` before custom memory when restarting work.

### Options

| Option | Dependency | Pros | Cons | Verdict |
|---|---:|---|---|---|
| Plain bash + git + `.pi/progress.md` | none | Native LLM fluency; low obsolescence risk; easy to inspect | Less fancy retrieval | **Start here** |
| Managed persistent shell session | none / Bun child process | Preserves cwd/env/processes | More lifecycle complexity | Add after eval shows fresh shells hurt |
| Custom rollback/state machine | none/new code | Fine-grained control | Rebuilds git poorly; likely obsolete | Avoid |
| Memory DB first | existing extensions | Searchable facts | More moving parts/context injection | Use after text progress baseline |

### Recommendation

Promote bash/git/text state before custom state machinery. Add a progress-file convention and resource/headroom checks before any batch/code-exec architecture.

---

## Step 3 — Streaming outputs

### Benchmark update

E2E testing shows streaming is not the dominant wall-clock fix for short one-shot/test paths. Host-direct Gemma 4 E4B IQ2_M has ~69ms TTFT and ~103–115 tok/s generation, while `smolvm exec` adds ~125ms per invocation and guest→host round-trip averages ~216ms vs ~92ms host-only. Therefore, prioritize long-running `make machine-run` sessions and span logging over per-exec micro-optimizations. Streaming remains valuable for perceived latency and TTFT observability inside the live agent loop.

### Implemented first slice

- Added no-dependency OpenAI-compatible SSE parsing in `agent/index.ts`.
- Added `LLM_STREAM` (default on) with automatic fallback to non-streaming if `stream:true` is rejected.
- Main agent calls stream deltas to stdout while accumulating the final reply for action parsing and JSONL logs.
- Extended `agent/logger.ts` with `streaming` and `ttft_ms`; `/logs` summarizes streaming calls and avg TTFT.
- Added regression test: `tests/test_llm_streaming.sh`.

### Ideal solution

OpenAI-compatible SSE streaming with graceful fallback.

- Interactive REPL defaults to streaming.
- One-shot can stream unless `LLM_STREAM=0`.
- Accumulate full final reply for action parsing and logs.
- Track TTFT, total latency, streamed/non-streamed mode.
- If backend rejects `stream:true`, retry non-streaming once and log fallback.

### Options

| Option | Dependency | Pros | Cons | Verdict |
|---|---:|---|---|---|
| Hand-rolled SSE parser | none | Tiny; OpenAI chunks are simple; no install | Must handle chunk boundaries carefully | **Start here** |
| `eventsource-parser` | 1 tiny MIT dep (`3.1.0`) | Battle-tested SSE chunk parser; small surface | Adds dep for ~30 lines of parsing | Good fallback if hand parser flakes |
| Full EventSource client | medium | Browser-like semantics | Wrong shape for POST streaming; unnecessary | Avoid |

### Recommendation

Start with hand-rolled parser. If evals expose chunk-boundary bugs, add `eventsource-parser`.

---

## Step 4 — Structured action protocol

### Ideal solution

Strict validated action object, XML tags retained as compatibility fallback until evals prove JSON stability.

Preferred model output:

```json
{"action":{"kind":"sh","cmd":"pwd"}}
{"action":{"kind":"browse","url":"https://example.com"}}
{"action":{"kind":"tool","name":"mcp","args":{"search":"click"}}}
{"action":{"kind":"done","final":"answer"}}
```

Harness behavior:

- Parse JSON object first.
- Validate deterministically.
- On invalid action, feed `ACTION_VALIDATION_ERROR` as an observation.
- Do not guess missing fields.
- XML fallback remains for small-model robustness.

### Options

| Option | Dependency | Pros | Cons | Verdict |
|---|---:|---|---|---|
| Manual TypeScript validation | none | Tiny; no runtime dep; enough for 4 action kinds | Less reusable for MCP-like schemas | **Start here** |
| `@sinclair/typebox` | already installed | JSON-schema-ish; already in dependency tree | Needs Value module/import discipline | Strong candidate |
| `zod` | new MIT dep (`4.4.3`) | Excellent DX; clear errors | Adds overlapping schema system | Defer |
| `ajv` | new MIT dep + 4 deps (`8.20.0`) | Real JSON Schema validation | Heavier; overkill for local action union | Avoid for now |

### Recommendation

Use manual validation or existing TypeBox. Do not add Zod/AJV yet. The action schema is small.

---

## Step 5 — Permission checkpoints as alignment/eval feedback

### Ideal solution

A deterministic pre-action classifier plus sparse interactive checkpoints for risky actions.

Decision record fields:

- `risk_class`
- `intended_outcome`
- `why_needed`
- `uncertainty`
- `safer_alternative`
- `model_recommendation`
- `user_decision`: approve / deny / modify
- `user_feedback`

Initial policy:

- Auto-allow obvious read-only: `pwd`, `rg`, `fd`, `bat`, `sed -n`, `wc`, `git status`, `git diff`.
- Checkpoint writes/destructive/network-write/secret-ish commands.
- Deny obvious credential exfil and recursive destructive commands unless user explicitly overrides.
- Feed denied/modified feedback back as an observation.

### Options

| Option | Dependency | Pros | Cons | Verdict |
|---|---:|---|---|---|
| Regex/heuristic classifier | none | Fast; transparent; good L1 | Imperfect shell understanding | **Start here** |
| `shell-quote` | tiny MIT dep (`1.8.4`) | Tokenizes shell-ish strings better than split | Not a full Bash AST | Add if heuristics need tokenization |
| `bash-parser` | MIT but many stale deps (`0.5.0`) | AST-like parsing | Old, many deps, likely edge-case pain | Avoid initially |
| Policy engines (OPA/Cedar/etc.) | heavy | Serious authz | Too much gravity for smol harness | Defer far future |
| Inquirer prompts | `@inquirer/prompts` + subdeps | Nice UX | Bun/TTY complexity; approval fatigue risk | Avoid; use readline first |

### Recommendation

Start with a no-dep classifier and readline prompt. Treat false positives/negatives as eval cases.

---

## Step 6 — Span tracing / observability

### Ideal solution

JSONL spans for every harness phase:

- `prompt.assemble`
- `extension.before_agent_start`
- `llm.request`
- `llm.stream`
- `action.parse`
- `permission.decide`
- `tool.call`
- `context.trim`
- `delegate.child`

Each span should include `turn`, `step`, `status`, `latency_ms`, `error_class`, and compact metadata.

### Options

| Option | Dependency | Pros | Cons | Verdict |
|---|---:|---|---|---|
| Extend current JSONL logger | none | Fits existing logs; dead simple; eval-ready | Not standard OTel | **Start here** |
| `pino` | MIT, ~10 deps (`10.3.1`) | Fast structured logging; redaction support | Duplicates current logger; more deps | Defer |
| OpenTelemetry API only | Apache dep (`1.9.1`) | Standard semantic conventions | Needs exporter story for value | Later |
| OTel SDK trace node | Apache + several deps (`2.7.1`) | Full tracing | Heavy for current phase | Avoid tonight |

### Recommendation

Extend `agent/logger.ts`. Consider OTel only after local JSONL spans drive evals.

---

## Step 7 — Budgeted context assembly

### Ideal solution

Replace arbitrary `sys.slice(0, cap)` with block-aware injection.

- Each extension returns or is wrapped as a named block.
- Each block has priority and char/token budget.
- Drop or summarize whole blocks; never cut arbitrary text mid-structure.
- Log dropped block names and sizes.

### Options

| Option | Dependency | Pros | Cons | Verdict |
|---|---:|---|---|---|
| Block wrapper + char budgets | none | Simple; predictable; immediate fix | Approx token counting | **Start here** |
| Token counting via llama tokenizer | native/server call | Accurate | Slower, backend-specific | Later |
| JS tokenizer packages | new deps | More accurate budgets | Model-specific mismatch risk | Defer |
| Compression libs/LLMLingua | heavy/Python | Strong compression | Complexity exceeds L1 target | Defer |

### Recommendation

Implement named blocks + char budgets now. Token-accurate budgeting can wait.

---

## Step 8 — Minimal semantic task-state compaction

### Ideal solution

Maintain a task-state object that survives context trimming:

- goal
- plan/current step
- files inspected/touched
- commands run
- errors/failures
- current hypothesis
- next action

### Options

| Option | Dependency | Pros | Cons | Verdict |
|---|---:|---|---|---|
| Deterministic extractor from actions/observations | none | Cheap; predictable; enough for file/cmd state | Weak semantic summaries | Start here |
| Model-generated compaction update | no new dep | Better summaries | Extra model call; can drift | Use after deterministic skeleton |
| SQLite state store | built-in? / existing shims | Durable | More schema work | Later |
| External memory framework | existing extensions | Already present | Might bloat prompt; partial compat | Use as retrieval, not task state source |

### Recommendation

Start deterministic. Add model summary only at compaction thresholds.

---

## Step 9 — Tiny eval suite

### Ideal solution

A fast local eval runner that exercises the harness protocol without requiring a real big model for every check.

- Unit-ish parser/permission tests run without LLM.
- Doctor tests use a fake `/v1/models` server.
- Optional live evals run against configured LLM.
- Results include pass/fail, steps, tokens, latency, and permission decisions.

### Options

| Option | Dependency | Pros | Cons | Verdict |
|---|---:|---|---|---|
| Bash + Bun scripts | none | Smallest; works now | Less ergonomic assertions | **Start here** |
| Bun test | none if Bun test is available | Native to runtime; good TS tests | Need exportable modules | Good next |
| Vitest | MIT but pulls Vite tree (`4.1.7`) | Great DX | Heavy for smol repo | Avoid initially |
| Bats/ShellSpec | external tools | Nice shell tests | Extra install | Avoid |

### Recommendation

Use Bash for integration smoke and Bun test for exported TS modules. No Vitest yet.

---

## Step 10 — Batch/code-execution primitive

### Ideal solution

A read-only batch action that executes independent inspection commands concurrently and returns compact structured observations.

- Only read-only commands at first.
- Per-command exit code, stdout/stderr cap, timeout.
- Permission classifier evaluates every member.
- Later: a code-execution/MCP-style tool that runs a script with access to safe helper APIs.

### Options

| Option | Dependency | Pros | Cons | Verdict |
|---|---:|---|---|---|
| Native `batch` action in Bun | none | Fits current harness; easy logging | Must guard blast radius | Start after permission v0 |
| Shell script generated by model | none | Collapses turns | Harder to attribute per step | Use only inside batch wrapper |
| Code-exec-over-MCP | MCP SDK already present | Strong long-term pattern | More architecture | Later L2 |
| Worker pool libraries | new deps | Scheduling niceties | Overkill | Avoid |

### Recommendation

Do not start batch until permission classification and spans exist. Then implement read-only batch native.

---

## Dependency policy for the next phase

### Add now

Nothing required.

### Acceptable if implementation pain appears

- `eventsource-parser` for robust SSE parsing.
- `shell-quote` if command classification needs safer tokenization.

### Avoid for now

- `zod` / `ajv`: schema validation can be manual or TypeBox because action union is tiny.
- `vitest`: Bun test or shell tests are enough.
- `pino` / OpenTelemetry SDK: current JSONL logger should grow spans first.
- `bash-parser`: old, many deps, not worth the blast radius.
- prompt/UI libraries: readline is enough for sparse permission checkpoints.

## Immediate next commits

1. `feat: add native workspace progress and resource checks` — no new deps; `.pi/progress.md` convention, git-first checkpoint guidance, CPU/RAM/headroom visibility.
2. `feat: stream chat completions` — no new deps, fallback to non-streaming; treat as thin UX layer, not core architecture.
3. `refactor: introduce validated action protocol` — no new deps, XML fallback retained; keep protocol removable if future models follow simpler tags reliably.
4. `feat: log harness spans` — no new deps, JSONL spans.
5. `feat: add permission checkpoints` — no new deps, initial heuristic policy.
6. `test: add harness eval smoke suite` — no new deps.
