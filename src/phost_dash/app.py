"""The dashboard's behaviour, with no HTTP in it: every request is a method that takes plain data and returns plain data,
so it can be tested without a server and the server stays a thin translation layer."""

from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import os
import subprocess
import sys
import threading
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Mapping

from phost import ContractError, Registry
from phost_lab import NATIVE, GraphSpec
from phost_lab.bootstrap import load_registry, load_scenes
from phost_lab.engine import require_capability, supports
from phost_lab.isolate import run_isolated
from phost_lab.runner import RunConfig, comparable_to_native, stage_classes
from phost_score import Entry, Ledger, SELF_REPORTED, leaderboard, make_entries, reverify

from . import gpu, userkernels
from .jobs import DONE, JobError, JobManager, NoSuchJob
from .render import PREFIX as RENDER_PREFIX
from .store import NotFound, Store, StoreError

OPTIONAL_PLUGINS = ("phost_author.expression_impls", "phost_coupledchol.phost_impl")
MAX_WORLDS, MAX_STEPS, MAX_SOURCE, MAX_LIVE_STEPS = 4096, 2000, 200_000, 5000
PACKAGES = ("phost", "phost-lab", "phost-score", "phost-dash", "phost-author", "phost-agent", "phost-coupledchol", "mujoco",
            "mujoco-warp", "warp-lang", "numpy")


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


@dataclass(frozen=True)
class Config:
    state: Path
    plugins: tuple[str, ...] = ()                   # modules exposing register(registry), beyond the ones found installed
    scene_modules: tuple[str, ...] = ()
    scene_dirs: tuple[str, ...] = ()
    job_timeout: float = 900.0


def installed(module: str) -> bool:
    return importlib.util.find_spec(module.split(".")[0]) is not None


def _version(name: str) -> str | None:
    """The installed version, or for our own packages run from a source checkout, the version they declare."""
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        module = name.replace("-", "_")
        if name.startswith("phost") and installed(module):
            return getattr(importlib.import_module(module), "__version__", None)
        return None


class App:
    def __init__(self, config: Config, *, runners: Mapping[str, Callable] | None = None,
                 gpu_status: Callable[[], dict] = gpu.status):
        self.config = config
        self.store = Store(config.state)
        self.ledger = Ledger(config.state / "ledger.jsonl")
        self.plugins = tuple(dict.fromkeys([m for m in OPTIONAL_PLUGINS if installed(m)] + list(config.plugins)))
        self._gpu = gpu_status
        self._lock = threading.Lock()
        self.jobs = JobManager(self.store, runners if runners is not None else {
            "run": self._run, "live": self._live, "reverify": self._reverify, "render": self._render,
            "check": self._check, "analysis": self._analysis, "profile": self._profile})

    def close(self) -> None:
        self.jobs.close()

    # ---- what there is ----

    def registry(self) -> Registry:
        """A registry of the stages and implementations a graph may use: built in, plugins, and the saved user kernels.
        Nothing in the user's kernel source is executed here."""
        registry = load_registry(self.plugins, Registry())
        userkernels.register(registry, self.config.state)
        return registry

    def scenes(self):
        return load_scenes(self.config.scene_modules, self.config.scene_dirs)

    def info(self) -> dict:
        return dict(gpu=self._gpu(), packages={p: _version(p) for p in PACKAGES if _version(p)},
                    plugins=list(self.plugins), state=str(self.config.state), author=installed("phost_author"),
                    render=self._can_render(), limits=dict(max_accuracy_ratio=RunConfig().max_accuracy_ratio))

    def _can_render(self) -> bool:
        return installed("mujoco")

    def research(self) -> dict:
        """What the agent layer (phost-agent) has done on this machine: the funnel its proposals went through, what its memo
        saved, what it spent, who holds each device, and whether its journal is intact. Read-only: a search is started with
        ``phost-agent run``, which writes the journal under this dashboard's state directory by default."""
        if not installed("phost_agent"):
            return dict(installed=False)
        from phost_agent import Journal, overview
        agent = self.config.state / "agent"
        return dict(installed=True, journal=str(agent / "journal.jsonl"),
                    **overview(Journal(agent / "journal.jsonl"), lease_dir=agent / "leases"))

    def catalog(self) -> dict:
        return dict(registry=self.registry().describe(), scenes=self.scenes().describe(), plugins=list(self.plugins))

    # ---- graphs ----

    def _graph(self, spec: Any, registry: Registry | None = None) -> GraphSpec:
        if not isinstance(spec, Mapping):
            raise ApiError(400, "a graph is a JSON object")
        if not isinstance(spec.get("name"), str) or not spec["name"]:
            raise ApiError(400, "a graph needs a name (text)")
        try:
            graph = GraphSpec.from_dict(dict(spec))
            extra = sorted(set(graph.plugins) - set(self.plugins))
            if extra:
                raise ApiError(400, f"the graph names plugin {extra[0]!r}, which this dashboard was not started with "
                                    f"(start it with --plugin {extra[0]})")
            graph.validate(registry or self.registry())
        except (ContractError, KeyError, TypeError, ValueError) as error:
            raise ApiError(400, f"not a graph: {error}" if not isinstance(error, ContractError) else str(error)) from None
        return graph

    @staticmethod
    def _for_scene(graph: GraphSpec, spec: Any, scene) -> GraphSpec:
        """A graph the page built names no host: it runs on whichever simulator the scene does. One that names a host keeps
        it, and the lab refuses it on a scene of another engine (a stage is bound to the host it was written for)."""
        if isinstance(spec, Mapping) and "host" not in spec and graph.stages:
            return replace(graph, host=scene.engine)
        return graph

    @staticmethod
    def _need(scene, capability: str, what: str) -> None:
        """Refuse a tool the scene's engine does not offer (the lab says which engines do)."""
        try:
            require_capability(scene, capability, what)
        except ContractError as error:
            raise ApiError(400, str(error)) from None

    def validate(self, body: Mapping[str, Any]) -> dict:
        registry = self.registry()
        try:
            graph = self._graph(body.get("graph"), registry)
        except ApiError as error:
            return dict(ok=False, error=error.message)
        return dict(ok=True, stage_classes=stage_classes(graph, registry),
                    comparable_to_native=comparable_to_native(graph, registry))

    def list_graphs(self) -> list[str]:
        return self.store.list_graphs()

    def get_graph(self, name: str) -> dict:
        return self._stored(self.store.load_graph, name)

    def put_graph(self, name: str, body: Mapping[str, Any]) -> dict:
        self._graph(body)
        self._stored(self.store.save_graph, name, body)
        return dict(name=name)

    def delete_graph(self, name: str) -> dict:
        self._stored(self.store.delete_graph, name)
        return dict(name=name)

    def _stored(self, call: Callable, *args, **kwargs):
        try:
            return call(*args, **kwargs)
        except NotFound as error:
            raise ApiError(404, str(error)) from None
        except StoreError as error:
            raise ApiError(400, str(error)) from None

    # ---- kernels and equations ----

    def list_kernels(self) -> list[dict]:
        return [{k: v for k, v in self.store.load_kernel(n).items() if k != "source"} for n in self.store.list_kernels()]

    def get_kernel(self, name: str) -> dict:
        return self._stored(self.store.load_kernel, name)

    def put_kernel(self, name: str, body: Mapping[str, Any]) -> dict:
        self._need_author()
        source, stage = body.get("source"), body.get("stage")
        if not isinstance(source, str) or not source.strip() or len(source) > MAX_SOURCE:
            raise ApiError(400, f"source must be text of at most {MAX_SOURCE} characters")
        if stage not in {c.name for c in self.registry().contracts()}:
            raise ApiError(400, f"unknown stage {stage!r}")
        entry = body.get("entry", "Runtime")
        if not isinstance(entry, str) or not entry.isidentifier():
            raise ApiError(400, "entry must be a class name")
        self._stored(self.store.save_kernel, name, stage=stage, source=source, entry=entry, params=body.get("params"))
        return dict(name=name, impl=userkernels.impl_id(stage, name))

    def delete_kernel(self, name: str) -> dict:
        self._stored(self.store.delete_kernel, name)
        return dict(name=name)

    def kernel_template(self) -> dict:
        self._need_author()
        import phost_author
        path = Path(phost_author.__file__).parent / "templates" / "newton_solver_template.py"
        return dict(source=path.read_text(encoding="utf-8"), stage="newton.linear_solve", entry="Runtime")

    def equation(self, body: Mapping[str, Any]) -> dict:
        """Check what was typed for a stage and show what it does. A bad one is a normal answer (``ok: false`` and the message),
        not an error. What comes back depends on the stage's form: a curve per output, channel values on a sample state, or the
        residual of a solver step after each pass."""
        self._need_author()
        from phost_author.expression_impls import preview
        try:
            numbers = {k: float(body[k]) for k in ("lo", "hi", "condition") if k in body}
            whole = {k: int(body[k]) for k in ("n", "iterations", "size") if k in body}
            text = {k: str(body[k]) for k in ("init", "step") if k in body}
            return dict(ok=True, **preview(
                self.registry(), str(body.get("stage")), str(body.get("expr", "")), body.get("constants") or {}, body.get("sweep"),
                body.get("at") or {}, **numbers, **whole, **text))
        except (ContractError, TypeError, ValueError) as error:
            return dict(ok=False, error=str(error))

    def equation_forms(self) -> dict:
        """What a person typing for each stage needs to know (its names, outputs and kind), for the editor."""
        self._need_author()
        from phost_author.expression_impls import describe_form
        registry = self.registry()
        return {stage: describe_form(registry, stage) for stage in registry.equation_stages()}

    def _need_author(self) -> None:
        if not installed("phost_author"):
            raise ApiError(501, "this needs phost-author: pip install phost-dash[author]")

    # ---- starting jobs ----

    def start_run(self, body: Mapping[str, Any]) -> dict:
        registry = self.registry()
        spec = self.get_graph(body["graph_name"]) if "graph_name" in body and "graph" not in body else body.get("graph")
        graph = self._graph(spec, registry)
        scenes = self.scenes()
        scene_id = body.get("scene")
        if scene_id not in scenes.ids():
            raise ApiError(400, f"no scene {scene_id!r}")
        worlds = body.get("worlds", [1, 8])
        if not (isinstance(worlds, list) and 1 <= len(worlds) <= 6
                and all(isinstance(w, int) and not isinstance(w, bool) and 1 <= w <= MAX_WORLDS for w in worlds)):
            raise ApiError(400, f"worlds is a list of 1 to 6 whole numbers between 1 and {MAX_WORLDS}")
        steps = body.get("steps", 20)
        if not (isinstance(steps, int) and not isinstance(steps, bool) and 1 <= steps <= MAX_STEPS):
            raise ApiError(400, f"steps is a whole number between 1 and {MAX_STEPS}")
        scene = scenes.get(scene_id)
        graph = self._for_scene(graph, spec, scene)
        frames = bool(body.get("frames", True)) and not scene.hidden and supports(scene, "render")      # only MuJoCo scenes are drawn as images
        job = self.jobs.submit("run", dict(graph=graph.to_dict(), scene=scene_id, worlds=worlds, steps=steps,
                                           frames=frames))
        return job.summary()

    def start_live(self, body: Mapping[str, Any]) -> dict:
        """Watch a graph and native side by side, streamed (see ``phost_lab.live``). Never for a held-out scene."""
        registry = self.registry()
        spec = self.get_graph(body["graph_name"]) if "graph_name" in body and "graph" not in body else body.get("graph")
        graph = self._graph(spec, registry)
        scenes = self.scenes()
        scene_id = body.get("scene")
        if scene_id not in scenes.ids():
            raise ApiError(400, f"no scene {scene_id!r}")
        if scenes.get(scene_id).hidden:
            raise ApiError(403, "a held-out scene is never drawn")
        self._need(scenes.get(scene_id), "live", "the live view")
        steps, every = body.get("steps", 300), body.get("every", 6)
        for name, value, high in (("steps", steps, MAX_LIVE_STEPS), ("every", every, 200)):
            if not (isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= high):
                raise ApiError(400, f"{name} is a whole number between 1 and {high}")
        return self.jobs.submit("live", dict(graph=graph.to_dict(), scene=scene_id, steps=steps, every=every)).summary()

    def start_check(self, body: Mapping[str, Any]) -> dict:
        self._need_author()
        source = body.get("source")
        if not isinstance(source, str) or not source.strip() or len(source) > MAX_SOURCE:
            raise ApiError(400, f"source must be text of at most {MAX_SOURCE} characters")
        stage = body.get("stage", "newton.linear_solve")
        if stage not in {c.name for c in self.registry().contracts()}:
            raise ApiError(400, f"unknown stage {stage!r}")
        return self.jobs.submit("check", dict(source=source, stage=stage, entry=body.get("entry", "Runtime"),
                                              params=body.get("params") or {}, scene=body.get("scene"),
                                              worlds=2)).summary()

    def start_analysis(self, body: Mapping[str, Any]) -> dict:
        """Where a change could pay on a scene: each stage's share of the step and its speedup ceiling, where it applies, and
        the structure of its system matrix. Measured in a worker, on this machine's GPU. Never for a held-out scene."""
        scenes = self.scenes()
        scene_id = body.get("scene")
        if scene_id not in scenes.ids():
            raise ApiError(400, f"no scene {scene_id!r}")
        if scenes.get(scene_id).hidden:
            raise ApiError(403, "a held-out scene's structure and timings are never shown")
        worlds = body.get("worlds", [1])
        if not (isinstance(worlds, list) and 1 <= len(worlds) <= 3
                and all(isinstance(w, int) and not isinstance(w, bool) and 1 <= w <= MAX_WORLDS for w in worlds)):
            raise ApiError(400, f"worlds is a list of 1 to 3 whole numbers between 1 and {MAX_WORLDS}")
        return self.jobs.submit("analysis", dict(scene=scene_id, worlds=worlds)).summary()

    def start_profile(self, body: Mapping[str, Any]) -> dict:
        """Time each phase of the step on a scene: native, and with an experiment installed when one is given. Never for a
        held-out scene."""
        scenes = self.scenes()
        scene_id = body.get("scene")
        if scene_id not in scenes.ids():
            raise ApiError(400, f"no scene {scene_id!r}")
        if scenes.get(scene_id).hidden:
            raise ApiError(403, "a held-out scene's timings are never shown")
        self._need(scenes.get(scene_id), "profile", "the phase profile")
        worlds = body.get("worlds", [1])
        if not (isinstance(worlds, list) and 1 <= len(worlds) <= 3
                and all(isinstance(w, int) and not isinstance(w, bool) and 1 <= w <= MAX_WORLDS for w in worlds)):
            raise ApiError(400, f"worlds is a list of 1 to 3 whole numbers between 1 and {MAX_WORLDS}")
        graph = self._graph(body["graph"], self.registry()).to_dict() if body.get("graph") else None
        return self.jobs.submit("profile", dict(scene=scene_id, worlds=worlds, graph=graph)).summary()

    def start_reverify(self, body: Mapping[str, Any]) -> dict:
        seq = body.get("seq")
        if not isinstance(seq, int) or isinstance(seq, bool):
            raise ApiError(400, "seq is the record number")
        if not any(r.seq == seq for r in self.ledger.records(strict=False)):
            raise ApiError(404, f"no record #{seq}")
        return self.jobs.submit("reverify", dict(seq=seq)).summary()

    def start_render(self, job_id: str) -> dict:
        record = self._job(job_id)
        if record["kind"] != "run" or record["status"] != DONE:
            raise ApiError(409, "only a finished run can be drawn")
        if self.scenes().get(record["request"]["scene"]).hidden:
            raise ApiError(403, "a held-out scene is never drawn")
        if not any(c.get("frames") for c in record["result"]["cells"]):
            raise ApiError(409, "this run recorded no frames")
        return self.jobs.submit("render", dict(job=job_id, scene=record["request"]["scene"])).summary()

    # ---- looking at and controlling jobs ----

    def _job(self, job_id: str) -> dict:
        try:
            return self.jobs.stored(job_id)
        except NoSuchJob as error:
            raise ApiError(404, str(error)) from None

    def list_jobs(self) -> list[dict]:
        return self.jobs.summaries()

    def get_job(self, job_id: str) -> dict:
        record = self._job(job_id)
        return {k: v for k, v in record.items() if k != "events"}

    def cancel(self, job_id: str) -> dict:
        try:
            job = self.jobs.get(job_id)
            if job.kind == "check" and job.status == "running":
                raise ApiError(409, "a sandboxed check cannot be interrupted; it ends at its own time limit")
            return self.jobs.cancel(job_id).summary()
        except JobError as error:
            raise ApiError(404 if isinstance(error, NoSuchJob) else 409, str(error)) from None

    def frame_path(self, job_id: str, index: int) -> Path:
        path = self.store.job_dir(job_id) / "frames" / f"{index}.png"
        if not path.is_file():
            raise ApiError(404, "no such frame")
        return path

    # ---- the ledger ----

    def record(self, job_id: str, body: Mapping[str, Any]) -> dict:
        record = self._job(job_id)
        if record["kind"] != "run" or record["status"] != DONE:
            raise ApiError(409, "only a finished run can be recorded")
        with self._lock:                                   # one recording at a time, so two clicks record once
            record = self._job(job_id)
            if record.get("recorded"):
                raise ApiError(409, f"already recorded as #{', #'.join(map(str, record['recorded']))}")
            label = body.get("label", "")
            if not isinstance(label, str) or len(label) > 80:
                raise ApiError(400, "label is text of at most 80 characters")
            entries = make_entries(record["result"], label=label, trust=SELF_REPORTED)
            records = [self.ledger.append(e.to_dict()) for e in entries]
            self.jobs.mark_recorded(job_id, [r.seq for r in records])
        return dict(records=[dict(seq=r.seq, klass=e.klass, worlds=e.worlds, eligible=e.eligible, reasons=list(e.reasons),
                                  objectives=dict(e.objectives), reliable=e.reliable)
                             for r, e in zip(records, entries)])

    def ledger_status(self) -> dict:
        verification = self.ledger.verify()
        return dict(ok=verification.ok, problems=list(verification.problems[:10]), count=len(verification.records),
                    head=str(verification.head))

    def board(self, query: Mapping[str, str]) -> dict:
        known = {"scene", "device", "worlds", "klass", "trust", "label"}
        unknown = set(query) - known - {"include_unreliable"}
        if unknown:
            raise ApiError(400, f"unknown filter {sorted(unknown)[0]!r}")
        filters: dict[str, Any] = {k: query[k] for k in known if k in query and query[k] != ""}
        try:
            if "worlds" in filters:
                filters["worlds"] = int(filters["worlds"])
        except ValueError:
            raise ApiError(400, "worlds is a whole number") from None
        records = self.ledger.records(strict=False)
        return dict(groups=leaderboard(records, include_unreliable=query.get("include_unreliable") == "1", **filters),
                    ledger=self.ledger_status())

    # ---- runners (they run on the job thread) ----

    def _env(self) -> dict[str, str]:
        return {userkernels.ENV: str(self.config.state)}

    def _worker_plugins(self) -> list[str]:
        return [*self.plugins, userkernels.__name__]

    def _isolated(self, graph: Mapping[str, Any], scene: str, config: RunConfig, emit, cancel) -> dict:
        return run_isolated(GraphSpec.from_dict(dict(graph)), scene, config, plugins=self._worker_plugins(),
                            scene_modules=self.config.scene_modules, scene_dirs=self.config.scene_dirs,
                            timeout=self.config.job_timeout, on_progress=emit, cancel=cancel, env=self._env())

    def _run(self, request, emit, cancel) -> dict:
        worlds, steps = tuple(request["worlds"]), request["steps"]
        config = RunConfig(worlds=worlds, steps=steps,
                           frame_every=max(1, steps // 30) if request.get("frames") else 0, max_frames=60)
        return self._isolated(request["graph"], request["scene"], config, emit, cancel)

    def _live(self, request, emit, cancel) -> dict:
        return run_isolated(GraphSpec.from_dict(dict(request["graph"])), request["scene"], RunConfig(worlds=(1,)),
                            plugins=self._worker_plugins(), scene_modules=self.config.scene_modules,
                            scene_dirs=self.config.scene_dirs, timeout=self.config.job_timeout, on_progress=emit,
                            cancel=cancel, env=self._env(), live=dict(steps=request["steps"], every=request["every"]))

    def _analysis(self, request, emit, cancel) -> dict:
        emit(dict(event="start", what="measuring each stage's share of the step"))
        return run_isolated(NATIVE, request["scene"], RunConfig(), plugins=self._worker_plugins(),
                            scene_modules=self.config.scene_modules, scene_dirs=self.config.scene_dirs,
                            timeout=self.config.job_timeout, on_progress=emit, cancel=cancel, env=self._env(),
                            report=dict(kinds=["opportunities", "structure"], worlds=request["worlds"]))

    def _profile(self, request, emit, cancel) -> dict:
        emit(dict(event="start", what="timing each phase of the step"))
        graph = GraphSpec.from_dict(dict(request["graph"])) if request.get("graph") else NATIVE
        return run_isolated(graph, request["scene"], RunConfig(), plugins=self._worker_plugins(),
                            scene_modules=self.config.scene_modules, scene_dirs=self.config.scene_dirs,
                            timeout=self.config.job_timeout, on_progress=emit, cancel=cancel, env=self._env(),
                            report=dict(kinds=["profile"], worlds=request["worlds"]))

    def _reverify(self, request, emit, cancel) -> dict:
        record = next(r for r in self.ledger.records(strict=False) if r.seq == request["seq"])
        entry = Entry.from_dict(record.entry)

        def run(graph, scene, config):
            return self._isolated(graph, scene, RunConfig(**{**config, "worlds": tuple(config["worlds"])}), emit, cancel)

        outcome = reverify(entry, run)
        return dict(agrees=outcome.agrees, differences=list(outcome.differences),
                    entry=outcome.entry.to_dict() if outcome.entry else None, recorded=entry.to_dict())

    def _check(self, request, emit, cancel) -> dict:
        from phost_author.submit import Submission, check_submission
        emit(dict(event="start", what="checking in a sandbox"))
        report = check_submission(Submission(request["source"], request["stage"], request["entry"], request["params"]),
                                  scene=request["scene"], worlds=request["worlds"])
        # a wrong kernel is a finished check with a negative verdict; only "could not run it" is an error
        return {k: v for k, v in report.items() if not (k == "error" and v is None)}

    def _render(self, request, emit, cancel) -> dict:
        record = self._job(request["job"])
        cell = max((c for c in record["result"]["cells"] if c.get("frames")), key=lambda c: c["worlds"])
        out = self.store.job_dir(request["job"]) / "frames"
        for stale in out.glob("*.png") if out.is_dir() else ():
            stale.unlink()
        spec = dict(xml=self.scenes().get(request["scene"]).xml(), frames=cell["frames"], width=480, height=320,
                    out=str(out))
        env = dict(os.environ, MUJOCO_GL="egl", PYTHONPATH=os.pathsep.join(p for p in sys.path if p))
        emit(dict(event="start", what=f"drawing {len(cell['frames'])} frames"))
        done = subprocess.run([sys.executable, "-m", "phost_dash.render"], input=json.dumps(spec), capture_output=True,
                              text=True, env=env, timeout=300)
        lines = [line for line in done.stdout.splitlines() if line.startswith(RENDER_PREFIX)]
        if not lines:
            return dict(error=f"the renderer exited with code {done.returncode}", stderr=done.stderr[-1500:])
        return json.loads(lines[-1][len(RENDER_PREFIX):]) | dict(worlds=cell["worlds"])
