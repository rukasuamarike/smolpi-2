#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

port="${TEST_LLM_PORT:-18080}"
tmp="$(mktemp -d)"
trap 'kill "${server_pid:-}" 2>/dev/null || true; rm -rf "$tmp"' EXIT

cat > "$tmp/server.py" <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/v1/models":
            body = json.dumps({"data": [{"id": "test-model"}]}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()
    def log_message(self, *_args):
        pass

HTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler).serve_forever()
PY

PORT="$port" python3 "$tmp/server.py" &
server_pid=$!

for _ in {1..40}; do
  if curl -sf "http://127.0.0.1:$port/v1/models" >/dev/null; then
    break
  fi
  sleep 0.05
done

out="$tmp/doctor.out"
set +e
BRAIN_MODE=external LLM_HOST=127.0.0.1 LLM_PORT="$port" ./scripts/doctor.sh > "$out" 2>&1
status=$?
set -e

if [ "$status" -ne 0 ]; then
  echo "doctor should exit 0 in external mode when /v1/models is reachable; got $status" >&2
  cat "$out" >&2
  exit 1
fi

if grep -q "llama-server not built" "$out"; then
  echo "doctor still treats missing local llama-server as fatal in external mode" >&2
  cat "$out" >&2
  exit 1
fi
if grep -q "no .gguf" "$out"; then
  echo "doctor still treats missing local model as fatal in external mode" >&2
  cat "$out" >&2
  exit 1
fi
if ! grep -q "external brain mode" "$out"; then
  echo "doctor output should make external brain mode explicit" >&2
  cat "$out" >&2
  exit 1
fi

echo "PASS: doctor external brain mode"
