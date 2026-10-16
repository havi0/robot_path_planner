"""Training manager: runs DQN / tabular Q-learning in a background thread through
real environment interaction, with pause/resume/stop, checkpoints, evaluation
and per-episode metrics persisted to the experiment store."""
import copy
import math
import os
import threading
import time
import traceback

import numpy as np
import torch

from agent.q_learning import QLearningAgent
from environment.nav_env import NavigationEnv
from evaluation.evaluate import (dqn_method, evaluate_method, heldout_seeds, load_dqn, load_qlearning,
                                 make_discretizer, qlearning_method, validation_seeds, with_recovery)
from training.logger import plain
from scenarios.curriculum import Curriculum
from training.train_dqn import DQNTrainer

HP_LIMITS = {
    "lr": (1e-6, 1e-1), "gamma": (0.5, 0.9999), "eps_start": (0.0, 1.0), "eps_end": (0.0, 1.0),
    "eps_decay": (1, 10_000_000), "buffer_size": (1_000, 2_000_000), "batch_size": (8, 1024),
    "target_update": (10, 1_000_000), "episodes": (1, 200_000), "seed": (0, 2 ** 31 - 1),
    "density_min": (0.0, 0.35), "density_max": (0.0, 0.35), "eval_every": (1_000, 1_000_000),
    "alpha": (1e-4, 1.0),
}


class TrainingError(ValueError):
    pass


def validate_training_request(req):
    algo = req.get("algorithm", "dqn")
    if algo not in ("dqn", "qlearning"):
        raise TrainingError("algorithm must be 'dqn' or 'qlearning'")
    for k, (lo, hi) in HP_LIMITS.items():
        if k in req and req[k] is not None:
            v = req[k]
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or not lo <= v <= hi:
                raise TrainingError(f"{k} must be between {lo} and {hi}")
    if req.get("eps_end", 0) > req.get("eps_start", 1):
        raise TrainingError("eps_end must not exceed eps_start")
    if req.get("density_min", 0) > req.get("density_max", 0.35):
        raise TrainingError("density_min must not exceed density_max")
    cur = req.get("curriculum")
    if cur and cur.get("enabled"):
        if algo != "dqn":
            raise TrainingError("curriculum mode is available for DQN only")
        t, w, m = cur.get("threshold", 0.6), cur.get("window", 50), cur.get("min_episodes", 50)
        if not (0 < t <= 1 and 5 <= w <= 1000 and w <= m <= 100000):
            raise TrainingError("curriculum: 0 < threshold <= 1, 5 <= window <= 1000, min_episodes >= window")
    name = (req.get("name") or "").strip()
    if not name or len(name) > 80:
        raise TrainingError("experiment name is required (max 80 characters)")
    return algo


class TrainingManager:
    def __init__(self, base_cfg, store, models, events):
        self.base_cfg = base_cfg
        self.store = store
        self.models = models
        self.events = events
        self.lock = threading.RLock()
        self.status = "idle"            # idle | running | paused | stopping | completed | stopped | failed
        self.experiment_id = None
        self.algorithm = None
        self.target_episodes = 0
        self.episodes = []              # in-memory metrics of the active experiment
        self.preview = None
        self.started = None
        self.elapsed = 0.0
        self.evaluating = None          # experiment id under evaluation
        self.last_eval = None
        self._thread = None
        self._resume = threading.Event()
        self._resume.set()
        self._stop = threading.Event()
        self._ckpt_request = threading.Event()
        self.epsilon = None
        self.total_steps = 0
        self.throughput = 0.0
        self.last_loss = None
        self._seg_start = time.time()
        self.on_finished = None         # callback(experiment_id) e.g. register checkpoints in the model registry

    # ------------------------------------------------------------ config
    def _build_cfg(self, req):
        cfg = copy.deepcopy(self.base_cfg)
        d = cfg.dqn
        for key, dst in (("lr", "lr"), ("gamma", "gamma"), ("eps_start", "eps_start"), ("eps_end", "eps_end"),
                         ("buffer_size", "buffer_size"), ("batch_size", "batch_size"),
                         ("target_update", "target_update_interval")):
            if req.get(key) is not None:
                d[dst] = type(d[dst])(req[key]) if not isinstance(d[dst], list) else req[key]
        q = cfg.qlearning
        for key in ("gamma", "eps_start", "eps_end"):
            if req.get(key) is not None:
                q[key] = float(req[key])
        if req.get("alpha") is not None:
            q.alpha = float(req["alpha"])
        if req.get("eps_decay") is not None:
            d.eps_decay_steps = int(req["eps_decay"])
            q.eps_decay_episodes = int(req["eps_decay"])
        if req.get("seed") is not None:
            cfg.training.seed = int(req["seed"])
        if req.get("eval_every") is not None:
            cfg.training.eval_every = int(req["eval_every"])
        cfg.training.eval_episodes = 30
        lo, hi = req.get("density_min"), req.get("density_max")
        if lo is not None and hi is not None:
            cfg.randomization.obstacle_density = [float(lo), float(hi)]
        if req.get("randomization") is not None:
            cfg.randomization.enabled = bool(req["randomization"])
        return cfg

    # ------------------------------------------------------------ control
    def start(self, req):
        algo = validate_training_request(req)
        with self.lock:
            if self.status in ("running", "paused", "stopping"):
                raise TrainingError("A training run is already active - stop it first")
            cfg = self._build_cfg(req)
            hp = plain(cfg.dqn) if algo == "dqn" else plain(cfg.qlearning)
            env = {"world": plain(cfg.world), "randomization": plain(cfg.randomization), "reward": plain(cfg.reward)}
            meta = self.store.create(req["name"].strip(), algo, hp, env, cfg.training.seed,
                                     {"target_episodes": int(req.get("episodes", 1000))})
            self.experiment_id = meta["id"]
            self.curriculum_req = req.get("curriculum") if (req.get("curriculum") or {}).get("enabled") else None
            self.curriculum = None
            if self.curriculum_req:
                self.store.update(meta["id"], curriculum=self.curriculum_req)
            self.algorithm = algo
            self.target_episodes = int(req.get("episodes", 1000))
            self.episodes = []
            self.preview = None
            self.total_steps = 0
            self.epsilon = None
            self.throughput = 0.0
            self.last_loss = None
            self.elapsed = 0.0
            self._stop.clear()
            self._resume.set()
            self.status = "running"
            self.started = time.time()
            self._seg_start = self.started
            self.store.update(meta["id"], status="running", started_at=self.started)
            target = self._run_dqn if algo == "dqn" else self._run_q
            self._thread = threading.Thread(target=self._guard, args=(target, cfg), name="training", daemon=True)
            self._thread.start()
        self.events.emit("info", "training", f"Training started: {meta['name']} ({algo.upper()}, "
                                             f"{self.target_episodes} episodes)", experiment=meta["id"])
        return meta

    def pause(self):
        with self.lock:
            if self.status != "running":
                raise TrainingError("Training is not running")
            self._resume.clear()
            self.status = "paused"
        self.events.emit("info", "training", "Training paused")

    def resume(self):
        with self.lock:
            if self.status != "paused":
                raise TrainingError("Training is not paused")
            self.status = "running"
            self._resume.set()
        self.events.emit("info", "training", "Training resumed")

    def stop(self):
        with self.lock:
            if self.status not in ("running", "paused"):
                raise TrainingError("No active training run")
            self.status = "stopping"
            self._stop.set()
            self._resume.set()

    def request_checkpoint(self):
        with self.lock:
            if self.status not in ("running", "paused"):
                raise TrainingError("No active training run")
            self._ckpt_request.set()
            if self.status == "paused":       # save immediately while paused
                self._resume.set()

    def shutdown(self):
        self._stop.set()
        self._resume.set()
        if self._thread:
            self._thread.join(timeout=5)

    # ------------------------------------------------------------ helpers
    def _record(self, row):
        now = time.time()
        row["time"] = round(now - self.started, 3)
        with self.lock:
            self.episodes.append(row)
            self.total_steps = row["total_steps"]
            self.epsilon = row["epsilon"]
        self._pending.append(row)
        if len(self._pending) >= 20 or now - self._last_flush > 2:
            self._flush()

    def _flush(self):
        if self._pending:
            self.store.append_metrics(self.experiment_id, self._pending)
            self._pending = []
        self._last_flush = time.time()
        self.store.update(self.experiment_id, episodes=len(self.episodes), total_steps=self.total_steps,
                          duration_s=self._elapsed())

    def _elapsed(self):
        return self.elapsed + (time.time() - self._seg_start if self.status == "running" else 0.0)

    def _publish_preview(self, env, episode, reward):
        b = env.backend
        s = b.state
        self.preview = {"world": {"width": b.world.width, "height": b.world.height,
                                  "rects": b.world.rects.round(3).tolist(), "goal": list(b.world.goal),
                                  "start": list(b.world.start), "movers": b.world.movers[:, :2].round(3).tolist(),
                                  "mover_radius": b.world.mover_radius, "goal_radius": self.base_cfg.world.goal_radius,
                                  "robot_radius": self.base_cfg.robot.radius},
                        "robot": {"x": s.x, "y": s.y, "theta": s.theta}, "trail": self._preview_trail[-400:],
                        "episode": episode, "reward": reward}

    def _guard(self, target, cfg):
        self._pending, self._last_flush = [], time.time()
        try:
            target(cfg)
            final = "stopped" if self._stop.is_set() else "completed"
        except Exception as e:          # never leave the UI in a fake 'running' state
            traceback.print_exc()
            final = "failed"
            self.events.emit("error", "training", f"Training failed: {e}")
        with self.lock:
            self._flush()
            self.status = final
            self.store.update(self.experiment_id, status=final, finished_at=time.time(), duration_s=self._elapsed())
        if self.on_finished:
            try:
                self.on_finished(self.experiment_id)
            except Exception as e:
                self.events.emit("warning", "registry", f"Could not register checkpoints: {e}")
        if final != "failed":
            self.events.emit("success" if final == "completed" else "warning", "training",
                             f"Training {final} after {len(self.episodes)} episodes ({self.total_steps:,} steps)",
                             experiment=self.experiment_id)

    def _pause_point(self, save_fn):
        """Handles checkpoint requests and pausing; returns False if stop was requested."""
        if self._ckpt_request.is_set():
            self._ckpt_request.clear()
            name = save_fn(f"checkpoint_{self.total_steps}.pt")
            self.events.emit("success", "checkpoint", f"Checkpoint saved: {name}", experiment=self.experiment_id)
        if not self._resume.is_set():
            self.elapsed += time.time() - self._seg_start
            self._flush()
            while not self._resume.wait(0.1):
                if self._stop.is_set():
                    break
            self._seg_start = time.time()
            if self._ckpt_request.is_set():
                return self._pause_point(save_fn)
        return not self._stop.is_set()

    # ------------------------------------------------------------ DQN
    def _run_dqn(self, cfg):
        run_dir = self.store.run_dir(self.experiment_id)
        trainer = DQNTrainer(cfg, run_dir=run_dir, quiet=True)
        if not cfg.randomization.enabled:
            trainer.reset_options = {"density": float(np.mean(cfg.randomization.obstacle_density))}
        evals_seen = 0
        t_window = [(time.perf_counter(), 0)]
        self._preview_trail = []
        last_preview = 0.0
        if self.curriculum_req:
            c = self.curriculum_req
            self.curriculum = Curriculum(c.get("types"), c.get("threshold", 0.6), c.get("window", 50),
                                         c.get("min_episodes", 50), seed=cfg.training.seed, events=self.events)
            cur = self.curriculum

            def next_options():
                if trainer.history:
                    trainer.history[-1]["level"] = cur.level      # level the finished episode was played at
                    cur.record(trainer.history[-1]["outcome"], trainer.episode)
                w = cur.next_world()
                return {"world": w} if w is not None else None

            trainer.reset_options = next_options
            first = cur.next_world()
            if first is not None:
                trainer.obs, _ = trainer.env.reset(options={"world": first})
            self.events.emit("info", "curriculum", f"Curriculum started at level 1/{cur.n_levels}: {cur.state()['criterion']}")

        def save(name):
            trainer.save(name)
            return name

        while trainer.episode < self.target_episodes:
            if not self._pause_point(save):
                break
            summary = trainer.step()
            s = trainer.env.backend.state
            self._preview_trail.append([round(s.x, 3), round(s.y, 3)])
            now = time.perf_counter()
            if now - last_preview > 0.08:
                self._publish_preview(trainer.env, trainer.episode + 1, trainer.ep_return)
                last_preview = now
            self.last_loss = None if math.isnan(trainer.last_loss) else trainer.last_loss
            if summary:
                t_window.append((now, trainer.total_steps))
                t_window = [w for w in t_window if now - w[0] < 10] or t_window[-1:]
                dt = t_window[-1][0] - t_window[0][0]
                self.throughput = (t_window[-1][1] - t_window[0][1]) / dt if dt > 0 else 0.0
                self._record({"episode": summary["episode"], "total_steps": summary["total_steps"],
                              "reward": summary["return"], "length": summary["length"],
                              "outcome": summary["outcome"], "epsilon": summary["epsilon"],
                              "loss": self.last_loss, "throughput": round(self.throughput, 1),
                              "level": None if self.curriculum is None else summary.get("level", self.curriculum.level) + 1})
                self._preview_trail = []
            if len(trainer.eval_history) > evals_seen:
                evals_seen = len(trainer.eval_history)
                ev = trainer.eval_history[-1]
                self._add_eval({"kind": "validation", "total_steps": ev["total_steps"], "episodes": ev["episodes"],
                                "success_rate": ev["success_rate"], "collision_rate": ev["collision_rate"],
                                "timeout_rate": ev["timeout_rate"]})
                self.events.emit("info", "evaluation",
                                 f"Validation @ {ev['total_steps']:,} steps: success {ev['success_rate']:.0%}, "
                                 f"collision {ev['collision_rate']:.0%}", experiment=self.experiment_id)
                self.events.emit("success", "checkpoint", "Checkpoint saved: last.pt / best.pt",
                                 experiment=self.experiment_id)
        trainer.save("last.pt")
        if not os.path.exists(os.path.join(run_dir, "best.pt")):
            trainer.save("best.pt")
        trainer.ep_log.close()
        trainer.eval_log.close()

    # ------------------------------------------------------------ Q-learning
    def _run_q(self, cfg):
        run_dir = self.store.run_dir(self.experiment_id)
        env = NavigationEnv(cfg, mode="train", use_safety=False)
        agent = QLearningAgent(make_discretizer(cfg), env.action_space.n, cfg.qlearning, cfg.training.seed)
        opts = None if cfg.randomization.enabled else {"density": float(np.mean(cfg.randomization.obstacle_density))}
        obs, _ = env.reset(seed=cfg.training.seed, options=opts)
        best = None
        self._preview_trail = []
        t_window = [(time.perf_counter(), 0)]
        last_preview = 0.0

        def save(name, stats=None):
            torch.save({"q_table": torch.from_numpy(agent.Q.copy()), "config": plain(cfg), "eval": stats or {}},
                       os.path.join(run_dir, name))
            return name

        ep = 0
        total = 0
        while ep < self.target_episodes:
            if not self._pause_point(save):
                break
            eps = agent.epsilon(ep + 1)
            ret, done, length = 0.0, False, 0
            while not done:
                a = agent.act(obs, eps)
                nxt, r, term, trunc, info = env.step(a)
                agent.update(obs, a, r, nxt, term)
                obs, ret, length, done = nxt, ret + r, length + 1, term or trunc
                s = env.backend.state
                self._preview_trail.append([round(s.x, 3), round(s.y, 3)])
                now = time.perf_counter()
                if now - last_preview > 0.08:
                    self._publish_preview(env, ep + 1, ret)
                    last_preview = now
                if self._stop.is_set():
                    break
            if self._stop.is_set():
                break
            ep += 1
            total += length
            now = time.perf_counter()
            t_window.append((now, total))
            t_window = [w for w in t_window if now - w[0] < 10] or t_window[-1:]
            dt = t_window[-1][0] - t_window[0][0]
            self.throughput = (t_window[-1][1] - t_window[0][1]) / dt if dt > 0 else 0.0
            outcome = "success" if info["is_success"] else "collision" if info["collision"] else "timeout"
            self._record({"episode": ep, "total_steps": total, "reward": round(ret, 3), "length": length,
                          "outcome": outcome, "epsilon": round(eps, 4), "loss": None,
                          "throughput": round(self.throughput, 1)})
            self._preview_trail = []
            obs, _ = env.reset(options=opts)
            if ep % 500 == 0 or ep == self.target_episodes:
                stats, _ = evaluate_method(cfg, qlearning_method(agent), validation_seeds(cfg, 30))
                self._add_eval({"kind": "validation", "total_steps": total, "episodes": 30,
                                "success_rate": stats["success_rate"], "collision_rate": stats["collision_rate"],
                                "timeout_rate": stats["timeout_rate"]})
                save("last.pt", stats)
                score = (stats["success_rate"], -stats["collision_rate"])
                if best is None or score > best:
                    best = score
                    save("best.pt", stats)
                self.events.emit("info", "evaluation", f"Validation @ episode {ep}: success "
                                                       f"{stats['success_rate']:.0%}", experiment=self.experiment_id)
        save("last.pt")
        if not os.path.exists(os.path.join(run_dir, "best.pt")):
            save("best.pt")

    def _add_eval(self, ev):
        meta = self.store.get(self.experiment_id)
        self.store.update(self.experiment_id, evaluations=meta.get("evaluations", []) + [ev])

    # ------------------------------------------------------------ evaluation
    def evaluate(self, exp_id, checkpoint=None, episodes=50, recovery=True):
        meta = self.store.get(exp_id)
        if not meta["checkpoints"]:
            raise TrainingError("This experiment has no checkpoint yet")
        if self.evaluating:
            raise TrainingError("An evaluation is already running")
        if not 5 <= int(episodes) <= 500:
            raise TrainingError("episodes must be between 5 and 500")
        names = [c["name"] for c in meta["checkpoints"]]
        name = checkpoint or ("best.pt" if "best.pt" in names else names[-1])
        path = self.store.checkpoint_path(exp_id, name)
        self.evaluating = exp_id

        def run():
            try:
                if meta["algorithm"] == "dqn":
                    agent, cfg = load_dqn(path)
                    method = dqn_method(agent)
                    methods = [method] + ([with_recovery(method, cfg)] if recovery else [])
                else:
                    agent, cfg = load_qlearning(path)
                    methods = [qlearning_method(agent)]
                results = {}
                for m in methods:
                    stats, _ = evaluate_method(cfg, m, heldout_seeds(cfg, int(episodes)))
                    results[m.name] = {k: (None if isinstance(v, float) and math.isnan(v) else v)
                                       for k, v in stats.items()}
                ev = {"kind": "test", "checkpoint": name, "episodes": int(episodes), "time": time.time(),
                      "results": results}
                m = self.store.get(exp_id)
                self.store.update(exp_id, evaluations=m.get("evaluations", []) + [ev])
                self.last_eval = {"experiment_id": exp_id, **ev}
                main = next(iter(results.values()))
                self.events.emit("success", "evaluation",
                                 f"Evaluation completed on {episodes} unseen maps: success "
                                 f"{main['success_rate']:.0%}, collision {main['collision_rate']:.0%}",
                                 experiment=exp_id)
            except Exception as e:
                traceback.print_exc()
                self.events.emit("error", "evaluation", f"Evaluation failed: {e}")
            finally:
                self.evaluating = None

        threading.Thread(target=run, name="evaluation", daemon=True).start()
        self.events.emit("info", "evaluation", f"Evaluating {meta['name']} ({name}) on {episodes} unseen maps",
                         experiment=exp_id)
        return {"checkpoint": name}

    # ------------------------------------------------------------ state
    def summary(self):
        with self.lock:
            ep = self.episodes
            recent = ep[-50:]
            n = len(recent)
            return {
                "status": self.status, "experiment_id": self.experiment_id, "algorithm": self.algorithm,
                "episode": len(ep), "target_episodes": self.target_episodes, "total_steps": self.total_steps,
                "epsilon": self.epsilon, "loss": self.last_loss, "throughput": self.throughput,
                "elapsed": self._elapsed() if self.status in ("running", "paused") else self.elapsed_final(),
                "mean_reward": float(np.mean([e["reward"] for e in recent])) if n else None,
                "success_rate": sum(e["outcome"] == "success" for e in recent) / n if n else None,
                "collision_rate": sum(e["outcome"] == "collision" for e in recent) / n if n else None,
                "mean_length": float(np.mean([e["length"] for e in recent])) if n else None,
                "window": n, "evaluating": self.evaluating, "preview": self.preview,
                "curriculum": self.curriculum.state() if getattr(self, "curriculum", None) else None,
            }

    def elapsed_final(self):
        if not self.experiment_id:
            return 0.0
        try:
            return self.store.get(self.experiment_id).get("duration_s") or 0.0
        except KeyError:
            return 0.0

    def episodes_since(self, n):
        with self.lock:
            return self.episodes[n:]
