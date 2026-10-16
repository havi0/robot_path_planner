"""Curriculum: training scenarios get harder only when the agent meets a
configurable, measured criterion.

Levels are bands of GEOMETRIC difficulty (see scenarios/analyzer.py). Promotion
rule: at the current level, after at least `min_episodes` episodes, the success
rate over the last `window` episodes must reach `threshold`. All training
scenarios use seeds < 1,000,000 (never evaluation seeds).
"""
import copy

import numpy as np

from scenarios.generator import SCENARIO_TYPES, TRAIN_SEED_LIMIT, generate_scenario
from scenarios.io import world_to_dict

DEFAULT_EDGES = [0, 20, 32, 45, 101]


class Curriculum:
    def __init__(self, types, threshold=0.6, window=50, min_episodes=50, edges=None, pool_size=10, seed=0,
                 robot_radius=0.15, events=None):
        self.types = [t for t in (types or list(SCENARIO_TYPES)) if t in SCENARIO_TYPES]
        if not self.types:
            raise ValueError("curriculum needs at least one scenario type")
        if not 0 < threshold <= 1 or window < 5 or min_episodes < window:
            raise ValueError("invalid curriculum criteria (0 < threshold <= 1, window >= 5, min_episodes >= window)")
        self.edges = list(edges or DEFAULT_EDGES)
        self.threshold, self.window, self.min_episodes = threshold, window, min_episodes
        self.pool_size, self.robot_radius, self.events = pool_size, robot_radius, events
        self.rng = np.random.default_rng(seed)
        self.level = 0
        self.outcomes = []          # outcomes at the current level
        self.history = []           # promotion records
        self.pools = {}
        self._next_seed = int(self.rng.integers(0, TRAIN_SEED_LIMIT // 2))

    @property
    def n_levels(self):
        return len(self.edges) - 1

    def _build_pool(self, level):
        lo, hi = self.edges[level], self.edges[level + 1]
        pool, tries = [], 0
        while len(pool) < self.pool_size and tries < 250:
            tries += 1
            kind = self.types[int(self.rng.integers(len(self.types)))]
            self._next_seed = (self._next_seed + 7919) % TRAIN_SEED_LIMIT
            try:
                world, analysis, _ = generate_scenario(kind, self._next_seed, self.robot_radius)
            except RuntimeError:
                continue
            score = analysis["difficulty"]["score"]
            if score is not None and lo <= score < hi:
                pool.append({"type": kind, "score": score, "seed": self._next_seed, "world": world})
        self.pools[level] = pool
        return pool

    def next_world(self):
        """World for the next episode (a fresh copy, since episodes mutate worlds)."""
        level = self.level
        pool = self.pools.get(level) or self._build_pool(level)
        while not pool and level > 0:          # no scenario of the selected types falls in this band
            level -= 1
            pool = self.pools.get(level) or self._build_pool(level)
        if not pool:
            return None
        return copy.deepcopy(pool[int(self.rng.integers(len(pool)))]["world"])

    def record(self, outcome, episode):
        self.outcomes.append(outcome == "success")
        recent = self.outcomes[-self.window:]
        rate = sum(recent) / len(recent)
        if (len(self.outcomes) >= self.min_episodes and len(recent) >= self.window and rate >= self.threshold
                and self.level < self.n_levels - 1):
            self.history.append({"episode": episode, "from": self.level, "to": self.level + 1, "success": rate,
                                 "episodes_at_level": len(self.outcomes)})
            self.level += 1
            self.outcomes = []
            if self.events:
                self.events.emit("success", "curriculum", f"Curriculum promoted to level {self.level + 1}/{self.n_levels} "
                                                          f"(difficulty {self.edges[self.level]}-{self.edges[self.level + 1]}) "
                                                          f"after {rate:.0%} success over {self.window} episodes")
            return True
        return False

    def state(self):
        recent = self.outcomes[-self.window:]
        return {"level": self.level, "n_levels": self.n_levels, "band": [self.edges[self.level], self.edges[self.level + 1]],
                "edges": self.edges, "episodes_at_level": len(self.outcomes),
                "rolling_success": (sum(recent) / len(recent)) if recent else None, "threshold": self.threshold,
                "window": self.window, "min_episodes": self.min_episodes, "types": self.types, "history": self.history,
                "pool_sizes": {k: len(v) for k, v in self.pools.items()},
                "criterion": f"promote when success over the last {self.window} episodes >= {self.threshold:.0%} "
                             f"(after >= {self.min_episodes} episodes at the level)"}

    @staticmethod
    def world_dict(world):
        return world_to_dict(world)
