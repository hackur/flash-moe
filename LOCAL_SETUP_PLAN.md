# Flash-MoE: Local Setup Plan
_Written: 2026-03-30_

## Hardware Assessment

| Item | Required | This Machine |
|------|----------|-------------|
| RAM | 48 GB | **Unknown — need to verify** |
| SSD free space | 215+ GB | **25 GB free on /Volumes/JS-DEV** ⚠️ |
| OS | macOS (Apple Silicon) | macOS 25.3.0 arm64 ✅ |
| Xcode / clang | Yes | Xcode 17.0.0 ✅ |
| Metal support | Apple Silicon GPU | ✅ |

**⚠️ STORAGE BLOCKER:** `/Volumes/JS-DEV` has only 25 GB free. The model requires:
- `model_weights.bin` — 5.5 GB (non-expert weights)
- `packed_experts/` — 218 GB (60 × 3.63 GB layer files, 4-bit)
- Or 120 GB for 2-bit experts (breaks tool calling)
- `vocab.bin` + `tokenizer.bin` — <100 MB

**You need at least 230 GB free for the 4-bit configuration.**

Options to resolve:
1. Free space on the volume (delete old data)
2. Use a different volume with enough space
3. Use 2-bit experts (120 GB) — acceptable for non-tool-calling use

---

## What Needs to Happen (Full Pipeline)

### Phase 1 — Python tooling
The weight extraction and repacking scripts need:
- `numpy`
- `safetensors`
- `huggingface_hub`

Python 3.9.6 is present. These are quick installs via pip.

### Phase 2 — Download the model
The model is `mlx-community/Qwen3.5-397B-A17B-4bit` on HuggingFace (~209 GB).

Download path (hardcoded in scripts):
```
~/.cache/huggingface/hub/models--mlx-community--Qwen3.5-397B-A17B-4bit/
snapshots/39159bd8aa74f5c8446d2b2dc584f62bb51cb0d3/
```
Or set `--model` flag in extraction scripts to a custom path.

### Phase 3 — Extract non-expert weights
Run `extract_weights.py` to create `model_weights.bin` (5.5 GB):
```bash
cd metal_infer
python extract_weights.py --model /path/to/model --output .
```
This creates `model_weights.bin` and `model_weights.json`.

### Phase 4 — Export tokenizer
Run `export_tokenizer.py` to create `tokenizer.bin` and `vocab.bin`:
```bash
cd metal_infer
python export_tokenizer.py /path/to/model/tokenizer.json tokenizer.bin
```

### Phase 5 — Repack experts
Run `repack_experts.py` to create `packed_experts/` (60 files, ~218 GB total):
```bash
# From repo root (not metal_infer/)
python repack_experts.py
```
This reads `expert_index.json` which currently points to the original author's HF cache path. **You must update `expert_index.json` to point to your local model path**, or pass `--model` if the script supports it.

Alternatively for 2-bit (120 GB, faster but no tool calling):
```bash
cd metal_infer
python repack_experts_2bit.py
```

### Phase 6 — Build the inference engine
```bash
cd metal_infer
make
```
This builds:
- `metal_infer` — expert benchmark binary
- `infer` — full inference engine
- `make chat` — builds the interactive chat TUI

### Phase 7 — Run
```bash
cd metal_infer
./infer --prompt "Hello, what is 2+2?" --tokens 50
./chat
```

---

## Detailed Steps

### Step 1 — Install Python dependencies

```bash
pip3 install numpy safetensors huggingface_hub
```

### Step 2 — Fix model path references

The scripts hardcode the original author's HuggingFace cache path. You must update two files:

**`expert_index.json`** (repo root):
```json
{ "model_path": "<YOUR_MODEL_PATH>", ... }
```

**`metal_infer/extract_weights.py`** line ~53:
```python
default=os.path.expanduser('<YOUR_MODEL_PATH>')
```

**`metal_infer/export_tokenizer.py`** line ~56:
```python
'/path/to/model/tokenizer.json'
```

### Step 3 — Download model

Option A — via `huggingface-cli`:
```bash
huggingface-cli download mlx-community/Qwen3.5-397B-A17B-4bit \
  --local-dir /path/to/destination
```

Option B — via Python:
```python
from huggingface_hub import snapshot_download
snapshot_download(repo_id="mlx-community/Qwen3.5-397B-A17B-4bit",
                  local_dir="/path/to/destination")
```

### Step 4 — Extract non-expert weights

```bash
cd metal_infer
python3 extract_weights.py \
  --model /path/to/downloaded/model \
  --output .
```
Produces: `model_weights.bin` (5.5 GB), `model_weights.json`

### Step 5 — Export tokenizer

```bash
cd metal_infer
python3 export_tokenizer.py \
  /path/to/model/tokenizer.json \
  tokenizer.bin
```

### Step 6 — Repack experts

```bash
# Edit expert_index.json first: update model_path to your local path
# Then from repo root:
python3 repack_experts.py
```

Creates `packed_experts/layer_00.bin` through `layer_59.bin` in the repo root.
Each file is ~3.63 GB. Total: ~218 GB.

**This is the longest step — ~45–90 min depending on SSD speed.**

### Step 7 — Build

```bash
cd metal_infer
make
```

If build fails check:
- Xcode command line tools: `xcode-select --install`
- Accelerate framework: bundled with Xcode/macOS, should be auto-found
- compression library: `-lcompression` — bundled with macOS

### Step 8 — Verify build

```bash
cd metal_infer
# Quick sanity check (needs packed_experts/layer_0.bin)
./metal_infer --layer 0 --expert 0 --verify
```

### Step 9 — Run inference

```bash
cd metal_infer
# Single prompt
./infer --prompt "Explain quantum computing" --tokens 100

# Interactive chat with tool calling
./chat

# Timing breakdown
./infer --prompt "Hello" --tokens 20 --timing
```

---

## Blockers and Risk Assessment

| Blocker | Severity | Notes |
|---------|----------|-------|
| Only 25 GB free on /Volumes/JS-DEV | 🔴 Critical | Need 230 GB+ for 4-bit, 125 GB+ for 2-bit |
| Python deps not installed | 🟡 Minor | `pip3 install numpy safetensors huggingface_hub` |
| Model not downloaded | 🔴 Must-do | 209 GB download from HuggingFace |
| Hardcoded paths in scripts | 🟡 Minor | Update `expert_index.json` and 2 Python scripts |
| RAM unknown | 🟡 Verify | Target machine was 48 GB M3 Max; this machine may differ |

---

## Recommended Approach

Given the storage constraint, the recommended order is:

1. **Verify RAM** — confirm this machine has ≥ 48 GB
2. **Find storage** — identify a volume with 250+ GB free (internal preferred for SSD speed)
3. **Install Python deps** — `pip3 install numpy safetensors huggingface_hub`
4. **Download model** — `huggingface-cli download mlx-community/Qwen3.5-397B-A17B-4bit`
5. **Fix paths** — update `expert_index.json` and the two Python scripts
6. **Run extraction + repack** — `extract_weights.py` → `export_tokenizer.py` → `repack_experts.py`
7. **Build** — `cd metal_infer && make`
8. **Run** — `./infer --prompt "Hello" --tokens 50`

---

## Notes on This Specific Machine

- `/Volumes/JS-DEV` is 1.8 TB total, but 93% full (only 25 GB free)
- The model download + expert repack will require 215–230 GB
- **Storage is the gating factor. Nothing else can proceed until it is resolved.**
- Xcode 17 with clang is present — build will work once storage is sorted
- Python 3.9.6 is present — deps just need to be installed
