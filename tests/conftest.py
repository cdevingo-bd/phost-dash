"""Fixtures: an App with a fake runner (no GPU), and a real HTTP server around it."""

import http.client
import json
import threading
import time

import pytest

from phost_dash import App, Config
from phost_dash.cli import serve, serve_in_thread

TOKEN = "t" * 43
NATIVE_GRAPH = dict(version=1, name="g", host="mjwarp", plugins=[], note="",
                    stages={"newton.linear_solve": dict(impl="newton.linear_solve/native", params={})})
CONTROL_GRAPH = dict(version=1, name="pd", host="mjwarp", plugins=[], note="",
                     stages={"control.law": dict(impl="control.law/pd", params={})})
FAKE_GPU = dict(available=True, name="Fake GPU", memory_used_mb=10, memory_total_mb=1000, utilization=0, processes=0)


class FakeRunners:
    """Stands in for the lab: emits a start and a cell per world count, honours cancel, can be held open."""

    def __init__(self, nq=3):
        self.calls, self.nq = [], nq
        self.hold = threading.Event()
        self.hold.set()                       # clear() it to keep a job running until you set() it or cancel it
        self.running = 0
        self.max_running = 0

    def run(self, request, emit, cancel):
        self.calls.append(request)
        self.running += 1
        self.max_running = max(self.max_running, self.running)
        try:
            emit(dict(event="start", scene=request["scene"], worlds=request["worlds"]))
            for worlds in request["worlds"]:
                while not self.hold.wait(0.01):
                    if cancel.is_set():
                        return dict(error="cancelled")
                if cancel.is_set():
                    return dict(error="cancelled")
                emit(dict(event="cell", cell=dict(worlds=worlds)))
            return self.result(request)
        finally:
            self.running -= 1

    def result(self, request):
        from phost import Registry
        from phost_lab import GraphSpec
        from phost_lab.bootstrap import load_registry
        from phost_lab.runner import stage_classes
        classes = stage_classes(GraphSpec.from_dict(request["graph"]), load_registry([], Registry()))
        accuracy = None if "model_changing" in classes.values() else True        # not gated for a model change
        cells = []
        for worlds in request["worlds"]:
            cell = dict(worlds=worlds, step_ms=1.0, native_ms=2.0, speedup=2.0, native_spread=0.01, rms_dqpos=1e-6,
                        control_rms_dqpos=1e-6, accuracy_ratio=1.0, stage_metrics={}, advisories=[],
                        other_gpu_processes=0,
                        verdict=dict(ok=True, problems=[], notes=[], gates=dict(finite=True, accuracy=accuracy, stage=True)))
            if request.get("frames"):
                cell["frames"] = [[0.1 * i] * self.nq for i in range(3)]
            cells.append(cell)
        return {"graph": request["graph"], "scene": request["scene"], "scene_hidden": False,
                "stage_classes": classes,
                "config": dict(worlds=request["worlds"], steps=request["steps"]),
                "meta": dict(device="Fake GPU", mujoco="3", warp="1", nv=3, timestep=0.002, date="2026-01-01"),
                "cells": cells, "comparable_to_native": True, "pass": True}

    live_error = None
    hold_live = False                       # emit the layout, then wait to be cancelled

    def live(self, request, emit, cancel):
        """A small scene a viewer can draw: a floor, a ball, a turning box and one flex triangle."""
        self.calls.append(request)
        if self.live_error:
            return dict(error=self.live_error)
        geoms = [dict(type=0, size=[0, 0, 0.1], rgba=[.9, .9, .9, 1], body=0, turns=False),
                 dict(type=2, size=[0.05, 0, 0], rgba=[.2, .4, .9, .6], body=1, turns=False),
                 dict(type=6, size=[0.1, 0.05, 0.03], rgba=[.8, .3, .2, 1], body=2, turns=True)]
        flexes = [dict(dim=2, vertadr=0, vertnum=3, rgba=[.8, .8, .8, 1], tri=[[0, 1, 2]])]
        emit(dict(event="layout", scene=request["scene"], every=request["every"], timestep=0.002, geoms=geoms, flexes=flexes, bodies=3))
        if self.hold_live:
            cancel.wait(20)
            return dict(error="cancelled")
        frames = 0
        for step in range(request["every"], request["steps"] + 1, request["every"]):
            if cancel.is_set():
                return dict(error="cancelled")
            z = 0.2 + 0.1 * step / request["steps"]
            pose = dict(x=[0, 0, 0, 0.2, 0, z, -0.2, 0, 0.05], r=[1, 0, 0, 0, 1, 0, 0, 0, 1], f=[0, 0.3, 0.1, 0.1, 0.3, 0.1, 0, 0.4, 0.1])
            emit(dict(event="live", step=step, t=step * 0.002, native=pose, graph=pose, drift=step * 1e-6, noise=1e-7, finite=True))
            frames += 1
        return dict(scene=request["scene"], steps=request["steps"], frames=frames, drift=1e-6, noise=1e-7, advisories=[])

    def reverify(self, request, emit, cancel):
        return dict(agrees=True, differences=[], entry=None, recorded={})

    def render(self, request, emit, cancel):
        return dict(count=3, width=480, height=320, worlds=8)

    def check(self, request, emit, cancel):
        return dict(ok=True, verdict=dict(ok=True), sandbox="fake")

    def analysis(self, request, emit, cancel):
        self.calls.append(request)
        stage = lambda cls, applies=True, **kw: {
            **dict(swap_class=cls, applies=applies, native_ms=None, share=None, ceiling=None, enclosing=None,
                   reason=None if applies else "the host only calls this solve with the discrete integrator"), **kw}
        stages = {
            "newton.linear_solve": stage("exact", native_ms=1.1, share=0.63, enclosing="the solver phase (solver.solve)"),
            "effective.solve": stage("exact", native_ms=0.149, share=0.08, ceiling=1.09),
            "dof.passive_force": stage("model_changing", native_ms=0.035, share=0.02),
            "probe.state": stage("observer"),
            "control.law": stage("model_changing", applies=False),
        }
        structure = dict(n=330, nnz=9678, density=0.089, coupled=300, bandwidth=65, bandwidth_rcm=59,
                         dense_flops=1.2e7, coupled_flops=9.0e6, banded_flops=1.15e6)
        return dict(opportunities=dict(scene=request["scene"], cells=[dict(worlds=1, nv=330, integrator="discrete", step_ms=1.76,
                                                                           launch_floor_ms=0.004, stages=stages)]),
                    structure=dict(scene=request["scene"], nv=330, integrator="discrete", stages={
                        "effective.solve": dict(applies=True, reason=None, structure=structure)}))


@pytest.fixture
def runners():
    return FakeRunners()


@pytest.fixture
def config(tmp_path):
    return Config(state=tmp_path / "state")


@pytest.fixture
def app(config, runners):
    app = App(config, runners=dict(run=runners.run, live=runners.live, reverify=runners.reverify, render=runners.render,
                                   check=runners.check, analysis=runners.analysis), gpu_status=lambda: FAKE_GPU)
    yield app
    app.close()


def wait_for(predicate, timeout=10.0, message="condition"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting for {message}")


def finished(app, job_id, timeout=10.0):
    return wait_for(lambda: (j := app.get_job(job_id))["status"] in ("done", "failed", "cancelled") and j,
                    timeout, f"job {job_id}")


class Client:
    """A browser that has already followed the one-time address: it holds the cookie."""

    def __init__(self, dash, authenticated=True):
        self.dash = dash
        self.port = dash.server_address[1]
        self.cookie = f"{dash.guard.cookie}={dash.guard.token}" if authenticated else None

    def request(self, method, path, body=None, headers=None, raw=None, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        head = {"Host": host or f"127.0.0.1:{self.port}"}
        if self.cookie:
            head["Cookie"] = self.cookie
        data = raw
        if body is None and raw is None and method != "GET":
            body = {}                                    # the guard wants a JSON content type on every change
        if body is not None:
            data = json.dumps(body).encode()
            head["Content-Type"] = "application/json"
        head.update(headers or {})
        conn.request(method, path, body=data, headers=head)
        response = conn.getresponse()
        payload = response.read()
        conn.close()
        return response, payload

    def json(self, method, path, body=None, **kw):
        response, payload = self.request(method, path, body, **kw)
        return response.status, (json.loads(payload) if payload else None)

    def get(self, path, **kw):
        return self.json("GET", path, **kw)

    def post(self, path, body=None, **kw):
        return self.json("POST", path, body if body is not None else {}, **kw)


@pytest.fixture
def dash(config, runners):
    server = serve(config, token=TOKEN)
    server.app.close()                                         # swap in fakes before serving
    server.app = App(config, runners=dict(run=runners.run, live=runners.live, reverify=runners.reverify, render=runners.render,
                                           check=runners.check, analysis=runners.analysis), gpu_status=lambda: FAKE_GPU)
    serve_in_thread(server)
    yield server
    server.shutdown_all()


@pytest.fixture
def client(dash):
    return Client(dash)
