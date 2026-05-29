#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

port="${TEST_LLM_PORT:-18081}"
tmp="$(mktemp -d)"
trap 'kill "${server_pid:-}" 2>/dev/null || true; rm -rf "$tmp"' EXIT

cat > "$tmp/server.py" <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os, time

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path == "/v1/models":
            self._json(200, {"data": [{"id": "stream-test-model"}]})
        else:
            self.send_response(404)
            self.send_header("content-length", "0")
            self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        stream = bool(body.get("stream"))
        mode = os.environ.get("MODE", "stream")
        if self.path != "/v1/chat/completions":
            self.send_response(404)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        if stream and mode == "fallback":
            self._json(400, {"error": "stream unsupported"})
            return
        if stream:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.send_header("connection", "close")
            self.end_headers()
            chunks = [
                {"choices": [{"delta": {"reasoning_content": "thinking before visible output"}}]},
                {"choices": [{"delta": {"content": "STREAMING_"}}]},
                {"choices": [{"delta": {"content": "OK <done/>"}}]},
                {"choices": [{"finish_reason": "stop"}], "timings": {"prompt_n": 7, "predicted_n": 2}},
            ]
            for chunk in chunks:
                payload = ("data: " + json.dumps(chunk) + "\n\n").encode()
                # Split every event across writes: real HTTP may split SSE events
                # anywhere, and the parser must buffer partial events correctly.
                mid = max(1, len(payload) // 2)
                self.wfile.write(payload[:mid])
                self.wfile.flush()
                time.sleep(0.005)
                self.wfile.write(payload[mid:])
                self.wfile.flush()
                time.sleep(0.02)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return
        self._json(200, {
            "choices": [{"message": {"content": "FALLBACK_OK <done/>"}}],
            "usage": {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6},
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

PORT="$port" MODE=stream python3 "$tmp/server.py" &
server_pid=$!
for _ in {1..60}; do
  curl -sf "http://127.0.0.1:$port/v1/models" >/dev/null && break
  sleep 0.05
done

stream_logs="$tmp/logs-stream"
stream_out="$tmp/stream.out"
PI_LOG_DIR="$stream_logs" LLM_URL="http://127.0.0.1:$port" LLM_MODEL=stream-test-model AGENT_MAX_STEPS=1 APPEND_SYSTEM_PATH=/tmp/nonexistent-smolpi-append.md LLM_STREAM=1 bun run agent/index.ts "stream once" > "$stream_out" 2>&1

if ! grep -q "STREAMING_OK" "$stream_out"; then
  echo "streamed agent output missing accumulated streamed content" >&2
  cat "$stream_out" >&2
  exit 1
fi
stream_log="$(find "$stream_logs" -name '*.jsonl' -type f | head -1)"
if [ -z "$stream_log" ]; then
  echo "streaming run did not create a JSONL log" >&2
  exit 1
fi
if ! grep -q '"streaming":true' "$stream_log"; then
  echo "streaming log record should mark streaming=true" >&2
  cat "$stream_log" >&2
  exit 1
fi
if ! grep -q '"ttft_ms":' "$stream_log"; then
  echo "streaming log record should include ttft_ms" >&2
  cat "$stream_log" >&2
  exit 1
fi
if ! grep -q '"reasoning_chars":30' "$stream_log"; then
  echo "streaming log should account for reasoning_content chunks explicitly" >&2
  cat "$stream_log" >&2
  exit 1
fi
if ! grep -q '"prompt_tokens":7' "$stream_log" || ! grep -q '"completion_tokens":2' "$stream_log"; then
  echo "streaming log should derive token usage from llama.cpp timings when usage is absent" >&2
  cat "$stream_log" >&2
  exit 1
fi

kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
PORT="$port" MODE=fallback python3 "$tmp/server.py" &
server_pid=$!
for _ in {1..60}; do
  curl -sf "http://127.0.0.1:$port/v1/models" >/dev/null && break
  sleep 0.05
done

fallback_logs="$tmp/logs-fallback"
fallback_out="$tmp/fallback.out"
PI_LOG_DIR="$fallback_logs" LLM_URL="http://127.0.0.1:$port" LLM_MODEL=stream-test-model AGENT_MAX_STEPS=1 APPEND_SYSTEM_PATH=/tmp/nonexistent-smolpi-append.md LLM_STREAM=1 bun run agent/index.ts "fallback once" > "$fallback_out" 2>&1

if ! grep -q "FALLBACK_OK" "$fallback_out"; then
  echo "agent should retry non-streaming when stream:true is rejected" >&2
  cat "$fallback_out" >&2
  exit 1
fi
fallback_log="$(find "$fallback_logs" -name '*.jsonl' -type f | head -1)"
if ! grep -q '"streaming":false' "$fallback_log"; then
  echo "fallback log record should mark streaming=false" >&2
  cat "$fallback_log" >&2
  exit 1
fi
if ! grep -q "streaming failed; falling back to non-streaming" "$fallback_out"; then
  echo "fallback should emit a visible warning instead of silently doubling latency" >&2
  cat "$fallback_out" >&2
  exit 1
fi

if grep -q "eventsource-parser" package.json; then
  echo "streaming slice should stay dependency-free unless hand parser flakes" >&2
  exit 1
fi

echo "PASS: llm streaming and fallback"
