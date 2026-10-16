"""Persistent experiment store.

data/experiments/<id>/
    experiment.json   metadata: name, algorithm, hyperparameters, environment, seed,
                      status, timings, checkpoints, evaluation results
    metrics.csv       one row per training episode
    run/              trainer output (config snapshot, checkpoints *.pt, CSV logs)
"""
import csv
import json
import os
import re
import shutil
import threading
import time
import uuid

METRIC_FIELDS = ["episode", "total_steps", "reward", "length", "outcome", "epsilon", "loss", "throughput", "time", "level"]


def _slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "experiment"


class ExperimentStore:
    def __init__(self, root):
        self.root = root
        os.makedirs(root, exist_ok=True)
        self._lock = threading.RLock()

    # ---------- paths ----------
    def dir(self, exp_id):
        if not re.fullmatch(r"[a-z0-9\-]+", exp_id or ""):
            raise KeyError(exp_id)
        return os.path.join(self.root, exp_id)

    def run_dir(self, exp_id):
        return os.path.join(self.dir(exp_id), "run")

    # ---------- CRUD ----------
    def create(self, name, algorithm, hyperparameters, environment, seed, extra=None):
        exp_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{_slug(name)}-{uuid.uuid4().hex[:4]}"
        os.makedirs(self.run_dir(exp_id), exist_ok=True)
        meta = {"id": exp_id, "name": name, "algorithm": algorithm, "hyperparameters": hyperparameters,
                "environment": environment, "seed": seed, "status": "created", "created_at": time.time(),
                "started_at": None, "finished_at": None, "duration_s": 0.0, "episodes": 0, "total_steps": 0,
                "evaluations": [], "imported": False, **(extra or {})}
        self.save(meta)
        return meta

    def save(self, meta):
        with self._lock:
            path = os.path.join(self.dir(meta["id"]), "experiment.json")
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(meta, f, indent=2)
            os.replace(tmp, path)

    def get(self, exp_id):
        with self._lock:
            path = os.path.join(self.dir(exp_id), "experiment.json")
            if not os.path.exists(path):
                raise KeyError(exp_id)
            with open(path, encoding="utf-8") as f:
                meta = json.load(f)
        meta["checkpoints"] = self.checkpoints(meta)
        return meta

    def update(self, exp_id, **fields):
        with self._lock:
            meta = self.get(exp_id)
            meta.pop("checkpoints", None)
            meta.update(fields)
            self.save(meta)
            return meta

    def list(self):
        out = []
        for name in sorted(os.listdir(self.root), reverse=True):
            try:
                out.append(self.get(name))
            except (KeyError, json.JSONDecodeError):
                continue
        return out

    def delete(self, exp_id):
        with self._lock:
            shutil.rmtree(self.dir(exp_id))

    # ---------- checkpoints ----------
    def checkpoints(self, meta):
        if meta.get("checkpoint_paths"):          # imported experiments point at existing files
            return [{"name": os.path.basename(p), "path": p, "size": os.path.getsize(p),
                     "modified": os.path.getmtime(p)} for p in meta["checkpoint_paths"] if os.path.exists(p)]
        run = self.run_dir(meta["id"])
        if not os.path.isdir(run):
            return []
        files = [f for f in os.listdir(run) if f.endswith(".pt")]
        return sorted(({"name": f, "path": os.path.join(run, f), "size": os.path.getsize(os.path.join(run, f)),
                        "modified": os.path.getmtime(os.path.join(run, f))} for f in files),
                      key=lambda c: c["modified"])

    def checkpoint_path(self, exp_id, name):
        for c in self.get(exp_id)["checkpoints"]:
            if c["name"] == name:
                return c["path"]
        raise KeyError(name)

    # ---------- metrics ----------
    def append_metrics(self, exp_id, rows):
        path = os.path.join(self.dir(exp_id), "metrics.csv")
        new = not os.path.exists(path)
        with self._lock, open(path, "a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=METRIC_FIELDS, extrasaction="ignore")
            if new:
                w.writeheader()
            w.writerows(rows)

    def metrics(self, exp_id):
        path = os.path.join(self.dir(exp_id), "metrics.csv")
        if not os.path.exists(path):
            return []
        out = []
        with open(path, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                row = {}
                for k, v in r.items():
                    if k == "outcome":
                        row[k] = v
                    elif k == "level":
                        row[k] = None if v in ("", None) else int(float(v))
                    elif v in ("", "nan", None):
                        row[k] = None
                    else:
                        row[k] = float(v) if k not in ("episode", "total_steps", "length") else int(float(v))
                out.append(row)
        return out

    def metrics_csv_path(self, exp_id):
        return os.path.join(self.dir(exp_id), "metrics.csv")

    # ---------- import the reference models trained with the CLI ----------
    def import_reference_runs(self, project_root):
        """Register the models produced by `python main.py train-*` (used in REPORT.md) as
        read-only experiments so their real training curves appear in the studio."""
        refs = [("reference-dqn", "Reference DQN (report model)", "dqn",
                 os.path.join(project_root, "runs", "final", "B"), os.path.join(project_root, "models", "dqn.pt")),
                ("reference-qlearning", "Reference Q-learning (report model)", "qlearning",
                 os.path.join(project_root, "runs", "final", "Q"), os.path.join(project_root, "models", "qlearning.pt"))]
        for exp_id, name, algo, run, model in refs:
            if os.path.exists(os.path.join(self.root, exp_id, "experiment.json")):
                continue
            if not (os.path.isdir(run) and os.path.exists(model)):
                continue
            import yaml
            cfg = yaml.safe_load(open(os.path.join(run, "config.yaml"), encoding="utf-8"))
            rows = []
            with open(os.path.join(run, "episodes.csv"), encoding="utf-8") as f:
                for r in csv.DictReader(f):
                    rows.append({"episode": r["episode"], "total_steps": r["total_steps"], "reward": r["return"],
                                 "length": r["length"], "outcome": r["outcome"], "epsilon": r["epsilon"],
                                 "loss": r.get("loss", ""), "throughput": "", "time": ""})
            evals = []
            with open(os.path.join(run, "evals.csv"), encoding="utf-8") as f:
                for r in csv.DictReader(f):
                    evals.append({"kind": "validation", "total_steps": int(float(r["total_steps"])),
                                  "episodes": int(float(r["episodes"])),
                                  "success_rate": float(r["success_rate"]), "collision_rate": float(r["collision_rate"]),
                                  "timeout_rate": float(r["timeout_rate"])})
            hp = cfg["dqn"] if algo == "dqn" else cfg["qlearning"]
            os.makedirs(os.path.join(self.root, exp_id), exist_ok=True)
            meta = {"id": exp_id, "name": name, "algorithm": algo, "hyperparameters": hp,
                    "environment": {"world": cfg["world"], "randomization": cfg["randomization"],
                                    "reward": cfg["reward"]},
                    "seed": cfg["training"]["seed"], "status": "completed",
                    "created_at": os.path.getmtime(os.path.join(run, "config.yaml")),
                    "started_at": None, "finished_at": os.path.getmtime(model), "duration_s": None,
                    "episodes": len(rows), "total_steps": int(rows[-1]["total_steps"]) if rows else 0,
                    "evaluations": evals, "imported": True, "checkpoint_paths": [os.path.abspath(model)],
                    "notes": f"Imported from {os.path.relpath(run, project_root)} (trained with the CLI)."}
            self.save(meta)
            self.append_metrics(exp_id, rows)
