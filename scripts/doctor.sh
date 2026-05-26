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
echo "🥣 Pi-Agent Soup — preflight ($(pwd))"

echo "── host tools ──"
have smolvm && ok "smolvm" || bad "smolvm missing" "install Smolmachines (see HOST_SETUP.md)"
have docker && ok "docker" || bad "docker missing" "install Docker + buildx (see HOST_SETUP.md)"
have git    && ok "git"    || bad "git missing" "install git"
have go     && ok "go $(go version 2>/dev/null | awk '{print $3}')" || warn "go missing" "only needed for 'make build-go' (browser skill); the OCI image build doesn't use host go"
have bun    && ok "bun $(bun --version 2>/dev/null)" || warn "bun not on host" "only needed to run the agent OUTSIDE the VM; the guest installs bun via 'make machine-init'"

echo "── brain: llama.cpp ──"
if [ -n "$(ls -A llama.cpp 2>/dev/null)" ]; then ok "llama.cpp submodule populated"; else bad "llama.cpp submodule empty" "make setup   (git submodule update --init llama.cpp)"; fi

LS=""
for p in ./llama.cpp/build/bin/llama-server ./llama.cpp/llama-server "$(command -v llama-server 2>/dev/null || true)" /usr/local/bin/llama-server; do
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

echo "── brain: model ──"
if ls models/*.gguf >/dev/null 2>&1; then
  ok "model(s): $(ls models/*.gguf | xargs -n1 basename | tr '\n' ' ')"
else
  bad "no .gguf in ./models" "mkdir -p models && download a Gemma gguf into it (see README → Get a model)"
fi

echo "── brain: reachable ──"
if curl -sf --connect-timeout 2 http://localhost:8080/health >/dev/null 2>&1; then
  ok "llama-server responding on localhost:8080"
else
  warn "brain not running on :8080" "start it: ./scripts/run-brain.sh"
fi

echo "── guest VM ──"
if smolvm machine ls 2>/dev/null | grep -q 'pi-agent-dev'; then ok "VM 'pi-agent-dev' exists"; else warn "no VM yet" "make machine-up && make machine-init && make machine-snapshot"; fi
grep -q '\.pi:/app/\.pi' Smolfile 2>/dev/null && ok "Smolfile mounts ./.pi (soul + extension config reach the guest)" || warn ".pi not mounted in Smolfile" "add \"./.pi:/app/.pi:ro\" to [dev].volumes so APPEND_SYSTEM.md / extensions.json load in the guest"

echo
echo "summary: ${PASS} ok · ${WARN} warnings · ${FAIL} failures"
if [ "$FAIL" -ne 0 ]; then
  echo "→ fix the ✗ items above, then re-run: make doctor"
  exit 1
fi
echo "→ ready. Run:  ./scripts/run-brain.sh   then   make machine-up && make machine-run"
