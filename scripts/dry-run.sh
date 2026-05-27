#!/usr/bin/env bash
set -euo pipefail

VM_NAME="pi-agent-dev"
SMOLFILE="Smolfile"
CLEAN=false

usage() {
    echo "Usage: $0 [--clean]"
    echo ""
    echo "  --clean   Tear down existing machine before starting fresh"
    echo ""
    echo "Without --clean, creates only if the machine doesn't exist."
    exit 0
}

[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && usage
[[ "${1:-}" == "--clean" ]] && CLEAN=true

step() { echo ""; echo "==> $1"; }

# ── Clean slate ──────────────────────────────────────────────
if $CLEAN; then
    step "Clean slate: tearing down ${VM_NAME}"
    smolvm machine stop --name "$VM_NAME" 2>/dev/null || true
    smolvm machine delete -f "$VM_NAME" 2>/dev/null || true
    echo "    Done."
fi

# ── Step 1: Create machine ──────────────────────────────────
step "Step 1/4: Create machine from ${SMOLFILE}"
if smolvm machine ls 2>/dev/null | grep -q "$VM_NAME"; then
    echo "    ${VM_NAME} already exists, skipping create."
else
    smolvm machine create -s "$SMOLFILE" "$VM_NAME"
fi

# ── Step 2: Start machine ───────────────────────────────────
step "Step 2/4: Start machine (init commands will run on first boot)"
echo "    This may take a few minutes on first run (apt-get + bun install + browser39)."
echo "    Ctrl+C to cancel if it hangs."
smolvm machine start --name "$VM_NAME"

# ── Step 3: Verify ──────────────────────────────────────────
step "Step 3/4: Verify guest environment"
echo "    Checking bun..."
smolvm machine exec --name "$VM_NAME" -- which bun && echo "    OK: bun found" || echo "    WARN: bun not found"

echo "    Checking browser39..."
smolvm machine exec --name "$VM_NAME" -- sh -c 'command -v browser39 || browser39 --version' && echo "    OK: browser39 found" || echo "    WARN: browser39 not found (install via 'bun add -g @aquintanar/browser39')"

echo "    Checking agent mount..."
smolvm machine exec --name "$VM_NAME" -- ls /app/agent/index.ts && echo "    OK: agent source mounted" || echo "    WARN: agent source not found at /app/agent/"

echo "    Checking env..."
smolvm machine exec --name "$VM_NAME" -- sh -c 'echo "LLM_URL=$LLM_URL"'
smolvm machine exec --name "$VM_NAME" -- sh -c 'echo "LLM_MODEL=$LLM_MODEL"'
smolvm machine exec --name "$VM_NAME" -- sh -c 'echo "BROWSER_BIN=$BROWSER_BIN"'

# ── Step 4: Summary ─────────────────────────────────────────
step "Step 4/4: Machine status"
smolvm machine ls

echo ""
echo "────────────────────────────────────────────────"
echo "  All checks passed. Next steps:"
echo ""
echo "  Shell:   make machine-exec"
echo "  Agent:   make machine-run"
echo "  Stop:    make machine-down"
echo "────────────────────────────────────────────────"
