#!/usr/bin/env bash
# doctor.sh — preflight for the Pi-Agent Soup. Diagnoses why a run might fail and
# prints the exact fix for each problem. Run from the repo root: `make doctor`.
set -u
PASS=0; WARN=0; FAIL=0
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
warn() { printf "  \033[33m!\033[0m %s\n      ↳ %s\n" "$1" "$2"; WARN=$((WARN+1)); }
bad()  { printf "  \033[31m✗\033[0m %s\n      ↳ fix: %s\n" "$1" "$2"; FAIL=$((FAIL+1)); }
have() { command -v "$1" >/dev/null 2>&1; }

cd "$(dirname "$0")/.." || exit 1
[ -f .env ] && { set -a; . ./.env; set +a; }   # host-side overrides (see .env.example)
BRAIN_MODE="${BRAIN_MODE:-local}"  # local | external
case "$BRAIN_MODE" in
  local|external) ;;
  *) warn "unknown BRAIN_MODE=$BRAIN_MODE" "expected 'local' or 'external'; falling back to local checks"; BRAIN_MODE=local ;;
esac

echo "🥣 Pi-Agent Soup — preflight ($(pwd))"
echo "brain mode: $BRAIN_MODE"

echo "── host tools ──"
if have smolvm; then
  SMV="$(smolvm --version 2>/dev/null | awk '{print $2}')"
  if [ -n "$SMV" ] && [ "$(printf '%s\n0.8.0\n' "$SMV" | sort -V | head -1)" = "0.8.0" ]; then
    ok "smolvm $SMV"
  else
    warn "smolvm ${SMV:-?} is old (< 0.8.0)" "v0.8.0+ packs embed libkrun & self-extract (no system libkrun needed). upgrade: curl -fsSL https://smolmachines.com/install.sh | bash"
  fi
else
  bad "smolvm missing" "install Smolmachines (see SETUP.md)"
fi
have git     && ok "git"     || bad "git missing" "install git"
have git-lfs && ok "git-lfs" || warn "git-lfs missing" "smolvm/llama.cpp submodules ship libs via LFS; without it 'make setup' leaves them as pointer files. install: sudo apt install git-lfs && git lfs install"
have bun     && ok "bun $(bun --version 2>/dev/null)" || warn "bun not on host" "needed for 'make setup' (bun install wires extension shims + the MCP SDK, mounted into the guest) and to run the agent on the host: curl -fsSL https://bun.sh/install | bash"
# smolvm's linux release links GPU-enabled libkrun → libvirglrenderer needed at load time (CLI + packed binaries)
if ldconfig -p 2>/dev/null | grep -q 'libvirglrenderer\.so\.1'; then
  ok "libvirglrenderer (libkrun runtime dep)"
else
  warn "libvirglrenderer.so.1 missing" "smolvm's linux release links GPU-enabled libkrun; CLI & packed binaries need it. install: sudo apt install libvirglrenderer1"
fi
[ -n "$(ls -A smolvm 2>/dev/null)" ] && ok "smolvm submodule populated (vendored source)" || warn "smolvm submodule empty" "make setup  (vendored runtime source; needed only to build smolvm from source)"

echo "── host resources ──"
if have nproc; then
  ok "host CPU: $(nproc) logical cores"
else
  warn "host CPU: unknown" "install coreutils or check /proc/cpuinfo manually"
fi
if have free; then
  ok "host memory: $(free -h | awk '/^Mem:/ {print $2 " total, " $7 " available"}')"
else
  warn "host memory: unknown" "install procps or check /proc/meminfo manually"
fi
if have df; then
  ok "workspace disk: $(df -h . | awk 'NR==2 {print $4 " free of " $2 " (" $5 " used)"}')"
else
  warn "workspace disk: unknown" "install coreutils or check filesystem free space manually"
fi
GUEST_CPUS="$(awk -F= '/^[[:space:]]*cpus[[:space:]]*=/{gsub(/[[:space:]]/, "", $2); print $2; exit}' Smolfile 2>/dev/null || true)"
GUEST_MEM_MB="$(awk -F= '/^[[:space:]]*memory[[:space:]]*=/{gsub(/[[:space:]]/, "", $2); print $2; exit}' Smolfile 2>/dev/null || true)"
if [ -n "$GUEST_CPUS" ] && [ -n "$GUEST_MEM_MB" ]; then
  ok "Smolfile guest limits: ${GUEST_CPUS} CPU, ${GUEST_MEM_MB} MiB RAM"
else
  warn "Smolfile guest limits: unknown" "set cpus = N and memory = MiB in Smolfile so doctor can report guest headroom"
fi

echo "── brain: llama.cpp ──"
if [ "$BRAIN_MODE" = "external" ]; then
  warn "external brain mode: skipping local llama.cpp build checks" "doctor will require only an OpenAI-compatible /v1/models endpoint at LLM_HOST:LLM_PORT"
else
  if [ -n "$(ls -A llama.cpp 2>/dev/null)" ]; then ok "llama.cpp submodule populated"; else warn "llama.cpp submodule empty" "only needed to BUILD llama-server here; fine if you use an external build (LLAMA_SERVER/BRAIN_DIR) or a system one. populate: make setup"; fi

  LS=""
  for p in "${LLAMA_SERVER:-}" ./llama.cpp/build/bin/llama-server ./llama.cpp/llama-server "$(command -v llama-server 2>/dev/null || true)" /usr/local/bin/llama-server "${BRAIN_DIR:+$BRAIN_DIR/llama.cpp/build/bin/llama-server}"; do
    [ -n "$p" ] && [ -x "$p" ] && LS="$p" && break
  done
  if [ -n "$LS" ]; then
    ok "llama-server binary: $LS"
    LIBDIR="$(cd "$(dirname "$LS")" && pwd)"
    DEV="$(LD_LIBRARY_PATH="$LIBDIR" "$LS" --list-devices 2>&1)"
    if printf '%s' "$DEV" | grep -qiE 'error while loading shared libraries'; then
      bad "llama-server can't load its shared libraries" "run it via ./scripts/run-brain.sh (sets LD_LIBRARY_PATH), or rebuild llama.cpp"
    else
      ok "shared libraries load"
      if printf '%s' "$DEV" | grep -qiE 'cuda|metal|vulkan|hip|rocm|sycl'; then
        ok "GPU backend: $(printf '%s' "$DEV" | grep -ioE 'cuda|metal|vulkan|hip|rocm|sycl' | head -1)"
      else
        warn "no GPU backend (CPU only — slow)" "rebuild: cmake -B llama.cpp/build -S llama.cpp -DGGML_CUDA=ON (or -DGGML_METAL=ON / -DGGML_VULKAN=ON) && cmake --build llama.cpp/build -j --target llama-server"
      fi
    fi
  else
    bad "llama-server not built" "cmake -B llama.cpp/build -S llama.cpp -DGGML_CUDA=ON && cmake --build llama.cpp/build -j --target llama-server"
  fi
fi

echo "── brain: model ──"
if [ "$BRAIN_MODE" = "external" ]; then
  warn "external brain mode: skipping local model file checks" "the external server owns model loading; set LLM_MODEL to its served model id"
else
  MODELS_DIR="${MODELS_DIR:-./models}"
  if ls "$MODELS_DIR"/*.gguf >/dev/null 2>&1; then
    ok "model(s) in $MODELS_DIR: $(ls "$MODELS_DIR"/*.gguf | xargs -n1 basename | tr '\n' ' ')"
  elif [ -n "${BRAIN_DIR:-}" ] && ls "$BRAIN_DIR"/models/*.gguf >/dev/null 2>&1; then
    ok "model(s) in \$BRAIN_DIR/models: $(ls "$BRAIN_DIR"/models/*.gguf | xargs -n1 basename | tr '\n' ' ')"
  else
    bad "no .gguf in $MODELS_DIR${BRAIN_DIR:+ or \$BRAIN_DIR/models}" "drop a Gemma gguf into ./models (see README → Get a model), or set MODELS_DIR=… / BRAIN_DIR=…"
  fi
fi

echo "── brain: reachable ──"
LLM_HOST="${LLM_HOST:-localhost}"; LLM_PORT="${LLM_PORT:-8080}"
if curl -sf --connect-timeout 2 "http://$LLM_HOST:$LLM_PORT/v1/models" >/dev/null 2>&1; then
  ok "LLM (OpenAI API) responding on $LLM_HOST:$LLM_PORT"
else
  if [ "$BRAIN_MODE" = "external" ]; then
    bad "external LLM not reachable on $LLM_HOST:$LLM_PORT" "start LMStudio/llama.cpp/other OpenAI-compatible server, or set LLM_HOST/LLM_PORT/LLM_URL"
  else
    warn "no LLM on $LLM_HOST:$LLM_PORT" "start llama.cpp (./scripts/run-brain.sh) or LMStudio's server; override LLM_HOST/LLM_PORT (LMStudio defaults to 1234)"
  fi
fi

echo "── guest VM ──"
if smolvm machine ls 2>/dev/null | grep -q 'pi-agent-dev'; then ok "VM 'pi-agent-dev' exists"; else warn "no VM yet" "make machine-up && make machine-init && make machine-snapshot"; fi
grep -q '\.pi:/app/\.pi' Smolfile 2>/dev/null && ok "Smolfile mounts ./.pi (soul + extension config reach the guest)" || warn ".pi not mounted in Smolfile" "add \"./.pi:/app/.pi:ro\" to [dev].volumes so APPEND_SYSTEM.md / extensions.json load in the guest"

echo "── extensions (optional) ──"
if [ -f .pi/extensions.json ] && grep -q '"enabled": true' .pi/extensions.json 2>/dev/null; then
  if [ -e node_modules/@sinclair/typebox/package.json ] && [ -e node_modules/better-sqlite3/package.json ]; then
    ok "extension compat shims installed (memory/wiki tools will load)"
  else
    warn "extensions enabled but shims not installed" "run 'make setup' (or 'bun install') to wire the compat shims"
  fi
  [ -n "$(ls -A extensions/memctx 2>/dev/null)" ] && ok "extension submodules populated" || warn "extension submodules empty" "make setup  (git submodule update --init)"
  grep -q 'extensions:/app/extensions' Smolfile 2>/dev/null && ok "Smolfile mounts ./extensions + node_modules" || warn "extensions not mounted to guest" "add ./extensions and ./node_modules to Smolfile [dev].volumes"
else
  ok "no extensions enabled (base agent only)"
fi

echo "── MCP bridge (optional) ──"
if [ -f .pi/mcp.json ] && grep -q '"mcpServers"' .pi/mcp.json 2>/dev/null; then
  if [ -e node_modules/@modelcontextprotocol/sdk/package.json ]; then
    ok "MCP bridge ready (.pi/mcp.json + @modelcontextprotocol/sdk installed)"
  else
    warn "mcp.json present but MCP SDK not installed" "run 'make setup' (or 'bun install') to pull @modelcontextprotocol/sdk"
  fi
else
  ok "no MCP servers configured (.pi/mcp.json absent — browser still works via <browse>)"
fi

echo
echo "summary: ${PASS} ok · ${WARN} warnings · ${FAIL} failures"
if [ "$FAIL" -ne 0 ]; then
  echo "→ fix the ✗ items above, then re-run: make doctor"
  exit 1
fi
echo "→ ready. Run:  ./scripts/run-brain.sh   then   make machine-up && make machine-run"
