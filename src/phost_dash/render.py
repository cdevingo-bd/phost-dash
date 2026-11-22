"""Draw a recorded motion as pictures, with MuJoCo's own offscreen renderer on this machine's GPU (EGL).

Run as a subprocess (``python -m phost_dash.render``): it reads one JSON request on stdin, writes ``<n>.png`` files, and
prints one result line. A separate process keeps a GL context and its memory out of the dashboard.

Request: ``{xml, frames: [[qpos...], ...], width, height, out}``. Result: ``{count, width, height}`` or ``{error}``.
"""

from __future__ import annotations

import json
import os
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


def render(xml: str, frames, width: int, height: int, out: Path) -> dict:
    import mujoco
    import numpy as np

    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    out.mkdir(parents=True, exist_ok=True)
    camera = mujoco.MjvCamera()
    mujoco.mjv_defaultFreeCamera(model, camera)
    camera.lookat[:] = model.stat.center
    camera.distance = 2.4 * model.stat.extent
    camera.elevation, camera.azimuth = -25, 130
    renderer = mujoco.Renderer(model, height=height, width=width)
    try:
        for index, frame in enumerate(frames):
            qpos = np.asarray(frame, dtype=np.float64)
            if qpos.shape != (model.nq,):
                raise ValueError(f"frame {index} has {qpos.size} values; the model has nq={model.nq}")
            data.qpos[:] = qpos
            mujoco.mj_forward(model, data)
            renderer.update_scene(data, camera=camera)
            (out / f"{index}.png").write_bytes(png(renderer.render()))
    finally:
        renderer.close()
    return dict(count=len(frames), width=width, height=height)


def main() -> int:
    os.environ.setdefault("MUJOCO_GL", "egl")
    request = json.loads(sys.stdin.read())
    try:
        result = render(request["xml"], request["frames"], int(request["width"]), int(request["height"]),
                        Path(request["out"]))
    except BaseException as error:
        result = dict(error=f"{type(error).__name__}: {error}")
    print(PREFIX + json.dumps(result), flush=True)
    return 0 if "error" not in result else 1


if __name__ == "__main__":
    sys.exit(main())
