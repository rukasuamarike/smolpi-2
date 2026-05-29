# E2E Test Findings — 2026-05-29

Test session: `doctor.sh` preflight → live agent probes → direct LLM quality probes → parsing unit tests.  
Model: Gemma 4 E4B IQ2_M on llama.cpp CUDA (RTX 5080). Agent: `bun run agent/index.ts`.

---

## Preflight (doctor.sh)

**21 ok · 1 warning · 0 failures**

The one warning: `bun not on host PATH` — bun is at `~/.bun/bin/bun` and not in the default `$PATH`, so `doctor.sh` misdetects it. All other checks pass: smolvm 0.8.0, llama-server with CUDA GPU, model file present, LLM responding, VM exists with `.pi` writable mount, extension shims installed, MCP bridge ready.

**Minor**: `pi-agent` binary in repo root is the smolmachines VM runner (smolvm CLI), **not** the agent. Running `AGENT_TASK=... ./pi-agent` silently exits 0. Nothing in `doctor.sh` or `README` flags this naming confusion.

---

## Parsing (19/19 pass)

All `parseAction` edge cases pass: `<sh>`, `<browse>`, `<done/>`, `<tool>`, legacy `[sh:]`/`[browse:]` fallback, earliest-action-wins, done-beats-sh-in-same-reply, multiline, malformed. No regressions.

---

## Model Quality Probes (direct LLM, no agent harness) — 5/8 pass

These hit the LLM directly with a minimal system prompt, not through the full agent loop.

| # | Case | Result | Notes |
|---|------|--------|-------|
| 1 | `sh elicit: ls` | **PASS** | `<sh>ls</sh>` |
| 2 | `sh elicit: grep` | **PASS** | `<sh>grep -r "parseAction" .</sh>` |
| 3 | `pure knowledge: done` | **FAIL** | Answered correctly but no `<done/>` (works fine inside agent harness — null action terminates cleanly) |
| 4 | `no double action` | **FAIL** | `<sh>echo hello</sh> <done/>` in same reply — violates "one action per reply" constraint. Harness correctly picks `done` and skips the sh. But intent (run echo) is lost. |
| 5 | `math: 17*13` | **PASS** | `221` |
| 6 | `refusal: harmful` | **PASS** | Empty reply (refuses) |
| 7 | `action format: sh tag` | **PASS** | `<sh>echo hello</sh>` |
| 8 | `done self-closing` | **FAIL** | `I am ready.` — ignored the explicit `<done/>` instruction without the agent system prompt |

Cases 3, 4, 8 only manifest when testing the bare LLM; inside the agent harness all three resolve correctly.

---

## Live Agent Probes

### P1 — sh elicit: find TS files ✅
- Emitted `<sh>find agent/ -name "*.ts" -type f</sh>` → executed → summarized → `<done/>`
- 2 LLM calls · avg 1126ms · correct result
- `browse` capability absent (browser39 not in host PATH) — system prompt shows no WEB group

### P2 — pure knowledge (no tool needed) ✅
- Answered directly, included `<done/>`, 1 LLM call · 1113ms
- No spurious `<sh>` emitted

### P3 — error recovery: nonexistent file ⚠️
- `<sh>head -n 3 /tmp/...nonexistent.txt</sh>` → `[exit 1] head: cannot open ...`
- Next reply: `<done/>` — harness terminated cleanly, no crash ✅
- **Issue**: model emitted bare `<done/>` with zero explanation. User gets no feedback that the file didn't exist or why the task couldn't be completed. No attempt to create the file, suggest alternatives, or report the error.

### P4 — multi-step with self-correction ✅ (with note)
- Step 1: `find agent/ -name "*.ts" -type f` → file list ✅
- Step 2: `find agent/ ... -exec wc -l {} \;\` → **[exit 1]** (`find: missing argument to -exec`) — double-escaped semicolon ⚠️
- Step 3: self-corrected to `-exec wc -l {} +` → got full counts including `1939 total` ✅
- Step 4: summarized + `<done/>` ✅
- 4 LLM calls · avg 2203ms (latency growth as context grows — expected) ✅

### P5 — MCP tool call (cold start, no hint) ❌
- Step 1: `<tool name="mcp_list">{"query":"available_tools"}` → `ERROR: unknown tool "mcp_list"` — hallucinated tool name
- Step 2: `<tool name="mcp">{"tool":"browser39","args":"browse",...}` → `args must be a valid JSON string; got: browse` — wrong args format
- Step 3: `<tool name="mcp">{"tool":"browser39","params":{...}}` → `unknown tool "browser39"` — wrong field name
- Hit 3-step budget with 0 successful tool calls
- **Root cause**: see Issue #3 below (description truncation)

### P6 — step budget exhaustion ✅
- Graceful: `(stopped: hit 2-step budget — refine the task or raise AGENT_MAX_STEPS)` ✅
- **Note**: model chose `wc -l` on one file at a time instead of `wc -l agent/*.ts` — inefficient strategy for multi-file counting

### P7 — streaming mode ✅
- `avg TTFT 96ms` · `streaming calls: 1/1` · 342ms total for simple math
- Non-streaming same query would take ~466ms — streaming wins on perceived latency

### P8 — double action in live agent ✅
- When prompted "Run echo hello, then say you are done" the model correctly split across turns: `<sh>echo hello</sh>` → observation → `<done/>`
- No double-action issue in full multi-turn agent context (only in bare LLM calls)

### P9 — MCP list then use ⚠️
- Step 1: `<tool name="mcp_list">` → ERROR (hallucinated name)
- Step 2: `<tool name="mcp">{"args":["list_servers"]}` → listing appeared! browser39 shown as OFFLINE ✅
- Step 3: retried with OFFLINE server → same error
- Step 4: `<done/>` — accepted gracefully
- **Inconsistency**: `args: ["list_servers"]` (array) returned a useful response even though the bridge spec says `args` should be a JSON string. The bridge code at `bridge.ts:265` tolerates object/array form. So the tool is more forgiving than advertised.

### P10 — parseAction harness edge cases (Python mirror) ✅
- All 7 cases pass: sh+done same reply → done wins; earliest of sh/browse wins; null action → None

### P11 — browse → curl fallback ✅ (impressive adaptation)
- `<browse>https://example.com</browse>` → `ERROR: Executable not found in $PATH: "browser39"` ✅ (correct error, not crash)
- Model adapted: `<sh>curl https://example.com</sh>` → got the HTML ✅
- `<done/>` ✅
- **Note**: model is shown `<browse>` in the Acting section even though browse is not in the active capabilities list (browser39 absent). This teaches it a broken tool on the host.

### P12 — null action (no done tag) ✅
- Model said `hello world` without any tags
- `stop_reason: no_action` logged ✅, task ended cleanly, exit 0

---

## Issues & Friction Log

### Issue 1 — `<browse>` shown unconditionally in Acting section (LOW)

**Where**: `agent/index.ts` lines ~80–85, `generatePrompt()` — the "Acting" section always adds:
```
- Fetch a URL as Markdown:
  <browse>https://example.com</browse>
```
…regardless of whether `browser39` is in PATH.

The `browse` capability entry is only added to the prompt if it passes `isAvailable()`, but the `<browse>` example in "Acting" is always there. On the host (where browser39 is guest-only), the model learns a broken action format. When it fails, it adapts (curl fallback) but wastes a step.

**Fix**: gate the browse lines in the "Acting" section on the same `browse` capability being active.

---

### Issue 2 — Silent error termination without user feedback (MEDIUM)

**Where**: model behavior, reproduced in P3.

When a tool fails and there's no obvious recovery action, the model emits `<done/>` with no human-readable explanation. The user sees no output between the error observation and the `✓ done` line. For P11 (browse fail → curl) the model adapted; for P3 (nonexistent file) it silently quit.

**Trigger**: "Show me the first 3 lines of /tmp/definitely_nonexistent_file_xyz.txt"  
**Behavior**: `[exit 1]` → (reply: `<done/>`)  
**Expected**: at minimum, a sentence like "The file does not exist — cannot show its contents."

**Fix**: cannot be fixed in the harness alone (it's model behavior). Could add a few-shot example to the system prompt for "graceful failure" → explain + done.

---

### Issue 3 — MCP proxy tool description truncated at 140 chars (HIGH for MCP usability)

**Where**: `agent/extensions/host.ts:310`
```ts
return { name: td.name, args, description: desc.slice(0, 140) };
```

The MCP bridge's proxy tool has a rich description:
```
Bridge to MCP servers (...). Verbs: {} lists servers+tools; {"search":"keywords"} finds tools;
{"describe":"toolName"} shows a tool's schema; {"tool":"toolName","args":"{...json...}"} CALLS a tool
(args is a JSON STRING); {"connect":"server"} (re)connects.
```

After `.slice(0, 140)` the model sees only:
```
Bridge to MCP servers (configured: browser39; ...). Verbs: {} lists servers+to
```

The Verbs section — the entire calling convention — is truncated. The model has no idea how to call a tool (`{"tool":"name","args":"{...}"}`) or that `args` must be a JSON string. It guesses, fails, and burns through its step budget.

**Observed**: P5 exhausted all 3 steps with 0 successful calls. P9 succeeded only because `args: ["list_servers"]` happens to be tolerated by the bridge's object-fallback path.

**Fix**: Increase the slice cap for MCP proxy tool descriptions specifically, or put the critical Verbs line first (so the first 140 chars contains the invocation pattern rather than the preamble). Or split into `description` (short) + `usage` (examples, shown only in tool call context).

---

### Issue 4 — Infrequent shell escape errors (self-corrects) (LOW)

**Where**: P4, model generated `find ... -exec wc -l {} \;\` — the `\;` should work inside `bash -c` but an extra trailing `\` caused "missing argument to -exec".

The model self-corrected to `-exec wc -l {} +` on the next step. No harness bug, but shows the 4B model occasionally generates subtle command-line syntax errors under complex invocations.

---

### Issue 5 — Latency grows with context depth (LOW/EXPECTED)

| Steps | Prompt tokens | Avg LLM latency |
|-------|---------------|-----------------|
| 1 (simple) | 45 | 342ms |
| 1 (with system) | ~835 | 466ms |
| 2 | ~870 | 1113–1126ms |
| 4 | ~970 | 2203ms |

Context accumulates across steps; latency climbs roughly linearly with token count. The sliding-window `trimContext()` (CTX_CHAR_BUDGET=16000) prevents blowup but doesn't compress — once older observations are trimmed, the model loses that history.

**KV cache works**: `cached_tokens: 780` of 835 (93%) on repeated system prompt — llama.cpp is caching the stable prefix. Sessions can reuse this.

---

### Issue 6 — `bun` PATH miss in doctor.sh (LOW/COSMETIC)

`bun` is at `~/.bun/bin/bun` but not in the default `$PATH` that `doctor.sh` checks via `have()` (which uses `command -v`). Doctor warns "bun not on host" when it's actually present. Should check `~/.bun/bin/bun` as a fallback, or note it in the fix suggestion.

---

### Issue 7 — `pi-agent` binary name collision (INFO/DOC)

The root-level `pi-agent` binary is the smolmachines VM runner (`smolvm`-style CLI with `run`, `start`, `exec`, `shell` subcommands). Running `AGENT_TASK=... ./pi-agent` does nothing (exits 0). A developer testing with `./pi-agent` will get silent no-ops.

The actual agent entrypoint is `~/.bun/bin/bun run agent/index.ts` (or via `scripts/start-agent.sh` inside the VM). This should be called out more clearly in `SETUP.md`.

---

### Issue 8 — Step-budget efficiency: one file at a time (LOW/MODEL)

When counting lines across multiple files (P6), the model starts with one `wc -l` per file instead of `wc -l agent/*.ts` or `find -exec wc -l {} +`. With a tight `AGENT_MAX_STEPS`, this exhausts the budget before all files are counted.

Not a harness bug, but the few-shot examples in the system prompt only show `rg` and `cat`-style single-step patterns. A multi-file aggregation example would help.

---

## Summary Table

| # | Issue | Severity | File | Status |
|---|-------|----------|------|--------|
| 1 | `<browse>` shown in Acting even when browser39 absent | LOW | `agent/index.ts` | Open |
| 2 | Silent `<done/>` on tool error — no user feedback | MEDIUM | model behavior | Open |
| 3 | MCP tool description truncated at 140 chars | HIGH | `agent/extensions/host.ts:310` | Open |
| 4 | Occasional shell escape syntax error (self-corrects) | LOW | model behavior | Open |
| 5 | Latency grows with context (expected, no fix yet) | LOW | architecture | Open |
| 6 | `bun` PATH miss in doctor.sh | LOW | `scripts/doctor.sh` | Open |
| 7 | `pi-agent` binary name confusion | INFO | doc/naming | Open |
| 8 | Step inefficiency: one-file-at-a-time strategy | LOW | model/examples | Open |

**What's solid**: multi-step autonomous loop ✅, error isolation (no crashes) ✅, self-correction on tool errors ✅, streaming TTFT 96ms ✅, KV cache hit 93% ✅, parseAction 19/19 ✅, null-action + done termination ✅, browse→curl fallback adaptation ✅, graceful step-budget message ✅.

**Highest-leverage fix**: Issue 3 (MCP description truncation). It completely breaks MCP tool calling from cold start. Either raise the 140-char cap for the MCP proxy tool specifically, or restructure the description to front-load the calling convention.
