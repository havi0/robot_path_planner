"""Thread-safe event log. Every event shown in the UI is recorded here by the
component that actually caused it (training thread, simulation loop, ...)."""
import logging
import threading
import time
from collections import deque

log = logging.getLogger("nexus")

LEVELS = ("info", "success", "warning", "error")


class EventLog:
    def __init__(self, maxlen=500):
        self._events = deque(maxlen=maxlen)
        self._lock = threading.Lock()
        self._seq = 0

    def emit(self, level, category, message, **data):
        assert level in LEVELS
        with self._lock:
            self._seq += 1
            ev = {"seq": self._seq, "time": time.time(), "level": level, "category": category,
                  "message": message, "data": data}
            self._events.append(ev)
        getattr(log, "error" if level == "error" else "warning" if level == "warning" else "info")(
            "[%s] %s", category, message)
        return ev

    def since(self, seq):
        with self._lock:
            return [e for e in self._events if e["seq"] > seq]

    def recent(self, n=50):
        with self._lock:
            return list(self._events)[-n:]

    @property
    def seq(self):
        return self._seq
