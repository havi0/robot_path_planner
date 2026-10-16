"""Per-episode metrics and aggregation."""
import math
from dataclasses import asdict, dataclass

import numpy as np


@dataclass
class EpisodeMetrics:
    method: str
    map_seed: int
    density: float
    sensor_noise: float
    motion_noise: float
    outcome: str               # success | collision | timeout | no_path | aborted
    steps: int
    path_length: float         # metres actually driven
    reference_length: float    # A* shortest path on the known map (for path-efficiency ratio)
    inference_ms: float        # mean per-step policy decision time
    planning_ms: float         # one-off global planning time (classical planners)
    nodes_expanded: int
    safety_interventions: int

    def row(self):
        return asdict(self)


def wilson_interval(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def aggregate(episodes):
    n = len(episodes)
    if n == 0:
        return {}
    succ = [e for e in episodes if e.outcome == "success"]
    count = lambda o: sum(e.outcome == o for e in episodes)
    lo, hi = wilson_interval(len(succ), n)
    ratios = [e.path_length / e.reference_length for e in succ
              if math.isfinite(e.reference_length) and e.reference_length > 0]
    mean = lambda xs: float(np.mean(xs)) if len(xs) else float("nan")
    return {
        "episodes": n,
        "success_rate": len(succ) / n,
        "success_ci_low": lo,
        "success_ci_high": hi,
        "collision_rate": count("collision") / n,
        "timeout_rate": count("timeout") / n,
        "no_path_rate": count("no_path") / n,
        "mean_steps_success": mean([e.steps for e in succ]),
        "mean_path_length_success": mean([e.path_length for e in succ]),
        "mean_path_ratio_success": mean(ratios),
        "mean_inference_ms": mean([e.inference_ms for e in episodes]),
        "mean_planning_ms": mean([e.planning_ms for e in episodes]),
        "mean_nodes_expanded": mean([e.nodes_expanded for e in episodes]),
        "interventions_per_episode": mean([e.safety_interventions for e in episodes]),
    }
