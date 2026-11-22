import json

import pytest

from phost_dash import store as store_module
from phost_dash.store import NotFound, Store, StoreError, valid_name


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "state")


@pytest.mark.parametrize("name", ["a", "graph-1", "My_graph.v2", "0", "a" * 64])
def test_ordinary_names_are_accepted(name):
    assert valid_name(name) == name


@pytest.mark.parametrize("name", ["", ".hidden", "-x", "a/b", "../x", "a..b", "a\\b", "a b", "x" * 65, "trailing.",
                                  "nul\x00", "é", None, 5, "/etc/passwd", "a/../../b"])
def test_names_that_could_reach_outside_the_folder_are_refused(name):
    with pytest.raises(StoreError, match="not a usable name"):
        valid_name(name)


def test_graphs_round_trip_and_list_sorted(store):
    store.save_graph("b", dict(x=1))
    store.save_graph("a", dict(y=[1, 2]))
    assert store.list_graphs() == ["a", "b"] and store.load_graph("a") == dict(y=[1, 2])
    store.save_graph("a", dict(y=3))
    assert store.load_graph("a") == dict(y=3)
    store.delete_graph("a")
    assert store.list_graphs() == ["b"]


def test_missing_things_are_not_found_not_bad_requests(store):
    for call in (lambda: store.load_graph("nope"), lambda: store.delete_graph("nope"), lambda: store.load_kernel("nope"),
                 lambda: store.delete_kernel("nope"), lambda: store.load_job("0" * 12)):
        with pytest.raises(NotFound):
            call()


def test_nothing_is_written_outside_the_state_folder(store, tmp_path):
    with pytest.raises(StoreError):
        store.save_graph("../escape", {})
    with pytest.raises(StoreError):
        store.save_kernel("../escape", stage="s", source="x")
    assert not [p for p in tmp_path.rglob("*escape*")]


def test_a_failed_write_leaves_the_old_file_and_no_temporary_one(store, monkeypatch):
    store.save_graph("g", dict(v=1))
    monkeypatch.setattr(store_module.os, "replace", lambda *a: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        store.save_graph("g", dict(v=2))
    monkeypatch.undo()
    assert store.load_graph("g") == dict(v=1)
    assert [p.name for p in (store.root / "graphs").iterdir()] == ["g.json"]


def test_kernels_keep_source_and_manifest_together(store):
    store.save_kernel("k", stage="newton.linear_solve", source="class Runtime: pass\n", params=dict(a=1))
    assert store.load_kernel("k") == dict(name="k", stage="newton.linear_solve", entry="Runtime", params=dict(a=1),
                                          source="class Runtime: pass\n")
    assert store.list_kernels() == ["k"]
    store.delete_kernel("k")
    assert store.list_kernels() == [] and not list((store.root / "kernels").iterdir())


def test_jobs_round_trip_and_list_newest_first(store):
    for i, created in enumerate((100, 300, 200)):
        store.save_job(dict(id=f"{i:012x}", created=created, status="done"))
    assert [j["created"] for j in store.list_jobs()] == [300, 200, 100]
    assert store.load_job(f"{1:012x}")["created"] == 300


def test_job_ids_must_look_like_job_ids(store):
    for bad in ("../x", "short", "G" * 12, "", None):
        with pytest.raises(StoreError, match="not a job id"):
            store.job_dir(bad)


def test_a_damaged_job_file_does_not_hide_the_others(store):
    store.save_job(dict(id="a" * 12, created=1))
    (store.root / "jobs" / ("b" * 12 + ".json")).write_text("{broken")
    assert [j["id"] for j in store.list_jobs()] == ["a" * 12]


def test_old_jobs_and_their_files_are_pruned(store, monkeypatch):
    monkeypatch.setattr(store_module, "KEEP_JOBS", 2)
    import os
    for i in range(4):
        store.save_job(dict(id=f"{i:012x}", created=i))
        folder = store.job_dir(f"{i:012x}")
        folder.mkdir()
        (folder / "0.png").write_bytes(b"x")
        os.utime(store.job_dir(f"{i:012x}").with_suffix(".json"), (i, i))
    store.save_job(dict(id=f"{9:012x}", created=9))
    kept = sorted(p.name for p in (store.root / "jobs").glob("*.json"))
    assert kept == [f"{3:012x}.json", f"{9:012x}.json"]
    assert not store.job_dir(f"{0:012x}").exists() and store.job_dir(f"{3:012x}").exists()


def test_saved_jobs_are_kept_within_a_byte_budget_newest_first(store, monkeypatch):
    import os
    monkeypatch.setattr(store_module, "KEEP_BYTES", 2500)
    for i in range(4):
        store.save_job(dict(id=f"{i:012x}", created=i, events=["x" * 900]))
        os.utime(store.job_dir(f"{i:012x}").with_suffix(".json"), (i, i))
    store.save_job(dict(id=f"{9:012x}", created=9, events=["x" * 900]))
    assert sorted(p.name for p in (store.root / "jobs").glob("*.json")) == [f"{3:012x}.json", f"{9:012x}.json"]


def test_a_single_job_bigger_than_the_budget_is_still_kept(store, monkeypatch):
    monkeypatch.setattr(store_module, "KEEP_BYTES", 100)
    store.save_job(dict(id="a" * 12, created=1, events=["x" * 5000]))
    assert store.load_job("a" * 12)["events"] == ["x" * 5000]
