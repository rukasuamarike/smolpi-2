# Latency Benchmark — Gemma 4 E4B IQ2_M · CUDA · WSL2

Captured from end-to-end testing after native substrate wiring.

## Status

- `make doctor`: 22 ok · 0 warnings · 0 failures
- `tests/test_native_substrate_bootstrap.sh`: PASS
- `tests/test_native_workspace_ease.sh`: PASS
- `tests/test_doctor_external_brain.sh`: PASS
- `make test`: PASS (`test-smol-net` packed binary path)

## Host-direct LLM inference

| Metric | Value |
|---|---:|
| TTFT, streaming, 5 runs | avg 69ms · min 62ms · max 80ms |
| Generation throughput, long outputs | ~103–115 tok/s |
| Short response, 2 tokens | avg 69ms |
| Medium response, 8 tokens | avg 242ms |
| Prompt ingestion | 253 tok/s cold, faster when cached |

## smolvm overhead

| Metric | Value |
|---|---:|
| smolvm exec spawn cost | +125ms per invocation |
| Guest→host LLM round-trip | avg 216ms vs 92ms host-only |
| VM stop | 250ms |
| VM start from stopped state | 1.8s |

## Interpretation

The LLM is not the short-task bottleneck. For 2-token answers, the host-direct LLM path is ~69ms while the guest path is ~216ms; the +125ms `smolvm exec` spawn cost dominates. Optimize away per-invocation VM execs before chasing parser/protocol micro-optimizations.

Long-running interactive sessions (`make machine-run`) are the intended low-latency path because the agent loop stays alive inside the guest. Per-exec overhead mainly affects one-shot commands and tests.

The 1.8s VM start time matters only if workflows kill/restart the VM between sessions. Keep the machine warm when iterating. Later benchmark whether creating/starting from a packed snapshot is faster than restarting a stopped machine.

Gemma 4 E4B IQ2_M at ~103–115 tok/s leaves quality headroom. Q3_K_M or Q4_K_M should be evaluated next; on this GPU, Q4_K_M is expected to remain comfortably interactive while improving answer quality.

## Harness implications

1. Keep latency work focused on the live REPL / long-running agent path, not repeated `smolvm machine exec` one-shots.
2. Streaming is still useful for perceived latency and observability, but it is not the dominant wall-clock fix for short one-shot/test paths.
3. Add span logging around model calls and tool execution before adding complex protocol layers so the benchmark can separate LLM latency, VM exec overhead, shell/tool runtime, and parser overhead.
4. Do not add batch/code-exec scaffolding until eval traces prove one-action-per-step is the actual bottleneck in the live agent path.
5. Compare Q3_K_M/Q4_K_M quality-vs-latency before considering LoRA/SFT.
