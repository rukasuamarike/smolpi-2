#!/usr/bin/env bash
# setup.sh — one-shot, semi-interactive onboarding for pi-agent-smol.
#
# After cloning the repo:
#     ./scripts/setup.sh            # or: make setup
#     ./scripts/setup.sh --yes      # assume yes to every prompt
#     ./scripts/setup.sh --dry-run  # show what it would do, change nothing
#
# It walks you through: host deps (apt) → submodules → smolvm runtime (latest
# release) → agent deps (bun) → locating the brain → preflight. Each step
# prompts before doing anything heavy or privileged; sensible defaults let you
# hold Enter through it. NOT `set -e`: an optional step failing (e.g. no sudo)
# warns and continues instead of aborting the whole setup.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

ASSUME_YES=0; DRY=0
for a in "$@"; do case "$a" in
  --yes|-y) ASSUME_YES=1 ;;
  --dry-run|-n) DRY=1 ;;
  -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
esac; done
[ -t 0 ] || ASSUME_YES=1   # piped/non-interactive stdin → take defaults

B=$'\033[1;36m'; G=$'\033[32m'; Y=$'\033[33m'; X=$'\033[31m'; Z=$'\033[0m'
say()  { printf '\n%s==>%s %s\n' "$B" "$Z" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$Z" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$Z" "$*"; }
err()  { printf '  %s✗%s %s\n' "$X" "$Z" "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
run()  { if [ "$DRY" = 1 ]; then printf '  %s[dry-run]%s %s\n' "$Y" "$Z" "$*"; else "$@"; fi; }
ask()  { # ask "Question?" <Y|N default> → 0 = yes
  local q="$1" def="${2:-Y}" ans hint
  [ "$def" = Y ] && hint="Y/n" || hint="y/N"
  if [ "$ASSUME_YES" = 1 ]; then printf '  %s [%s] → %s\n' "$q" "$hint" "$def"; [ "$def" = Y ]; return; fi
  read -rp "  $q [$hint] " ans; ans="${ans:-$def}"
  case "$ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# ── fold-in: install a smolvm release (default latest) ──────────────────────
install_smolvm() { # [version]
  local ver="${1:-}" asset body base tarball tmp dest
  local binlink="${SMOLVM_BIN:-$HOME/.local/bin/smolvm}" prefix="${SMOLVM_PREFIX:-$HOME/.local/share}"
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)  asset=linux-x86_64 ;;
    Darwin-arm64|Darwin-x86_64) asset=darwin-arm64 ;;
    *) err "unsupported platform $(uname -s)-$(uname -m)"; return 1 ;;
  esac
  if [ -z "$ver" ]; then
    body="$(curl -fsSL https://api.github.com/repos/smol-machines/smolvm/releases/latest)" \
      || { err "GitHub API request failed"; return 1; }
    # capture-then-parse (avoids curl SIGPIPE under pipefail with grep -m1)
    ver="$(printf '%s\n' "$body" | grep '"tag_name"' | head -1 | sed -E 's/.*"v?([^"]+)".*/\1/')"
  fi
  ver="${ver#v}"; [ -n "$ver" ] || { err "could not resolve smolvm version"; return 1; }
  base="https://github.com/smol-machines/smolvm/releases/download/v$ver"
  tarball="smolvm-$ver-$asset.tar.gz"
  if [ "$DRY" = 1 ]; then warn "[dry-run] would install smolvm v$ver → $binlink"; return 0; fi
  tmp="$(mktemp -d)"
  printf '  downloading smolvm v%s …\n' "$ver"
  curl -fSL "$base/$tarball" -o "$tmp/$tarball" || { rm -rf "$tmp"; err "download failed (v$ver?)"; return 1; }
  if curl -fsSL "$base/checksums.sha256" -o "$tmp/sums" 2>/dev/null; then
    ( cd "$tmp" && grep " .$tarball\$" sums | sha256sum -c - >/dev/null 2>&1 ) \
      && ok "checksum verified" || warn "checksum missing/mismatch (continuing)"
  fi
  tar -xzf "$tmp/$tarball" -C "$tmp" || { rm -rf "$tmp"; err "extract failed"; return 1; }
  dest="$prefix/smolvm-$ver"; mkdir -p "$prefix"; rm -rf "$dest"
  mv "$tmp/smolvm-$ver-$asset" "$dest"; rm -rf "$tmp"
  mkdir -p "$(dirname "$binlink")"; ln -sfn "$dest/smolvm" "$binlink"
  ok "installed smolvm v$ver → $binlink"
  case ":$PATH:" in *":$(dirname "$binlink"):"*) : ;; *) warn "$(dirname "$binlink") not on \$PATH — add it";; esac
}

say "pi-agent-smol setup  (root: $REPO_ROOT)$([ "$DRY" = 1 ] && echo "   ${Y}[DRY-RUN]${Z}")"

# ── 1) host deps via apt ────────────────────────────────────────────────────
say "1/6  Host dependencies"
need=()
have git-lfs || need+=(git-lfs)
ldconfig -p 2>/dev/null | grep -q 'libvirglrenderer\.so\.1' || need+=(libvirglrenderer1)
have mkfs.ext4 || need+=(e2fsprogs)
if [ "${#need[@]}" -eq 0 ]; then
  ok "git-lfs, libvirglrenderer1, e2fsprogs all present"
elif have apt-get; then
  warn "missing: ${need[*]}"
  warn "  (libvirglrenderer1 is required at load time by smolvm's GPU-linked libkrun)"
  if ask "Install them with sudo apt-get?" Y; then
    if [ "$DRY" = 1 ]; then warn "[dry-run] sudo apt-get install -y ${need[*]}"
    elif sudo apt-get update && sudo apt-get install -y "${need[@]}"; then ok "installed ${need[*]}"
    else err "apt install failed (no sudo?) — run later: sudo apt-get install -y ${need[*]}"; fi
  else warn "skipped — later: sudo apt-get install -y ${need[*]}"; fi
else
  warn "non-apt host — install yourself: ${need[*]}"
fi
have git-lfs && { [ "$DRY" = 1 ] && warn "[dry-run] git lfs install" || git lfs install >/dev/null 2>&1; } || true

# ── 2) submodules ───────────────────────────────────────────────────────────
say "2/6  Submodules  (extensions, smolvm source, MCP adapter)"
# Non-recursive on purpose: smolvm's nested submodules (libkrun/libkrunfw/
# smolvm-sdk) are SSH-only (smol-machines org) and unneeded — step 3 installs
# the smolvm *release binary*, not a from-source build.
mods=$(git config -f .gitmodules --get-regexp '\.path$' | awk '{print $2}')
if ! ask "Also pull the llama.cpp submodule? (large; skip if you run an external llama-server)" N; then
  warn "skipping llama.cpp (use a system/external llama-server — set LLAMA_SERVER or BRAIN_DIR for run-brain.sh)"
  mods=$(printf '%s\n' "$mods" | grep -vx 'llama.cpp')
fi
# shellcheck disable=SC2086
if [ "$DRY" = 1 ]; then warn "[dry-run] git submodule update --init $mods"
elif git submodule update --init $mods; then ok "submodules updated"
else warn "some submodules failed (see above) — non-fatal, continuing"; fi

# ── 3) smolvm runtime (>= 0.8.0) ────────────────────────────────────────────
say "3/6  smolvm runtime"
cur=""; have smolvm && cur="$(smolvm --version 2>/dev/null | awk '{print $2}')"
if [ -n "$cur" ] && [ "$(printf '%s\n0.8.0\n' "$cur" | sort -V | head -1)" = "0.8.0" ]; then
  ok "smolvm $cur (>= 0.8.0)"
  ask "Reinstall the latest anyway?" N && install_smolvm || true
else
  [ -n "$cur" ] && warn "smolvm $cur is < 0.8.0 (v0.8.0+ packs self-extract libkrun)" || warn "smolvm not installed"
  ask "Install the latest smolvm release now?" Y && install_smolvm || warn "skipped — re-run setup to install"
fi

# ── 4) agent deps (bun) ─────────────────────────────────────────────────────
say "4/6  Agent deps  (bun: extension shims + @modelcontextprotocol/sdk)"
mkdir -p models
if have bun; then run bun install && ok "bun install done"
else warn "bun not on host — install: curl -fsSL https://bun.sh/install | bash  (then re-run setup)"; fi

# ── 5) brain (llama-server + model) ─────────────────────────────────────────
say "5/6  Brain  (llama-server + a .gguf model)"
ls_bin=""
for p in "${LLAMA_SERVER:-}" ./llama.cpp/build/bin/llama-server "$(command -v llama-server 2>/dev/null||true)" /usr/local/bin/llama-server "${BRAIN_DIR:+$BRAIN_DIR/llama.cpp/build/bin/llama-server}"; do
  [ -n "$p" ] && [ -x "$p" ] && ls_bin="$p" && break
done
[ -n "$ls_bin" ] && ok "llama-server: $ls_bin" || warn "no llama-server found — build one: 'make brain' (auto-detects CUDA/Metal/Vulkan/CPU); or use LMStudio: 'make machine-run LLM_PORT=1234'; or set LLAMA_SERVER=… / BRAIN_DIR=…"
model=""; mdirs=("${MODELS_DIR:-./models}"); [ -n "${BRAIN_DIR:-}" ] && mdirs+=("$BRAIN_DIR/models")
for d in "${mdirs[@]}"; do
  m=$(find "$d" -maxdepth 1 -name '*.gguf' -type f 2>/dev/null | head -1); [ -n "$m" ] && model="$m" && break
done
[ -n "$model" ] && ok "model: $model" || warn "no .gguf found — drop one in ./models, or set MODELS_DIR=… / BRAIN_DIR=…"

# ── 6) preflight ────────────────────────────────────────────────────────────
say "6/6  Preflight"
run bash scripts/doctor.sh || true

say "Setup complete. To run:"
printf '    %s./scripts/run-brain.sh%s        # start the brain (GPU: GPU_LAYERS=99)\n' "$B" "$Z"
printf '    %smake machine-up%s               # build + provision the dev VM (installs browser39)\n' "$B" "$Z"
printf '    %smake machine-run%s              # drop into the agent\n' "$B" "$Z"
