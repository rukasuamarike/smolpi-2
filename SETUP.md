# Setup — pi-agent-smol

Everything needed to build and run this project on a fresh host.

> **Fastest path:** run **`./scripts/setup.sh`** (or `make setup`) — one semi-interactive
> script that installs host deps (apt), pulls submodules, fetches the latest **smolvm**
> release (checksum-verified), runs `bun install`, and locates your brain. `make setup-yes`
> runs it non-interactively. The sections below are the per-component manual reference.

Tested on:
- Ubuntu 24.04 (WSL2), x86_64 — primary dev target
- macOS 14+ on Apple Silicon (M1–M4) — for `llama-server` only; smolvm guests run on Linux hosts

Install `git-lfs` before `make setup` — the smolvm and llama.cpp submodules ship binaries (libkrun, libkrunfw) via LFS, and without it they arrive as pointer files. `sudo apt install git-lfs && git lfs install`.

Linux/WSL2 sections cover smolvm, libkrun, etc. Mac users primarily need section 4 (llama-server) — smolvm itself currently targets Linux.

---

## 1. Browser — nothing to install on the host

The "Eyes" used to be a Go binary you cross-compiled on the host (`make build-go`) that shelled out to
headless Chromium. That's gone: the browser is now [`browser39`](https://github.com/alejandroqh/browser39),
a single Rust binary installed **inside the guest** by `guest-setup.sh` (`bun add -g @aquintanar/browser39`).
No host Go toolchain, no Chromium, no system libs. Skip straight to Bun.

---

## 2. Bun

Only needed for running the agent directly on the host (outside the smolvm guest); the guest installs its own bun via `guest-setup.sh`.

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Verify
bun --version
```

---

## 3. smolvm CLI

The MicroVM runtime. Packs OCI images into self-contained executables with sub-second boot.

> `make setup` (scripts/setup.sh) installs the latest release for you — downloads the
> GitHub release tarball, verifies its checksum, and symlinks `smolvm` onto your PATH.
> The manual install below is the alternative / for a specific version.

```bash
# Install (check https://smolmachines.com for latest instructions)
curl -fsSL https://smolmachines.com/install.sh | bash

# Verify
smolvm --version   # should be v0.8.0+
```

### libkrun (MicroVM backend)

smolvm runs on `libkrun` + `libkrunfw`. How they're located differs between the CLI and a packed binary:

- **CLI (`smolvm …`)** — the wrapper script bundles the libs (release `lib/`, or `~/.smolvm/lib/`) and sets `LD_LIBRARY_PATH` automatically. Always invoke the `smolvm` wrapper, never `smolvm-bin` directly.
- **Packed binaries (v0.8.0+, e.g. `./pi-agent`)** — the libs are **embedded inside the executable** (a `SMOLLIBS` footer) and self-extract to `~/.cache/smolvm-pack/<id>/lib/` on first run, loaded from there by absolute path. **No system install and no `LD_LIBRARY_PATH` needed** — a packed binary runs on any host with `/dev/kvm`, even with smolvm fully uninstalled. (Verified: a v0.8.0 single-file pack boots a guest in a clean env with `smolvm` off `PATH` and an empty `LD_LIBRARY_PATH`; `strace` confirms it loads its own extracted libkrun, not any system copy.)

> **Obsolete (v0.5.x only):** older instructions here told you to `sudo cp` libkrun into `/usr/local/lib` + `ldconfig`. That was only needed for **v0.5.x** packs, which linked against the *system* library path. v0.8.0+ packs carry and self-extract their own libs and ignore any system copy — an old `/usr/local/lib/libkrun.so.1.9.1` is harmless but unused. Safe to leave or remove.

#### Caveat: the official Linux release ships GPU-enabled libkrun

The published `smolvm-*-linux-x86_64` release builds libkrun with `GPU=1`, so `libkrun.so` carries a hard `NEEDED` dependency on **`libvirglrenderer.so.1`** — required *at load time even if you never use the GPU* — and the release does **not** bundle it. virglrenderer in turn needs `libgbm`, `libdrm`, `libX11`, `libvulkan`, `libepoxy`. So both the CLI and any packed artifact's embedded libkrun need these present at runtime:

```bash
# Debian/Ubuntu
sudo apt install libvirglrenderer1
```

Symptom if missing: `load libkrun: … libvirglrenderer.so.1: cannot open shared object file`.

For a **truly minimal, `/dev/kvm`-only portable artifact** (no graphics-stack dependency at all), build libkrun *without* GPU from the `smolvm/` submodule — drop `GPU=1`, keep `BLK=1 NET=1` — and pack with that build.

---

## 4. llama-server (llama.cpp)

The local LLM backend. Must listen on `0.0.0.0` so the smolvm guest can reach it via the host gateway (`172.16.0.1`).

> **Prefer LMStudio (or any OpenAI-compatible server)?** The agent only needs an
> OpenAI-compatible `/v1/chat/completions` endpoint, so llama.cpp is not required. Start
> your server — for **LMStudio**, enable its local server (defaults to port **1234**) and
> tick *Serve on local network* / bind `0.0.0.0` so the guest can reach it — then point the
> agent at it by overriding the port (or full URL):
>
> ```bash
> make machine-up  LLM_PORT=1234
> make machine-run LLM_PORT=1234 LLM_MODEL=<your-model-id>
> # or set the base URL explicitly (the agent appends /v1/chat/completions):
> make machine-run LLM_URL=http://127.0.0.1:1234 LLM_MODEL=<your-model-id>
> ```
>
> These pass through to the guest via `smolvm … -e LLM_URL=… -e LLM_MODEL=…`, so nothing is
> hardcoded in the Smolfile. `make doctor LLM_PORT=1234` probes `/v1/models` (exposed by both
> llama.cpp and LMStudio). The rest of this section is llama.cpp-specific.

**Shortcut — building llama.cpp yourself:** `make brain` auto-detects your backend
(CUDA / Metal / Vulkan / CPU) and builds `llama-server`; force one with
`make brain-cuda | brain-metal | brain-vulkan | brain-hip | brain-cpu`, then start it with
`make brain-run`. These live in **`brain.mk`** (`make -f brain.mk brain` to run standalone) —
kept separate from `make setup` so LMStudio users skip them. The manual steps below are the
underlying detail.

### Get the source

`llama.cpp` is vendored as a git submodule. If you cloned this repo without `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

Otherwise, clone it standalone:

```bash
git clone https://github.com/ggerganov/llama.cpp.git
```

### Build (CPU-only — fastest to set up)

```bash
sudo apt-get install -y build-essential cmake
cd llama.cpp
cmake -B build
cmake --build build --config Release -j$(nproc)

# Binary is at build/bin/llama-server
sudo cp build/bin/llama-server /usr/local/bin/
```

### Build with GPU acceleration (CUDA / Metal / Vulkan / HIP)

> **Apple Silicon shortcut**: Metal is auto-enabled on macOS by default. The CPU-only build instructions above already produce a Metal-accelerated `llama-server` on M-series Macs. Skip ahead to "Apple Silicon (Metal)" for prereqs and verification.

On Linux/WSL2 the default build is **CPU-only**. Without a GPU backend, `--n-gpu-layers` is silently ignored — the model loads to host RAM and runs on CPU. To verify any build's backends:

```bash
./build/bin/llama-server --list-devices
# CPU-only build shows just "CPU"
# CUDA build shows e.g. "CUDA0 - NVIDIA GeForce RTX 4090 (...)"
# Metal build shows e.g. "Metal - Apple M4 Pro"
```

#### Apple Silicon (Metal) — macOS

Apple Silicon Macs (M1 / M2 / M3 / M4) get GPU offload "for free" — llama.cpp detects Metal at build time and enables it unless explicitly disabled.

> **Terminology**: llama.cpp uses **Metal** directly (low-level GPU API), not **MPS** (Metal Performance Shaders, which is the higher-level PyTorch/MLX layer). When llama.cpp says "GPU offload to Metal" that's the right thing — you do not need MPS or MLX installed.

Prereqs:

```bash
# Xcode Command Line Tools (provides clang, make, etc.)
xcode-select --install

# Homebrew (if not already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# cmake
brew install cmake
```

Build (Metal auto-enabled — no flag needed):

```bash
cd llama.cpp
cmake -B build
cmake --build build --config Release -j$(sysctl -n hw.ncpu)

# Install
sudo cp build/bin/llama-server /usr/local/bin/

# Verify Metal is present
llama-server --list-devices
# Should show e.g.:
#   Metal - Apple M4 Pro (54 GB)
```

To **disable** Metal (rare — debugging, comparing CPU perf):

```bash
cmake -B build -DGGML_METAL=OFF
```

Run with full GPU offload — Apple Silicon's unified memory means you can offload all layers as long as the model fits in your total RAM:

```bash
GPU_LAYERS=99 ./scripts/run-brain.sh
```

The MacBook Pro M4 (24 GB+) handles Gemma 4 E4B Q4_K_M (~2.7 GB) with `--n-gpu-layers 99` instantly — first token in well under a second.

#### NVIDIA (CUDA) — WSL2 prerequisites

CUDA in WSL2 requires:
1. Recent NVIDIA driver on **Windows** (not in WSL — WSL inherits it)
2. CUDA toolkit installed in **WSL** (not Windows)

Verify:

```bash
nvidia-smi                    # should show GPU + driver (works inside WSL)
nvcc --version                # CUDA toolkit version
```

If `nvcc` is missing, install the CUDA toolkit for WSL-Ubuntu:
<https://developer.nvidia.com/cuda-downloads> → Linux → WSL-Ubuntu

#### Rebuild with the right backend

```bash
cd llama.cpp
rm -rf build

# Pick ONE of:
cmake -B build -DGGML_CUDA=ON       # NVIDIA
cmake -B build -DGGML_HIP=ON        # AMD
cmake -B build -DGGML_VULKAN=ON     # Vulkan (cross-vendor)
cmake -B build -DGGML_METAL=ON      # Apple Silicon (auto on macOS)

cmake --build build --config Release -j$(nproc)
sudo cp build/bin/llama-server /usr/local/bin/

# Verify the backend is present
llama-server --list-devices
```

`scripts/run-brain.sh` runs `--list-devices` automatically and refuses to pass `--n-gpu-layers` unless a GPU backend is detected — so you'll see a clear warning if a CPU-only build is still in place.

### Download a model

```bash
# Gemma 4 E4B (4-bit, ~2.7GB) — fits iPhone 13+ and MacBook Pro M4
mkdir -p ~/models

# Q4_K_M — best balance of quality and size for Apple Silicon / iPhone
curl -L -o ~/models/gemma-4-E4B-it-Q4_K_M.gguf \
  "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf"

# Q2_K — smaller (~1.5GB), better for iPhone 13/14 with tighter RAM
curl -L -o ~/models/gemma-4-E4B-it-Q2_K.gguf \
  "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q2_K.gguf"
```

**Recommended quants by device:**

```
┌────────────────┬────────┬────────┬──────────────────────────────────────────┐
│     Device     │ Quant  │ ~Size  │                  Notes                   │
├────────────────┼────────┼────────┼──────────────────────────────────────────┤
│ MacBook Pro M4 │ Q4_K_M │ ~2.7GB │ Full speed via Metal, plenty of headroom │
├────────────────┼────────┼────────┼──────────────────────────────────────────┤
│ iPhone 15 Pro+ │ Q4_K_M │ ~2.7GB │ 8GB RAM, fits comfortably                │
├────────────────┼────────┼────────┼──────────────────────────────────────────┤
│ iPhone 13/14   │ Q2_K   │ ~1.5GB │ 4-6GB RAM, tighter margins               │
└────────────────┴────────┴────────┴──────────────────────────────────────────┘
```

### Run

```bash
# From the llama.cpp build directory:
./llama-server \
  -m ~/models/gemma-4-E4B-it-Q4_K_M.gguf \
  --host 0.0.0.0 \
  --port 8080 \
  --ctx-size 4096

# Or if installed to PATH:
llama-server \
  -m ~/models/gemma-4-E4B-it-Q4_K_M.gguf \
  --host 0.0.0.0 \
  --port 8080 \
  --ctx-size 4096
```

`--host 0.0.0.0` is **mandatory**. Without it, the server binds to `127.0.0.1` and the smolvm guest cannot connect.

Add `--n-gpu-layers 99` if you have a GPU build (see "Build with GPU acceleration" above). Or just use `GPU_LAYERS=99 ./scripts/run-brain.sh` — it auto-detects the backend.

### Verify from host

```bash
curl http://localhost:8080/health
```

---

## 5. WSL2 Mirrored Networking (REQUIRED for guest → host LLM)

By default, WSL2 puts your distro behind a NAT bridge. The smolvm guest sits behind a second NAT layer, so reaching `llama-server` on the WSL2 host through `localhost` does not work without configuration. The legacy workaround was hardcoding the host gateway (`172.16.0.1`), which is fragile and changes between Windows updates.

**Mirrored networking** is the supported fix. It makes the WSL2 host share the Windows network stack so `localhost` resolves the same from the host, the guest, and the Windows side.

### Enable

On Windows, open `%USERPROFILE%` (paste into File Explorer's address bar) and create or edit `.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

Then restart WSL from PowerShell (Admin):

```powershell
wsl --shutdown
```

Re-open your WSL terminal. Verify mirrored mode:

```bash
ip addr show eth0 | grep inet
# In mirrored mode, you'll see Windows-side interfaces, not 172.x.x.x
```

### Verify the agent can reach the LLM

With `llama-server` running on the host:

```bash
make machine-up
make test-brain
```

Expected output:
```
── LLM Connection Test (port 8080, timeout 2000ms) ──

  localhost              127.0.0.1        PASS (200)

PASS: LLM is reachable.
```

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `localhost: TIMEOUT` | Mirrored mode not active | Re-check `.wslconfig`, run `wsl --shutdown`, re-open terminal |
| `localhost: REFUSED` | llama-server not running | Start with `--host 0.0.0.0 --port 8080` |
| Test hangs forever | Old `172.16.0.1` probe | Pull latest — that probe was removed |
| `localhost: PASS` but agent fails | Wrong endpoint path | Agent appends `/v1/chat/completions` automatically; only set `LLM_URL` to base URL |

Even with mirrored networking, **always start `llama-server` with `--host 0.0.0.0`**. Binding to `127.0.0.1` only is fragile and breaks if mirroring is later disabled.

---

## Quick validation

After installing everything:

```bash
cd pi-agent-smol

# Smolfile dev workflow (the only build path — no Docker):
make machine-up        # Boot the dev VM (uses snapshot if available)
make machine-init      # First-time package install (one-off, then snapshot)
make machine-snapshot  # Cache the configured VM for fast future boots
make test-brain        # Verify guest → host LLM connection
make machine-run       # Start the agent

# 'make pack' (alias for machine-snapshot) produces ./pi-agent — a self-contained
# binary that boots on any host with /dev/kvm, no smolvm install required.
make test-smol-net     # End-to-end guest → host network test (needs ./pi-agent)
```
