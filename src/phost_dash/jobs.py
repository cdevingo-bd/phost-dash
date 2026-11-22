"""Jobs: one thing at a time on the GPU.

Timing on a shared GPU is meaningless, so the dashboard runs one job at a time, in the order they were submitted.
A job is a request, a status, the events it emitted while running, and a result. Events are kept in memory so a page
that connects late (or reconnects) can read the whole history and then follow the rest.

A runner is ``runner(request, emit, cancel) -> result``: it does the work, calls ``emit(event)`` as it goes, and
stops early when ``cancel`` is set. A result with a non-empty ``error`` makes the job ``failed``.
"""

from __future__ import annotations

import secrets
import threading
import time
import traceback
from typing import Any, Callable, Iterator, Mapping

from .store import NotFound, Store

QUEUED, RUNNING, DONE, FAILED, CANCELLED = "queued", "running", "done", "failed", "cancelled"
FINISHED = (DONE, FAILED, CANCELLED)

Runner = Callable[[Mapping[str, Any], Callable[[dict], None], threading.Event], Mapping[str, Any]]


class JobError(Exception):
    """The request cannot be done to this job (it does not exist, or it is in the wrong state)."""


class NoSuchJob(JobError):
    pass


class Job:
    def __init__(self, kind: str, request: Mapping[str, Any]):
        self.id = secrets.token_hex(6)
        self.kind, self.request = kind, dict(request)
        self.status = QUEUED
        self.created = time.time()
        self.started = self.finished = None
        self.events: list[dict] = []
        self.result: Mapping[str, Any] | None = None
        self.error: str | None = None
        self.cancel = threading.Event()
        self.recorded: list[int] = []        # ledger sequence numbers this job's results were recorded as

    def summary(self) -> dict:
        return summarize(self.full())

    def full(self) -> dict:
        return dict(id=self.id, kind=self.kind, status=self.status, created=self.created, started=self.started,
                    finished=self.finished, error=self.error, request=self.request, result=self.result,
                    events=len(self.events), recorded=self.recorded)


def label(request: Mapping[str, Any]) -> dict:
    """The few request fields worth listing: what ran where, without the bulk (kernel source, whole graphs)."""
    graph = request.get("graph")
    fields = dict(scene=request.get("scene"), worlds=request.get("worlds"),
                  graph=graph.get("name") if isinstance(graph, Mapping) else None,
                  seq=request.get("seq"), label=request.get("label"), job=request.get("job"))
    return {k: v for k, v in fields.items() if v is not None}


def summarize(record: Mapping[str, Any]) -> dict:
    """A job's list entry, from a live job's ``full()`` or a stored record."""
    return dict(id=record["id"], kind=record["kind"], status=record["status"], created=record["created"],
                started=record.get("started"), finished=record.get("finished"), error=record.get("error"),
                request=label(record.get("request") or {}), recorded=record.get("recorded") or [])


def from_disk(record: Mapping[str, Any]) -> dict:
    """A stored record as it is now: one still saved as queued or running belongs to a session that is over, so it did
    not finish, whatever the file says."""
    if record.get("status") in (QUEUED, RUNNING):
        return dict(record, status=FAILED, error="interrupted: the dashboard stopped while this was running")
    return dict(record)


class JobManager:
    def __init__(self, store: Store, runners: Mapping[str, Runner]):
        self.store, self.runners = store, dict(runners)
        self._jobs: dict[str, Job] = {}
        self._queue: list[Job] = []
        self._cond = threading.Condition()
        self._closed = False
        self._thread = threading.Thread(target=self._work, name="phost-dash-jobs", daemon=True)
        self._thread.start()

    # ---- submitting and looking ----

    def submit(self, kind: str, request: Mapping[str, Any]) -> Job:
        if kind not in self.runners:
            raise JobError(f"no such kind of job: {kind!r}")
        job = Job(kind, request)
        with self._cond:
            if self._closed:
                raise JobError("the dashboard is shutting down")
            self._save(job)                    # before the worker can see it, so a later save can never be overwritten
            self._jobs[job.id] = job
            self._queue.append(job)
            self._cond.notify_all()
        return job

    def get(self, job_id: str) -> Job:
        with self._cond:
            try:
                return self._jobs[job_id]
            except KeyError:
                raise NoSuchJob(f"no job {job_id!r} in this session") from None

    def summaries(self) -> list[dict]:
        """This session's jobs, then earlier ones from disk."""
        with self._cond:
            live = {j.id: j.summary() for j in self._jobs.values()}
        old = [summarize(from_disk(stored)) for stored in self.store.list_jobs() if stored.get("id") not in live]
        return sorted(list(live.values()) + old, key=lambda j: j["created"], reverse=True)

    def stored(self, job_id: str) -> dict:
        """A job from this session, or its saved record (an unfinished one is reported as interrupted)."""
        try:
            return self.get(job_id).full()
        except JobError:
            try:
                record = self.store.load_job(job_id)
            except NotFound as error:
                raise NoSuchJob(str(error)) from None
            return from_disk(record)

    def mark_recorded(self, job_id: str, seqs: list[int]) -> None:
        """Remember which ledger records a job's results became, so they are not recorded twice."""
        record = self.stored(job_id)
        record["recorded"] = list(seqs)
        try:
            self.get(job_id).recorded = list(seqs)
        except JobError:
            pass
        self.store.save_job(record)

    # ---- cancelling ----

    def cancel(self, job_id: str) -> Job:
        job = self.get(job_id)
        with self._cond:
            if job.status in FINISHED:
                raise JobError(f"job {job_id} is already {job.status}")
            if job.status == QUEUED:
                self._queue.remove(job)
                self._finish(job, CANCELLED, None, "cancelled before it started")
                return job
        job.cancel.set()
        return job

    # ---- following events ----

    def follow(self, job_id: str, *, poll: float = 15.0) -> Iterator[dict | None]:
        """Every event of the job, past and future, then ``{"event": "end", ...}``. Yields None every ``poll`` seconds
        of quiet so a caller can send a keep-alive and notice a closed connection. A job from an earlier session is
        replayed from its saved record. An unknown job raises here, at the call, not on the first event."""
        try:
            job = self.get(job_id)
        except NoSuchJob:
            record = self.stored(job_id)                      # raises NoSuchJob if there is no such record either
            return self._replay(record)
        return self._follow(job, poll)

    @staticmethod
    def _replay(record: dict) -> Iterator[dict | None]:
        yield from record.get("events") or []
        yield dict(event="end", status=record["status"], error=record.get("error"))

    def _follow(self, job: Job, poll: float) -> Iterator[dict | None]:
        seen = 0
        while True:
            with self._cond:
                if len(job.events) == seen and job.status not in FINISHED:
                    self._cond.wait(timeout=poll)
                batch = job.events[seen:]
                seen += len(batch)
                finished = job.status in FINISHED and seen == len(job.events)
            for event in batch:
                yield event
            if finished:
                yield dict(event="end", status=job.status, error=job.error)
                return
            if not batch:
                yield None

    # ---- the worker ----

    def _work(self) -> None:
        while True:
            with self._cond:
                while not self._queue and not self._closed:
                    self._cond.wait()
                if self._closed and not self._queue:
                    return
                job = self._queue.pop(0)
                job.status, job.started = RUNNING, time.time()
                self._cond.notify_all()
            self._run(job)

    def _emit(self, job: Job) -> Callable[[dict], None]:
        def emit(event: dict) -> None:
            with self._cond:
                job.events.append(dict(event, seq=len(job.events)))
                self._cond.notify_all()
        return emit

    def _run(self, job: Job) -> None:
        try:
            result = dict(self.runners[job.kind](job.request, self._emit(job), job.cancel))
        except BaseException as error:                       # a runner's bug must not kill the worker thread
            traceback.print_exc()
            self._finish(job, FAILED, None, f"{type(error).__name__}: {error}")
            return
        if job.cancel.is_set() or result.get("error") == "cancelled":
            self._finish(job, CANCELLED, result, "cancelled")
        elif result.get("error"):
            self._finish(job, FAILED, result, str(result["error"]))
        else:
            self._finish(job, DONE, result, None)

    def _finish(self, job: Job, status: str, result: Mapping[str, Any] | None, error: str | None) -> None:
        """Save the finished record, then publish it: whoever sees the job finished can also find it on disk."""
        finished = time.time()
        with self._cond:
            record = dict(job.full(), status=status, result=result, error=error, finished=finished,
                          events=list(job.events))
        self._save_record(record)
        with self._cond:
            job.status, job.result, job.error, job.finished = status, result, error, finished
            self._cond.notify_all()

    def _save(self, job: Job) -> None:
        self._save_record(dict(job.full(), events=list(job.events)))

    def _save_record(self, record: Mapping[str, Any]) -> None:
        try:
            self.store.save_job(record)
        except OSError as problem:                           # a full disk must not lose the live result
            print(f"could not save job {record['id']}: {problem}")

    def close(self, timeout: float = 5.0) -> None:
        """Stop accepting jobs, cancel what is running or queued, and wait for the worker."""
        with self._cond:
            self._closed = True
            pending = list(self._queue)
            self._queue.clear()
            running = [j for j in self._jobs.values() if j.status == RUNNING]
            self._cond.notify_all()
        for job in pending:
            self._finish(job, CANCELLED, None, "the dashboard shut down")
        for job in running:
            job.cancel.set()
        self._thread.join(timeout)
