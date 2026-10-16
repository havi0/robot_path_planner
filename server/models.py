"""Registry of the trained models the simulator and hardware bridge can run."""
import os
import threading

from evaluation.evaluate import load_dqn, load_qlearning


class ModelRegistry:
    def __init__(self, dqn_path=None, q_path=None):
        self._lock = threading.Lock()
        self.dqn = None          # (agent, train_cfg, info)
        self.q = None
        if dqn_path and os.path.exists(dqn_path):
            self.load("dqn", dqn_path, {"experiment_id": None, "label": "Reference DQN (models/dqn.pt)"})
        if q_path and os.path.exists(q_path):
            self.load("qlearning", q_path, {"experiment_id": None, "label": "Reference Q-learning"})

    def load(self, algorithm, path, info):
        if algorithm == "dqn":
            agent, cfg = load_dqn(path)
        elif algorithm == "qlearning":
            agent, cfg = load_qlearning(path)
        else:
            raise ValueError(f"unknown algorithm {algorithm}")
        entry = (agent, cfg, {**info, "path": os.path.abspath(path), "algorithm": algorithm})
        with self._lock:
            if algorithm == "dqn":
                self.dqn = entry
            else:
                self.q = entry
        return entry[2]

    def get(self, algorithm):
        with self._lock:
            return self.dqn if algorithm == "dqn" else self.q

    def describe(self):
        with self._lock:
            return {"dqn": self.dqn[2] if self.dqn else None, "qlearning": self.q[2] if self.q else None}
