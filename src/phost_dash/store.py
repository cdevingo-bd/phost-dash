"""What the dashboard keeps on disk: saved graphs, user kernels, finished jobs.

Everything lives under one state directory and is addressed by a validated name, so a name from a request can never
reach outside it. Files are replaced atomically, so a crash leaves the old file or the new one, never half of one.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Mapping

NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
JOB_ID = re.compile(r"^[0-9a-f]{12}$")
KEEP_JOBS = 200
KEEP_BYTES = 400 << 20          # live runs carry frames; the saved jobs as a whole stay under this


class StoreError(Exception):
    """A request the store cannot honour: a bad name, or something that is not there."""


class NotFound(StoreError):
    """The name is fine; nothing is stored under it."""


def valid_name(name: str) -> str:
    if not isinstance(name, str) or not NAME.match(name) or name.endswith(".") or ".." in name:
        raise StoreError(f"{name!r} is not a usable name: letters, digits, '.', '_' and '-', starting with a letter "
                         "or digit, at most 64 characters")
    return name


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".write-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


class Store:
    def __init__(self, root: str | Path):
        self.root = Path(root)

    # ---- graphs: <root>/graphs/<name>.json ----

    def _graph(self, name: str) -> Path:
        return self.root / "graphs" / f"{valid_name(name)}.json"

    def save_graph(self, name: str, spec: Mapping[str, Any]) -> None:
        _write(self._graph(name), json.dumps(spec, indent=1, sort_keys=True) + "\n")

    def load_graph(self, name: str) -> dict:
        try:
            return json.loads(self._graph(name).read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise NotFound(f"no saved graph {name!r}") from None

    def list_graphs(self) -> list[str]:
        return sorted(p.stem for p in (self.root / "graphs").glob("*.json")) if (self.root / "graphs").is_dir() else []

    def delete_graph(self, name: str) -> None:
        try:
            self._graph(name).unlink()
        except FileNotFoundError:
            raise NotFound(f"no saved graph {name!r}") from None

    # ---- kernels: <root>/kernels/<name>.json (manifest) and <name>.py (source) ----

    def _kernel(self, name: str) -> tuple[Path, Path]:
        base = self.root / "kernels" / valid_name(name)
        return base.with_suffix(".json"), base.with_suffix(".py")

    def save_kernel(self, name: str, *, stage: str, source: str, entry: str = "Runtime",
                    params: Mapping[str, Any] | None = None) -> None:
        manifest, code = self._kernel(name)
        _write(code, source)
        _write(manifest, json.dumps(dict(name=name, stage=stage, entry=entry, params=dict(params or {})), indent=1) + "\n")

    def load_kernel(self, name: str) -> dict:
        manifest, code = self._kernel(name)
        try:
            return dict(json.loads(manifest.read_text(encoding="utf-8")), source=code.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise NotFound(f"no saved kernel {name!r}") from None

    def list_kernels(self) -> list[str]:
        folder = self.root / "kernels"
        return sorted(p.stem for p in folder.glob("*.json")) if folder.is_dir() else []

    def delete_kernel(self, name: str) -> None:
        manifest, code = self._kernel(name)
        if not manifest.exists():
            raise NotFound(f"no saved kernel {name!r}")
        manifest.unlink()
        code.unlink(missing_ok=True)

    # ---- jobs: <root>/jobs/<id>.json, and <root>/jobs/<id>/ for files a job produced ----

    def job_dir(self, job_id: str) -> Path:
        if not JOB_ID.match(job_id or ""):
            raise StoreError(f"{job_id!r} is not a job id")
        return self.root / "jobs" / job_id

    def save_job(self, job: Mapping[str, Any]) -> None:
        _write(self.job_dir(job["id"]).with_suffix(".json"), json.dumps(job, separators=(",", ":")))
        self._prune()

    def load_job(self, job_id: str) -> dict:
        try:
            return json.loads(self.job_dir(job_id).with_suffix(".json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise NotFound(f"no job {job_id!r}") from None

    def list_jobs(self) -> list[dict]:
        """Every stored job, newest first. A file that does not parse is skipped rather than hiding the others."""
        folder = self.root / "jobs"
        jobs = []
        for path in folder.glob("*.json") if folder.is_dir() else ():
            try:
                jobs.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
        return sorted(jobs, key=lambda j: (j.get("created", 0), j.get("id", "")), reverse=True)

    def _prune(self) -> None:
        """Keep the newest jobs: at most ``KEEP_JOBS`` of them, and no more than ``KEEP_BYTES`` in all."""
        folder = self.root / "jobs"
        files = sorted(folder.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        kept, total = [], 0
        for path in files:
            size = path.stat().st_size
            if len(kept) < KEEP_JOBS and (total + size <= KEEP_BYTES or not kept):      # the newest is always kept
                kept.append(path)
                total += size
            else:
                self._remove(path)

    @staticmethod
    def _remove(path: Path) -> None:
        path.unlink(missing_ok=True)
        extra = path.with_suffix("")
        if extra.is_dir():
            for child in extra.iterdir():
                child.unlink(missing_ok=True)
            extra.rmdir()
