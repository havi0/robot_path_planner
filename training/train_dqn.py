"""DQN training loop with periodic evaluation on held-out maps and checkpointing.

DQNTrainer.step() advances exactly one environment step, so the same trainer
drives both the headless CLI and the live Pygame training view.
"""
import os
import shutil
import time

import torch

from agent.dqn import DQNAgent
from environment.nav_env import NavigationEnv
from evaluation.evaluate import dqn_method, evaluate_method, validation_seeds
from training.logger import CSVLogger, make_run_dir, plain, snapshot_config


class DQNTrainer:
    def __init__(self, cfg, run_dir=None, seed=None, quiet=False):
        self.cfg = cfg
        self.seed = cfg.training.seed if seed is None else seed
        torch.set_num_threads(cfg.training.torch_threads)
        self.run_dir = run_dir or make_run_dir("runs", "dqn")
        os.makedirs(self.run_dir, exist_ok=True)
        snapshot_config(cfg, self.run_dir)
        self.env = NavigationEnv(cfg, mode="train", use_safety=cfg.training.use_safety_shield)
        self.agent = DQNAgent(self.env.observation_space.shape[0], self.env.action_space.n, cfg.dqn, self.seed)
        self.obs, _ = self.env.reset(seed=self.seed)
        self.reset_options = None      # dict, or callable returning one per episode (curriculum)
        self.quiet = quiet
        self.total_steps = 0
        self.episode = 0
        self.ep_return = 0.0
        self.ep_len = 0
        self.last_loss = float("nan")
        self.history = []              # one dict per finished episode
        self.eval_history = []
        self.best_score = None
        self.ep_log = CSVLogger(os.path.join(self.run_dir, "episodes.csv"))
        self.eval_log = CSVLogger(os.path.join(self.run_dir, "evals.csv"))
        self.t0 = time.perf_counter()

    @property
    def epsilon(self):
        return self.agent.epsilon(self.total_steps)

    def step(self):
        """One environment step + learning update. Returns the episode summary
        dict when an episode finished during this step, else None."""
        c = self.cfg.dqn
        action = self.agent.act(self.obs, self.epsilon)
        nxt, reward, term, trunc, info = self.env.step(action)
        self.agent.buffer.add(self.obs, action, reward, nxt, term)
        self.total_steps += 1
        if self.total_steps >= c.learning_starts and self.total_steps % c.train_freq == 0:
            self.last_loss = self.agent.update()
        self.ep_return += reward
        self.ep_len += 1
        self.obs = nxt
        self.last_info = info

        summary = None
        if term or trunc:
            self.episode += 1
            outcome = "success" if info["is_success"] else "collision" if info["collision"] else "timeout"
            summary = {
                "episode": self.episode, "total_steps": self.total_steps, "return": round(self.ep_return, 3),
                "length": self.ep_len, "outcome": outcome, "epsilon": round(self.epsilon, 4),
                "loss": round(self.last_loss, 5), "density": round(self.env.backend.episode_params["density"], 3),
            }
            self.history.append(summary)
            self.ep_log.log(summary)
            self.ep_return, self.ep_len = 0.0, 0
            opts = self.reset_options() if callable(self.reset_options) else self.reset_options
            self.obs, _ = self.env.reset(options=opts)
            if not self.quiet and self.episode % self.cfg.training.log_every_episodes == 0:
                self._print_progress()

        if self.total_steps % self.cfg.training.eval_every == 0:
            self.evaluate()
        return summary

    def _print_progress(self):
        recent = self.history[-self.cfg.training.log_every_episodes:]
        sr = sum(h["outcome"] == "success" for h in recent) / len(recent)
        cr = sum(h["outcome"] == "collision" for h in recent) / len(recent)
        ret = sum(h["return"] for h in recent) / len(recent)
        print(f"step {self.total_steps:>7}  ep {self.episode:>5}  eps {self.epsilon:.2f}  "
              f"return {ret:7.2f}  success {sr:.2f}  collision {cr:.2f}  "
              f"loss {self.last_loss:.4f}  [{time.perf_counter() - self.t0:.0f}s]", flush=True)

    def evaluate(self):
        self.agent.q.eval()
        n = self.cfg.training.eval_episodes
        stats, _ = evaluate_method(self.cfg, dqn_method(self.agent), validation_seeds(self.cfg, n))
        self.agent.q.train()
        row = {"total_steps": self.total_steps, "episode": self.episode,
               **{k: round(v, 4) for k, v in stats.items()}}
        self.eval_history.append(row)
        self.eval_log.log(row)
        self.save("last.pt", stats)
        score = (stats["success_rate"], -stats["collision_rate"])
        if self.best_score is None or score > self.best_score:
            self.best_score = score
            self.save("best.pt", stats)
        if not self.quiet:
            print(f"  [eval @ {self.total_steps}] validation success {stats['success_rate']:.2f} "
                  f"collision {stats['collision_rate']:.2f} timeout {stats['timeout_rate']:.2f}"
                  f"{'  * new best' if score == self.best_score else ''}", flush=True)
        return stats

    def save(self, name, stats=None):
        torch.save({"agent": self.agent.state_dict(), "config": plain(self.cfg),
                    "total_steps": self.total_steps, "episode": self.episode,
                    "eval": stats or {}}, os.path.join(self.run_dir, name))

    def train(self, total_steps=None):
        total_steps = total_steps or self.cfg.training.total_steps
        while self.total_steps < total_steps:
            self.step()
        if self.total_steps % self.cfg.training.eval_every != 0:
            self.evaluate()
        self.ep_log.close()
        self.eval_log.close()
        return os.path.join(self.run_dir, "best.pt")


def train_dqn(cfg, run_dir=None, export_to="models/dqn.pt"):
    trainer = DQNTrainer(cfg, run_dir)
    print(f"Training DQN for {cfg.training.total_steps} steps -> {trainer.run_dir}")
    best = trainer.train()
    if export_to:
        os.makedirs(os.path.dirname(export_to), exist_ok=True)
        shutil.copy(best, export_to)
        print(f"Best checkpoint copied to {export_to}")
    return trainer
