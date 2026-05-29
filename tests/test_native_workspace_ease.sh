#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

out="$tmp/doctor.out"
set +e
BRAIN_MODE=external LLM_HOST=127.0.0.1 LLM_PORT=9 ./scripts/doctor.sh > "$out" 2>&1
status=$?
set -e

# This run may fail because port 9 has no LLM; the resource/workspace guidance
# should still print before the brain reachability failure exits.
if [ "$status" -eq 0 ]; then
  echo "expected external brain reachability to fail on port 9" >&2
  cat "$out" >&2
  exit 1
fi

for needle in \
  "── host resources ──" \
  "host CPU:" \
  "host memory:" \
  "workspace disk:" \
  "Smolfile guest limits:"; do
  if ! grep -q "$needle" "$out"; then
    echo "doctor output missing resource line: $needle" >&2
    cat "$out" >&2
    exit 1
  fi
done

if [ ! -f .pi/progress.md.example ]; then
  echo "missing .pi/progress.md.example template" >&2
  exit 1
fi

for needle in "Goal" "Current state" "Last commands" "Open risks" "Next step"; do
  if ! grep -q "$needle" .pi/progress.md.example; then
    echo "progress template missing section: $needle" >&2
    exit 1
  fi
done

for needle in "git status" "git diff" "git log --oneline -5" ".pi/progress.md"; do
  if ! grep -q "$needle" agent/index.ts; then
    echo "agent prompt missing native workspace guidance: $needle" >&2
    exit 1
  fi
done

echo "PASS: native workspace ease-of-use substrate"
