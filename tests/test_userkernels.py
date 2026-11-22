import json
import sys

import pytest

from phost import Registry
from phost.stages import register_all
from phost_dash import userkernels

pytest.importorskip("phost_author")


def fresh():
    registry = Registry()
    register_all(registry)
    return registry


def kernels_dir(root):
    folder = root / "kernels"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def save(root, name, source, stage="newton.linear_solve", entry="Runtime"):
    folder = kernels_dir(root)
    (folder / f"{name}.py").write_text(source)
    (folder / f"{name}.json").write_text(json.dumps(dict(name=name, stage=stage, entry=entry, params={})))


def test_each_saved_kernel_becomes_an_implementation_of_its_stage(tmp_path):
    save(tmp_path, "mine", "class Runtime: pass\n")
    registry = fresh()
    userkernels.register(registry, tmp_path)
    impl = registry.impl("newton.linear_solve/user-mine")
    assert impl.stage == "newton.linear_solve" and impl.kind.value == "kernel" and "mine" in impl.title


def test_registering_reads_manifests_and_never_runs_the_source(tmp_path):
    marker = tmp_path / "ran"
    save(tmp_path, "evil", f"open({str(marker)!r}, 'w').write('x')\nclass Runtime: pass\n")
    userkernels.register(fresh(), tmp_path)
    assert not marker.exists()


def test_the_source_runs_only_when_a_run_builds_the_implementation(tmp_path):
    marker = tmp_path / "ran"
    save(tmp_path, "lazy", f"open({str(marker)!r}, 'w').write('x')\nclass Runtime:\n    def __init__(self, host, params):\n        self.args = (host, params)\n")
    registry = fresh()
    userkernels.register(registry, tmp_path)
    runtime = registry.impl("newton.linear_solve/user-lazy").factory("HOST", {"p": 1})
    assert marker.exists() and runtime.args == ("HOST", {"p": 1})


def test_a_missing_entry_class_is_a_clear_error_at_build_time(tmp_path):
    save(tmp_path, "empty", "x = 1\n")
    registry = fresh()
    userkernels.register(registry, tmp_path)
    with pytest.raises(LookupError, match="defines no 'Runtime'"):
        registry.impl("newton.linear_solve/user-empty").factory(None, {})


def test_the_reference_is_the_sources_own_function(tmp_path):
    save(tmp_path, "ref", "class Runtime: pass\ndef reference(inputs, params):\n    return {'out': inputs['x'] * 2}\n")
    registry = fresh()
    userkernels.register(registry, tmp_path)
    assert registry.impl("newton.linear_solve/user-ref").reference({"x": 4}, {}) == {"out": 8}


def test_a_broken_manifest_does_not_hide_the_others(tmp_path, capsys):
    save(tmp_path, "good", "class Runtime: pass\n")
    (kernels_dir(tmp_path) / "bad.json").write_text("{not json")
    (kernels_dir(tmp_path) / "bad.py").write_text("")
    (kernels_dir(tmp_path) / "nostage.json").write_text(json.dumps(dict(name="nostage")))
    (kernels_dir(tmp_path) / "nostage.py").write_text("")
    registry = fresh()
    userkernels.register(registry, tmp_path)
    assert [i.id for i in registry.impls_for("newton.linear_solve") if "user-" in i.id] == ["newton.linear_solve/user-good"]
    assert "skipping kernel bad.json" in capsys.readouterr().err


def test_a_manifest_without_source_is_ignored(tmp_path):
    (kernels_dir(tmp_path) / "orphan.json").write_text(json.dumps(dict(name="orphan", stage="newton.linear_solve")))
    registry = fresh()
    userkernels.register(registry, tmp_path)
    assert [i.id for i in registry.impls_for("newton.linear_solve") if "user-" in i.id] == []


def test_no_folder_and_no_environment_is_not_an_error(tmp_path, monkeypatch):
    monkeypatch.delenv(userkernels.ENV, raising=False)
    userkernels.register(fresh(), tmp_path)
    userkernels.register(fresh())


def test_the_state_comes_from_the_environment_in_a_worker(tmp_path, monkeypatch):
    save(tmp_path, "env", "class Runtime: pass\n")
    monkeypatch.setenv(userkernels.ENV, str(tmp_path))
    registry = fresh()
    userkernels.register(registry)
    assert registry.impl("newton.linear_solve/user-env")


def test_a_kernel_for_a_stage_that_no_longer_exists_is_skipped_not_fatal(tmp_path, capsys):
    save(tmp_path, "good", "class Runtime: pass\n")
    save(tmp_path, "stale", "class Runtime: pass\n", stage="removed.stage")
    registry = fresh()
    userkernels.register(registry, tmp_path)
    assert registry.impl("newton.linear_solve/user-good")
    assert "skipping kernel stale.json" in capsys.readouterr().err
