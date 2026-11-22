import threading
import time

import pytest

from phost_dash.jobs import CANCELLED, DONE, FAILED, JobError, JobManager, NoSuchJob
from phost_dash.store import Store

from conftest import wait_for


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "state")


def make(store, **runners):
    return JobManager(store, runners)


def done(manager, job, timeout=10):
    return wait_for(lambda: job.status in (DONE, FAILED, CANCELLED) and job, timeout, f"job {job.id}")


def test_a_runner_result_becomes_a_done_job_with_its_events(store):
    def run(request, emit, cancel):
        emit(dict(event="start"))
        emit(dict(event="cell", n=request["n"]))
        return dict(value=request["n"] * 2)

    manager = make(store, run=run)
    job = manager.submit("run", dict(n=21))
    done(manager, job)
    assert job.status == DONE and job.result == dict(value=42) and job.error is None
    assert [e["event"] for e in job.events] == ["start", "cell"] and [e["seq"] for e in job.events] == [0, 1]
    assert job.started and job.finished >= job.started
    manager.close()


def test_jobs_run_one_at_a_time_in_the_order_submitted(store):
    order, active, peak = [], [0], [0]
    lock = threading.Lock()

    def run(request, emit, cancel):
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        order.append(request["i"])
        time.sleep(0.03)
        with lock:
            active[0] -= 1
        return {}

    manager = make(store, run=run)
    jobs = [manager.submit("run", dict(i=i)) for i in range(5)]
    for job in jobs:
        done(manager, job)
    assert order == [0, 1, 2, 3, 4] and peak[0] == 1
    manager.close()


def test_a_runner_that_raises_fails_the_job_and_the_worker_goes_on(store, capsys):
    def run(request, emit, cancel):
        if request.get("boom"):
            raise RuntimeError("kaboom")
        return dict(fine=True)

    manager = make(store, run=run)
    bad = manager.submit("run", dict(boom=True))
    good = manager.submit("run", {})
    assert done(manager, bad).status == FAILED and bad.error == "RuntimeError: kaboom"
    assert done(manager, good).status == DONE
    manager.close()


@pytest.mark.parametrize("returned,status,error", [(dict(error="worker exited with code 3"), FAILED, "worker exited with code 3"),
                                                  (dict(error=None, ok=1), DONE, None), (dict(error=""), DONE, None)])
def test_only_a_real_error_message_fails_a_job(store, returned, status, error):
    manager = make(store, run=lambda r, e, c: returned)
    job = manager.submit("run", {})
    assert done(manager, job).status == status and job.error == error
    manager.close()


def test_a_queued_job_can_be_cancelled_before_it_starts(store):
    gate = threading.Event()
    manager = make(store, run=lambda r, e, c: (gate.wait(5), {})[1])
    first, second = manager.submit("run", {}), manager.submit("run", {})
    wait_for(lambda: first.status == "running", message="first to start")
    manager.cancel(second.id)
    assert second.status == CANCELLED and "before it started" in second.error
    gate.set()
    done(manager, first)
    assert second.status == CANCELLED and second.started is None
    manager.close()


def test_a_running_job_is_cancelled_through_its_cancel_event(store):
    started = threading.Event()

    def run(request, emit, cancel):
        started.set()
        cancel.wait(10)
        return dict(error="cancelled")

    manager = make(store, run=run)
    job = manager.submit("run", {})
    started.wait(5)
    manager.cancel(job.id)
    assert done(manager, job).status == CANCELLED
    manager.close()


def test_a_cancelled_job_is_cancelled_even_if_the_runner_returned_a_result(store):
    started = threading.Event()

    def run(request, emit, cancel):
        started.set()
        cancel.wait(10)
        return dict(partial=True)

    manager = make(store, run=run)
    job = manager.submit("run", {})
    started.wait(5)
    manager.cancel(job.id)
    assert done(manager, job).status == CANCELLED and job.result == dict(partial=True)
    manager.close()


def test_cancelling_a_finished_or_unknown_job_is_an_error(store):
    manager = make(store, run=lambda r, e, c: {})
    job = manager.submit("run", {})
    done(manager, job)
    with pytest.raises(JobError, match="already done"):
        manager.cancel(job.id)
    with pytest.raises(NoSuchJob):
        manager.cancel("0" * 12)
    manager.close()


def test_an_unknown_kind_is_refused(store):
    manager = make(store, run=lambda r, e, c: {})
    with pytest.raises(JobError, match="no such kind"):
        manager.submit("mine-bitcoin", {})
    manager.close()


def test_following_a_job_replays_history_then_live_events_then_ends(store):
    release = threading.Event()

    def run(request, emit, cancel):
        emit(dict(event="a"))
        release.wait(5)
        emit(dict(event="b"))
        return {}

    manager = make(store, run=run)
    job = manager.submit("run", {})
    wait_for(lambda: len(job.events) == 1, message="first event")
    seen = []
    follower = threading.Thread(target=lambda: seen.extend(e for e in manager.follow(job.id, poll=0.05) if e))
    follower.start()
    time.sleep(0.15)
    release.set()
    follower.join(10)
    assert [e["event"] for e in seen] == ["a", "b", "end"] and seen[-1]["status"] == DONE
    late = [e["event"] for e in manager.follow(job.id) if e]
    assert late == ["a", "b", "end"]                                   # a page that connects later still sees everything
    manager.close()


def test_following_sends_none_while_quiet_so_a_caller_can_keep_the_connection_alive(store):
    release = threading.Event()
    manager = make(store, run=lambda r, e, c: (release.wait(5), {})[1])
    job = manager.submit("run", {})
    stream = manager.follow(job.id, poll=0.05)
    assert next(stream) is None
    release.set()
    assert [e["event"] for e in stream if e] == ["end"]
    manager.close()


def test_following_an_unknown_job_is_an_error(store):
    manager = make(store, run=lambda r, e, c: {})
    with pytest.raises(NoSuchJob):
        manager.follow("0" * 12)
    manager.close()


def test_a_finished_job_is_saved_with_its_events(store):
    manager = make(store, run=lambda r, e, c: (e(dict(event="x")), dict(v=1))[1])
    job = manager.submit("run", dict(scene="s"))
    done(manager, job)
    saved = store.load_job(job.id)
    assert saved["status"] == DONE and saved["result"] == dict(v=1) and saved["events"][0]["event"] == "x"
    manager.close()


def test_a_job_saved_as_running_by_an_earlier_session_is_listed_as_interrupted(store):
    store.save_job(dict(id="a" * 12, kind="run", status="running", created=1.0, request=dict(scene="s")))
    store.save_job(dict(id="b" * 12, kind="run", status="done", created=2.0, request=dict(scene="s")))
    manager = make(store, run=lambda r, e, c: {})
    by_id = {j["id"]: j for j in manager.summaries()}
    assert by_id["a" * 12]["status"] == FAILED and "interrupted" in by_id["a" * 12]["error"]
    assert by_id["b" * 12]["status"] == DONE
    assert manager.stored("a" * 12)["status"] == FAILED
    manager.close()


def test_summaries_list_what_ran_without_the_bulk(store):
    manager = make(store, run=lambda r, e, c: {})
    job = manager.submit("run", dict(scene="s1", worlds=[8], graph=dict(name="mine", stages={}), source="x" * 10_000))
    done(manager, job)
    summary, = manager.summaries()
    assert summary["request"] == dict(scene="s1", worlds=[8], graph="mine") and "source" not in str(summary)
    manager.close()


def test_stored_finds_a_job_from_this_session_or_from_disk(store):
    store.save_job(dict(id="c" * 12, kind="run", status="done", created=1.0, request={}, result=dict(old=True)))
    manager = make(store, run=lambda r, e, c: dict(new=True))
    job = manager.submit("run", {})
    done(manager, job)
    assert manager.stored(job.id)["result"] == dict(new=True) and manager.stored("c" * 12)["result"] == dict(old=True)
    with pytest.raises(NoSuchJob):
        manager.stored("d" * 12)
    manager.close()


def test_mark_recorded_persists_and_updates_the_live_job(store):
    manager = make(store, run=lambda r, e, c: dict(v=1))
    job = manager.submit("run", {})
    done(manager, job)
    manager.mark_recorded(job.id, [4, 5])
    assert job.recorded == [4, 5] and store.load_job(job.id)["recorded"] == [4, 5]
    manager.close()


def test_closing_cancels_what_is_queued_and_asks_the_running_job_to_stop(store):
    started = threading.Event()

    def run(request, emit, cancel):
        started.set()
        cancel.wait(10)
        return dict(error="cancelled")

    manager = make(store, run=run)
    running, queued = manager.submit("run", {}), manager.submit("run", {})
    started.wait(5)
    manager.close()
    assert queued.status == CANCELLED and running.status == CANCELLED
    with pytest.raises(JobError, match="shutting down"):
        manager.submit("run", {})


def test_a_live_job_is_never_reported_as_interrupted(store):
    release = threading.Event()
    manager = make(store, run=lambda r, e, c: (release.wait(5), {})[1])
    running, queued = manager.submit("run", {}), manager.submit("run", {})
    wait_for(lambda: running.status == "running", message="the first job to start")
    assert running.summary()["status"] == "running" and queued.summary()["status"] == "queued"
    assert {j["id"]: j["status"] for j in manager.summaries()} == {running.id: "running", queued.id: "queued"}
    assert manager.stored(running.id)["status"] == "running" and running.summary()["error"] is None
    release.set()
    manager.close()


def test_a_job_from_an_earlier_session_replays_its_saved_events_then_ends(store):
    store.save_job(dict(id="e" * 12, kind="live", status="done", created=1.0, request={},
                        events=[dict(event="layout"), dict(event="live", step=6)]))
    manager = make(store, run=lambda r, e, c: {})
    assert [e["event"] for e in manager.follow("e" * 12)] == ["layout", "live", "end"]
    store.save_job(dict(id="f" * 12, kind="run", status="failed", error="boom", created=2.0, request={}))
    last = list(manager.follow("f" * 12))[-1]
    assert last == dict(event="end", status="failed", error="boom")
    with pytest.raises(NoSuchJob):
        manager.follow("0" * 12)
    manager.close()
