"""The Research tab's data: what phost-agent's journal says, read from the dashboard's state directory."""

import json

import pytest

phost_agent = pytest.importorskip("phost_agent")

from phost_agent import Journal, Lease

SCENE, STAGE = "chain32:pluck", "effective.solve"
TASK = dict(id="abc123abc123", scene=SCENE, stage=STAGE, worlds=[1, 8], goal="speed")


def attempt(n, verdict, reached, speedup=None, memo=False, reason="", impl="effective.solve/expression", params=None, improved=False):
    return dict(task_id=TASK["id"], attempt=n, proposal=dict(stage=STAGE, impl=impl, params=params or {}, note="", tokens=100),
                key=f"k{n}", reached=reached, verdict=verdict, reason=reason, speedup=speedup, accuracy_ratio=None, memo=memo,
                seconds={}, entries=[], klass="exact", improved=improved)


def seed(path):
    """Four proposals: one stopped by the cheap check, one by the scene's check, one run and not faster, one run and a win."""
    journal = Journal(path)
    journal.append("task", phase="start", task=TASK, budget={}, proposer="scripted", gate={})
    journal.append("attempt", **attempt(1, "rejected", "cheap", reason="max_relative_residual = 0.14 exceeds 0.01"))
    journal.append("attempt", **attempt(2, "measured", "run", speedup=0.4, reason="0.400x at its worst world count, not above 1x",
                                        params=dict(iterations=10)))
    journal.append("attempt", **attempt(3, "accepted", "run", speedup=1.3, reason="1.300x on every world count", improved=True,
                                        params=dict(iterations=20, step="x = x + 1\nmore text beyond the cut")))
    journal.append("attempt", **attempt(4, "rejected", "real", reason="reads the lower triangle", memo=True))
    journal.append("tier", key="k1", tier="cheap", ok=False, reason="r")
    journal.append("task", phase="end", task_id=TASK["id"], status="stalled", reason="stalled: 5 attempts in a row without a new best",
                   spend=dict(attempts=4, gpu_seconds=0.0, cpu_seconds=3.2, tokens=400), best=attempt(3, "accepted", "run", 1.3))


def test_without_the_agent_layer_the_tab_says_so(app, monkeypatch):
    import phost_dash.app as module
    real = module.installed
    monkeypatch.setattr(module, "installed", lambda name: False if name.startswith("phost_agent") else real(name))
    assert app.research() == dict(installed=False)


def test_before_anything_has_run_there_is_an_empty_record_not_an_error(app):
    out = app.research()
    assert out["installed"] and out["intact"] and out["attempts"] == 0 and out["recent"] == [] and out["task_list"] == []
    assert out["arena"] is None
    assert out["journal"].endswith("agent/journal.jsonl") and set(out["leases"]) == {"cuda:0", "cpu"}


def test_the_funnel_the_memo_the_spend_and_the_latest_attempts_come_from_the_journal(app, config):
    seed(config.state / "agent" / "journal.jsonl")
    out = app.research()
    assert out["funnel"] == dict(proposed=4, static=4, cheap=3, real=2, run=2, accepted=1)
    assert out["memo"]["hits"] == 1 and out["memo"]["rate"] == 0.25 and out["spend"]["cpu_seconds"] == 3.2 and out["spend"]["tokens"] == 400
    assert out["best"]["speedup"] == 1.3 and out["best"]["scene"] == SCENE
    assert [r["attempt"] for r in out["recent"]] == [4, 3, 2, 1] and out["recent"][0]["memo"] is True
    assert out["recent"][1]["improved"] and "…" in out["recent"][1]["candidate"] and "iterations=20" in out["recent"][1]["candidate"]
    (task,) = out["task_list"]
    assert task["status"] == "stalled" and task["best_speedup"] == 1.3 and task["proposer"] == "scripted"
    json.dumps(out)                                                  # it goes over HTTP


def test_a_device_a_timed_run_holds_is_shown_as_held(app, config):
    leases = config.state / "agent" / "leases"
    with Lease("cuda:0", leases).hold("run effective.solve/agent-1234"):
        held = app.research()["leases"]
    assert held["cuda:0"]["holder"] == "run effective.solve/agent-1234" and held["cpu"] is None
    assert app.research()["leases"]["cuda:0"] is None


def test_a_journal_that_was_edited_is_reported_as_damaged_and_still_shown(app, config):
    path = config.state / "agent" / "journal.jsonl"
    seed(path)
    lines = path.read_text().splitlines()
    record = json.loads(lines[2])
    record["entry"]["verdict"] = "accepted"
    lines[2] = json.dumps(record)
    path.write_text("\n".join(lines) + "\n")
    out = app.research()
    assert out["intact"] is False and "line 3" in out["problems"][0] and len(out["recent"]) >= 3


def test_the_tab_is_served_to_a_logged_in_browser_and_is_read_only(client, config):
    seed(config.state / "agent" / "journal.jsonl")
    status, out = client.get("/api/research")
    assert status == 200 and out["installed"] and out["attempts"] == 4
    assert client.json("POST", "/api/research")[0] == 405 and client.json("DELETE", "/api/research")[0] == 405


def test_an_arena_contest_is_on_the_tab_with_who_is_in_it_what_they_checked_and_entered(app, config, client):
    """The contest `phost-agent arena` writes to the same journal: it used to be invisible here, so the page showed only older searches."""
    journal = Journal(config.state / "agent" / "journal.jsonl")
    journal.append("arena", phase="start", task=dict(scene=SCENE, worlds=[1, 8]), budget=dict(turns=60, submits=10, open=True),
                   contestants=[dict(name="opus", model="claude-code:opus"), dict(name="sonnet", model="claude-code:sonnet")])
    journal.append("arena", phase="turn", contestant="opus", turn=1, action="check", tokens=900)
    graph = dict(stages={STAGE: dict(source="class Runtime:\n    pass\n", entry="Runtime", impl="effective.solve/agent-1")})
    journal.append("arena", phase="attempt", id="a1b2c3d4", contestant="opus", turn=1, scene=SCENE, action="check", ok=False, digest="d",
                   graph=graph, reasons=[dict(stage=STAGE, tier="cheap", reason="RuntimeError: PROBE")])
    journal.append("submission", contestant="sonnet", graph=graph, entry_ids=["e1"], note="a dense solve", speedup=0.247, klass="exact")
    out = app.research()["arena"]
    assert out["status"] == "running" and out["scene"] == SCENE and [c["name"] for c in out["contestants"]] == ["opus", "sonnet"]
    assert out["contestants"][0]["checks"] == 1 and out["contestants"][1]["best_speedup"] == 0.247
    assert out["checks"][0]["id"] == "a1b2c3d4" and "PROBE" in out["checks"][0]["outcome"] and "source, 2 lines" in out["checks"][0]["what"]
    assert out["entries"][0]["note"] == "a dense solve"
    status, over_http = client.get("/api/research")
    assert status == 200 and over_http["arena"]["status"] == "running"
    json.dumps(out)
