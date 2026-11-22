import json
import os
import struct
import subprocess
import sys
import zlib

import numpy as np
import pytest

from phost_dash.render import PREFIX, png

SPHERE = """<mujoco><worldbody><light pos="0 0 3"/><geom type="plane" size="2 2 .1"/>
<body pos="0 0 1"><freejoint/><geom type="sphere" size=".2" rgba="1 0 0 1"/></body></worldbody></mujoco>"""


def decode(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, chunks = 8, {}
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        kind, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + length]
        (crc,) = struct.unpack(">I", data[pos + 8 + length:pos + 12 + length])
        assert crc == zlib.crc32(kind + body) & 0xFFFFFFFF, f"bad CRC in {kind}"
        chunks[kind] = chunks.get(kind, b"") + body
        pos += 12 + length
    width, height, depth, color = struct.unpack(">IIBB", chunks[b"IHDR"][:10])
    assert (depth, color) == (8, 2)
    raw = zlib.decompress(chunks[b"IDAT"])
    rows = [raw[i * (1 + 3 * width) + 1:(i + 1) * (1 + 3 * width)] for i in range(height)]
    assert all(raw[i * (1 + 3 * width)] == 0 for i in range(height))
    return np.frombuffer(b"".join(rows), np.uint8).reshape(height, width, 3)


def test_the_png_encoder_round_trips_pixels():
    image = np.random.default_rng(0).integers(0, 256, (7, 5, 3), dtype=np.uint8)
    assert (decode(png(image)) == image).all()


def run_render(request):
    done = subprocess.run([sys.executable, "-m", "phost_dash.render"], input=json.dumps(request), capture_output=True,
                          text=True, env=dict(os.environ, MUJOCO_GL="egl"), timeout=120)
    line = [l for l in done.stdout.splitlines() if l.startswith(PREFIX)][-1]
    return json.loads(line[len(PREFIX):]), done


def egl_works():
    pytest.importorskip("mujoco")
    done = subprocess.run([sys.executable, "-c", "import mujoco; mujoco.Renderer(mujoco.MjModel.from_xml_string("
                           "'<mujoco/>'), 8, 8).close()"], capture_output=True, env=dict(os.environ, MUJOCO_GL="egl"),
                          timeout=120)
    return done.returncode == 0


def test_frames_are_drawn_to_numbered_pngs_that_differ_when_the_motion_does(tmp_path):
    if not egl_works():
        pytest.skip("no EGL offscreen rendering here")
    frames = [[0, 0, 1.0, 1, 0, 0, 0], [0, 0, 0.3, 1, 0, 0, 0]]
    result, _ = run_render(dict(xml=SPHERE, frames=frames, width=160, height=120, out=str(tmp_path / "f")))
    assert result == dict(count=2, width=160, height=120)
    first, second = (decode((tmp_path / "f" / f"{i}.png").read_bytes()) for i in (0, 1))
    assert first.shape == (120, 160, 3) and first.std() > 1 and (first != second).any()
    red = lambda im: ((im[..., 0] > 150) & (im[..., 1] < 80) & (im[..., 2] < 80))
    assert red(first).sum() > 50 and red(second).sum() > 50                      # the red sphere is in both pictures
    assert np.argwhere(red(first)).mean(0)[0] < np.argwhere(red(second)).mean(0)[0]   # and lower in the second


def test_a_frame_of_the_wrong_length_is_an_error_line_not_a_crash(tmp_path):
    if not egl_works():
        pytest.skip("no EGL offscreen rendering here")
    result, done = run_render(dict(xml=SPHERE, frames=[[0.0, 1.0]], width=64, height=48, out=str(tmp_path / "f")))
    assert "has 2 values; the model has nq=7" in result["error"] and done.returncode == 1


def test_a_model_that_does_not_parse_is_an_error_line(tmp_path):
    pytest.importorskip("mujoco")
    result, _ = run_render(dict(xml="<mujoco><nonsense/></mujoco>", frames=[[]], width=64, height=48, out=str(tmp_path / "f")))
    assert "error" in result
