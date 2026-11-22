"""Kernels the user saved in the dashboard, offered to phost as implementations.

``register(registry)`` is a phost plugin: it adds one implementation per saved kernel, named
``<stage>/user-<name>``. It only reads the small manifests; a kernel's source is not executed until a run builds the
implementation, and that happens in the lab's worker process, never in the dashboard's.

The kernels live in ``$PHOST_DASH_STATE/kernels`` (the dashboard sets that variable for the workers it starts).
"""

from __future__ import annotations

import functools
import json
import os
import sys
from pathlib import Path
from typing import Any

from phost import ContractError, Impl, ImplKind, Registry

ENV = "PHOST_DASH_STATE"


def impl_id(stage: str, name: str) -> str:
    return f"{stage}/user-{name}"


@functools.lru_cache(maxsize=64)
def _module(source: str):
    from phost_author.modules import load_source
    return load_source(source, "user_kernel")


def _impl(manifest: dict[str, Any], source_path: Path) -> Impl:
    stage, name, entry = manifest["stage"], manifest["name"], manifest.get("entry", "Runtime")

    def module():
        return _module(source_path.read_text(encoding="utf-8"))

    def factory(host, params):
        runtime = getattr(module(), entry, None)
        if runtime is None:
            raise LookupError(f"kernel {name!r} defines no {entry!r}")
        return runtime(host, params)

    def reference(inputs, params):
        return module().reference(inputs, params)

    return Impl(id=impl_id(stage, name), stage=stage, stage_version=1, version="user", title=f"{name} (your kernel)",
                kind=ImplKind.KERNEL, doc=f"Your saved kernel {name!r}, from {source_path.name}.",
                factory=factory, reference=reference)


def register(registry: Registry, root: str | Path | None = None) -> None:
    folder = Path(root if root is not None else os.environ.get(ENV, "")) / "kernels"
    if not folder.is_dir():
        return
    for manifest_path in sorted(folder.glob("*.json")):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            source_path = manifest_path.with_suffix(".py")
            if source_path.is_file():
                registry.add_impl(_impl(manifest, source_path))
        except (OSError, KeyError, ValueError, ContractError) as error:         # one broken manifest must not hide the others
            print(f"phost-dash: skipping kernel {manifest_path.name}: {error}", file=sys.stderr)
