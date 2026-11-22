import json

import pytest

from phost_dash import ApiError
from phost_dash.app import MAX_LIVE_STEPS, MAX_STEPS, MAX_WORLDS

from conftest import CONTROL_GRAPH, NATIVE_GRAPH, finished

needs_author = pytest.mark.skipif(__import__("importlib").util.find_spec("phost_author") is None, reason="phost-author not installed")


def run(app, **over):
    body = dict(graph=NATIVE_GRAPH, scene="trampoline8:impact", worlds=[1, 8], steps=10)
    body.update(over)
    return finished(app, app.start_run(body)["id"])


def error_of(call, *args):
    with pytest.raises(ApiError) as caught:
        call(*args)
    return caught.value


# ---- what there is ----

def test_info_reports_gpu_packages_and_state(app, config):
    info = app.info()
    assert info["gpu"]["name"] == "Fake GPU" and info["state"] == str(config.state)
    assert "phost" in info["packages"] and "phost-dash" in info["packages"]


def test_the_catalog_lists_stages_implementations_and_scenes(app):
    catalog = app.catalog()
    stages = {c["name"] for c in catalog["registry"]["contracts"]}
    assert {"newton.linear_solve", "dof.passive_force", "control.law", "probe.state"} <= stages
    assert any(i["id"] == "newton.linear_solve/native" for i in catalog["registry"]["impls"])
    assert any(s["id"] == "trampoline12:impact" for s in catalog["scenes"])


def test_the_catalog_never_describes_a_hidden_scene(config, tmp_path):
    from phost_dash import App
    (tmp_path / "scenes").mkdir()
    (tmp_path / "scenes" / "held.xml").write_text("<mujoco/>")
    (tmp_path / "scenes" / "held.json").write_text(json.dumps(dict(hidden=True, description="SECRET", settle_steps=77)))
    held = App(type(config)(state=config.state, scene_dirs=(str(tmp_path / "scenes"),)), runners={})
    shown = json.dumps(held.catalog()["scenes"])
    held.close()
    assert '"id": "held"' in shown and "SECRET" not in shown and "77" not in shown


# ---- graphs ----

def test_validate_says_how_the_graph_will_be_judged(app):
    ok = app.validate(dict(graph=NATIVE_GRAPH))
    assert ok == dict(ok=True, stage_classes={"newton.linear_solve": "exact"}, comparable_to_native=True)
    changing = app.validate(dict(graph=CONTROL_GRAPH))
    assert changing["stage_classes"] == {"control.law": "model_changing"} and changing["comparable_to_native"] is False


@pytest.mark.parametrize("graph,message", [
    (dict(NATIVE_GRAPH, stages={"newton.linear_solve": dict(impl="no/such", params={})}), "no/such"),
    (dict(NATIVE_GRAPH, stages={"nope.stage": dict(impl="x", params={})}), "no implementation 'x'"),
    (dict(NATIVE_GRAPH, plugins=["os"]), "not started with"),
    ("a string", "JSON object"),
    (dict(NATIVE_GRAPH, stages="no"), "malformed graph"),
    (dict(NATIVE_GRAPH, stages={"newton.linear_solve": "str"}), "malformed graph"),
    (dict(NATIVE_GRAPH, name=5), "needs a name"),
    (dict(NATIVE_GRAPH, name=""), "needs a name"),
    ({k: v for k, v in NATIVE_GRAPH.items() if k != "version"}, "version"),
])
def test_validate_gives_a_message_not_a_traceback(app, graph, message):
    out = app.validate(dict(graph=graph))
    assert out["ok"] is False and message in out["error"]


def test_a_graph_cannot_make_the_server_import_a_module_it_was_not_started_with(app):
    assert "os" in error_of(app.start_run, dict(graph=dict(NATIVE_GRAPH, plugins=["os"]), scene="trampoline8:impact")).message


def test_saved_graphs_round_trip_and_must_be_valid(app):
    assert app.put_graph("mine", NATIVE_GRAPH) == dict(name="mine")
    assert app.list_graphs() == ["mine"] and app.get_graph("mine") == NATIVE_GRAPH
    assert error_of(app.put_graph, "bad", dict(NATIVE_GRAPH, stages={"x": dict(impl="y", params={})})).status == 400
    assert error_of(app.put_graph, "../escape", NATIVE_GRAPH).status == 400
    assert app.list_graphs() == ["mine"]
    app.delete_graph("mine")
    assert error_of(app.get_graph, "mine").status == 404 and error_of(app.delete_graph, "mine").status == 404


# ---- runs ----

def test_a_run_goes_to_the_runner_with_what_was_asked(app, runners):
    job = run(app)
    assert job["status"] == "done" and job["result"]["scene"] == "trampoline8:impact"
    request, = runners.calls
    assert request["worlds"] == [1, 8] and request["steps"] == 10 and request["frames"] is True
    assert request["graph"]["stages"]["newton.linear_solve"]["impl"] == "newton.linear_solve/native"


def test_a_saved_graph_can_be_run_by_name(app, runners):
    app.put_graph("mine", NATIVE_GRAPH)
    job = finished(app, app.start_run(dict(graph_name="mine", scene="trampoline8:impact"))["id"])
    assert job["status"] == "done" and runners.calls[0]["worlds"] == [1, 8]
    assert error_of(app.start_run, dict(graph_name="nope", scene="trampoline8:impact")).status == 404


@pytest.mark.parametrize("over,message", [
    (dict(scene="nope"), "no scene"),
    (dict(worlds=[]), "worlds"), (dict(worlds=[0]), "worlds"), (dict(worlds=[MAX_WORLDS + 1]), "worlds"),
    (dict(worlds=[1] * 7), "worlds"), (dict(worlds="8"), "worlds"), (dict(worlds=[True]), "worlds"), (dict(worlds=[1.5]), "worlds"),
    (dict(steps=0), "steps"), (dict(steps=MAX_STEPS + 1), "steps"), (dict(steps="20"), "steps"), (dict(steps=True), "steps"),
])
def test_a_run_request_is_checked_before_anything_is_queued(app, runners, over, message):
    body = dict(graph=NATIVE_GRAPH, scene="trampoline8:impact", worlds=[1, 8], steps=10)
    body.update(over)
    assert message in error_of(app.start_run, body).message
    assert app.list_jobs() == [] and runners.calls == []


def test_frames_are_not_requested_for_a_hidden_scene(config, runners, tmp_path):
    from phost_dash import App
    (tmp_path / "s").mkdir()
    (tmp_path / "s" / "held.xml").write_text("<mujoco/>")
    (tmp_path / "s" / "held.json").write_text(json.dumps(dict(hidden=True)))
    held = App(type(config)(state=config.state, scene_dirs=(str(tmp_path / "s"),)), runners=dict(run=runners.run))
    try:
        job = finished(held, held.start_run(dict(graph=NATIVE_GRAPH, scene="held", frames=True))["id"])
        assert runners.calls[0]["frames"] is False
        assert error_of(held.start_render, job["id"]).status in (403, 409)
    finally:
        held.close()


# ---- live ----

def test_a_live_watch_goes_to_the_runner_and_streams_its_frames(app, runners):
    job = finished(app, app.start_live(dict(graph=NATIVE_GRAPH, scene="trampoline8:impact", steps=30, every=10))["id"])
    request, = runners.calls
    assert job["kind"] == "live" and job["status"] == "done"
    assert (request["steps"], request["every"], request["scene"]) == (30, 10, "trampoline8:impact")
    stored = app.store.load_job(job["id"])             # saved before the job was reported finished
    assert [e["event"] for e in stored["events"]] == ["layout", "live", "live", "live"]
    assert [e["step"] for e in stored["events"][1:]] == [10, 20, 30] and stored["result"]["frames"] == 3


@pytest.mark.parametrize("over,message", [
    (dict(scene="nope"), "no scene"),
    (dict(steps=0), "steps"), (dict(steps=MAX_LIVE_STEPS + 1), "steps"), (dict(steps="600"), "steps"), (dict(steps=True), "steps"),
    (dict(every=0), "every"), (dict(every=201), "every"), (dict(every=1.5), "every"),
])
def test_a_live_request_is_checked_before_anything_is_queued(app, runners, over, message):
    body = dict(graph=NATIVE_GRAPH, scene="trampoline8:impact", steps=60, every=6)
    body.update(over)
    assert message in error_of(app.start_live, body).message
    assert app.list_jobs() == [] and runners.calls == []


def test_a_held_out_scene_is_never_watched(config, runners, tmp_path):
    from phost_dash import App
    (tmp_path / "s").mkdir()
    (tmp_path / "s" / "held.xml").write_text("<mujoco/>")
    (tmp_path / "s" / "held.json").write_text(json.dumps(dict(hidden=True)))
    held = App(type(config)(state=config.state, scene_dirs=(str(tmp_path / "s"),)), runners=dict(live=runners.live))
    try:
        assert error_of(held.start_live, dict(graph=NATIVE_GRAPH, scene="held")).status == 403
        assert held.list_jobs() == [] and runners.calls == []
    finally:
        held.close()


def test_a_live_watch_defaults_to_a_short_stream(app, runners):
    finished(app, app.start_live(dict(graph=NATIVE_GRAPH, scene="trampoline8:impact"))["id"])
    assert (runners.calls[0]["steps"], runners.calls[0]["every"]) == (300, 6)


# ---- jobs ----

def test_jobs_are_listed_and_fetched_without_their_event_log(app):
    job = run(app)
    assert [j["id"] for j in app.list_jobs()] == [job["id"]]
    fetched = app.get_job(job["id"])
    assert "events" not in fetched and fetched["result"]["scene"] == "trampoline8:impact"
    assert error_of(app.get_job, "0" * 12).status == 404


def test_cancel_through_the_app(app, runners):
    runners.hold.clear()
    job = app.start_run(dict(graph=NATIVE_GRAPH, scene="trampoline8:impact", worlds=[1, 8], steps=10))
    from conftest import wait_for
    wait_for(lambda: runners.running == 1, message="the run to start")
    app.cancel(job["id"])
    assert finished(app, job["id"])["status"] == "cancelled"
    assert error_of(app.cancel, job["id"]).status == 409 and error_of(app.cancel, "0" * 12).status == 404


# ---- the ledger ----

def test_recording_a_run_puts_it_in_the_ledger_and_on_the_board(app):
    job = run(app, worlds=[8])
    recorded = app.record(job["id"], dict(label="mine"))
    assert [r["seq"] for r in recorded["records"]] == [1] and recorded["records"][0]["klass"] == "exact"
    board = app.board({})
    group, = board["groups"]
    assert group["rows"][0]["label"] == "mine" and group["rows"][0]["trust"] == "self-reported"
    assert board["ledger"]["ok"] and board["ledger"]["count"] == 1
    assert app.get_job(job["id"])["recorded"] == [1]


def test_a_run_is_recorded_only_once_even_by_two_clicks(app):
    job = run(app, worlds=[8])
    app.record(job["id"], {})
    err = error_of(app.record, job["id"], {})
    assert err.status == 409 and "already recorded as #1" in err.message
    assert app.ledger_status()["count"] == 1


def test_only_a_finished_run_can_be_recorded(app, runners):
    runners.hold.clear()
    job = app.start_run(dict(graph=NATIVE_GRAPH, scene="trampoline8:impact", worlds=[8], steps=10))
    assert error_of(app.record, job["id"], {}).status == 409
    runners.hold.set()
    finished(app, job["id"])
    assert error_of(app.record, "0" * 12, {}).status == 404
    assert error_of(app.record, job["id"], dict(label="x" * 81)).status == 400


def test_a_recorded_entry_never_carries_the_frames(app):
    job = run(app, worlds=[8])
    assert "frames" in json.dumps(app.get_job(job["id"])["result"])
    app.record(job["id"], {})
    assert "frames" not in (app.ledger.path.read_text())


def test_board_filters_and_unknown_filters(app):
    run_a = run(app, worlds=[8])
    app.record(run_a["id"], dict(label="a"))
    assert app.board(dict(scene="nope"))["groups"] == []
    assert app.board(dict(worlds="8", klass="exact"))["groups"] != []
    assert error_of(app.board, dict(color="red")).status == 400
    assert error_of(app.board, dict(worlds="many")).status == 400


def test_a_damaged_ledger_still_shows_the_board_but_says_so(app):
    job = run(app, worlds=[8])
    app.record(job["id"], {})
    text = app.ledger.path.read_text().replace('"speedup":2.0', '"speedup":9.0')
    app.ledger.path.write_text(text)
    board = app.board({})
    assert board["ledger"]["ok"] is False and "changed" in board["ledger"]["problems"][0]


def test_reverify_needs_a_record_that_exists(app):
    assert error_of(app.start_reverify, dict(seq=7)).status == 404
    assert error_of(app.start_reverify, dict(seq="1")).status == 400
    job = run(app, worlds=[8])
    app.record(job["id"], {})
    assert finished(app, app.start_reverify(dict(seq=1))["id"])["result"]["agrees"] is True


# ---- drawing ----

def test_only_a_finished_run_with_frames_can_be_drawn(app):
    job = run(app, worlds=[8])
    assert finished(app, app.start_render(job["id"])["id"])["result"]["count"] == 3
    nothing = run(app, frames=False)
    assert error_of(app.start_render, nothing["id"]).status == 409
    assert error_of(app.start_render, "0" * 12).status == 404
    assert error_of(app.frame_path, job["id"], 0).status == 404            # the fake renderer wrote no file


# ---- kernels and equations ----

@needs_author
def test_the_template_and_saved_kernels(app):
    template = app.kernel_template()
    assert "class Runtime" in template["source"] and template["stage"] == "newton.linear_solve"
    assert app.put_kernel("mine", dict(stage="newton.linear_solve", source=template["source"])) == \
        dict(name="mine", impl="newton.linear_solve/user-mine")
    assert [k["name"] for k in app.list_kernels()] == ["mine"] and "source" not in app.list_kernels()[0]
    assert app.get_kernel("mine")["source"] == template["source"]
    assert any(i["id"] == "newton.linear_solve/user-mine" for i in app.catalog()["registry"]["impls"])
    app.delete_kernel("mine")
    assert error_of(app.get_kernel, "mine").status == 404


@needs_author
@pytest.mark.parametrize("body,message", [
    (dict(stage="newton.linear_solve", source=""), "source"), (dict(stage="newton.linear_solve", source="x" * 200_001), "source"),
    (dict(stage="nope", source="x"), "unknown stage"), (dict(stage="newton.linear_solve", source="x", entry="a b"), "class name"),
    (dict(source="x"), "unknown stage")])
def test_a_bad_kernel_is_refused(app, body, message):
    assert message in error_of(app.put_kernel, "k", body).message


@needs_author
def test_saving_a_kernel_does_not_execute_it(app, tmp_path):
    marker = tmp_path / "ran"
    app.put_kernel("evil", dict(stage="newton.linear_solve", source=f"open({str(marker)!r}, 'w').write('x')\nclass Runtime: pass\n"))
    app.catalog()
    app.validate(dict(graph=NATIVE_GRAPH))
    assert not marker.exists()


@needs_author
def test_a_kernel_check_is_a_queued_job(app):
    job = finished(app, app.start_check(dict(source="class Runtime: pass"))["id"])
    assert job["status"] == "done" and job["result"]["sandbox"] == "fake"
    assert error_of(app.start_check, dict(source="x", stage="nope")).status == 400


@needs_author
def test_equation_previews_come_back_as_data_and_bad_equations_as_messages(app):
    good = app.equation(dict(stage="dof.passive_force", expr="-a*q", constants=dict(a=2.0), lo=-1, hi=1, n=3))
    assert good["ok"] and good["y"] == [2.0, 0.0, -2.0]
    bad = app.equation(dict(stage="dof.passive_force", expr="__import__('os')"))
    assert bad["ok"] is False and bad["error"]
    assert app.equation(dict(stage="nope", expr="q"))["ok"] is False
    assert app.equation(dict(stage="dof.passive_force", expr="q", lo="x"))["ok"] is False
    assert app.equation(dict(stage="dof.passive_force", expr="q", n="many"))["ok"] is False


def test_author_features_say_what_is_missing(app, monkeypatch):
    import phost_dash.app as module
    monkeypatch.setattr(module, "installed", lambda name: False)
    for call, arg in ((app.kernel_template, ()), (app.equation, ({},)), (app.start_check, ({},))):
        assert error_of(call, *arg).status == 501
