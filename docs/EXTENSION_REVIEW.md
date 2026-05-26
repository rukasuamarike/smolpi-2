# Extension Quality Review — six pi.dev packages vs the rubric

Source-level audit of each vendored extension against [`HARNESS_RUBRIC.md`](~/study/notes/HARNESS_RUBRIC.md).
Question answered: **do these extensions follow the good practices in `~/study/notes`?** Evidence is from
reading each repo's source (entrypoint, tools, hooks, tests, package.json), vendored under `extensions/`.

> TL;DR — Four of six are genuinely well-built (memctx, hermes-memory, delegate, llm-wiki: mostly L3).
> **`thread-engine` is the one to gate hard** (dead upstream repo, no tests, ungated autonomy).
> **`share-redacted-gist` is well-gated but publishes off-machine** — keep publish opt-in.

## Scorecard (level per rubric dimension; — = N/A)

| Extension | Ctx-eff #3 | Memory-state #3 | Tool design #4 | Planning/Orch #5/9 | Safety #8 | Verif #6 | Obs #7 | Provenance |
|-----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **pi-memctx** | **L3** | L2 | **L3** | — | **L3** | L3 (unit+e2e+CI) | L2 | **L3** |
| **pi-hermes-memory** | L2 | **L3** | **L3** | — | **L3** | L3 (unit+integ) | L2 | **L3** |
| **pi-delegate** | — | — | **L3** | **L3** isolation | **L3** | **L3** (66 + live eval) | L3 | L3 (Codeberg) |
| **@zosmaai/pi-llm-wiki** | L3 | L3 | L2+ | **L3** research-org | **L3** | L2+ (66, Vitest/CodeQL) | L3 | L3 |
| **pi-thread-engine** | — | — | L2 | **L3** design / **L2** safety | ⚠ **L2** ungated | ❌ **L0** no tests | L2 | ❌ **L0** repo 404 |
| **pi-share-redacted-gist** | — | — | — (cmd only) | L3 | **L1** gated | L3 | L2 | L3 |

---

## Per-extension verdicts

### pi-memctx — ✅ exemplary "ctx-efficient memory"
- **Good practice it nails:** measured token budgets (README benchmark: **80.8% fewer provider tokens,
  95% fewer tool calls, 66.9% faster** — reproducible via `benchmark/run.sh`); a "Memory Gateway" that
  judges sufficiency (`sufficient`/`partial`/`insufficient`) *before* injecting, so it doesn't re-bloat
  the window; secret blocklist before persist; only `@sinclair/typebox` as a runtime dep; unit + e2e + CI.
- **Gaps:** consolidation is pack-structure-implicit, not algorithmic (L2 memory-state); observability is
  opt-in debug snapshots, no metrics.
- **Verdict:** directly closes weakness Axis-3 / rubric #3. **Best first port.**

### pi-hermes-memory — ✅ strong learning + safety
- **Good practice it nails:** explicit memory state machine (memory/user/failure/project), correction
  detection, background-review nudge (every 10 turns / 15 tool calls), LLM-driven consolidation; **30+
  secret/threat patterns** with severity + `<memory-context>` injection fencing against prompt injection;
  comprehensive tests; explicit "ported from Nous Hermes" provenance.
- **Gaps:** token efficiency is qualitative (policy-only mode, no measured budget — L2); consolidation
  spawns a child `pi` and can fail/add latency.
- **Verdict:** complements memctx (facts/skills vs ctx-injection). ⚠ Two memory layers can fight — stage
  and measure (see redundancy note).

### pi-delegate — ✅ textbook subagent isolation
- **Good practice it nails:** fresh in-memory child, returns **only final text** (output truncated 2000
  lines/50 KB, full saved to temp), 15-min hard timeout, **recursion blocked via tool denylist**, effort→
  thinking-level mapping, AbortSignal, full usage/cost metadata returned; **66 tests + an opt-in live eval
  suite** comparing delegate-on vs delegate-off. Lean peer-deps only.
- **Gaps:** none material; child inherits parent FS access by design (parent owns write-delegation).
- **Verdict:** the notes' subagent-isolation pattern, implemented well. Unlocks coding/debug + research-org
  — **but needs smolpi's loop to support multiple steps first.**

### @zosmaai/pi-llm-wiki — ✅ disciplined knowledge vault
- **Good practice it nails:** 4-layer architecture with **ownership guardrails** (`raw/**` and `meta/**`
  write-blocked via `tool_call` hook; immutable source packets), layered personal+project recall,
  link-linting (orphans/broken links), event log + registry for observability, MCP server + bundled SKILL.
  Untrusted URL/PDF ingestion is shell-quoted + timeout-bounded and stored as data (not eval'd as prompt).
- **Gaps:** some tools take free-text params (L2+ tool design); guardrails themselves aren't unit-tested;
  no live ingestion security test. URL/PDF ingestion is still a prompt-injection *surface* to watch.
- **Verdict:** best fit for rubric #9 (research organization).

### pi-thread-engine — ⚠ powerful design, **gate hard / treat as untrusted**
- **Good practice it has:** clean registry state machine + event model; result distillation; checkpoint
  callback for chained threads; worktree isolation; `/threads` kill switch.
- **Failures against the rubric:**
  - ❌ **Provenance L0 (supply chain):** declared repo `github.com/arosstale/pi-threads` returns
    **404** — vendored from the npm tarball only; no commit history, no signatures, no upstream to audit.
  - ❌ **Verification L0:** **no test suite** at all. Parts are "ported from Grok CLI" (unvalidated).
  - ⚠ **Excessive agency (rubric #8):** **Z-Thread** (zero-touch) runs the write phase autonomously — the
    `--verify` command is a *post-hoc* ship gate, not a pre-flight approval, and is *optional*. **L-Thread**
    (long-running) has **zero** gates. No rate-limit, no budget cap, deny-by-default absent. On a harness
    with unrestricted `[sh:]`, that is the notes' "excessive agency" anti-pattern at maximum blast radius.
- **Verdict:** **do not enable by default.** If used, restrict to **P-thread (parallel)** + **C-thread
  (checkpoint)** only, behind the experimental toggle, and never wire Z/L-thread without a real PEP/PDP
  approval gate.

### pi-share-redacted-gist — ✅ well-gated, but it's the data-egress one
- **Good practice it nails:** mandatory attestation + interactive redaction review UI before publish;
  two-pass redaction (sensitive-file payloads → generic patterns → detect-secrets-style scanner with
  entropy detectors); live repo + tests + CHANGELOG.
- **Gaps / risks:** publishing is the whole point — data goes to **GitHub Gist (hardcoded `--public`)** and
  **HF datasets (default `public`)**, which is **irreversible**. `--yes` bypasses attestation in
  non-interactive mode; entropy thresholds are fixed defaults; `cat .env` via bash relies on the scanner
  catching it in output. No persistent publish audit log.
- **Verdict:** fine to vendor; **never auto-run.** Publish only behind explicit per-invocation opt-in;
  keep it off during any automated/break testing.

---

## Two cross-cutting cautions (straight from the notes)

1. **Memory redundancy → window re-bloat.** memctx + hermes-memory + llm-wiki each inject context. Three
   layers firing into smolpi's **4096-token** window will undo the savings each one advertises. Stage one
   at a time and measure tokens/turn (rubric #3). Cap a global injected-memory budget.

   **Measured** (same prompt, one LLM call, Umi soul loaded, via `/logs`):

   | Config | prompt tokens | injected memory |
   |--------|:---:|:---:|
   | base + soul (no memory) | 3271 | 0 |
   | + memctx | 3559 | ~1058 chars (~265 tok) |
   | + memctx **+ hermes-memory** | 4341 | ~4737 chars (~1184 tok) |

   memctx's gateway brief is cheap (+288 tok); **hermes-memory is ~3× heavier** (+782 tok on top). Combined
   injection ≈ **1184 tokens** — ~29% of a 4096 window, which is why staging now runs at 16k ctx. If both
   are kept, lower `policy.maxInjectedContextChars` and/or put hermes-memory in `policy-only` mode.
2. **Lethal trifecta amplified.** smolpi already has browse(untrusted) + `[sh:]` + net (see
   [`PI_AGENT_WEAKNESSES.md`](./PI_AGENT_WEAKNESSES.md) Axis-4). llm-wiki adds URL/PDF ingestion (more
   untrusted input) and gist adds external comms. Each is individually careful, but **together** they widen
   the exfiltration surface — exactly why the toggle system below is deny-by-default.

---

## Recommendation: deny-by-default toggle system (your "configure toggles" ask)

Classify extensions by trust and default-state. Implemented as `.pi/extensions.json` (see
[`EXTENSION_PLAN.md`](./EXTENSION_PLAN.md) for the loader contract):

| Tier | Extensions | Default | Rationale |
|------|------------|:------:|-----------|
| **Stable** | memctx, hermes-memory, delegate, llm-wiki | opt-in `enabled` | L3 quality, tested, safe |
| **Experimental** | thread-engine (P/C subset only) | **off**, requires `"experimental": true` | no tests, dead repo |
| **Egress (manual)** | share-redacted-gist | **off**, command-only, never autorun | irreversible publish |

This matches the rubric's #8 (deny-by-default, deliberate authorization) and #10 (curate a vetted registry
rather than enabling everything).
