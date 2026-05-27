#!/bin/sh
set -e

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
