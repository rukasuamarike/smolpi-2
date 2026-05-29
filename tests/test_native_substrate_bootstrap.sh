#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

backup=""
if [ -f .pi/progress.md ]; then
  backup="$(mktemp)"
  cp .pi/progress.md "$backup"
fi
cleanup() {
  if [ -n "$backup" ] && [ -f "$backup" ]; then
    cp "$backup" .pi/progress.md
    rm -f "$backup"
  else
    rm -f .pi/progress.md
  fi
}
trap cleanup EXIT

rm -f .pi/progress.md
set +e
make progress-init >/tmp/smolpi-progress-init.out 2>&1
init_status=$?
set -e
if [ "$init_status" -ne 0 ]; then
  echo "make progress-init should succeed" >&2
  cat /tmp/smolpi-progress-init.out >&2
  exit 1
fi

if [ ! -f .pi/progress.md ]; then
  echo "make progress-init should create .pi/progress.md from the template" >&2
  cat /tmp/smolpi-progress-init.out >&2
  exit 1
fi

for needle in "Goal" "Current state" "Last commands" "Open risks" "Next step"; do
  if ! grep -q "$needle" .pi/progress.md; then
    echo "initialized progress file missing section: $needle" >&2
    exit 1
  fi
done

printf '\nTEST_NATIVE_PROGRESS_MARKER\n' >> .pi/progress.md

prompt_out="$(mktemp)"
DUMP_SYSTEM_PROMPT=1 APPEND_SYSTEM_PATH=/tmp/nonexistent-smolpi-append.md bun run agent/index.ts "inspect prompt" > "$prompt_out" 2>&1
if ! grep -q "TEST_NATIVE_PROGRESS_MARKER" "$prompt_out"; then
  echo "system prompt dump should include live .pi/progress.md content" >&2
  cat "$prompt_out" >&2
  exit 1
fi
if ! grep -q "## Workspace progress (.pi/progress.md)" "$prompt_out"; then
  echo "system prompt should label injected progress content" >&2
  cat "$prompt_out" >&2
  exit 1
fi

if grep -q '"\./\.pi:/app/\.pi:ro"' Smolfile; then
  echo "Smolfile mounts .pi read-only; progress.md must be writable by the guest" >&2
  exit 1
fi
if ! grep -q '"\./\.pi:/app/\.pi"' Smolfile; then
  echo "Smolfile should mount .pi writable for native progress updates" >&2
  exit 1
fi

echo "PASS: native substrate bootstrap"
