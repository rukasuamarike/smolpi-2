# smolpi Harness — Break Log

"Test the harness to see where it breaks." Findings from three methods, each break tagged with the
[`HARNESS_RUBRIC.md`](~/study/notes/HARNESS_RUBRIC.md) dimension it hits and a severity.
Method: (A) runtime-readiness probe, (B) **empirical** repro on host with `node`, (C) static code analysis
(detailed in [`PI_AGENT_WEAKNESSES.md`](./PI_AGENT_WEAKNESSES.md)).

Environment note: `bun` is not on the host (the agent runs inside the MicroVM), and the runnable brain
lives in the **sibling** `~/pi-agent-smol`, so a full end-to-end boot is entangled with that other tree.
The breaks below were reproduced without a full boot; the full-boot items (B-runtime) are readiness gaps
found by inspection + tool probes.

---

## ✅ RESOLVED on this branch (loop rewrite + runnable brain)

Verified end-to-end against the live `gemma-4-E4B` brain (GPU, RTX 5080) in one-shot mode:

| Was | Now | Evidence |
|-----|-----|----------|
| **#1/#2 brain not runnable** | Moved built `llama.cpp` + model into the repo; `run-brain.sh` now exports `LD_LIBRARY_PATH` (stale RUNPATH fix). `/health`→ok, `PONG` smoke passed. | `run-brain.sh:41` |
| **#6 one tool-call then waits** | **Autonomous multi-step loop to `<done/>`** with a `MAX_STEPS` budget. Test: `printf>file` → `wc -l` → answer → `<done/>`. | `index.ts:runTask` |
| **#7 crash-on-error** | **Per-turn error isolation** — tool errors become observations the model recovers from; LLM errors return to prompt. Test: `cat` missing file → `[exit 1]` → model created+re-read it. | `index.ts:runTask` try/catch |
| **#3/#4/#5 brittle regex parse** | **Robust `<sh>`/`<browse>`/`<done/>` tags** (multiline; tolerant of inner `]`; earliest-action-wins). Test: `echo '[10,20,30]' \| jq '.[0]'` ran correctly. | `index.ts:parseAction` |
| **#8 shell hangs forever** | **`SHELL_TIMEOUT_MS`** kills blocked commands. Test: `sleep 30` killed at 3000ms → `[timed out after 3000ms]`. | `index.ts:shell` |
| **#9 unbounded context** | Sliding-window `trimContext()` keeps system + original task, drops oldest observations. | `index.ts:trimContext` |
| **#11 lost debug output** | Tool output cap is now configurable (`TOOL_OUTPUT_CAP`) and exit codes/stderr are surfaced. | `index.ts:shell` |
| **#12 soul not mounted** | `Smolfile` `[dev]` now mounts `./.pi`. | `Smolfile` |
| **#13 memctx not wired** | Real `pi-memctx` loads through the compat host (deny-by-default `.pi/extensions.json`, only typebox installed `--ignore-scripts`); its per-prompt **Memory Gateway brief** is injected into the system prompt. Test: agent answered `bun test` / `run-brain.sh` straight from seeded memory, no repo exploration, while in full Umi persona. | `host.ts`, `index.ts`, `.pi/extensions.json` |
| **NEW: agent executed example commands from its own answer** | The small model wraps documentation commands in `<sh>`. Fixed two ways: **`<done/>` is now terminal** (never run trailing actions), and a **few-shot** teaches "backticks to show, `<sh>` to run." Verified: the recall answer now uses backticks + `<done/>` and runs nothing; the execute path still works (file create → cat → done). | `index.ts:parseAction`, `generatePrompt` |

Still open (next): structured *parallel* tool calls + a real orchestration layer (you liked thread-engine's
idea but its repo is dead — build a native P/C-thread instead); per-turn span tracing (#7-obs); the SEV-2/3
context-compaction, permission-gate, and extension-wiring items below.

---

## SEV-1 — the harness can't run end-to-end from this repo

| # | Break | Evidence | Rubric |
|---|-------|----------|:------:|
| 1 | **`run-brain.sh` fails from `~/smolpi`.** It searches `./llama.cpp/build/bin/llama-server` and `./models/*.gguf`; the `smolpi` `llama.cpp` submodule is **empty** (0 files) and there is **no `models/` dir**. The built binary + CUDA libs + `gemma-4-E4B-it-Q4_K_M.gguf` only exist in `~/pi-agent-smol`. So the brain won't start here. | `find` shows binary/model only under `~/pi-agent-smol`; `scripts/run-brain.sh:11-13,42-57` | #1, repo hygiene |
| 2 | **Existing VM is from the other tree.** `smolvm machine ls` shows one stopped machine `pi-agent-dev` whose mounts point at the sibling repo, not this branch — so my `Smolfile` `.pi` mount + the vendored `extensions/` won't appear in it until a machine is recreated from this repo. | `smolvm machine ls` | #9 |

**Fix:** make the repo self-sufficient — `git submodule update --init llama.cpp` (or point `run-brain.sh`
at a configurable `LLAMA_DIR`/`MODELS_DIR`), and recreate the dev machine from this branch's `Smolfile`.

## SEV-1 — brittle tool parsing (EMPIRICALLY REPRODUCED)

`index.ts:140-141` parses tool calls with `reply.match(/\[browse:(.*?)\]/)` / `/\[sh:(.*?)\]/`.
Ran the exact regexes in `node` against realistic model output:

```
model said: "[sh:jq '.users[0].name' data.json]"
  -> harness runs: sh="jq '.users[0"          # ❌ truncated at first ']' → corrupt command executed
model said: "Let me look. [sh:grep -rn foo src/] and also [browse:https://x.com]"
  -> harness runs: browse="https://x.com"      # ❌ shell action dropped; browse always wins
model said: "[sh:for f in *.ts; do echo $f;\ndone]"
  -> harness runs: NONE                         # ❌ newline in cmd → '.' doesn't match → silent no-op
```

| # | Break | Rubric |
|---|-------|:------:|
| 3 | Any command containing `]` is silently truncated and a **corrupted command is executed**. | #2, #4 |
| 4 | When the model emits two actions, only the **first regex (browse) wins**; the real intent is dropped. | #2, #4 |
| 5 | Multi-line commands match nothing → the turn becomes a silent no-op (the agent looks "stuck"). | #2 |

**Fix:** replace regex free-text parsing with a structured tool protocol (fenced block / JSON / tool-call
schema) and constrained decoding (rubric #4).

## SEV-1 — loop can't complete multi-step work; crash-on-error

| # | Break | Evidence | Rubric |
|---|-------|----------|:------:|
| 6 | **One tool-call + one follow-up, then it waits for the human.** No autonomous loop; `[done]` (promised at `index.ts:45`) is never checked. A real debug cycle (edit→test→read→fix) is impossible unattended. | `index.ts:140-161`; no `[done]` handler | #2, #5 |
| 7 | **Any tool/LLM error kills the whole session** — the only catch is `agentLoop().catch()` at top level. One failed browse or one LLM 500 ends the REPL. | `index.ts:167`; `browse()` throws on non-zero exit `:87-90` | #2, #7 |
| 8 | **`shell()` has no timeout** — a command blocking on stdin hangs the agent forever (browser has 30 s; shell has none). | `index.ts:94-109` vs `browser_skill.go` 30 s | #1, #2 |

## SEV-2 — context & memory

| # | Break | Evidence | Rubric |
|---|-------|----------|:------:|
| 9 | `messages[]` grows unbounded with no compaction; against `--ctx-size 4096` the window overflows mid-session. | `index.ts:117,136,138,155,157`; `run-brain.sh` ctx 4096 | #3 |
| 10 | Cache-hostile system prompt: `Current Time: <ISO>` baked into the system message breaks cross-session prefix caching. | `index.ts:48` | #1 |
| 11 | Debug output truncated at 4000 chars (`shell`) — long stack traces, the thing you need, are cut. | `index.ts:107` | #2 |

## SEV-2 — integration gaps found while wiring Umi + extensions

| # | Break | Evidence | Rubric |
|---|-------|----------|:------:|
| 12 | **`.pi/` wasn't delivered to the guest** → the Umi soul (`/app/.pi/APPEND_SYSTEM.md`) would silently not load. *Fixed on this branch* by adding `./.pi:/app/.pi:ro` to `Smolfile` `[dev]`. | `Dockerfile` (no `.pi` COPY); `Smolfile` `[dev]` (now patched) | #10 |
| 13 | **`extensions/` is also not mounted** to the guest, and the vendored extensions need peer deps (`pi-coding-agent`, `pi-ai`, `pi-tui`, `better-sqlite3`, `typebox`) absent in the image. The compat host (`agent/extensions/host.ts`) therefore **fails soft** (logs a missing-dep skip) rather than loading them. | `Smolfile` `[dev]`; `host.ts:loadOne` catch | #10 |
| 14 | For the packed (non-dev) image, `.pi/` and `extensions/` still aren't `COPY`'d in the `Dockerfile` — soul/extensions won't ship in a snapshot. | `Dockerfile:9,49,53,63` | #10 |

## SEV-2/3 — safety & observability (see weakness audit Axis-4)

| # | Break | Rubric |
|---|-------|:------:|
| 15 | Full **lethal trifecta** (untrusted `[browse:]` + unrestricted `[sh:]` + `net=true`); only "control" is prompt text. The Umi soul's roleplay ("wipe your database") sits on top of real shell access — mitigated on this branch by the Operational Guardrails footer added to `.pi/APPEND_SYSTEM.md`. | #8 |
| 16 | Observability is `console.log` of final text only — no spans, no error classification, nothing replayable into evals. | #7 |

---

## Priority fix order (highest leverage first)
1. **Structured tool protocol + multi-step loop to `[done]` + per-turn error isolation** (breaks 3-8). Nothing
   else — memory, persona, delegate — pays off until the loop can take more than one step and survive an error.
2. **Make the repo runnable** (break 1-2): init the `llama.cpp` submodule / configurable model dir; recreate VM from this branch.
3. **Context management**: compaction + stable cache prefix (breaks 9-11).
4. **Deliver `.pi/` + `extensions/` to the guest and add peer deps**, then enable `memctx` via the toggle registry (breaks 13-14).
5. **Add a deterministic permission gate** for `[sh:]` (break 15) before enabling delegate/thread-engine.

> The extensions you chose are well-built (see [`EXTENSION_REVIEW.md`](./EXTENSION_REVIEW.md)), but they
> assume a loop that can iterate and a runtime that can load them. Fix #1 and #4 first.
