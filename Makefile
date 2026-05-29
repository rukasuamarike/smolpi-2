# Local host overrides (gitignored; copy from .env.example). CLI args still win.
-include .env

IMAGE_NAME  := pi-agent-smol
ARCH        ?= amd64
PACK_BIN    := ./pi-agent
# LLM endpoint — all overridable, e.g. `make machine-run LLM_PORT=1234` for LMStudio.
LLM_HOST    ?= 127.0.0.1
LLM_PORT    ?= 8080
LLM_URL     ?= http://$(LLM_HOST):$(LLM_PORT)
LLM_MODEL   ?= gemma-4
HOST_GW     ?= $(LLM_HOST)
VM_NAME     := pi-agent-dev
# Forward host-side config into recipe subshells (run-brain.sh etc. inherit these).
export LLM_HOST LLM_PORT LLM_URL LLM_MODEL LLM_STREAM BRAIN_DIR LLAMA_SERVER MODELS_DIR GPU_LAYERS CTX_SIZE

.PHONY: doctor setup setup-yes setup-extensions progress-init pack \
        machine-up machine-init machine-snapshot machine-down \
        test test-brain test-smol-net machine-exec machine-run clean

# ── Setup / Doctor ───────────────────────────────────────────
doctor:          ## Preflight: check tools, llama.cpp, model, brain, VM — with fixes
	@bash scripts/doctor.sh

setup:           ## One-shot semi-interactive onboarding (deps, submodules, smolvm, bun, brain)
	@bash scripts/setup.sh

setup-yes:       ## Non-interactive onboarding (assume yes to every prompt)
	@bash scripts/setup.sh --yes

setup-extensions: ## (re)wire the extension compat shims into node_modules
	bun install

progress-init:   ## Create local .pi/progress.md from the tracked template if absent
	@mkdir -p .pi
	@if [ -f .pi/progress.md ]; then \
		echo ".pi/progress.md already exists; leaving it alone"; \
	else \
		cp .pi/progress.md.example .pi/progress.md; \
		echo "created .pi/progress.md from .pi/progress.md.example"; \
	fi

# ── Smolfile dev machine — the build path (no Docker) ────────
# `make machine-up` builds the VM from the Smolfile and, on a FRESH create,
# auto-provisions the guest (guest-setup.sh — installs browser39, the toolkit,
# bun). `make machine-snapshot` then packs it for instant future boots;
# `make machine-init` re-runs provisioning by hand.
machine-up:
	@fresh=0; \
	if smolvm machine ls 2>/dev/null | grep -q '$(VM_NAME)'; then \
		echo "Machine $(VM_NAME) already exists, starting..."; \
	elif [ -f $(PACK_BIN).smolmachine ]; then \
		echo "Creating machine from snapshot..."; \
		smolvm machine create -e LLM_URL=$(LLM_URL) -e LLM_MODEL=$(LLM_MODEL) $(VM_NAME) --from $(PACK_BIN).smolmachine; \
	else \
		echo "No snapshot found. Creating fresh machine from Smolfile..."; \
		smolvm machine create -e LLM_URL=$(LLM_URL) -e LLM_MODEL=$(LLM_MODEL) -s Smolfile $(VM_NAME); fresh=1; \
	fi; \
	smolvm machine start --name $(VM_NAME); \
	if [ "$$fresh" = "1" ]; then \
		echo "Provisioning guest (guest-setup.sh installs browser39 + toolkit)..."; \
		smolvm machine exec --name $(VM_NAME) -it -- sh /app/scripts/guest-setup.sh; \
		echo "Provisioned. Run 'make machine-snapshot' to cache for instant boots."; \
	fi
	@echo "Machine $(VM_NAME) is running."

machine-init:
	smolvm machine exec --name $(VM_NAME) -it -- sh /app/scripts/guest-setup.sh

# Pack the initialized VM into a self-contained binary (runs on any host
# with /dev/kvm, no smolvm install). 'pack' is an alias for machine-snapshot.
pack: machine-snapshot
machine-snapshot:
	smolvm machine stop --name $(VM_NAME)
	smolvm pack create --from-vm $(VM_NAME) -o $(PACK_BIN)
	@echo "Snapshot saved: $(PACK_BIN) (+ $(PACK_BIN).smolmachine)"
	@echo "Future 'make machine-up' boots from this snapshot."

test-brain:
	smolvm machine exec --name $(VM_NAME) -e LLM_URL=$(LLM_URL) -e LLM_MODEL=$(LLM_MODEL) -e LLM_STREAM=$(LLM_STREAM) -- bun run /app/scripts/test-connection.ts

machine-exec:
	smolvm machine exec --name $(VM_NAME) -it -- /bin/bash

machine-run:
	smolvm machine exec --name $(VM_NAME) -e LLM_URL=$(LLM_URL) -e LLM_MODEL=$(LLM_MODEL) -e LLM_STREAM=$(LLM_STREAM) -it -- sh /app/scripts/start-agent.sh

machine-down:
	-smolvm machine stop --name $(VM_NAME) 2>/dev/null
	-smolvm machine delete -f $(VM_NAME) 2>/dev/null

# ── Tests ────────────────────────────────────────────────────
# Guest → host network check, run against the packed binary.
test-smol-net:
	@if [ ! -x "$(PACK_BIN)" ]; then \
		echo "✗ $(PACK_BIN) not found — build it first: make machine-up machine-init machine-snapshot"; \
		exit 1; \
	fi
	@echo "==> Guest-to-host network (smolvm MicroVM)"
	@echo "    Target: $(HOST_GW):$(LLM_PORT)   (llama-server must run with --host 0.0.0.0)"
	$(PACK_BIN) run --net -- sh -c '\
		echo "[1/3] Checking gateway reachability..." && \
		if curl -sf --connect-timeout 5 http://$(HOST_GW):$(LLM_PORT)/health >/dev/null 2>&1; then \
			echo "PASS: $(HOST_GW):$(LLM_PORT) is reachable"; \
		else \
			echo "FAIL: $(HOST_GW):$(LLM_PORT) unreachable"; \
			echo "[2/3] Diagnosing..."; \
			if ping -c1 -W2 $(HOST_GW) >/dev/null 2>&1; then \
				echo "  Gateway $(HOST_GW) responds to ping"; \
				echo "  Port $(LLM_PORT) is NOT open — is llama-server running?"; \
				echo "  Ensure: llama-server --host 0.0.0.0 --port $(LLM_PORT)"; \
			else \
				echo "  Gateway $(HOST_GW) is unreachable — check smolvm networking"; \
			fi; \
			echo "[3/3] Showing guest network config:"; \
			ip addr 2>/dev/null || ifconfig 2>/dev/null; \
			exit 1; \
		fi'

test: test-smol-net
	@echo "==> Tests complete"

# ── Cleanup ──────────────────────────────────────────────────
clean:
	rm -f $(PACK_BIN) $(PACK_BIN).smolmachine

# ── Optional: build a local llama.cpp brain ──────────────────
# Platform-aware targets (brain, brain-cuda, brain-metal, brain-vulkan,
# brain-hip, brain-cpu, brain-run). Skip entirely if you use LMStudio / an
# external OpenAI-compatible server. Included last so `doctor` stays default.
include brain.mk
