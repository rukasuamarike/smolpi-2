#!/bin/sh
set -e

echo "[1/5] Updating apt..."
apt-get update

echo "[2/5] Installing packages... (no Chromium — browser39 replaces it, see below)"
apt-get install -y --no-install-recommends \
    ca-certificates curl unzip git less \
    neovim fzf ripgrep btop haveged \
    bat fd-find jq \
    cowsay sl
rm -rf /var/lib/apt/lists/*

echo "[3/5] Installing bun..."
if ! command -v bun >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash
    ln -sf /root/.bun/bin/bun /usr/local/bin/bun
fi

echo "[3.5/5] Installing zoxide..."
if ! command -v zoxide >/dev/null 2>&1; then
    curl -sSfL https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | sh
    [ -x /root/.local/bin/zoxide ] && ln -sf /root/.local/bin/zoxide /usr/local/bin/zoxide
fi

echo "[3.7/5] Installing browser39 (Rust single binary, no Chromium)..."
if ! command -v browser39 >/dev/null 2>&1; then
    # TODO(reliability): browser39 is the agent's "Eyes" but this install is non-fatal (|| echo); a missing/failed install is only noticed inline in the [5/5] verify block or at first <browse>. Print a prominent degraded banner (or fail hard behind an opt-out) so absent Eyes is obvious at provision time. (README near-term #1 boring happy path; hyperportable)
    bun add -g @aquintanar/browser39 || echo "WARN: browser39 install failed; <browse> + MCP browser tools will be unavailable"
    [ -x /root/.bun/bin/browser39 ] && ln -sf /root/.bun/bin/browser39 /usr/local/bin/browser39
fi

echo "[4/5] Linking Debian-renamed binaries..."
# bat → batcat, fd → fdfind on Debian; cowsay/sl live in /usr/games
[ -x /usr/bin/batcat ] && ln -sf /usr/bin/batcat /usr/local/bin/bat
[ -x /usr/bin/fdfind ] && ln -sf /usr/bin/fdfind /usr/local/bin/fd
[ -x /usr/games/cowsay ] && ln -sf /usr/games/cowsay /usr/local/bin/cowsay
[ -x /usr/games/sl ] && ln -sf /usr/games/sl /usr/local/bin/sl

echo "[4.5/5] Configuring bash environment..."
cat > /root/.bashrc.smol <<'EOF'
# pi-agent-smol bash environment
export HISTSIZE=50000
export HISTFILESIZE=100000
export HISTCONTROL=ignoredups:erasedups
export HISTTIMEFORMAT='%F %T '
shopt -s histappend cmdhist 2>/dev/null

# Keep history across sessions
PROMPT_COMMAND='history -a; history -c; history -r'

# zoxide (smart cd)
command -v zoxide >/dev/null && eval "$(zoxide init bash)"

# Aliases
alias ll='ls -la'
alias cat='bat --paging=never --style=plain'
alias find='fd'

# Path additions
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
EOF

# Idempotent: only source-line once
grep -q '\.bashrc\.smol' /root/.bashrc 2>/dev/null || \
    echo '[ -f ~/.bashrc.smol ] && . ~/.bashrc.smol' >> /root/.bashrc

echo "[5/5] Verifying..."
printf "  %-15s %s\n" "bun:"           "$(bun --version 2>/dev/null || echo 'MISSING')"
printf "  %-15s %s\n" "browser39:"     "$(browser39 --version 2>/dev/null || command -v browser39 || echo 'MISSING')"
printf "  %-15s %s\n" "rg:"            "$(rg --version 2>/dev/null | head -1 || echo 'MISSING')"
printf "  %-15s %s\n" "fd:"            "$(fd --version 2>/dev/null || echo 'MISSING')"
printf "  %-15s %s\n" "bat:"           "$(bat --version 2>/dev/null || echo 'MISSING')"
printf "  %-15s %s\n" "fzf:"           "$(fzf --version 2>/dev/null || echo 'MISSING')"
printf "  %-15s %s\n" "jq:"            "$(jq --version 2>/dev/null || echo 'MISSING')"
printf "  %-15s %s\n" "zoxide:"        "$(zoxide --version 2>/dev/null || echo 'MISSING')"
printf "  %-15s %s\n" "nvim:"          "$(nvim --version 2>/dev/null | head -1 || echo 'MISSING')"
printf "  %-15s %s\n" "btop:"          "$(command -v btop || echo 'MISSING')"
printf "  %-15s %s\n" "cowsay:"        "$(command -v cowsay || echo 'MISSING')"
printf "  %-15s %s\n" "sl:"            "$(command -v sl || echo 'MISSING')"
printf "  %-15s %s\n" "agent:"         "$(ls /app/agent/index.ts 2>/dev/null || echo 'MISSING')"
echo ""
echo "Guest setup complete. Open a new shell or 'source ~/.bashrc' to pick up env changes."
