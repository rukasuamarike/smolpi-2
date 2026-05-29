#!/bin/sh
set -e

# UTF-8 locale so TUI tools (btop, etc.) don't bail with "No UTF-8 locale
# detected". C.UTF-8 is always present in glibc — no locale-gen needed. The
# agent inherits this, and so do its `bash -c` <sh> child shells.
export LANG="${LANG:-C.UTF-8}"
export LC_ALL="${LC_ALL:-C.UTF-8}"

export LLM_URL="${LLM_URL:-http://127.0.0.1:8080}"
export LLM_MODEL="${LLM_MODEL:-gemma-4}"
export BROWSER_BIN="${BROWSER_BIN:-browser39}"
# llm-wiki appends ".llm-wiki" to its root, so point WIKI_HOME at the home dir
# (not ~/.llm-wiki) to get a single-level vault at $HOME/.llm-wiki.
export WIKI_HOME="${WIKI_HOME:-$HOME}"

echo "── pi-agent-smol ──"
echo "  LLM_URL:     ${LLM_URL}"
echo "  LLM_MODEL:   ${LLM_MODEL}"
echo "  BROWSER_BIN: ${BROWSER_BIN}"
echo ""

exec bun run /app/agent/index.ts
