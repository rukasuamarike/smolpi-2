# ============================================================
# Stage 1: Go builder — compile browser_skill
# ============================================================
FROM golang:1.22-bookworm AS go-builder

ARG TARGETARCH=amd64

WORKDIR /build
COPY browser/ ./
RUN go mod tidy && \
    CGO_ENABLED=0 GOARCH=${TARGETARCH} go build -ldflags="-s -w" -o /browser_skill browser_skill.go

# ============================================================
# Stage 2: Final image — Bun + Neovim + Chromium (headless)
# ============================================================
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Core packages + headless Chromium deps (no X11/GUI bloat)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip git \
    neovim fzf ripgrep btop \
    bat fd-find jq \
    cowsay sl \
    haveged \
    chromium \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxrandr2 libgbm1 libasound2 libpango-1.0-0 \
    libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# Debian renames bat→batcat, fd→fdfind; cowsay lives in /usr/games. Normalize all.
RUN ln -sf /usr/bin/batcat /usr/local/bin/bat && \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd && \
    ln -sf /usr/games/cowsay /usr/local/bin/cowsay && \
    ln -sf /usr/games/sl /usr/local/bin/sl

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Install zoxide
RUN curl -sSfL https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | bash
ENV PATH="/root/.local/bin:${PATH}"

# Copy Go browser skill binary
COPY --from=go-builder /browser_skill /usr/local/bin/browser_skill

# Copy agent source
WORKDIR /app
COPY agent/ ./agent/

# Bake the persona, extensions, and their compat shims into the image so the
# packed MicroVM is self-contained (the dev flow mounts these instead — Smolfile).
COPY .pi/ ./.pi/
COPY shims/ ./shims/
COPY extensions/ ./extensions/
COPY package.json bun.lock ./
RUN bun install --ignore-scripts || echo "WARN: extension shim install failed; base agent still runs"

# Shell config for agent-friendly terminal
RUN echo 'eval "$(zoxide init bash)"' >> /root/.bashrc && \
    echo 'export CHROME_BIN=/usr/bin/chromium' >> /root/.bashrc && \
    echo 'alias ll="ls -la"' >> /root/.bashrc

ENV CHROME_BIN=/usr/bin/chromium
ENV BROWSER_BIN=/usr/local/bin/browser_skill

COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "run", "agent/index.ts"]
