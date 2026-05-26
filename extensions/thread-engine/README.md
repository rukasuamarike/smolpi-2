# 🧵 pi-thread-engine

> *"When you start thinking in threads, you stop being a bottleneck and become an orchestrator."*
> — @IndyDevDan, [Thinking in Threads](https://agenticengineer.com/thinking-in-threads)

**Thread-Based Engineering** for [Pi Coding Agent](https://github.com/badlogic/pi-mono).
7 thread types + stories + fusion + zero-touch + full TUI dashboard.
Built on @IndyDevDan's framework from [agenticengineer.com](https://agenticengineer.com).

## Install

```bash
pi install npm:pi-thread-engine
```

## The Thread Framework

Everything starts with the base thread:

```
PROMPT → TOOL CALLS → REVIEW
  You      Agent       You
```

You show up at two nodes for maximum leverage. Your agent handles everything in between.

Then you multiply:

```
Thread Types
├── Base    → You → Agent → You (minutes)
├── P       → Parallel 5+ agents (hours)
├── C       → Checkpoint chains (high-stakes)
├── F       → Fusion 9 agents, pick winner
├── B       → Branch (orchestrator agents)
├── L       → Long-running 26hrs (days)
└── Z       → Zero-touch, no review (ultimate)
```

## Commands

| Command | Type | What |
|---------|------|------|
| `/threads` | Dashboard | TUI: 3-column status view, search, inline reply, keyboard nav |
| `/pthread` | P-Thread | N independent tasks in parallel |
| `/cthread` | C-Thread | Sequential phases with checkpoint reviews |
| `/bthread` | B-Thread | scout → plan → build → review pipeline |
| `/fthread` | F-Thread | Same prompt → N models → compare, pick winner |
| `/zthread` | Z-Thread | Autonomous + verification gate (ships only if tests pass) |
| `/lthread` | L-Thread | Extended autonomous run |
| `/story` | Stories | Auto-decompose goal into thread phases |
| `/agents` | Alias | Same as `/threads` — Claude muscle memory |

## Dashboard

Run `/threads` (or `/agents`) to open the TUI dashboard:

```
  🧵 Thread Dashboard
  ═══════════════════════════════════════════

  ⚡ Needs Input (2)
  ▸ t-001  ████████░░  needs_input  /fix bug in auth     → "password has special chars"
  ▸ t-003  ░░░░░░░░░  needs_input  /audit dependencies  → "found 3 vulnerable"

  ⚙ Working (3)
  ▸ t-002  ██████░░░░  running  /migrate database        ⏱ 4m 23s
  ▸ t-004  ████░░░░░░  running  /build API endpoints     ⏱ 2m 11s
  ▸ s-001  →scout→plan→build  running  /story add payments

  ✓ Done (4)
  ▸ t-005  ██████████  success  /refactor auth module     → "cleaned up 12 files"
  ▸ t-006  ██████████  success  /update docs             → "30 pages updated"
  ▸ t-007  ██████████  error    /deploy to prod          ✗ "missing env vars"

  nav=↑↓ exp=Enter rep=i srch=/ kill=k rev=r prune=p quit=q
```

**Keyboard shortcuts:**
- `↑↓` — navigate threads
- `Enter` — expand/collapse thread details
- `i` — inline reply (send message to blocked thread)
- `/` — search/filter threads
- `k` — kill selected thread
- `r` — review selected thread results
- `p` — prune (clear) finished threads
- `q` — quit dashboard

## Thread Types in Depth

### P-Thread — Parallel
Five in the terminal. Five to ten in the browser. Zero apologies.
— *Boris Cherny, creator of Claude Code*

```bash
/pthread "Review all PRs" --count 8
/pthread "Fix bug in auth" --count 3 --each
```

### C-Thread — Checkpoint Chains
High-stakes work needs verification at critical junctures.
Intentional chunking is a feature, not a bug.

```bash
/cthread "Migrate to new database" --phases scout,plan,build,test,deploy
```

### F-Thread — Fusion (pi-thread-engine unique)
Nine agents. Nine parallel futures. Pick the winner.

```bash
/fthread "Design the caching architecture" --count 5
/fthread "Refactor the auth module" --models claude,gpt-4o,gemini-pro
```

Best-of-N gives you confidence. Cherry-picking gives you quality.
Each agent runs in complete isolation — no cross-contamination.

### B-Thread — Branch/Meta-Agentic
When agents manage agents. You become an Orchestrator of Intelligence.

```bash
/bthread "Build the checkout flow"
```

Auto-runs: plan agent → scout → build → review → deploy

### L-Thread — Long-Running
A single prompt that ran 26 hours.

```bash
/lthread "Audit and fix all security vulnerabilities" --hours 24
```

### Z-Thread — Zero-Touch (pi-thread-engine unique)
Maximum earned trust. No review node. Ships only if verification passes.

```bash
/zthread "Fix all ESLint warnings" --verify "npm run lint"
/zthread "Add dark mode" --verify "npm test && npm run build"
```

This is NOT vibe coding. Z-threads are the opposite:
maximum earned trust through hundreds of iterations.

### Stories — Goal Decomposition (pi-thread-engine unique)
Auto-decompose a goal into thread phases. pi-thread-engine picks the right type for each.

```bash
/story "Add dark mode to the dashboard" --verify "npm test"
```

Auto-generates phases:
1. **Scout** (meta) — research the codebase
2. **Plan** (fusion) — 3 models brainstorm approaches  
3. **Decide** (checkpoint) — human picks the winner
4. **Build** (parallel) — implement across files
5. **Verify** (zero) — run tests

## LLM Tools

Use these inside any Pi prompt:

```typescript
thread_spawn({ type: "parallel", prompts: [...] })  // Start any thread type
thread_status({ id: "t-001" })                       // Check progress
thread_kill({ id: "t-001" })                         // Stop a thread
```

## The Core Four

Every thread runs on these four pillars. Invest in all of them:

| Pillar | Description | pi-thread-engine |
|--------|-------------|-----------------|
| **Context** | Right information (no more, no less) | `~/.pi-memory/` integration |
| **Model** | Capable of sustained reasoning | 324+ models via OpenRouter |
| **Prompt** | Crystal-clear agentic engineering | Structured commands |
| **Tools** | Self-verifying, comprehensive | 40+ pi-skills |

## Measuring Progress

You know you're improving at agentic coding when:

- **Width** ↑ — P-threads = 5x exploration per hour
- **Time** ↑ — L-threads = 10min → 8hrs autonomous work
- **Depth** ↑ — B-threads = one prompt → entire teams
- **Checkpoints** ↓ — Earned trust through evidence

> *The common denominator: increase tool calls per unit of your attention.*

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   pi-thread-engine                  │
├─────────────┬──────────────┬────────────────────────┤
│  Dashboard  │  Registry    │  Executor              │
│  (TUI v3)   │  (state)     │  (dispatch)            │
├─────────────┴──────────────┴────────────────────────┤
│  Commands: /threads /pthread /cthread /fthread     │
│            /bthread /zthread /lthread /story        │
├─────────────────────────────────────────────────────┤
│  Backends                                           │
│  ├─ pi-subagents (P/C/B threads)                   │
│  └─ native (F/Z/L threads, Stories)                 │
└─────────────────────────────────────────────────────┘
```

## Further Reading

- [Thinking in Threads](https://agenticengineer.com/thinking-in-threads) — @IndyDevDan
- [The Only Claude Code Competitor](https://agenticengineer.com/the-only-claude-code-competitor)
- [Compute Advantage Equation](https://agenticengineer.com/compute-advantage-equation)
- [Engineering with Exponentials](https://agenticengineer.com/state-of-ai-coding/engineering-with-exponentials)