"""Background job manager: long computations (benchmarks, experiment designs,
scenario sets, counterfactuals) run on a worker thread with progress,
cooperative cancellation and a persisted history."""
import json
import os
import threading
import time
import traceback
import uuid
from collections import deque


class Cancelled(Exception):
    pass


class Job:
    def __init__(self, kind, title, fn, params):
        self.id = f"job-{uuid.uuid4().hex[:8]}"
        self.kind, self.title, self.fn, self.params = kind, title, fn, params
        self.status = "queued"
        self.done, self.total = 0, None
        self.message = ""
        self.result = None
        self.error = None
        self.created, self.started, self.finished = time.time(), None, None
        self._cancel = threading.Event()

    # called from the job function
    def progress(self, done, total=None, message=None):
        self.done = done
        if total is not None:
            self.total = total
        if message is not None:
            self.message = message
        if self._cancel.is_set():
            raise Cancelled()

    def check(self):
        if self._cancel.is_set():
            raise Cancelled()

    def as_dict(self):
        return {"id": self.id, "kind": self.kind, "title": self.title, "status": self.status, "done": self.done,
                "total": self.total, "message": self.message, "result": self.result, "error": self.error,
                "created": self.created, "started": self.started, "finished": self.finished, "params": self.params}


class JobManager:
    def __init__(self, history_path, events, workers=1):
        self.history_path = history_path
        self.events = events
        self._queue = deque()
        self._jobs = {}
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self.history = []
        if os.path.exists(history_path):
            try:
                with open(history_path, encoding="utf-8") as f:
                    self.history = json.load(f)[-200:]
            except (OSError, json.JSONDecodeError):
                self.history = []
        self._threads = [threading.Thread(target=self._worker, name=f"jobs-{i}", daemon=True) for i in range(workers)]

    def start(self):
        for t in self._threads:
            t.start()

    def shutdown(self):
        self._stop.set()
        for j in list(self._jobs.values()):
            j._cancel.set()
        self._wake.set()

    def submit(self, kind, title, fn, params=None):
        job = Job(kind, title, fn, params or {})
        with self._lock:
            self._jobs[job.id] = job
            self._queue.append(job)
        self._wake.set()
        self.events.emit("info", "job", f"Queued: {title}", job=job.id)
        return job

    def cancel(self, job_id):
        job = self._jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        if job.status in ("completed", "failed", "cancelled"):
            raise ValueError("job already finished")
        job._cancel.set()
        if job.status == "queued":
            with self._lock:
                if job in self._queue:
                    self._queue.remove(job)
            self._finish(job, "cancelled")
        return job.as_dict()

    def get(self, job_id):
        if job_id in self._jobs:
            return self._jobs[job_id].as_dict()
        for h in self.history:
            if h["id"] == job_id:
                return h
        raise KeyError(job_id)

    def list(self):
        live = [j.as_dict() for j in self._jobs.values()]
        ids = {j["id"] for j in live}
        return sorted(live + [h for h in self.history if h["id"] not in ids], key=lambda j: -j["created"])[:100]

    def active(self):
        return [j.as_dict() for j in self._jobs.values() if j.status in ("queued", "running")]

    def _worker(self):
        while not self._stop.is_set():
            self._wake.wait(0.5)
            with self._lock:
                job = self._queue.popleft() if self._queue else None
                if not self._queue:
                    self._wake.clear()
            if job is None:
                continue
            job.status, job.started = "running", time.time()
            try:
                job.result = job.fn(job)
                self._finish(job, "completed")
            except Cancelled:
                self._finish(job, "cancelled")
            except Exception as e:
                traceback.print_exc()
                job.error = str(e)
                self._finish(job, "failed")

    def _finish(self, job, status):
        job.status, job.finished = status, time.time()
        level = {"completed": "success", "cancelled": "warning", "failed": "error"}[status]
        self.events.emit(level, "job", f"{job.title}: {status}" + (f" ({job.error})" if job.error else ""), job=job.id)
        with self._lock:
            self.history.append(job.as_dict())
            self.history = self.history[-200:]
            try:
                tmp = self.history_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(self.history, f, default=str)
                os.replace(tmp, self.history_path)
            except OSError:
                pass
