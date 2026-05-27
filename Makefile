IMAGE_NAME  := pi-agent-smol
ARCH        ?= amd64
PACK_BIN    := ./pi-agent
HOST_GW     := localhost
LLM_PORT    := 8080
VM_NAME     := pi-agent-dev

.PHONY: doctor setup setup-extensions pack \
        machine-up machine-init machine-snapshot machine-down \
        test test-brain test-smol-net machine-exec machine-run clean

# ── Setup / Doctor ───────────────────────────────────────────
doctor:          ## Preflight: check tools, llama.cpp, model, brain, VM — with fixes
	@bash scripts/doctor.sh

setup:           ## Fetch all submodules + wire extension shims (run before first boot)
	@command -v git-lfs >/dev/null 2>&1 || { \
		echo "✗ git-lfs missing — the smolvm submodule ships libkrun/libkrunfw via LFS;"; \
		echo "  without it 'git submodule update' leaves them as pointer files."; \
		echo "  install: sudo apt install git-lfs && git lfs install"; \
		exit 1; }
	git submodule update --init --recursive
	@mkdir -p models
	@command -v bun >/dev/null 2>&1 && bun install \
		|| echo "⚠ bun not on host — install bun then run 'bun install' to wire extension shims"
	@echo "Next: build llama-server (GPU example):"
	@echo "  cmake -B llama.cpp/build -S llama.cpp -DGGML_CUDA=ON && cmake --build llama.cpp/build -j --target llama-server"
	@echo "Then drop a .gguf into ./models/ and run 'make doctor'."

setup-extensions: ## (re)wire the extension compat shims into node_modules
	bun install

# ── Smolfile dev machine — the build path (no Docker) ────────
# First boot builds the VM from the Smolfile; machine-init provisions the
# guest (guest-setup.sh — installs browser39, the toolkit, bun); then
# machine-snapshot packs it into a portable binary.
machine-up:
	@if smolvm machine ls 2>/dev/null | grep -q '$(VM_NAME)'; then \
		echo "Machine $(VM_NAME) already exists, starting..."; \
	elif [ -f $(PACK_BIN).smolmachine ]; then \
		echo "Creating machine from snapshot..."; \
		smolvm machine create $(VM_NAME) --from $(PACK_BIN).smolmachine; \
	else \
		echo "No snapshot found. Creating fresh machine from Smolfile..."; \
		smolvm machine create -s Smolfile $(VM_NAME); \
		echo "Run 'make machine-init' then 'make machine-snapshot' to cache."; \
	fi
	smolvm machine start --name $(VM_NAME)
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
	smolvm machine exec --name $(VM_NAME) -- bun run /app/scripts/test-connection.ts

machine-exec:
	smolvm machine exec --name $(VM_NAME) -it -- /bin/bash

machine-run:
	smolvm machine exec --name $(VM_NAME) -it -- sh /app/scripts/start-agent.sh

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
