"""Algorithm comparison: run several navigation methods on the SAME map and
start/goal, then optionally repeat over many unseen maps for success rates."""
import copy
import time

import numpy as np

from backends.simulation_backend import SimulationBackend
from evaluation.evaluate import (dqn_method, evaluate_method, heldout_seeds, planner_methods, qlearning_method,
                                 run_episode, with_recovery)

ALGORITHMS = {"dqn_recovery": "DQN + recovery", "dqn": "DQN", "qlearning": "Q-learning",
              "astar": "A*", "dijkstra": "Dijkstra"}
KNOWN_MAP = {"astar", "dijkstra"}


class PlannerError(ValueError):
    pass


def _method(key, cfg, models):
    if key in ("dqn", "dqn_recovery"):
        entry = models.get("dqn")
        if not entry:
            raise PlannerError("No DQN model loaded")
        m = dqn_method(entry[0])
        return (with_recovery(m, entry[1]) if key == "dqn_recovery" else m), entry[1]
    if key == "qlearning":
        entry = models.get("qlearning")
        if not entry:
            raise PlannerError("No Q-learning model loaded")
        return qlearning_method(entry[0]), entry[1]
    if key in ("astar", "dijkstra"):
        return {m.name: m for m in planner_methods(cfg)}["A*" if key == "astar" else "Dijkstra"], None
    raise PlannerError(f"unknown algorithm {key}")


def compare(sim, models, algorithms, source="current", seed=None, density=None, trials=0):
    if not algorithms:
        raise PlannerError("Select at least one algorithm")
    if not 0 <= int(trials) <= 200:
        raise PlannerError("trials must be between 0 and 200")
    with sim.lock:
        cfg = copy.deepcopy(sim.cfg)
        if source == "current":
            world = copy.deepcopy(sim.base_world)
            map_seed = int(sim.config["seed"])
        else:
            map_seed = int(seed if seed is not None else cfg.evaluation.heldout_seed_offset)
            if density is not None:
                if not 0 <= float(density) <= 0.35:
                    raise PlannerError("density must be between 0 and 0.35")
                cfg.world.obstacle_density = float(density)
            world = None

    results, map_info = [], None
    for key in algorithms:
        method, obs_cfg = _method(key, cfg, models)
        backend = SimulationBackend(cfg)
        traj = []
        t0 = time.perf_counter()
        ep = run_episode(cfg, method, map_seed, backend=backend, world=copy.deepcopy(world) if world else None,
                         obs_cfg=obs_cfg, on_step=lambda r, t=traj: t.append([round(r.pose.x, 4), round(r.pose.y, 4)]))
        wall_ms = (time.perf_counter() - t0) * 1000
        w = backend.world
        if map_info is None:
            map_info = {"width": w.width, "height": w.height, "rects": w.rects.round(4).tolist(),
                        "start": list(w.start), "goal": list(w.goal), "goal_radius": cfg.world.goal_radius,
                        "robot_radius": cfg.robot.radius, "movers": [], "mover_radius": w.mover_radius}
        plan = getattr(method.policy, "path", None)
        results.append({
            "key": key, "name": ALGORITHMS[key], "uses_known_map": key in KNOWN_MAP,
            "outcome": ep.outcome, "success": ep.outcome == "success", "path_length": ep.path_length,
            "actions": ep.steps, "collisions": int(ep.outcome == "collision"),
            "planning_ms": ep.planning_ms, "nodes_expanded": ep.nodes_expanded,
            "inference_ms_per_step": ep.inference_ms, "wall_ms": wall_ms,
            "reference_length": ep.reference_length,
            "path_ratio": ep.path_length / ep.reference_length if ep.outcome == "success" else None,
            "trajectory": [list(w.start[:2])] + traj,
            "planned_path": [[round(x, 4), round(y, 4)] for x, y in plan[::4]] if plan else [],
        })

    trial_stats = None
    if int(trials) > 0:
        trial_stats = {}
        tcfg = copy.deepcopy(cfg)
        seeds = heldout_seeds(tcfg, int(trials))
        for key in algorithms:
            method, obs_cfg = _method(key, tcfg, models)
            stats, _ = evaluate_method(tcfg, method, seeds, obs_cfg=obs_cfg)
            trial_stats[key] = {k: (None if isinstance(v, float) and np.isnan(v) else v) for k, v in stats.items()}
        trial_stats["_info"] = {"trials": int(trials), "density": tcfg.world.obstacle_density,
                                "seeds": [seeds[0], seeds[-1]]}
    return {"map": map_info, "map_seed": map_seed, "source": source, "results": results, "trials": trial_stats}
