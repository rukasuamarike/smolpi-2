#!/usr/bin/env bash
set -euo pipefail

# Load host-side overrides from the repo-root .env (if present; see .env.example).
_ENV="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/.env"
[ -f "$_ENV" ] && { set -a; . "$_ENV"; set +a; }

PORT="${PORT:-${LLM_PORT:-8080}}"
HOST="0.0.0.0"
CTX_SIZE="${CTX_SIZE:-4096}"
MODELS_DIR="${MODELS_DIR:-./models}"

# ── Locate llama-server ──────────────────────────────────────
SEARCH_PATHS=(
    "${LLAMA_SERVER:-}"
    "./llama.cpp/build/bin/llama-server"
    "./llama.cpp/llama-server"
    "$(command -v llama-server 2>/dev/null || true)"
    "/usr/local/bin/llama-server"
    "${BRAIN_DIR:+$BRAIN_DIR/llama.cpp/build/bin/llama-server}"
)
# Tip: point BRAIN_DIR at an external checkout (expects
# $BRAIN_DIR/llama.cpp/build/bin/llama-server + $BRAIN_DIR/models), or set
# LLAMA_SERVER=/path/to/llama-server and MODELS_DIR=/path/to/models directly.

LLAMA_SERVER=""
for p in "${SEARCH_PATHS[@]}"; do
    if [[ -n "$p" && -x "$p" ]]; then
        LLAMA_SERVER="$p"
        break
    fi
done

if [[ -z "$LLAMA_SERVER" ]]; then
    echo "ERROR: llama-server not found."
    echo ""
    echo "Searched:"
    for p in "${SEARCH_PATHS[@]}"; do
        [[ -n "$p" ]] && echo "  - $p"
    done
    echo ""
    echo "Build it:"
    echo "  git clone https://github.com/ggerganov/llama.cpp.git"
    echo "  cd llama.cpp && cmake -B build && cmake --build build -j\$(nproc)"
    exit 1
fi

echo "Found: $LLAMA_SERVER"

# Co-locate shared libs with the binary. Handles a relocated build whose baked
# RUNPATH points at a stale absolute path (e.g. after moving the tree).
export LD_LIBRARY_PATH="$(cd "$(dirname "$LLAMA_SERVER")" && pwd)${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# ── Select a GGUF model (MODELS_DIR, else $BRAIN_DIR/models) ──
mapfile -t MODELS < <(find "$MODELS_DIR" -maxdepth 1 -name '*.gguf' -type f 2>/dev/null | sort)
if [[ ${#MODELS[@]} -eq 0 && -n "${BRAIN_DIR:-}" && -d "$BRAIN_DIR/models" ]]; then
    echo "No .gguf in $MODELS_DIR — falling back to \$BRAIN_DIR/models ($BRAIN_DIR/models)"
    MODELS_DIR="$BRAIN_DIR/models"
    mapfile -t MODELS < <(find "$MODELS_DIR" -maxdepth 1 -name '*.gguf' -type f 2>/dev/null | sort)
fi

if [[ ${#MODELS[@]} -eq 0 ]]; then
    echo "ERROR: No .gguf files found in $MODELS_DIR/${BRAIN_DIR:+ or \$BRAIN_DIR/models}"
    echo ""
    echo "Drop a .gguf into ./models/, or set MODELS_DIR=… or BRAIN_DIR=…, e.g.:"
    echo "  curl -L -o ./models/gemma-2-2b-Q4_K_M.gguf \\"
    echo '    "https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf"'
    exit 1
fi

if [[ ${#MODELS[@]} -eq 1 ]]; then
    MODEL="${MODELS[0]}"
    echo "Using only available model: $(basename "$MODEL")"
else
    echo ""
    echo "Available models:"
    for i in "${!MODELS[@]}"; do
        size=$(du -h "${MODELS[$i]}" | cut -f1)
        echo "  [$((i+1))] $(basename "${MODELS[$i]}") ($size)"
    done
    echo ""
    read -rp "Select model [1-${#MODELS[@]}]: " choice
    if [[ ! "$choice" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#MODELS[@]} )); then
        echo "Invalid selection."
        exit 1
    fi
    MODEL="${MODELS[$((choice-1))]}"
fi

# ── GPU backend detection ────────────────────────────────────
# llama-server only honors --n-gpu-layers if compiled with a GPU backend.
HAS_GPU_BACKEND=false
DEVICE_OUTPUT=""
if DEVICE_OUTPUT=$("$LLAMA_SERVER" --list-devices 2>&1); then
    if echo "$DEVICE_OUTPUT" | grep -qiE 'cuda|metal|vulkan|hip|rocm|sycl'; then
        HAS_GPU_BACKEND=true
    fi
fi

echo ""
echo "────────────────────────────────────────────────────"
echo "  GPU BACKEND DETECTION"
if $HAS_GPU_BACKEND; then
    echo "  ✓ GPU backend available:"
    echo "$DEVICE_OUTPUT" | sed 's/^/    /' | head -10
else
    echo "  ✗ No GPU backend in this llama-server build"
    echo ""
    echo "  Detected devices:"
    echo "$DEVICE_OUTPUT" | sed 's/^/    /' | head -5
    if [[ -n "${GPU_LAYERS:-}" ]]; then
        echo ""
        echo "  GPU_LAYERS=$GPU_LAYERS is set but will be IGNORED."
        echo "  Rebuild llama.cpp with a GPU backend:"
        echo ""
        echo "    NVIDIA :  cmake -B build -DGGML_CUDA=ON"
        echo "    AMD    :  cmake -B build -DGGML_HIP=ON"
        echo "    Vulkan :  cmake -B build -DGGML_VULKAN=ON"
        echo "    Apple  :  cmake -B build -DGGML_METAL=ON  (auto on macOS)"
        echo ""
        echo "    cmake --build build --config Release -j\$(nproc)"
        echo ""
        echo "  Then verify:"
        echo "    \$LLAMA_SERVER --list-devices"
    fi
fi
echo "────────────────────────────────────────────────────"
echo ""

# ── Build the command ────────────────────────────────────────
CMD=(
    "$LLAMA_SERVER"
    --host "$HOST"
    --port "$PORT"
    --model "$MODEL"
    --ctx-size "$CTX_SIZE"
)

if [[ -n "${GPU_LAYERS:-}" ]]; then
    if $HAS_GPU_BACKEND; then
        CMD+=(--n-gpu-layers "$GPU_LAYERS")
        echo "GPU offload: $GPU_LAYERS layers"
    else
        echo "WARN: GPU_LAYERS=$GPU_LAYERS ignored — llama-server has no GPU backend (CPU only)"
    fi
fi

echo "Starting: ${CMD[*]}"
echo "Endpoint: http://${HOST}:${PORT}"
echo ""

exec "${CMD[@]}"
