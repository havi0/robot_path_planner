"""Tabular Q-learning training on the same environment and observations as DQN."""
import os
import shutil
import time

import torch

from agent.q_learning import QLearningAgent
from environment.nav_env import NavigationEnv
from evaluation.evaluate import evaluate_method, make_discretizer, qlearning_method, validation_seeds
from training.logger import CSVLogger, make_run_dir, plain, snapshot_config


def train_qlearning(cfg, run_dir=None, export_to="models/qlearning.pt", eval_every_episodes=500):
    run_dir = run_dir or make_run_dir("runs", "qlearning")
    os.makedirs(run_dir, exist_ok=True)
    snapshot_config(cfg, run_dir)
    env = NavigationEnv(cfg, mode="train", use_safety=cfg.training.use_safety_shield)
    agent = QLearningAgent(make_discretizer(cfg), env.action_space.n, cfg.qlearning, cfg.training.seed)
    ep_log = CSVLogger(os.path.join(run_dir, "episodes.csv"))
    eval_log = CSVLogger(os.path.join(run_dir, "evals.csv"))
    episodes = cfg.qlearning.episodes
    print(f"Training Q-learning for {episodes} episodes -> {run_dir}")

    def save(name, stats):
        torch.save({"q_table": torch.from_numpy(agent.Q), "config": plain(cfg), "eval": stats},
                   os.path.join(run_dir, name))

    best, total_steps, t0, recent = None, 0, time.perf_counter(), []
    obs, _ = env.reset(seed=cfg.training.seed)
    for ep in range(1, episodes + 1):
        eps = agent.epsilon(ep)
        ret, done, length = 0.0, False, 0
        while not done:
            a = agent.act(obs, eps)
            nxt, r, term, trunc, info = env.step(a)
            agent.update(obs, a, r, nxt, term)
            obs, ret, length = nxt, ret + r, length + 1
            done = term or trunc
        total_steps += length
        outcome = "success" if info["is_success"] else "collision" if info["collision"] else "timeout"
        ep_log.log({"episode": ep, "total_steps": total_steps, "return": round(ret, 3), "length": length,
                    "outcome": outcome, "epsilon": round(eps, 4),
                    "density": round(env.backend.episode_params["density"], 3)})
        recent.append(outcome)
        obs, _ = env.reset()
        if ep % cfg.training.log_every_episodes == 0:
            r50 = recent[-cfg.training.log_every_episodes:]
            print(f"ep {ep:>5}  eps {eps:.2f}  success {r50.count('success') / len(r50):.2f}  "
                  f"collision {r50.count('collision') / len(r50):.2f}  [{time.perf_counter() - t0:.0f}s]", flush=True)
        if ep % eval_every_episodes == 0 or ep == episodes:
            stats, _ = evaluate_method(cfg, qlearning_method(agent), validation_seeds(cfg, cfg.training.eval_episodes))
            eval_log.log({"episode": ep, "total_steps": total_steps, **{k: round(v, 4) for k, v in stats.items()}})
            print(f"  [eval @ ep {ep}] validation success {stats['success_rate']:.2f} "
                  f"collision {stats['collision_rate']:.2f}", flush=True)
            save("last.pt", stats)
            score = (stats["success_rate"], -stats["collision_rate"])
            if best is None or score > best:
                best = score
                save("best.pt", stats)
    ep_log.close()
    eval_log.close()
    if export_to:
        os.makedirs(os.path.dirname(export_to), exist_ok=True)
        shutil.copy(os.path.join(run_dir, "best.pt"), export_to)
        print(f"Best Q-table copied to {export_to}")
    return run_dir
