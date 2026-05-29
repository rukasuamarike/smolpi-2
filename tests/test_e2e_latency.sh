#!/usr/bin/env bash
# test_e2e_latency.sh — end-to-end latency probes for the pi-agent stack.
#
# Sections:
#   A. Direct LLM probes (always run — requires llama-server on :8080)
#      A1. TTFT distribution, 10 streaming calls
#      A2. Throughput baseline (3 runs, ~50 completion tokens)
#      A3. Latency budget: TTFT must be < TTFT_BUDGET_MS
#   B. Agent pipeline span analysis (requires bun; skipped otherwise)
#      B1. Run a 2-step task against the real LLM
#      B2. Validate per-span latency properties from JSONL log
#      B3. Harness overhead = turn_wall_ms - llm_request_ms
#      B4. Print latency breakdown table
set -euo pipefail
cd "$(dirname "$0")/.."

LLM_URL="${LLM_URL:-http://127.0.0.1:8080}"
TTFT_BUDGET_MS="${TTFT_BUDGET_MS:-5000}"   # Gemma IQ2_M on CUDA — generous
HARNESS_OVERHEAD_WARN_MS=500               # warn if non-LLM agent work exceeds this

PASS=0; FAIL=0; WARN=0
col_green='\033[32m'; col_red='\033[31m'; col_yellow='\033[33m'; col_reset='\033[0m'
pass()  { echo -e "  ${col_green}PASS${col_reset}  $1"; PASS=$((PASS+1)); }
fail()  { echo -e "  ${col_red}FAIL${col_reset}  $1"; FAIL=$((FAIL+1)); }
warn()  { echo -e "  ${col_yellow}WARN${col_reset}  $1"; WARN=$((WARN+1)); }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "════════════════════════════════════════════════════"
echo " pi-agent e2e latency probe"
echo " LLM: $LLM_URL   TTFT budget: ${TTFT_BUDGET_MS}ms"
echo "════════════════════════════════════════════════════"

# ─────────────────────────────────────────────────────────────
echo ""
echo "── [A] DIRECT LLM LATENCY ───────────────────────────"

# Check that LLM is reachable before running any LLM probes.
if ! curl -sf "$LLM_URL/v1/models" >/dev/null 2>&1; then
  warn "LLM not reachable at $LLM_URL — skipping all LLM probes"
  echo ""
  echo "  (start llama-server with ./scripts/run-brain.sh and re-run)"
else

# ── A1. TTFT distribution ───────────────────────────────────
echo "  A1. TTFT distribution (10 streaming pings):"
python3 - "$LLM_URL" "$TTFT_BUDGET_MS" <<'PY'
import urllib.request, json, time, statistics, sys

url = sys.argv[1] + "/v1/chat/completions"
budget = int(sys.argv[2])
payload = json.dumps({
    "model": "x",
    "messages": [{"role": "user", "content": "Reply: pong"}],
    "max_tokens": 5,
    "stream": True,
}).encode()
ttfts = []
for i in range(10):
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=30) as r:
        for line in r:
            l = line.decode().strip()
            if l.startswith("data:") and "[DONE]" not in l:
                try:
                    d = json.loads(l[5:])
                except Exception:
                    continue
                delta = d.get("choices", [{}])[0].get("delta", {})
                tok = delta.get("content", "") or delta.get("reasoning_content", "")
                if tok:
                    ttfts.append((time.perf_counter() - t0) * 1000)
                    break

if not ttfts:
    print("  ERROR  no TTFT samples collected")
    sys.exit(1)

ttfts.sort()
med = statistics.median(ttfts)
p95 = ttfts[max(0, int(len(ttfts) * 0.95) - 1)]
print(f"    n={len(ttfts)}  min={min(ttfts):.0f}ms  median={med:.0f}ms  p95={p95:.0f}ms  max={max(ttfts):.0f}ms")
stdev = statistics.stdev(ttfts) if len(ttfts) > 1 else 0
print(f"    stdev={stdev:.1f}ms  budget={budget}ms")

status = "PASS" if med <= budget else "FAIL"
print(f"  {status}  median TTFT {med:.0f}ms {'≤' if med <= budget else '>'} budget {budget}ms")
sys.exit(0 if med <= budget else 1)
PY
if [ $? -eq 0 ]; then pass "A1 TTFT median within budget"; else fail "A1 TTFT median exceeds budget"; fi

# ── A2. Throughput baseline ─────────────────────────────────
echo ""
echo "  A2. Throughput baseline (3 × 50-token target):"
python3 - "$LLM_URL" <<'PY'
import urllib.request, json, time, statistics, sys

url = sys.argv[1] + "/v1/chat/completions"
prompt = "List 20 European capitals one per line."
runs = []
for _ in range(3):
    payload = json.dumps({
        "model": "x",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 120,
    }).encode()
    t0 = time.perf_counter()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read())
    elapsed = time.perf_counter() - t0
    ct = data.get("usage", {}).get("completion_tokens", 0)
    runs.append((elapsed, ct))

avg_s = statistics.mean(r[0] for r in runs)
avg_ct = statistics.mean(r[1] for r in runs)
tps = avg_ct / avg_s if avg_s > 0 else 0
print(f"    compl≈{avg_ct:.0f}t  avg {avg_s:.2f}s  {tps:.1f} tok/s")
sys.exit(0)
PY
pass "A2 throughput sampled"

# ── A3. Latency budget sanity: total latency = TTFT + decode time ───────────
echo ""
echo "  A3. TTFT vs total latency (1 streaming call, 50-token reply):"
python3 - "$LLM_URL" <<'PY'
import urllib.request, json, time, sys

url = sys.argv[1] + "/v1/chat/completions"
payload = json.dumps({
    "model": "x",
    "messages": [{"role": "user", "content": "List 10 countries, one per line."}],
    "max_tokens": 80,
    "stream": True,
}).encode()
t0 = time.perf_counter()
ttft = None
total = None
req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=60) as r:
    for line in r:
        l = line.decode().strip()
        if not l.startswith("data:"):
            continue
        if "[DONE]" in l:
            total = (time.perf_counter() - t0) * 1000
            break
        try:
            d = json.loads(l[5:])
        except Exception:
            continue
        delta = d.get("choices", [{}])[0].get("delta", {})
        tok = delta.get("content", "") or delta.get("reasoning_content", "")
        if tok and ttft is None:
            ttft = (time.perf_counter() - t0) * 1000

if ttft and total:
    decode_ms = total - ttft
    ratio = ttft / total * 100
    print(f"    TTFT={ttft:.0f}ms  total={total:.0f}ms  decode={decode_ms:.0f}ms")
    print(f"    TTFT is {ratio:.0f}% of total (decode is {100-ratio:.0f}%)")
    if ttft < total:
        print("  PASS  TTFT < total latency (streaming delivers early tokens)")
        sys.exit(0)
    else:
        print("  FAIL  TTFT >= total latency (something wrong with TTFT capture)")
        sys.exit(1)
else:
    print("  FAIL  could not capture both TTFT and total")
    sys.exit(1)
PY
if [ $? -eq 0 ]; then pass "A3 TTFT < total latency"; else fail "A3 TTFT/total relationship broken"; fi

fi  # end LLM reachable block

# ─────────────────────────────────────────────────────────────
echo ""
echo "── [B] AGENT PIPELINE SPAN ANALYSIS ─────────────────"

if ! command -v bun >/dev/null 2>&1; then
  warn "bun not installed — skipping agent pipeline probes"
  echo "       install bun: curl -fsSL https://bun.sh/install | bash"
  echo ""
else

log_dir="$tmp/e2e-logs"
agent_out="$tmp/agent.out"

echo "  Running 2-step agent task against real LLM..."
t_wall_start=$(date +%s%3N)
PI_LOG_DIR="$log_dir" \
LLM_URL="$LLM_URL" \
LLM_MODEL=x \
AGENT_MAX_STEPS=4 \
APPEND_SYSTEM_PATH=/tmp/nonexistent-smolpi-e2e.md \
LLM_STREAM=1 \
  timeout 120 bun run agent/index.ts \
  "Your first reply must be exactly this action and nothing else: <sh>printf E2E_LATENCY_OK</sh> . After the Observation, reply done with <done/>." \
  > "$agent_out" 2>&1
t_wall_end=$(date +%s%3N)
wall_ms=$(( t_wall_end - t_wall_start ))

if ! grep -q '^E2E_LATENCY_OK$' "$agent_out"; then
  fail "B0 agent did not execute the shell command"
  cat "$agent_out" >&2
else
  pass "B0 agent executed E2E task (${wall_ms}ms wall)"
fi

logfile=$(find "$log_dir" -name '*.jsonl' -type f 2>/dev/null | head -1 || true)
if [ -z "$logfile" ]; then
  fail "B1 no JSONL log written"
else
  pass "B1 JSONL log written: $(basename "$logfile")"

  python3 - "$logfile" "$wall_ms" "$HARNESS_OVERHEAD_WARN_MS" <<'PY'
import json, sys

logfile, wall_ms_str, warn_threshold_str = sys.argv[1], sys.argv[2], sys.argv[3]
wall_ms = int(wall_ms_str)
warn_threshold = int(warn_threshold_str)

records = [json.loads(l) for l in open(logfile) if l.strip()]
spans   = [r for r in records if r.get("type") == "span"]
llms    = [r for r in records if r.get("type", "llm") == "llm"]

PASS = FAIL = WARN = 0
def p(msg): global PASS; print(f"  \033[32mPASS\033[0m  {msg}"); PASS += 1
def f(msg): global FAIL; print(f"  \033[31mFAIL\033[0m  {msg}"); FAIL += 1
def w(msg): global WARN; print(f"  \033[33mWARN\033[0m  {msg}"); WARN += 1

# B2: required spans present
required = {"prompt.assemble", "context.trim", "llm.request", "action.parse",
            "permission.decide", "tool.call"}
seen = {s["span"] for s in spans}
missing = sorted(required - seen)
if missing:
    f(f"B2 missing required spans: {missing}")
else:
    p("B2 all required spans present")

# B2b: per-span latency sanity
by_span = {}
for s in spans:
    by_span.setdefault(s["span"], []).append(s)

def check_span(name, min_ms, max_ms, label):
    entries = by_span.get(name, [])
    if not entries:
        return
    for e in entries:
        lat = e.get("latency_ms", -1)
        if lat < min_ms:
            f(f"B2 {label} latency {lat}ms < {min_ms}ms minimum")
            return
        if lat > max_ms:
            w(f"B2 {label} latency {lat}ms > {max_ms}ms (expected fast)")
            return
    p(f"B2 {label} latency ok ({entries[0]['latency_ms']}ms)")

check_span("context.trim",      0, 200,   "context.trim")
check_span("action.parse",      0,  50,   "action.parse")
check_span("prompt.assemble",   0, 200,   "prompt.assemble")

# B2c: trace identity and parent-child hierarchy
trace_ids = {r.get("trace_id") for r in records}
if len(trace_ids) != 1 or None in trace_ids:
    f(f"B2 trace_id should be present and consistent: {trace_ids}")
else:
    p(f"B2 trace_id consistent: {next(iter(trace_ids))[:8]}…")
span_ids = [s.get("span_id") for s in spans]
if any(not sid for sid in span_ids) or len(span_ids) != len(set(span_ids)):
    f("B2 span_id values should be present and unique")
else:
    p("B2 span_id values present and unique")
step_ids = {s["span_id"] for s in spans if s.get("span") == "agent.step"}
children = [s for s in spans if s.get("span") in {"context.trim", "llm.request", "action.parse", "permission.decide", "tool.call"}]
if not step_ids or not all(s.get("parent_span_id") in step_ids for s in children):
    f("B2 step children should point parent_span_id at agent.step")
else:
    p("B2 parent_span_id links children to agent.step")

# permission.decide currently auto-allows, but should still be measured rather than hardcoded
for s in by_span.get("permission.decide", []):
    if s.get("latency_ms", -1) < 0:
        f(f"B2 permission.decide latency={s['latency_ms']}ms (must be >= 0)")
    elif s.get("metadata", {}).get("latency_source") != "measured":
        f(f"B2 permission.decide missing latency_source=measured: {s}")
    else:
        p(f"B2 permission.decide latency measured ({s['latency_ms']}ms, auto-allow)")

# llm.request should be the dominant span
llm_spans = by_span.get("llm.request", [])
if llm_spans:
    for s in llm_spans:
        lat = s["latency_ms"]
        if lat <= 0:
            f(f"B2 llm.request latency={lat}ms (must be > 0)")
        elif lat < 100:
            w(f"B2 llm.request latency={lat}ms seems too fast for real inference")
        else:
            p(f"B2 llm.request latency ok ({lat}ms)")
    # TTFT presence and sanity
    ttfts = [s["metadata"].get("ttft_ms") for s in llm_spans if s["metadata"].get("ttft_ms")]
    if not ttfts:
        f("B2 llm.request spans have no ttft_ms in metadata")
    else:
        ttft = ttfts[0]
        total = llm_spans[0]["latency_ms"]
        if ttft <= 0:
            f(f"B2 ttft_ms={ttft}ms (must be > 0)")
        elif ttft >= total:
            f(f"B2 ttft_ms={ttft}ms >= total={total}ms (TTFT capture broken)")
        else:
            ratio = ttft / total * 100
            p(f"B2 TTFT={ttft}ms < total={total}ms ({ratio:.0f}% decode time remaining)")

# tool.call latency
tool_spans = by_span.get("tool.call", [])
if tool_spans:
    for s in tool_spans:
        lat = s["latency_ms"]
        kind = s["metadata"].get("tool.kind", "?")
        if lat < 0:
            f(f"B2 tool.call ({kind}) latency={lat}ms (must be >= 0)")
        else:
            p(f"B2 tool.call ({kind}) latency ok ({lat}ms)")

# B3: harness overhead = wall_ms - sum(llm.request latencies)
total_llm_ms = sum(s["latency_ms"] for s in llm_spans)
harness_ms = wall_ms - total_llm_ms
if harness_ms < 0:
    w(f"B3 harness_ms={harness_ms}ms < 0 (wall clock less than LLM time — clock drift?)")
elif harness_ms > warn_threshold:
    w(f"B3 harness overhead {harness_ms}ms > {warn_threshold}ms (non-LLM work may be slow)")
else:
    p(f"B3 harness overhead {harness_ms}ms within {warn_threshold}ms budget")

# B4: latency breakdown table
print()
print("  ── latency breakdown ────────────────────────────")
print(f"    {'span':<28} {'calls':>5}  {'sum_ms':>7}  {'avg_ms':>7}  {'max_ms':>7}")
all_span_names = ["prompt.assemble","context.trim","llm.request","action.parse",
                  "permission.decide","tool.call"]
for name in all_span_names:
    entries = by_span.get(name, [])
    if not entries:
        continue
    lats = [e["latency_ms"] for e in entries]
    print(f"    {name:<28} {len(lats):>5}  {sum(lats):>7}  {sum(lats)//len(lats):>7}  {max(lats):>7}")
print(f"    {'─'*28}  {'─'*5}  {'─'*7}  {'─'*7}  {'─'*7}")
print(f"    {'LLM total (sum llm.request)':<28} {len(llm_spans):>5}  {total_llm_ms:>7}")
print(f"    {'wall (agent process)':<28}         {wall_ms:>7}")
print(f"    {'harness overhead':<28}         {harness_ms:>7}")
print()

# B4b: LLM log record sanity
if not llms:
    f("B4 no LLM records in log (type=llm)")
else:
    p(f"B4 {len(llms)} LLM record(s) in log")
    for rec in llms:
        ttft = rec.get("ttft_ms")
        lat  = rec.get("latency_ms", 0)
        streaming = rec.get("streaming", False)
        if streaming and (ttft is None or ttft <= 0):
            f(f"B4 streaming LLM record missing valid ttft_ms: ttft={ttft}")
        if lat <= 0:
            f(f"B4 LLM record latency={lat}ms (must be > 0)")

print(f"  result: {PASS} pass  {WARN} warn  {FAIL} fail")
sys.exit(0 if FAIL == 0 else 1)
PY
  if [ $? -eq 0 ]; then
    pass "B all span latency checks passed"
  else
    fail "B span latency validation failed"
  fi
fi

fi  # end bun block

# ─────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════"
echo " SUMMARY: pass=$PASS  fail=$FAIL  warn=$WARN"
echo "════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] && echo "PASS: e2e latency" || echo "FAIL: e2e latency"
[ "$FAIL" -eq 0 ]
