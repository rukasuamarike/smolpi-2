# 🥣 The Pi-Agent Soup

> An experimental, hyper-minimal OCI MicroVM stack for AI agents.
> Created as a fun little experiment by Saichi.

**Status:** 📡 Eyes and Brain are linked · 🔁 autonomous multi-step loop · 🧠 pluggable memory.

---

## 🧪 The "Why"

Most AI agents are bloated, slow, and live in giant Docker containers that take 10 seconds to boot.
This project is the antidote: the speed of Go, the runtime efficiency of Bun, and the isolation of
MicroVMs — an agent that boots in milliseconds. Stretch goal: run the whole soup — agent **and** brain —
on an iPhone.

---

## 🏗️ The Stack

- **🛡️ Armor** — `smolvm` (Smolmachines) runs the agent in a `libkrun` MicroVM built from a Debian
  Bookworm-slim OCI image. No Docker daemon at runtime; boots in ms.
- **🧠 Brain** — `llama.cpp` serving **Gemma 4 E4B** (~2.7 GB Q4_K_M) on the host GPU, exposed as an
  OpenAI-compatible API. The guest reaches it on `localhost:8080` (WSL2 mirrored networking).
- **👁️ Eyes** — a Go + Chromedp browser skill compiled to one static binary; turns the open web into
  clean, token-efficient Markdown (no messy HTML to the LLM).
- **🛠️ Hands** — a Bun TypeScript agent (`agent/index.ts`) with an **autonomous multi-step loop**, a
  self-describing capability registry (`agent/capabilities.ts`), and an optional **extension host** for
  pluggable memory/knowledge tools.

---

## 🚀 Quick start

> Hardware-specific setup (CUDA / Metal / Vulkan / CPU, WSL2 vs native vs Apple Silicon) lives in
> [`SETUP.md`](./SETUP.md). **Whenever anything fails, run `make doctor`** — it checks every
> prerequisite and prints the exact fix.

```bash
# 0. Prereqs: smolvm (v0.8.0+), git, git-lfs, go, bun.
#    (git-lfs materializes the submodules' libkrun/libkrunfw; bun on the host
#     wires the extension shims; the guest also installs its own.)

# 1. Fetch submodules (brain + extensions) and wire extension shims; makes ./models
make setup                       # git submodule update --init --recursive + bun install

# 2. Build llama-server for your GPU (CUDA example; see SETUP.md for Metal/Vulkan/CPU)
cmake -B llama.cpp/build -S llama.cpp -DGGML_CUDA=ON
cmake --build llama.cpp/build -j --target llama-server

# 3. Get a model — drop a .gguf into ./models/ (see "Get a model" below)

# 4. Preflight — confirm everything is wired before booting
make doctor

# 5. Run
./scripts/run-brain.sh           # starts llama-server (GPU offload via GPU_LAYERS=99)
make machine-up                  # boot the MicroVM (first run builds it from the Smolfile)
make machine-init                # one-off: install guest packages (bun, ripgrep, …)
make machine-snapshot            # cache the configured VM for instant future boots
make test-brain                  # verify the guest can reach the brain
make machine-run                 # drop into the agent REPL
```

Future boots are just `./scripts/run-brain.sh` + `make machine-up && make machine-run` — the snapshot
brings the VM up in well under a second.

### Get a model
Any GGUF works; the default expects a Gemma file. Pick a quant that fits your VRAM and place it in
`./models/` (git-ignored — never committed):

```bash
mkdir -p models
# example (swap for your preferred Gemma GGUF + quant):
curl -L -o models/gemma-4-E4B-it-Q4_K_M.gguf "<huggingface-gguf-url>"
```
`run-brain.sh` auto-selects the only `.gguf` it finds, or prompts if there are several.

---

## 🤖 Using the agent

The loop runs **autonomously across steps** until it emits `<done/>`. Each step it takes **one** action:

| Action | Meaning |
|--------|---------|
| `<sh>cmd</sh>` | run a shell command (RUNS it; multi-line ok) |
| `<browse>url</browse>` | fetch a page as Markdown |
| `<tool name="…">{json}</tool>` | call a memory/knowledge tool (if extensions enabled) |
| `<done/>` | finished — give the final answer; nothing else runs |

- **Interactive:** `make machine-run` → type tasks, `/logs` for token stats, `exit` to quit.
- **One-shot / scripted:** set `AGENT_TASK="…"` to run a single task and print a token summary — used by
  the test harness, e.g. `AGENT_TASK='create /tmp/x and show it' bun run agent/index.ts`.
- **Robust by design:** tool errors are fed back as observations (the agent recovers instead of crashing),
  shell commands are timeout-bounded, and context is trimmed to fit the window.

### Extensions, soul & logs (experimental)
- **Memory/knowledge extensions** are vendored under `extensions/` (git submodules) and toggled in
  [`.pi/extensions.json`](./.pi/extensions.json). They give the agent model-callable memory: `pi-memctx`
  (local-markdown recall), `pi-hermes-memory` (cross-session facts), and `@zosmaai/pi-llm-wiki` (a
  knowledge vault). These are written for the pi.dev runtime; smolpi loads them through a small compat
  host using tracked shims under `shims/` (wired by `make setup` / `bun install`). `make doctor` verifies
  they're installed. See [`docs/EXTENSION_REVIEW.md`](./docs/EXTENSION_REVIEW.md).
- **Soul / persona** — drop persona text into `.pi/APPEND_SYSTEM.md`; it's appended to the system prompt.
- **/logs** — every LLM call is dumped as JSONL to `~/.pi/agent/logs/` with token usage + messages
  (post-processable into training data). `/logs` summarizes token efficiency.
- **delegate** — with `AGENT_EXPERIMENTAL=1`, the agent can fan out independent sub-tasks in parallel via
  `<tool name="delegate">{"tasks":[…]}</tool>`; see [`docs/ORCHESTRATION_DESIGN.md`](./docs/ORCHESTRATION_DESIGN.md).

> Deeper analysis lives in `docs/`: the harness rubric, the agent weakness audit, the extension review,
> and the break log.

---

## ⚙️ Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `LLM_URL` | `http://127.0.0.1:8080` | brain endpoint |
| `LLM_MODEL` | `gemma-4` | model id sent to the API |
| `GPU_LAYERS` | _(unset)_ | layers to offload (`run-brain.sh`); set `99` for full GPU |
| `CTX_SIZE` | `4096` | llama.cpp context window (`run-brain.sh`) |
| `AGENT_MAX_STEPS` | `12` | max autonomous steps per task |
| `SHELL_TIMEOUT_MS` | `60000` | kill a hung shell command |
| `CTX_CHAR_BUDGET` | `16000` | sliding-window context trim |
| `AGENT_TASK` | _(unset)_ | one-shot task (non-interactive) |
| `AGENT_EXPERIMENTAL` | _(unset)_ | `1` enables native parallel `delegate` |
| `PI_EXTENSIONS_CONFIG` | `/app/.pi/extensions.json` | extension toggle registry |
| `APPEND_SYSTEM_PATH` | `/app/.pi/APPEND_SYSTEM.md` | persona/system append |
| `WIKI_HOME` | `$HOME` | llm-wiki vault root (keeps it single-level) |

---

## 🔧 Troubleshooting

**First step is always `make doctor`.** Common failures:

| Symptom | Cause → fix |
|---------|-------------|
| `llama-server: error while loading shared libraries` | binary moved; its RUNPATH is stale → use `./scripts/run-brain.sh` (sets `LD_LIBRARY_PATH`) or rebuild |
| `ERROR: llama-server not found` | submodule empty / not built → `make setup` then the cmake build |
| `ERROR: No .gguf files in models/` | no weights → download a GGUF into `./models/` |
| GPU not used / very slow | `--list-devices` shows no backend → rebuild llama.cpp with `-DGGML_CUDA=ON` (or Metal/Vulkan) |
| `test-brain` / guest TIMEOUT | brain not on `0.0.0.0:8080`, or WSL2 mirrored networking off → start `run-brain.sh`; `make test-smol-net` diagnoses |
| Soul / extensions don't load in guest | `.pi` not reaching the guest → `Smolfile` `[dev]` must mount `./.pi:/app/.pi:ro` (doctor checks this) |
| Empty `/proc/net/tcp` in guest | not a bug — libkrun TSI proxies sockets at the syscall layer |

---

## ⚠️ Known quirks
- **Memory pressure** — a 4B model + headless Chromium on one host is tight; the Smolfile caps the guest
  at 4 GiB to leave the host GPU/`llama-server` headroom.
- **Apple Silicon** — Metal auto-enables at build time, so the default build yields a Metal-accelerated
  `llama-server` on M-series Macs.

## 🛣️ Roadmap
- [ ] **iPhone deployment** — Gemma 4 E4B Q2_K (~1.5 GB) fits iPhone 13/14; Q4_K_M fits 15 Pro+.
- [ ] **Learned orchestration** — choose parallel tool/skill combos by logged token efficiency
      (`docs/ORCHESTRATION_DESIGN.md`).
- [ ] **NPU offload** on Apple Silicon; **multi-agent** soups over a shared bridge.

## 👨‍🔬 Author
**Saichi** — experiments in making agents smol, fast, and dangerous.
