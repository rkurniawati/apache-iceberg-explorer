#!/usr/bin/env python3
"""
Utility script to optimize and curate screen recording GIFs for README/Marketplace.
- Trims long idle pauses
- Condenses form-filling sequences into clear keyframes
- Resizes to standard markdown display widths (e.g. 1000px)
- Optimizes GIF frame deltas and palette using ImageMagick
"""

import os
import sys
import argparse
import subprocess
import tempfile
import numpy as np
from PIL import Image, ImageSequence

def optimize_gif(
    input_path: str,
    output_path: str,
    width: int = 1000,
    fuzz: str = "2%",
    max_pause_ms: int = 1000,
    diff_threshold: float = 0.3
):
    print(f"Loading {input_path}...")
    img = Image.open(input_path)
    raw_frames = [f.copy() for f in ImageSequence.Iterator(img)]
    durations = [f.info.get("duration", 200) for f in ImageSequence.Iterator(img)]
    total_frames = len(raw_frames)
    orig_duration = sum(durations) / 1000.0

    print(f"Loaded {total_frames} frames (total duration: {orig_duration:.1f}s)")

    sequence = []

    def add_with_dedup(frame_indices, pause_cap=max_pause_ms):
        last_rgb = None
        accum_dur = 0
        cur_idx = None
        for idx in frame_indices:
            f_rgb = np.array(raw_frames[idx].convert("RGB"))
            dur = durations[idx]
            if last_rgb is None:
                cur_idx = idx
                accum_dur = dur
                last_rgb = f_rgb
            else:
                diff = np.abs(f_rgb.astype(float) - last_rgb.astype(float)).mean()
                if diff <= diff_threshold and accum_dur < pause_cap:
                    accum_dur += dur
                else:
                    sequence.append((cur_idx, accum_dur))
                    cur_idx = idx
                    accum_dur = dur
                    last_rgb = f_rgb
        if cur_idx is not None:
            sequence.append((cur_idx, accum_dur))

    # Phase 1: Marketplace / Intro (Frames 0 to 35)
    add_with_dedup(range(0, 36), pause_cap=800)

    # Phase 2: Condensed Settings (Replace ~135 typing frames with key action states)
    sequence.append((35, 600))   # Empty Settings opened
    sequence.append((48, 400))   # S3 selected
    sequence.append((170, 1000)) # Config populated with auto-detected path

    # Phase 3: Core Demo (Frames 178 to end) - connection, overview, DAG, DuckDB query, parquet
    add_with_dedup(range(178, total_frames), pause_cap=max_pause_ms)

    new_duration = sum(dur for _, dur in sequence) / 1000.0
    print(f"Curated to {len(sequence)} frames (duration: {new_duration:.1f}s)")

    with tempfile.TemporaryDirectory() as tmpdir:
        cmd_base = ["magick"]
        for i, (f_idx, dur) in enumerate(sequence):
            p = os.path.join(tmpdir, f"f_{i:04d}.png")
            raw_frames[f_idx].save(p)
            delay_cs = max(2, int(round(dur / 10)))
            cmd_base.extend(["-delay", str(delay_cs), p])

        tmp_out = os.path.join(tmpdir, "assembled.gif")
        cmd_assemble = list(cmd_base)
        if width:
            cmd_assemble.extend(["-resize", f"{width}x"])
        cmd_assemble.extend(["-loop", "0", "-layers", "Optimize", tmp_out])

        print("Assembling frames with ImageMagick...")
        subprocess.run(cmd_assemble, check=True)

        print(f"Applying final optimization (fuzz: {fuzz})...")
        cmd_opt = ["magick", tmp_out, "-fuzz", fuzz, "-layers", "Optimize", output_path]
        subprocess.run(cmd_opt, check=True)

    orig_size = os.path.getsize(input_path) / (1024 * 1024)
    new_size = os.path.getsize(output_path) / (1024 * 1024)
    print(f"Done! {orig_size:.2f} MB -> {new_size:.2f} MB (saved {100*(1 - new_size/orig_size):.1f}%)")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Optimize screen recording demo GIF")
    parser.add_argument("input", nargs="?", default="iceberg-explorer-demo.gif", help="Input GIF path")
    parser.add_argument("output", nargs="?", default="iceberg-explorer-demo-optimized.gif", help="Output GIF path")
    parser.add_argument("--width", type=int, default=1000, help="Output width in px (0 for original)")
    parser.add_argument("--fuzz", default="2%", help="ImageMagick fuzz tolerance")
    args = parser.parse_args()

    optimize_gif(args.input, args.output, width=args.width if args.width > 0 else None, fuzz=args.fuzz)
