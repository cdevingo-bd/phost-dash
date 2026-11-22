"""What the GPU is doing right now, read with ``nvidia-smi`` so the dashboard process never opens a CUDA context
(a context of its own would take GPU memory and could disturb the timings it exists to show)."""

from __future__ import annotations

import subprocess
import time

_TTL = 2.0
_cache: tuple[float, dict] | None = None


def _query(*args: str) -> list[str]:
    out = subprocess.run(["nvidia-smi", *args, "--format=csv,noheader,nounits"], capture_output=True, text=True,
                         timeout=10, check=True).stdout
    return [line.strip() for line in out.splitlines() if line.strip()]


def probe() -> dict:
    """``{available, name, memory_used_mb, memory_total_mb, utilization, processes}``; ``available`` is False (and the
    rest absent) when there is no NVIDIA driver to ask. ``processes`` counts compute processes on the GPU."""
    try:
        name, used, total, util = [x.strip() for x in _query("--query-gpu=name,memory.used,memory.total,utilization.gpu")[0].split(",")]
        procs = len([p for p in _query("--query-compute-apps=pid") if p.isdigit()])
        return dict(available=True, name=name, memory_used_mb=int(used), memory_total_mb=int(total),
                    utilization=int(util), processes=procs)
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return dict(available=False)


def status() -> dict:
    """``probe()``, at most once every two seconds however many pages are watching."""
    global _cache
    now = time.monotonic()
    if _cache is None or now - _cache[0] > _TTL:
        _cache = (now, probe())
    return _cache[1]
