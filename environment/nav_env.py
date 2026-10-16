"""Gymnasium environment for training. It is a thin wrapper that adds episode
management and rewards around NavigationCore + SimulationBackend."""
import gymnasium as gym
import numpy as np
from gymnasium import spaces

from backends.simulation_backend import SimulationBackend
from navigation.actions import DiscreteActionSpace
from navigation.core import NavigationCore
from safety.safety_layer import SafetyLayer
from sensors.observation import observation_builder_from_config


class NavigationEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(self, cfg, mode="train", use_safety=False, backend=None):
        """mode='train': random maps from training seeds + domain randomisation.
        mode='eval': maps only from held-out seeds, no randomisation unless asked."""
        super().__init__()
        self.cfg = cfg
        self.mode = mode
        self.backend = backend or SimulationBackend(cfg)
        self.action_set = DiscreteActionSpace.from_config(cfg)
        self.obs_builder = observation_builder_from_config(cfg)
        self.safety = SafetyLayer(cfg.safety, cfg.robot.radius) if use_safety else None
        self.core = NavigationCore(self.backend, self.obs_builder, self.action_set,
                                   cfg.robot.control_dt, cfg.world.goal_radius, self.safety)
        self.observation_space = spaces.Box(-1.0, 1.0, shape=(self.obs_builder.dim,), dtype=np.float32)
        self.action_space = spaces.Discrete(self.action_set.n)
        self.stop_index = self.action_set.index_of("stop") if "stop" in self.action_set.names else None
        names = self.action_set.names
        self.turn_pair = {names.index("turn_left"), names.index("turn_right")} \
            if {"turn_left", "turn_right"} <= set(names) else set()
        self.last_action = None
        self.max_steps = cfg.training.max_episode_steps
        self.steps = 0
        self.prev_dist = 0.0

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        options = dict(options or {})
        offset = self.cfg.evaluation.heldout_seed_offset
        if "map_seed" not in options:
            lo, hi = (0, offset) if self.mode == "train" else (offset, 2 * offset)
            options["map_seed"] = int(self.np_random.integers(lo, hi))
        options.setdefault("randomize", self.mode == "train" and self.cfg.randomization.enabled)
        goal = self.backend.new_episode(**options)
        obs = self.core.begin(goal)
        self.steps = 0
        self.last_action = None
        self.prev_dist = self.core.distance_to_goal(self.core.last_pose)
        return obs, {"map_seed": options["map_seed"]}

    def step(self, action):
        rc = self.cfg.reward
        res = self.core.step(action)
        self.steps += 1

        # every reward component is computed and reported separately (info["reward_terms"])
        terms = {"time": rc.step, "progress": rc.progress_scale * (self.prev_dist - res.distance_to_goal),
                 "stop": 0.0, "dither": 0.0, "proximity": 0.0, "safety": 0.0, "goal": 0.0, "collision": 0.0}
        self.prev_dist = res.distance_to_goal
        if action == self.stop_index and not res.reached:
            terms["stop"] = rc.stop_penalty
        if {action, self.last_action} == self.turn_pair:     # left<->right dithering
            terms["dither"] = rc.get("turn_reversal_penalty", 0.0)
        self.last_action = action
        valid = res.reading.ranges[np.isfinite(res.reading.ranges)]
        if valid.size and valid.min() < rc.proximity_threshold:
            terms["proximity"] = rc.proximity_penalty
        if res.safety is not None and res.safety.intervened:
            terms["safety"] = rc.safety_intervention
        if res.reached:
            terms["goal"] = rc.goal
        if res.collided:
            terms["collision"] = rc.collision
        reward = sum(terms.values())

        terminated = res.reached or res.collided
        truncated = not terminated and self.steps >= self.max_steps
        info = {
            "is_success": res.reached,
            "collision": res.collided,
            "path_length": self.core.path_length,
            "distance_to_goal": res.distance_to_goal,
            "safety_intervened": bool(res.safety and res.safety.intervened),
            "safety_reasons": res.safety.reasons if res.safety else [],
            "reward_terms": terms,
            "collision_info": getattr(self.backend, "collision_info", None) if res.collided else None,
        }
        return res.observation, float(reward), terminated, truncated, info
