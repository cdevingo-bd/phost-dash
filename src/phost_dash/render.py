"""Draw a recorded motion as pictures. The scene's engine draws each frame (``phost_lab.engine.render_frames``); this file only
encodes the pictures as PNG files, so it knows no simulator.

Run as a subprocess (``python -m phost_dash.render``): it reads one JSON request on stdin, writes ``<n>.png`` files, and
prints one result line. A separate process keeps an engine's drawing context and its memory out of the dashboard.

Request: ``{scene, scene_modules, scene_dirs, frames: [[coordinate...], ...], width, height, out}``.
Result: ``{count, width, height}`` or ``{error}``.
"""

from __future__ import annotations

import json
import struct
import sys
import zlib
from pathlib import Path

PREFIX = "PHOST_DASH_RENDER "


def png(rgb) -> bytes:
    """An 8-bit RGB PNG from an (h, w, 3) uint8 array, without an imaging library."""
    height, width, _ = rgb.shape

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + rgb[row].tobytes() for row in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def render(scene, frames, width: int, height: int, out: Path) -> dict:
    from phost_lab.engine import render_frames

    images = render_frames(scene, frames, width, height)        # refuses here, before anything is written, if the engine cannot draw
    out.mkdir(parents=True, exist_ok=True)
    count = 0
    for index, image in enumerate(images):
        (out / f"{index}.png").write_bytes(png(image))
        count += 1
    return dict(count=count, width=width, height=height)


def main() -> int:
    request = json.loads(sys.stdin.read())
    try:
        from phost_lab.bootstrap import load_scenes

        scene = load_scenes(request.get("scene_modules", ()), request.get("scene_dirs", ())).get(request["scene"])
        result = render(scene, request["frames"], int(request["width"]), int(request["height"]), Path(request["out"]))
    except BaseException as error:
        result = dict(error=f"{type(error).__name__}: {error}")
    print(PREFIX + json.dumps(result), flush=True)
    return 0 if "error" not in result else 1


if __name__ == "__main__":
    sys.exit(main())
