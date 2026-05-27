# brain.mk — build & run a local llama.cpp "brain" (OPTIONAL).
#
# Skip this entirely if you use LMStudio or any other OpenAI-compatible server:
# just point the agent at it (see SETUP.md §4), e.g. `make machine-run LLM_PORT=1234`.
#
# Build your own llama-server (platform-aware):
#   make brain          # auto-detect backend: CUDA / Metal / Vulkan / CPU
#   make brain-cuda     # NVIDIA            make brain-metal    # Apple Silicon
#   make brain-vulkan   # cross-vendor      make brain-hip      # AMD ROCm
#   make brain-cpu      # CPU only
#   make brain-run      # start it (./scripts/run-brain.sh; GPU_LAYERS=99)
#   make brain-clean    # remove the build dir
#
# Standalone (without the main Makefile):  make -f brain.mk brain
LLAMA_DIR  ?= llama.cpp
GPU_LAYERS ?= 99
JOBS       ?= $(shell nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
_UNAME_S   := $(shell uname -s)

.PHONY: brain brain-cuda brain-metal brain-vulkan brain-hip brain-cpu brain-src brain-run brain-clean

# Ensure the llama.cpp source (git submodule) is present before configuring.
brain-src:
	@[ -f "$(LLAMA_DIR)/CMakeLists.txt" ] || git submodule update --init "$(LLAMA_DIR)"

brain: ## Build llama-server, auto-detecting CUDA / Metal / Vulkan / CPU
	@if [ "$(_UNAME_S)" = "Darwin" ]; then \
		echo "→ macOS: building with Metal"; $(MAKE) -f brain.mk brain-metal; \
	elif command -v nvcc >/dev/null 2>&1 || nvidia-smi >/dev/null 2>&1; then \
		echo "→ NVIDIA detected: building with CUDA"; $(MAKE) -f brain.mk brain-cuda; \
	elif command -v vulkaninfo >/dev/null 2>&1; then \
		echo "→ Vulkan detected: building with Vulkan"; $(MAKE) -f brain.mk brain-vulkan; \
	else \
		echo "→ no GPU backend detected: building CPU-only (slow)"; $(MAKE) -f brain.mk brain-cpu; \
	fi

brain-cuda:   brain-src ## NVIDIA (CUDA)
	cmake -B $(LLAMA_DIR)/build -S $(LLAMA_DIR) -DGGML_CUDA=ON
	cmake --build $(LLAMA_DIR)/build --config Release -j $(JOBS) --target llama-server

brain-metal:  brain-src ## Apple Silicon (Metal)
	cmake -B $(LLAMA_DIR)/build -S $(LLAMA_DIR) -DGGML_METAL=ON
	cmake --build $(LLAMA_DIR)/build --config Release -j $(JOBS) --target llama-server

brain-vulkan: brain-src ## cross-vendor (Vulkan)
	cmake -B $(LLAMA_DIR)/build -S $(LLAMA_DIR) -DGGML_VULKAN=ON
	cmake --build $(LLAMA_DIR)/build --config Release -j $(JOBS) --target llama-server

brain-hip:    brain-src ## AMD (HIP / ROCm)
	cmake -B $(LLAMA_DIR)/build -S $(LLAMA_DIR) -DGGML_HIP=ON
	cmake --build $(LLAMA_DIR)/build --config Release -j $(JOBS) --target llama-server

brain-cpu:    brain-src ## CPU only (Metal still auto-enables on macOS)
	cmake -B $(LLAMA_DIR)/build -S $(LLAMA_DIR)
	cmake --build $(LLAMA_DIR)/build --config Release -j $(JOBS) --target llama-server

brain-run: ## Start the brain (honors GPU_LAYERS, LLM_PORT, MODELS_DIR/BRAIN_DIR)
	GPU_LAYERS=$(GPU_LAYERS) ./scripts/run-brain.sh

brain-clean: ## Remove the llama.cpp build dir
	rm -rf $(LLAMA_DIR)/build
