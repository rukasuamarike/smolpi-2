# Extension Plan — six pi.dev packages into smolpi

Analysis of the six chosen extensions, mapped to the weaknesses in
[`PI_AGENT_WEAKNESSES.md`](./PI_AGENT_WEAKNESSES.md) and the rubric dimensions in
[`HARNESS_RUBRIC.md`](~/study/notes/HARNESS_RUBRIC.md).

## Reality check (why this isn't `pi install`)

All six are npm packages published for the **pi.dev Pi Coding Agent** runtime, installed there with
`pi install npm:<name>`. **smolpi is not that runtime** — it's the custom ~167-line Bun agent in
`agent/index.ts` with a hardcoded `agent/capabilities.ts` registry and no plugin loader. There is no `pi`
binary on host or guest. So the chosen path is: **vendor each package's source from GitHub under
`extensions/<name>/` and adapt it through a small smolpi compat host** (`agent/extensions/host.ts`).
The packages are written against the pi.dev extension API (tool registration, hooks, memory gateway), so
the compat host must implement the subset they call. Expect **clean ports for some, partial for others.**

## Priority → package map

| Your priority | Packages |
|---------------|----------|
| **HIGH — ctx-efficient memory** | `pi-memctx`, `pi-hermes-memory`, `@zosmaai/pi-llm-wiki` |
| **HIGH — persona** | the **Umi soul** (a copy step, not a package) |
| **LOW — auto-gen finetune dataset** | `pi-share-redacted-gist` |
| (supports coding/debug + research-org) | `pi-delegate`, `pi-thread-engine` |

---

## The six packages

### 1. `pi-memctx` — local-markdown memory + retrieval  ▸ **primary HIGH pick**
- **Does:** stores project knowledge as editable Markdown notes; semantic search via `qmd` (grep
  fallback); a "Memory Gateway" injects only relevant memories before each prompt. Claims ~67% faster /
  ~81% fewer provider tokens. Node 20+, local-first, no hosted service.
- **Targets:** rubric #3 (context efficiency), Axis 3 (no memory). **Best single fit for "ctx-efficient
  memory."**
- **Adaptation:** *clean.* Maps directly to a **context-injection hook** in the compat host — retrieve →
  rank → prepend to the system/user message before `llm()`. `qmd` is optional (grep fallback works in the
  MicroVM). **Port first.**

### 2. `pi-hermes-memory` — cross-session facts + consolidation
- **Does:** persistent facts/preferences/corrections/skills across sessions; SQLite **FTS5** search;
  secret-scanning to block keys from being saved; auto-consolidation at capacity. Categorized memory
  (failures, corrections, insights, conventions, tool-quirks). Config at `~/.pi/agent/hermes-memory-config.json`.
- **Targets:** rubric #3 (the hierarchical-consolidation tier model), Axis 3.
- **Adaptation:** *medium.* Needs SQLite in the guest (`apt-get install sqlite3` / `bun:sqlite`) plus
  persist hooks. Its secret-scanner is a bonus toward rubric #8. **Port second.**

### 3. `@zosmaai/pi-llm-wiki` — Obsidian-style knowledge vault  ▸ **research-org pick**
- **Does:** Karpathy "LLM Wiki" pattern — ingests URLs/PDFs/markdown into an interconnected, Obsidian-
  compatible vault with wikilinks, full-text search, link-linting, layered personal (`~/.llm-wiki/`) +
  project (`.llm-wiki/`) recall. Ships an MCP server.
- **Targets:** rubric #9 (research organization), Axis 3 — *better fit for organizing research than for
  per-turn ctx efficiency.*
- **Adaptation:** *medium.* The vault + ingestion port cleanly; the MCP-server surface is unused by smolpi
  (no MCP client) — wire the search/ingest as direct tools instead. **Port third.**

> ⚠ **Three memory layers, one 4096-token window.** memctx + hermes-memory + llm-wiki can all inject
> context simultaneously and re-bloat the window they're meant to save. Stage them one at a time and
> **measure tokens/turn between each** (rubric #3 signal); cap total injected memory budget.

### 4. `pi-delegate` — subagent isolation
- **Does:** spawns a fresh child agent for a sub-task (effort: fast/balanced/smart) and returns **only the
  distilled result**, keeping the parent context clean. 0 deps. The notes' subagent-isolation pattern.
- **Targets:** rubric #5,#9, Axis 2/3. Strong fit for "complex coding/debug and research organization."
- **Adaptation:** *medium.* In smolpi a "child agent" = a second `agentLoop()` instance with its own
  `messages[]`; needs the multi-step loop fix first (see caveat below). Implement as a `[delegate:TASK]`
  tool that runs a bounded sub-loop and returns its final answer.

### 5. `pi-thread-engine` — multi-thread orchestration  ▸ **heaviest, partial**
- **Does:** 7 thread types — P (parallel 5–10 tasks), C (checkpoint w/ human verify), F (fusion across
  models), B (branch: scout→plan→build→review), Z (zero-touch auto-deploy on pass), L (long-running, up to
  26 h), Stories (auto-decompose). Includes a `/threads` TUI dashboard.
- **Targets:** rubric #5,#9; the planning/parallelism gaps.
- **Adaptation:** *hard / partial.* Port a **reduced subset**: **P-thread** (parallel independent
  sub-tasks) and **C-thread** (checkpoint) map onto delegate + a gate. The `/threads` TUI doesn't fit
  smolpi's stdin REPL. ⚠ **Do NOT wire L-thread (26 h autonomous) or Z-thread (auto-deploy)** without
  rubric-#8 guardrails — high blast radius on an agent with unrestricted `[sh:]`. **Defer or subset.**

### 6. `pi-share-redacted-gist` — session → redacted dataset  ▸ **LOW, gated**
- **Does:** reads the persisted session file, redacts secrets (detect-secrets-style plugins; scrubs
  `.env`/SSH/cloud payloads + bash output), then **publishes to GitHub Gist and/or Hugging Face datasets**
  (needs `gh` auth or `HF_TOKEN`).
- **Targets:** rubric #6 (trace-driven evolution — turn sessions into eval/finetune data), Axis 4.
- **Adaptation:** *medium*, but ⚠ **off-machine data egress.** Wire the redact+export locally; keep the
  *publish* step behind an explicit per-invocation opt-in flag. **Do not run during break-testing.**

---

## Recommended staging order

1. **Compat host** (`agent/extensions/host.ts`) — tool registration + context-injection hook + persist hooks.
2. **pi-memctx** (HIGH, clean) → measure tokens/turn.
3. **Umi soul** into `.pi/APPEND_SYSTEM.md` (HIGH persona) → see plan §D4.
4. **pi-hermes-memory** (HIGH) → measure; ensure it doesn't fight memctx.
5. **pi-delegate** (unlocks coding/debug + research-org) — requires the loop fix.
6. **@zosmaai/pi-llm-wiki** (research-org) → measure.
7. **pi-thread-engine** subset (P + C only), guardrailed.
8. **pi-share-redacted-gist** — export wired, publish gated off.

## Prerequisite the extensions assume but smolpi lacks
`pi-delegate` and `pi-thread-engine` both assume an agent that can take **multiple autonomous steps**.
smolpi's loop does one tool-call + one follow-up then waits for the human (`index.ts:140–161`), and
crashes on any tool error (`index.ts:167`). **Fix the loop (iterate to `[done]`, isolate tool errors)
before** delegate/threads can do anything useful. This is tracked as the highest-leverage change in the
weakness audit.
