"""Model registry: every checkpoint becomes a versioned, content-addressed model.

model_id = "m-" + first 10 hex chars of SHA-256(checkpoint bytes), so the same
weights always get the same id and any change produces a new id. Each entry
records architecture, the observation/action interface ("environment
version"), training configuration, seed, metrics, evaluations and location.
"""
import hashlib
import json
import os
import threading
import time

import torch

from training.logger import plain

SIM_VERSION = "nexus-sim-2"   # bump when simulator semantics change


def file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def interface_spec(cfg):
    """Everything a policy depends on at runtime. Two models with the same spec are
    interchangeable in the same environment."""
    return {
        "sensor": {"num_beams": cfg["sensor"]["num_beams"], "fov_deg": cfg["sensor"]["fov_deg"],
                   "max_range": cfg["sensor"]["max_range"]},
        "actions": {k: list(v) for k, v in cfg["actions"].items()},
        "robot": {"radius": cfg["robot"]["radius"], "control_dt": cfg["robot"]["control_dt"]},
        "observation": "ranges/max_range + goal(dist,sin,cos) + last(v,w)",
        "sim_version": SIM_VERSION,
    }


def env_version(spec):
    return "env-" + hashlib.sha1(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:8]


def compatibility_issues(model_spec, runtime_cfg):
    """Differences that would make a model behave incorrectly in `runtime_cfg`."""
    rt = interface_spec(plain(runtime_cfg))
    issues = []
    for k in ("num_beams", "fov_deg", "max_range"):
        if model_spec["sensor"][k] != rt["sensor"][k]:
            issues.append(f"sensor.{k}: model {model_spec['sensor'][k]} vs runtime {rt['sensor'][k]}")
    if list(model_spec["actions"].keys()) != list(rt["actions"].keys()):
        issues.append(f"action set: model {list(model_spec['actions'])} vs runtime {list(rt['actions'])}")
    if model_spec["robot"]["control_dt"] != rt["robot"]["control_dt"]:
        issues.append(f"control period: model {model_spec['robot']['control_dt']} s vs runtime {rt['robot']['control_dt']} s")
    if model_spec["robot"]["radius"] != rt["robot"]["radius"]:
        issues.append(f"robot radius: model {model_spec['robot']['radius']} vs runtime {rt['robot']['radius']}")
    return issues


class ModelCatalog:
    def __init__(self, path):
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._lock = threading.RLock()
        self._models = {}
        self._by_path = {}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                for m in json.load(f):
                    self._models[m["model_id"]] = m
                    self._by_path[os.path.normcase(m["checkpoint"])] = m["model_id"]

    def _save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(list(self._models.values()), f, indent=1)
        os.replace(tmp, self.path)

    def register(self, path, experiment=None, label=None):
        path = os.path.abspath(path)
        key = os.path.normcase(path)
        with self._lock:
            mtime = os.path.getmtime(path)
            known = self._by_path.get(key)
            if known and self._models[known].get("checkpoint_mtime") == mtime:
                return self._models[known]
            ckpt = torch.load(path, map_location="cpu", weights_only=True)
            cfg = ckpt["config"]
            algo = "dqn" if "agent" in ckpt else "qlearning"
            mid = "m-" + file_hash(path)[:10]
            if mid in self._models:                      # same weights stored elsewhere
                self._by_path[key] = mid
                return self._models[mid]
            spec = interface_spec(cfg)
            if algo == "dqn":
                obs_dim = cfg["sensor"]["num_beams"] + 5
                arch = {"type": "MLP Q-network", "hidden": cfg["dqn"]["hidden"], "obs_dim": obs_dim,
                        "n_actions": len(cfg["actions"]), "double_dqn": cfg["dqn"]["double_dqn"],
                        "parameters": sum(v.numel() for v in ckpt["agent"]["q"].values())}
            else:
                arch = {"type": "Tabular Q", "states": int(ckpt["q_table"].shape[0]), "n_actions": int(ckpt["q_table"].shape[1])}
            exp = experiment or {}
            vals = [e for e in exp.get("evaluations", []) if e.get("kind") == "validation"]
            entry = {
                "model_id": mid, "label": label or f"{exp.get('name', 'model')} / {os.path.basename(path)}",
                "algorithm": algo, "architecture": arch, "interface": spec, "env_version": env_version(spec),
                "training_config": {"hyperparameters": cfg["dqn"] if algo == "dqn" else cfg["qlearning"],
                                    "reward": cfg["reward"], "randomization": cfg["randomization"],
                                    "world": cfg["world"]},
                "seed": cfg["training"]["seed"], "experiment_id": exp.get("id"),
                "checkpoint": path, "checkpoint_name": os.path.basename(path), "checkpoint_mtime": mtime,
                "training": {"episodes": exp.get("episodes"), "total_steps": ckpt.get("total_steps", exp.get("total_steps")),
                             "duration_s": exp.get("duration_s"),
                             "best_validation_success": max((v["success_rate"] for v in vals), default=None),
                             "checkpoint_eval": ckpt.get("eval") or None},
                "created": mtime, "registered": time.time(), "benchmarks": [],
            }
            self._models[mid] = entry
            self._by_path[key] = mid
            self._save()
            return entry

    def sync_from_experiments(self, store):
        """Register every checkpoint of every experiment (idempotent)."""
        for exp in store.list():
            for c in exp["checkpoints"]:
                try:
                    self.register(c["path"], exp)
                except Exception:
                    continue

    def id_for_path(self, path):
        with self._lock:
            mid = self._by_path.get(os.path.normcase(os.path.abspath(path)))
            return mid

    def get(self, mid):
        with self._lock:
            if mid not in self._models:
                raise KeyError(mid)
            return dict(self._models[mid])

    def list(self):
        with self._lock:
            return sorted((dict(m) for m in self._models.values()), key=lambda m: -m["created"])

    def add_benchmark(self, mid, result):
        with self._lock:
            self._models[mid].setdefault("benchmarks", []).append(result)
            self._save()

    def provenance(self, mid):
        m = self.get(mid)
        return {"model_id": mid, "label": m["label"], "algorithm": m["algorithm"], "env_version": m["env_version"],
                "checkpoint": m["checkpoint"]}
