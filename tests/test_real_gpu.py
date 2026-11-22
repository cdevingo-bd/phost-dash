"""The dashboard on this machine's GPU, end to end over HTTP, with nothing faked. Skipped without CUDA/mujoco_warp."""

import json
import os
import subprocess
import time

import pytest

pytest.importorskip("mujoco_warp")
wp = pytest.importorskip("warp")
try:
    wp.init()
    HAVE_CUDA = wp.is_cuda_available()
except Exception:                                   # pragma: no cover
    HAVE_CUDA = False
pytestmark = pytest.mark.skipif(not HAVE_CUDA, reason="no CUDA device")

from phost_dash import Config
from phost_dash.cli import serve, serve_in_thread

from conftest import Client, wait_for
from test_render import decode

COUPLED = dict(version=1, name="coupled", host="mjwarp", plugins=["phost_coupledchol.phost_impl"], note="",
               stages={"newton.linear_solve": dict(impl="newton.linear_solve/coupled", params={})})
DAMPING = dict(version=1, name="damped", host="mjwarp", plugins=[], note="",
               stages={"dof.passive_force": dict(impl="dof.passive_force/spring-damper", params=dict(k=0.0, c=0.4, q_ref=0.0, implicit=True))})
SCENE = "trampoline12:impact"


@pytest.fixture(scope="module")
def real(tmp_path_factory):
    server = serve(Config(state=tmp_path_factory.mktemp("state")), token="r" * 43)
    serve_in_thread(server)
    yield Client(server), server
    server.shutdown_all()


def finish(client, job_id, timeout=300):
    return wait_for(lambda: (j := client.get(f"/api/jobs/{job_id}")[1])["status"] in ("done", "failed", "cancelled") and j,
                    timeout, f"job {job_id}")


def workers():
    """Lab worker processes that are children of this test process."""
    found = []
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            stat = open(f"/proc/{pid}/stat").read().rsplit(") ", 1)[1].split()
            cmd = open(f"/proc/{pid}/cmdline").read()
        except OSError:
            continue
        if int(stat[1]) == os.getpid() and "phost_lab.worker" in cmd:
            found.append(int(pid))
    return found


def test_a_real_run_streams_records_ranks_and_draws(real):
    client, server = real
    status, job = client.post("/api/jobs/run", dict(graph=COUPLED, scene=SCENE, worlds=[8], steps=10))
    assert status == 200, job
    import http.client
    conn = http.client.HTTPConnection("127.0.0.1", client.port, timeout=300)
    conn.request("GET", f"/api/jobs/{job['id']}/events", headers={"Host": f"127.0.0.1:{client.port}", "Cookie": client.cookie})
    events = [json.loads(l[6:]) for l in iter(conn.getresponse().readline, b"") if l.startswith(b"data: ")]
    conn.close()
    assert [e["event"] for e in events] == ["start", "cell", "end"] and events[-1]["status"] == "done"
    assert events[1]["cell"]["worlds"] == 8

    done = finish(client, job["id"])
    result = done["result"]
    cell, = result["cells"]
    assert result["pass"] and result["stage_classes"] == {"newton.linear_solve": "exact"} and cell["speedup"] > 1.0
    assert len(cell["frames"]) == 10                                       # steps 10, a frame each
    assert "GPU" in result["meta"]["device"]

    status, recorded = client.post(f"/api/jobs/{job['id']}/record", dict(label="coupled"))
    assert status == 200 and recorded["records"][0]["klass"] == "exact" and recorded["records"][0]["eligible"]
    board = client.get("/api/board")[1]
    assert board["ledger"]["ok"] and board["groups"][0]["rows"][0]["label"] == "coupled"

    status, render = client.post(f"/api/jobs/{job['id']}/render")
    assert status == 200, render
    drawn = finish(client, render["id"])
    assert drawn["status"] == "done" and drawn["result"]["count"] == 10, drawn
    response, body = client.request("GET", f"/api/jobs/{job['id']}/frames/0.png")
    image = decode(body)
    assert response.status == 200 and image.shape == (320, 480, 3) and image.std() > 1
    _, last = client.request("GET", f"/api/jobs/{job['id']}/frames/9.png")
    assert (decode(last) != image).any()                                    # the trampoline moved between first and last frame


def test_the_server_process_never_holds_a_cuda_context(real):
    out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"], capture_output=True,
                         text=True, timeout=10).stdout.split()
    assert str(os.getpid()) not in out


def test_cancelling_a_real_run_stops_the_worker_and_frees_the_queue(real):
    client, _ = real
    status, job = client.post("/api/jobs/run", dict(graph=COUPLED, scene=SCENE, worlds=[4096, 4096], steps=2000))
    assert status == 200
    wait_for(lambda: workers(), message="the worker to start")
    time.sleep(1.0)
    assert client.post(f"/api/jobs/{job['id']}/cancel")[0] == 200
    started = time.monotonic()
    assert finish(client, job["id"], 60)["status"] == "cancelled" and time.monotonic() - started < 15
    wait_for(lambda: not workers(), 10, "the worker to be gone")
    again = client.post("/api/jobs/run", dict(graph=COUPLED, scene=SCENE, worlds=[1], steps=3))[1]
    assert finish(client, again["id"])["status"] == "done"                  # the queue is not stuck


def test_a_typed_equation_runs_as_a_model_changing_graph(real):
    client, _ = real
    graph = dict(version=1, name="spring", host="mjwarp", plugins=["phost_author.expression_impls"], note="",
                 stages={"dof.passive_force": dict(impl="dof.passive_force/expression",
                                                   params=dict(expr="-a*q - b*v", a=5.0, b=0.5))})
    preview = client.post("/api/author/equation", dict(stage="dof.passive_force", expr="-a*q - b*v",
                                                       constants=dict(a=5.0, b=0.5), lo=-1, hi=1, n=3))[1]
    assert preview["ok"] and preview["y"] == pytest.approx([5.0, 0.0, -5.0])
    status, job = client.post("/api/jobs/run", dict(graph=graph, scene=SCENE, worlds=[8], steps=10, frames=False))
    assert status == 200, job
    done = finish(client, job["id"])
    assert done["status"] == "done", done.get("error")
    assert done["result"]["stage_classes"] == {"dof.passive_force": "model_changing"}
    recorded = client.post(f"/api/jobs/{job['id']}/record", {})[1]["records"][0]
    assert recorded["klass"] == "model_changing" and "step_ms" in recorded["objectives"]


def test_the_template_kernel_goes_from_editor_to_check_to_graph_to_ledger(real):
    client, _ = real
    template = client.get("/api/author/template")[1]
    assert client.json("PUT", "/api/kernels/my-solver", dict(stage=template["stage"], source=template["source"]))[0] == 200
    check = client.post("/api/author/kernel/check", dict(source=template["source"], stage=template["stage"]))[1]
    checked = finish(client, check["id"], 600)
    assert checked["status"] == "done" and checked["result"]["ok"] is True, checked
    assert "own process" in checked["result"]["integrity"]               # the report says what it cannot promise

    impl = "newton.linear_solve/user-my-solver"
    assert any(i["id"] == impl for i in client.get("/api/catalog")[1]["registry"]["impls"])
    graph = dict(version=1, name="mine", host="mjwarp", plugins=[], note="",
                 stages={"newton.linear_solve": dict(impl=impl, params={})})
    status, job = client.post("/api/jobs/run", dict(graph=graph, scene="trampoline8:impact", worlds=[8], steps=10))
    assert status == 200, job
    done = finish(client, job["id"], 600)
    assert done["status"] == "done", done.get("error")
    assert done["result"]["stage_classes"] == {"newton.linear_solve": "exact"}
    assert done["result"]["cells"][0]["stage_metrics"]["newton.linear_solve"]["calls"] > 0


def test_a_run_of_a_hidden_scene_reveals_neither_its_description_nor_frames(real, tmp_path):
    client, server = real
    from phost_lab import default_scenes
    folder = tmp_path / "held"
    folder.mkdir()
    (folder / "held-out.xml").write_text(default_scenes().get("trampoline8:impact").xml())
    (folder / "held-out.json").write_text(json.dumps(dict(hidden=True, description="SECRET LAYOUT", settle_steps=5)))
    held = serve(Config(state=tmp_path / "state", scene_dirs=(str(folder),)), token="h" * 43)
    serve_in_thread(held)
    try:
        hidden = Client(held)
        assert "SECRET LAYOUT" not in json.dumps(hidden.get("/api/catalog")[1])
        job = hidden.post("/api/jobs/run", dict(graph=COUPLED, scene="held-out", worlds=[1], steps=4))[1]
        done = finish(hidden, job["id"])
        assert done["status"] == "done" and done["result"]["scene_hidden"] is True
        assert "frames" not in done["result"]["cells"][0]
        assert hidden.post(f"/api/jobs/{job['id']}/render")[0] in (403, 409)
    finally:
        held.shutdown_all()


def test_a_real_watch_streams_a_layout_then_frames_and_is_saved_with_them(real):
    from test_server import sse
    client, server = real
    status, job = client.post("/api/jobs/live", dict(graph=DAMPING, scene="trampoline8:impact", steps=12, every=3))
    assert status == 200, job
    done = finish(client, job["id"])
    assert done["status"] == "done", done.get("error")
    assert done["result"]["frames"] == 4 and done["result"]["steps"] == 12
    _, events = sse(client, job["id"])
    assert [e["event"] for e in events] == ["layout", "live", "live", "live", "live", "end"]
    layout, frames = events[0], events[1:5]
    assert [f["step"] for f in frames] == [3, 6, 9, 12] and layout["flexes"] and layout["geoms"]
    assert all(len(f["native"]["x"]) == 3 * len(layout["geoms"]) and f["finite"] for f in frames)
    saved = server.app.store.load_job(job["id"])["events"]                    # what a later session would replay
    assert [e["event"] for e in saved] == ["layout", "live", "live", "live", "live"]
    assert not workers()


def test_a_real_watch_of_a_scene_the_graph_cannot_run_on_says_why(real):
    client, _ = real
    status, job = client.post("/api/jobs/live", dict(graph=COUPLED, scene="trampoline14:impact", steps=6, every=3))
    assert status == 200
    done = finish(client, job["id"])
    assert done["status"] == "done"                                         # nv=462 is inside the coupled solver's range
    status, job = client.post("/api/jobs/live", dict(graph=COUPLED, scene="tank:boat", steps=6, every=3))
    assert status == 200
    failed = finish(client, job["id"])
    assert failed["status"] == "failed" and "outside 1..512" in failed["error"]
