#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

port="${TEST_LLM_PORT:-18082}"
tmp="$(mktemp -d)"
trap 'kill "${server_pid:-}" 2>/dev/null || true; rm -rf "$tmp"' EXIT

cat > "$tmp/server.py" <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os

calls = 0

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path == "/v1/models":
            self._json(200, {"data": [{"id": "span-test-model"}]})
        else:
            self.send_response(404)
            self.send_header("content-length", "0")
            self.end_headers()

    def do_POST(self):
        global calls
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path != "/v1/chat/completions":
            self.send_response(404)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        calls += 1
        if calls == 1:
            content = "<sh>printf SPAN_TOOL_OK</sh>"
        else:
            content = "all done <done/>"
        self._json(200, {
            "model": body.get("model", "span-test-model"),
            "choices": [{"message": {"content": content}}],
            "usage": {"prompt_tokens": 11 + calls, "completion_tokens": 3, "total_tokens": 14 + calls},
        })

    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass

HTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler).serve_forever()
PY

PORT="$port" python3 "$tmp/server.py" &
server_pid=$!
for _ in {1..60}; do
  curl -sf "http://127.0.0.1:$port/v1/models" >/dev/null && break
  sleep 0.05
done

logs="$tmp/logs"
out="$tmp/agent.out"
PI_LOG_DIR="$logs" \
LLM_URL="http://127.0.0.1:$port" \
LLM_MODEL=span-test-model \
AGENT_MAX_STEPS=2 \
APPEND_SYSTEM_PATH=/tmp/nonexistent-smolpi-append.md \
LLM_STREAM=0 \
bun run agent/index.ts "exercise span logging" > "$out" 2>&1

if ! grep -q "SPAN_TOOL_OK" "$out"; then
  echo "agent did not execute the shell action needed for span coverage" >&2
  cat "$out" >&2
  exit 1
fi
log="$(find "$logs" -name '*.jsonl' -type f | head -1)"
if [ -z "$log" ]; then
  echo "span run did not create a JSONL log" >&2
  exit 1
fi

python3 - "$log" <<'PY'
import json, sys
path = sys.argv[1]
records = [json.loads(line) for line in open(path) if line.strip()]
spans = [r for r in records if r.get("type") == "span"]
llm = [r for r in records if r.get("type", "llm") == "llm"]
required = {
    "prompt.assemble",
    "context.trim",
    "llm.request",
    "action.parse",
    "permission.decide",
    "tool.call",
}
seen = {r.get("span") for r in spans}
missing = sorted(required - seen)
if missing:
    raise SystemExit(f"missing spans: {missing}\nrecords={records}")
if len(llm) != 2:
    raise SystemExit(f"expected 2 LLM records, saw {len(llm)}")
for span in spans:
    for key in ("ts", "session", "turn", "step", "span", "status", "latency_ms", "metadata"):
        if key not in span:
            raise SystemExit(f"span missing {key}: {span}")
    if not isinstance(span["metadata"], dict):
        raise SystemExit(f"span metadata must be an object: {span}")
llm_spans = [s for s in spans if s.get("span") == "llm.request"]
if not llm_spans:
    raise SystemExit("no llm.request span")
if not any(s["metadata"].get("gen_ai.system") == "openai" for s in llm_spans):
    raise SystemExit(f"llm.request span missing gen_ai.system=openai: {llm_spans}")
if not any(s["metadata"].get("gen_ai.request.model") == "span-test-model" for s in llm_spans):
    raise SystemExit(f"llm.request span missing gen_ai.request.model: {llm_spans}")
if not any(s["metadata"].get("gen_ai.usage.input_tokens") for s in llm_spans):
    raise SystemExit(f"llm.request span missing gen_ai.usage.input_tokens: {llm_spans}")
if not any(s.get("span") == "tool.call" and s["metadata"].get("tool.kind") == "sh" and s["status"] == "ok" for s in spans):
    raise SystemExit(f"missing successful sh tool.call span: {spans}")
PY

if ! grep -q "span events:" "$out"; then
  echo "/logs session summary should include span counts" >&2
  cat "$out" >&2
  exit 1
fi

echo "PASS: span logging"
