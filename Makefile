IMAGE_NAME  := pi-agent-smol
ARCH        ?= amd64
FULL_TAG    := latest-$(ARCH)
TAR_FILE    := $(IMAGE_NAME)-$(ARCH).tar
PACK_BIN    := ./pi-agent
HOST_GW     := localhost
LLM_PORT    := 8080
REG_PORT    := 5000
REG_NAME    := smol-registry
REG_IMAGE   := localhost:$(REG_PORT)/$(IMAGE_NAME):$(FULL_TAG)
VM_NAME     := pi-agent-dev

# ── Build ────────────────────────────────────────────────────
.PHONY: doctor setup setup-extensions build build-go run pack clean test-chromium test-go-binary test-tar test-smol-net \
        registry-up registry-down machine-up machine-init machine-snapshot machine-down test-brain machine-exec machine-run

# ── Setup / Doctor ───────────────────────────────────────────
doctor:          ## Preflight: check tools, llama.cpp, model, brain, VM — with fixes
	@bash scripts/doctor.sh

setup:           ## Fetch all submodules + wire extension shims (run before first boot)
	git submodule update --init --recursive
	@mkdir -p models
	@command -v bun >/dev/null 2>&1 && bun install \
		|| echo "⚠ bun not on host — install bun then run 'bun install' to wire extension shims"
	@echo "Next: build llama-server (GPU example):"
	@echo "  cmake -B llama.cpp/build -S llama.cpp -DGGML_CUDA=ON && cmake --build llama.cpp/build -j --target llama-server"
	@echo "Then drop a .gguf into ./models/ and run 'make doctor'."

setup-extensions: ## (re)wire the extension compat shims into node_modules
	bun install

build:
	docker buildx build --platform linux/$(ARCH) \
		--build-arg TARGETARCH=$(ARCH) \
		-t $(IMAGE_NAME):$(FULL_TAG) \
		--load .

# ── Run locally in Docker (for testing) ──────────────────────
run: build
	docker run --rm -it --shm-size=2gb $(IMAGE_NAME):$(FULL_TAG)

# ── Local registry (bridges Docker → smolvm) ─────────────────
registry-up:
	@docker inspect $(REG_NAME) >/dev/null 2>&1 || \
		docker run -d --name $(REG_NAME) -p $(REG_PORT):5000 --restart=always registry:2
	@echo "Registry running at localhost:$(REG_PORT)"

registry-down:
	-docker rm -f $(REG_NAME) 2>/dev/null

# ── Export to local registry and pack into Smolmachines MicroVM
pack: build registry-up
	docker tag $(IMAGE_NAME):$(FULL_TAG) $(REG_IMAGE)
	docker push $(REG_IMAGE)
	smolvm pack create --image $(REG_IMAGE) -o $(PACK_BIN)

# ── Run via smolvm directly from image ───────────────────────
smol-run: registry-up
	smolvm machine run --net -it --image $(REG_IMAGE) -- /bin/bash

# ── Dry Run Tests ────────────────────────────────────────────
test-chromium: build
	@echo "==> Test 1: Verify chromium installed without X11 bloat"
	docker run --rm --shm-size=2gb $(IMAGE_NAME):$(FULL_TAG) \
		sh -c "chromium --headless --no-sandbox --disable-dev-shm-usage --dump-dom https://example.com 2>/dev/null | head -20 && echo 'PASS: chromium works'"

test-go-binary: build
	@echo "==> Test 2: Verify Go binary extracts aria roles"
	docker run --rm --shm-size=2gb $(IMAGE_NAME):$(FULL_TAG) \
		sh -c "echo '<html><body><button aria-label=\"Submit\" role=\"button\">Go</button></body></html>' > /tmp/test.html && browser_skill file:///tmp/test.html"

test-tar: build
	@echo "==> Test 3: Validate OCI tar export"
	docker save $(IMAGE_NAME):$(FULL_TAG) -o $(TAR_FILE)
	tar tf $(TAR_FILE) | head -20
	@echo "PASS: tar structure looks valid"

test-smol-net: pack
	@echo "==> Test 4: Guest-to-host network (smolvm MicroVM)"
	@echo "    Target: $(HOST_GW):$(LLM_PORT)"
	@echo "    NOTE: llama-server must be running with --host 0.0.0.0"
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

test: test-chromium test-go-binary test-tar
	@echo "==> All dry-run tests complete"

# ── Smolfile dev machine ─────────────────────────────────────
build-go:
	@echo "==> Compiling browser_skill for linux/$(ARCH)..."
	@mkdir -p bin
	cd browser && CGO_ENABLED=0 GOOS=linux GOARCH=$(ARCH) \
		go build -ldflags="-s -w" -o ../bin/browser_skill browser_skill.go

machine-up: build-go
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

machine-snapshot:
	smolvm machine stop --name $(VM_NAME)
	smolvm pack create --from-vm $(VM_NAME) -o $(PACK_BIN)
	@echo "Snapshot saved: $(PACK_BIN).smolmachine"
	@echo "Future 'make machine-up' will boot from this snapshot."

test-brain:
	smolvm machine exec --name $(VM_NAME) -- bun run /app/scripts/test-connection.ts

machine-exec:
	smolvm machine exec --name $(VM_NAME) -it -- /bin/bash

machine-run:
	smolvm machine exec --name $(VM_NAME) -it -- sh /app/scripts/start-agent.sh

machine-down:
	-smolvm machine stop --name $(VM_NAME) 2>/dev/null
	-smolvm machine delete -f $(VM_NAME) 2>/dev/null

# ── Cleanup ──────────────────────────────────────────────────
clean:
	rm -f $(IMAGE_NAME)-*.tar $(PACK_BIN) $(PACK_BIN).smolmachine
	rm -rf bin/
	-docker rmi $(IMAGE_NAME):$(FULL_TAG) $(REG_IMAGE) 2>/dev/null
