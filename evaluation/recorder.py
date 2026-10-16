"""Episode recording, deterministic re-simulation and counterfactual branching.

A recorded episode stores the initial world, every condition that influences
the simulation (seed, noise, action speeds, shield), the policy and the model
id, and full per-step telemetry. Because the simulator and the (greedy)
policies are deterministic given these inputs, the state at any step can be
restored EXACTLY by re-simulating the recorded prefix. Exactness is verified
step by step against the recording; if anything diverges the result is marked
as an approximate re-run instead.
"""
import copy
import hashlib
import json
import math
import time
import uuid

import numpy as np

from baselines.grid_planners import astar, dijkstra
from environment.nav_env import NavigationEnv
from evaluation.behavior import profile_episode
from evaluation.evaluate import plan_with_fallback
from navigation.policies import DQNPolicy, PathFollowerPolicy, QTablePolicy, RecoveryWrapper
from scenarios.io import world_from_dict, world_to_dict
from sensors.observation import observation_builder_from_config
from sensors.types import beam_angles

POLICY_NAMES = {"dqn_recovery": "DQN + recovery", "dqn": "DQN", "qlearning": "Q-learning",
                "astar": "A*", "dijkstra": "Dijkstra"}
LEARNED = {"dqn", "dqn_recovery", "qlearning"}


def world_hash(world_dict):
    return hashlib.sha1(json.dumps(world_dict, sort_keys=True).encode()).hexdigest()[:12]


def build_policy(key, cfg, agent=None, agent_cfg=None):
    """Returns (policy, planner_or_None). Learned policies need `agent`."""
    from navigation.actions import DiscreteActionSpace
    acts = DiscreteActionSpace.from_config(cfg)
    if key in ("dqn", "dqn_recovery"):
        pol = DQNPolicy(agent)
        if key == "dqn_recovery":
            pol = RecoveryWrapper(pol, acts, beam_angles(cfg.sensor.num_beams, cfg.sensor.fov_deg), cfg.sensor.max_range)
        return pol, None
    if key == "qlearning":
        return QTablePolicy(agent), None
    if key in ("astar", "dijkstra"):
        return PathFollowerPolicy(acts, POLICY_NAMES[key]), (astar if key == "astar" else dijkstra)
    raise ValueError(f"unknown policy {key}")


def episode_cfg(base_cfg, world, conditions):
    cfg = copy.deepcopy(base_cfg)
    cfg.world.width, cfg.world.height = float(world.width), float(world.height)
    if conditions.get("max_linear"):
        cfg.actions.forward = [float(conditions["max_linear"]), 0.0]
    if conditions.get("max_angular"):
        w = float(conditions["max_angular"])
        cfg.actions.turn_left, cfg.actions.turn_right = [0.0, w], [0.0, -w]
    return cfg


class Runner:
    """Runs one episode step by step; shared by recording and counterfactual branches."""

    def __init__(self, base_cfg, world_dict, policy_key, conditions, seed, agent=None, agent_cfg=None):
        world = world_from_dict(world_dict)
        self.cfg = episode_cfg(base_cfg, world, conditions)
        self.policy_key = policy_key
        self.env = NavigationEnv(self.cfg, mode="eval", use_safety=True)
        if agent_cfg is not None:                      # observation normalisation from training
            b = observation_builder_from_config(agent_cfg)
            self.env.obs_builder = b
            self.env.core.obs_builder = b
        if agent is not None and hasattr(agent, "rng"):
            agent.rng = np.random.default_rng(seed)    # Q-table tie-breaking deterministic per episode
        self.policy, planner = build_policy(policy_key, self.cfg, agent, agent_cfg)
        self.obs, _ = self.env.reset(options={"map_seed": int(seed), "world": world,
                                              "sensor_noise": conditions.get("sensor_noise", 0.0),
                                              "dropout": conditions.get("dropout", 0.0),
                                              "motion_noise": conditions.get("motion_noise", 0.0)})
        self.set_shield(conditions.get("shield", False))
        ctx = {}
        self.planned = []
        if planner is not None:
            plan = plan_with_fallback(self.cfg, planner, self.env.backend.world, self.env.core.goal)
            ctx = {"path": plan.path}
            self.planned = plan.path
        self.policy.reset(**ctx)
        ref = plan_with_fallback(self.cfg, astar, self.env.backend.world, self.env.core.goal)
        self.reference_length = max(ref.length - self.cfg.world.goal_radius, 1e-6) if ref.path else None
        self.done = False
        self.outcome = None
        self.steps = {k: [] for k in ("x", "y", "theta", "dist", "min_range", "action", "reward", "v", "w", "safety")}
        self.reward_terms = {}
        self.interventions = 0
        self.collision_info = None
        self._prev_reading = self.env.core.last_reading
        self._log_state()

    def set_shield(self, on):
        self.env.core.safety = self.env.safety if on else None

    def _log_state(self):
        p = self.env.core.last_pose
        r = self.env.core.last_reading.ranges
        valid = r[np.isfinite(r)]
        self.steps["x"].append(round(float(p.x), 6))
        self.steps["y"].append(round(float(p.y), 6))
        self.steps["theta"].append(round(float(p.theta), 6))
        self.steps["dist"].append(round(float(self.env.core.distance_to_goal(p)), 6))
        self.steps["min_range"].append(round(float(valid.min()), 5) if valid.size else None)

    def policy_action(self):
        core = self.env.core
        return self.policy.act(self.obs, core.last_pose, core.goal)

    def step(self, action=None):
        """Apply `action` (index) or the policy's choice. Returns the action index used."""
        if action is None:
            action = self.policy_action()
        pre_pose, pre_reading = self.env.core.last_pose, self.env.core.last_reading
        self.obs, r, term, trunc, info = self.env.step(action)
        for k, v in info["reward_terms"].items():
            self.reward_terms[k] = round(self.reward_terms.get(k, 0.0) + float(v), 5)
        if info["safety_intervened"]:
            self.interventions += 1
        if info.get("collision_info"):
            self.collision_info = classify_collision(info["collision_info"], pre_pose, pre_reading,
                                                     self.env.action_set.names[action], self.cfg.robot.radius)
        ex = self.env.core.last_cmd
        self.steps["action"].append(self.env.action_set.names[action])
        self.steps["reward"].append(round(float(r), 5))
        self.steps["v"].append(round(float(ex.v), 4))
        self.steps["w"].append(round(float(ex.w), 4))
        self.steps["safety"].append(info["safety_reasons"])
        self._log_state()
        if term or trunc:
            self.done = True
            self.outcome = "success" if info["is_success"] else "collision" if info["collision"] else "timeout"
        return action

    def observation_detail(self):
        b = self.env.obs_builder
        o = self.obs
        nb = b.num_beams
        return {"ranges_norm": [round(float(v), 4) for v in o[:nb]], "goal_dist_norm": round(float(o[nb]), 4),
                "goal_bearing_deg": round(math.degrees(math.atan2(float(o[nb + 1]), float(o[nb + 2]))), 2),
                "last_v_norm": round(float(o[nb + 3]), 3), "last_w_norm": round(float(o[nb + 4]), 3),
                "beam_angles_deg": [round(math.degrees(a), 1) for a in self.env.core.last_reading.angles]}

    def result(self):
        rewards = self.steps["reward"]
        xs, ys = self.steps["x"], self.steps["y"]
        path_len = float(sum(math.hypot(xs[i + 1] - xs[i], ys[i + 1] - ys[i]) for i in range(len(xs) - 1)))
        return {"outcome": self.outcome or "incomplete", "steps_taken": len(rewards), "reward": round(float(sum(rewards)), 4),
                "path_length": round(path_len, 4), "reference_length": self.reference_length,
                "path_ratio": round(path_len / self.reference_length, 4) if (self.outcome == "success" and self.reference_length) else None,
                "collisions": int(self.outcome == "collision"),
                "reward_terms": dict(getattr(self, "reward_terms", {})),
                "safety_interventions": int(getattr(self, "interventions", 0)),
                "collision": getattr(self, "collision_info", None)}


def classify_collision(info, pose, reading, action, radius):
    """Explain a simulator-detected collision: what was hit, where relative to the heading,
    and whether the range sensor had measured that obstacle on the step before contact."""
    bearing = math.degrees((math.atan2(info["y"] - pose.y, info["x"] - pose.x) - pose.theta + math.pi) % (2 * math.pi) - math.pi)
    dist = math.hypot(info["x"] - pose.x, info["y"] - pose.y)
    ang = np.degrees(reading.angles)
    near = np.abs((ang - bearing + 180) % 360 - 180) <= 10
    seen = bool(np.any(np.isfinite(reading.ranges[near]) & (reading.ranges[near] < dist + radius + 0.1)))
    if info["kind"] == "moving_obstacle":
        cause = "hit by / drove into a moving obstacle"
    elif info["kind"] == "boundary":
        cause = "drove into the arena wall"
    elif abs(bearing) <= 35:
        cause = "drove into an obstacle ahead"
    else:
        cause = "clipped an obstacle beside the robot"
    if info["kind"] != "moving_obstacle" and not seen:
        cause += " (not measured by any beam: between-beam gap)"
    return {"kind": info["kind"], "cause": cause, "bearing_deg": round(bearing, 1), "sensed_before": seen,
            "last_action": action, "x": round(info["x"], 4), "y": round(info["y"], 4)}


def make_episode(runner, *, source, world_dict, policy_key, conditions, seed, model=None, scenario=None,
                 run_id=None, parent=None, restoration=None, label=None):
    res = runner.result()
    beh = profile_episode(runner.steps, res["outcome"], res["reference_length"], runner.cfg.robot.radius)
    mr = [v for v in runner.steps["min_range"] if v is not None]
    res["min_clearance"] = round(min(mr) - runner.cfg.robot.radius, 4) if mr else None
    return {
        "id": f"ep-{time.strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6]}",
        "created": time.time(), "source": source, "label": label,
        "policy": policy_key, "policy_name": POLICY_NAMES[policy_key],
        "model": model, "scenario": scenario, "run_id": run_id, "parent": parent, "restoration": restoration,
        "seed": int(seed), "conditions": conditions, "world": world_dict, "world_hash": world_hash(world_dict),
        "control_dt": runner.cfg.robot.control_dt, "robot_radius": runner.cfg.robot.radius,
        "goal_radius": runner.cfg.world.goal_radius, "max_steps": runner.cfg.training.max_episode_steps,
        "planned_path": [[round(x, 4), round(y, 4)] for x, y in runner.planned],
        "steps": runner.steps, "metrics": res, "outcome": res["outcome"], "behavior": beh,
    }


def record_episode(base_cfg, world_dict, policy_key, conditions, seed, agent=None, agent_cfg=None, **meta):
    runner = Runner(base_cfg, world_dict, policy_key, conditions, seed, agent, agent_cfg)
    while not runner.done:
        runner.step()
    return make_episode(runner, world_dict=world_dict, policy_key=policy_key, conditions=conditions, seed=seed, **meta)


def resimulate_to(base_cfg, episode, k, agent=None, agent_cfg=None):
    """Rebuild the episode and re-simulate its first k actions. Returns (runner, restoration)."""
    runner = Runner(base_cfg, episode["world"], episode["policy"], episode["conditions"], episode["seed"], agent, agent_cfg)
    rec = episode["steps"]
    names = runner.env.action_set.names
    mismatches, max_dev = 0, 0.0
    for i in range(k):
        chosen = runner.policy_action()
        recorded = names.index(rec["action"][i])
        if chosen != recorded:
            mismatches += 1
        if episode["conditions"].get("shield_toggles"):
            for t in episode["conditions"]["shield_toggles"]:
                if t["step"] == i:
                    runner.set_shield(t["enabled"])
        runner.step(recorded)                    # always follow the recorded action sequence
        dev = math.hypot(runner.steps["x"][-1] - rec["x"][i + 1], runner.steps["y"][-1] - rec["y"][i + 1])
        max_dev = max(max_dev, dev)
        if runner.done:
            break
    exact = mismatches == 0 and max_dev < 1e-4
    return runner, {"method": "deterministic re-simulation", "exact": exact, "branch_step": k,
                    "prefix_action_mismatches": mismatches, "max_prefix_deviation_m": round(max_dev, 8),
                    "note": "State at the branch step reproduced exactly." if exact else
                    "Re-simulation diverged from the recording - this is an APPROXIMATE re-run, not an exact counterfactual."}


MODIFICATIONS = {"action", "shield", "add_obstacle", "remove_obstacle", "sensor_noise", "goal"}


def run_counterfactual(base_cfg, episode, k, modification, agent=None, agent_cfg=None):
    if modification.get("type") not in MODIFICATIONS:
        raise ValueError(f"modification type must be one of {sorted(MODIFICATIONS)}")
    n = len(episode["steps"]["action"])
    if not 0 <= k < max(n, 1):
        raise ValueError(f"branch step must be between 0 and {n - 1}")
    runner, restoration = resimulate_to(base_cfg, episode, k, agent, agent_cfg)
    if runner.done:
        raise ValueError("episode already ended before the branch step")
    t = modification["type"]
    world = runner.env.backend.world
    first_action = None
    if t == "action":
        first_action = runner.env.action_set.index_of(modification["action"])
    elif t == "shield":
        runner.set_shield(bool(modification["enabled"]))
    elif t == "add_obstacle":
        x0, y0, x1, y1 = modification["rect"]
        rect = [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]
        p = runner.env.core.last_pose
        if rect[0] - 0.15 <= p.x <= rect[2] + 0.15 and rect[1] - 0.15 <= p.y <= rect[3] + 0.15:
            raise ValueError("obstacle would overlap the robot at the branch step")
        world.rects = np.vstack([world.static_rects, [rect]])
    elif t == "remove_obstacle":
        x, y = modification["x"], modification["y"]
        hit = [i for i, (a, b, c, d) in enumerate(world.static_rects) if a <= x <= c and b <= y <= d]
        if not hit:
            raise ValueError("no static obstacle at that point")
        world.rects = np.delete(world.static_rects, hit[-1], axis=0)
    elif t == "sensor_noise":
        runner.env.backend.sensor.noise_std = float(modification["std"])
    elif t == "goal":
        gx, gy = modification["x"], modification["y"]
        if world.collides(gx, gy, runner.cfg.robot.radius + 0.05, include_movers=False):
            raise ValueError("goal must be in free space")
        world.goal = (gx, gy)
        runner.env.core.goal = (gx, gy)
        runner.env.prev_dist = runner.env.core.distance_to_goal(runner.env.core.last_pose)
    if first_action is not None:
        runner.step(first_action)
    while not runner.done:
        runner.step()
    return runner, restoration
