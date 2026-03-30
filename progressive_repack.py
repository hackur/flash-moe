#!/usr/bin/env python3
"""Progressive repack: repack experts layer by layer, deleting consumed safetensors as we go.

This saves disk space by freeing source files after all their layers are repacked.
Each safetensor (~4.9GB) covers ~2 layers. Each packed layer is ~3.63GB.
Net: we free ~4.9GB and use ~7.26GB per pair = need ~2.4GB headroom per pair.

With 27GB free, this is very comfortable.
"""

import json
import os
import subprocess
import sys

MODEL_DIR = "/Volumes/JS-DEV/flash-moe-model"
REPO_DIR = "/Volumes/JS-DEV/flash-moe"
INDEX_FILE = os.path.join(REPO_DIR, "expert_index.json")

def get_free_space_gb():
    st = os.statvfs(MODEL_DIR)
    return (st.f_bavail * st.f_frsize) / (1024**3)

def main():
    with open(INDEX_FILE) as f:
        idx = json.load(f)

    reads = idx["expert_reads"]

    # Build file→layers map
    file_to_layers = {}
    for layer_str, comps in reads.items():
        for comp_name, info in comps.items():
            if isinstance(info, dict) and "file" in info:
                fname = info["file"]
                file_to_layers.setdefault(fname, set()).add(int(layer_str))
            elif isinstance(info, list):
                for item in info:
                    if isinstance(item, dict) and "file" in item:
                        fname = item["file"]
                        file_to_layers.setdefault(fname, set()).add(int(layer_str))

    repacked_layers = set()
    
    # Check already repacked
    packed_dir = os.path.join(MODEL_DIR, "packed_experts")
    if os.path.isdir(packed_dir):
        for f in os.listdir(packed_dir):
            if f.startswith("layer_") and f.endswith(".bin"):
                layer_num = int(f.split("_")[1].split(".")[0])
                repacked_layers.add(layer_num)
    
    print(f"Already repacked: {len(repacked_layers)} layers")
    print(f"Free space: {get_free_space_gb():.1f} GB")
    
    # Process layers in order
    for layer in range(60):
        if layer in repacked_layers:
            print(f"Layer {layer}: already done, skipping")
            continue
        
        free = get_free_space_gb()
        print(f"\n{'='*60}")
        print(f"Layer {layer}/59 | Free: {free:.1f} GB")
        
        if free < 5.0:
            print(f"ERROR: Only {free:.1f} GB free, need at least 5 GB. Stopping.")
            sys.exit(1)
        
        # Repack this layer
        cmd = [
            sys.executable, os.path.join(REPO_DIR, "repack_experts.py"),
            "--layers", str(layer),
            "--index", INDEX_FILE
        ]
        print(f"Repacking layer {layer}...")
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"FAILED: {result.stderr}")
            sys.exit(1)
        
        # Extract timing from output
        for line in result.stdout.split("\n"):
            if "Layer" in line and "GB" in line:
                print(f"  {line.strip()}")
            if "verification" in line:
                print(f"  {line.strip()}")
        
        repacked_layers.add(layer)
        
        # Check which safetensors are now fully consumed
        for fname, needed_layers in file_to_layers.items():
            if needed_layers.issubset(repacked_layers):
                fpath = os.path.join(MODEL_DIR, fname)
                if os.path.exists(fpath):
                    size_gb = os.path.getsize(fpath) / (1024**3)
                    print(f"  🗑️  Deleting {fname} ({size_gb:.1f} GB) — all layers consumed")
                    os.remove(fpath)
    
    print(f"\n{'='*60}")
    print(f"DONE: All 60 layers repacked!")
    print(f"Free space: {get_free_space_gb():.1f} GB")
    
    # Final cleanup: remove any remaining safetensors
    remaining = [f for f in os.listdir(MODEL_DIR) if f.endswith(".safetensors")]
    if remaining:
        print(f"\nCleaning up {len(remaining)} remaining safetensors...")
        for f in remaining:
            fpath = os.path.join(MODEL_DIR, f)
            size_gb = os.path.getsize(fpath) / (1024**3)
            print(f"  🗑️  {f} ({size_gb:.1f} GB)")
            os.remove(fpath)
    
    print(f"\nFinal free space: {get_free_space_gb():.1f} GB")

if __name__ == "__main__":
    main()
