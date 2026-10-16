"""Simulated 2D range sensor (LiDAR-like ring of beams)."""
import numpy as np

from environment.geometry import raycast
from sensors.types import SensorReading, beam_angles


SAFETY_SUBRAYS = 7     # dense rays per policy beam for the safety layer (~2.1 deg spacing at 24 beams)


class SimulatedRangeSensor:
    def __init__(self, num_beams, fov_deg, max_range, noise_std=0.0, dropout_prob=0.0):
        self.angles = beam_angles(num_beams, fov_deg)
        spacing = (2 * np.pi / num_beams) if fov_deg >= 360 else np.deg2rad(fov_deg) / max(1, num_beams - 1)
        offs = (np.arange(SAFETY_SUBRAYS) - (SAFETY_SUBRAYS - 1) / 2) * spacing / SAFETY_SUBRAYS
        self.safety_angles = (self.angles[:, None] + offs[None, :]).ravel()
        self.max_range = max_range
        self.noise_std = noise_std
        self.dropout_prob = dropout_prob

    def scan(self, world, x, y, theta, timestamp, rng=None):
        ranges = raycast(x, y, self.angles + theta, world.rects, world.mover_circles,
                         world.width, world.height, self.max_range)
        if rng is not None and self.noise_std > 0:
            ranges = ranges + rng.normal(0, self.noise_std, size=ranges.shape)
        ranges = np.clip(ranges, 0.0, self.max_range)
        if rng is not None and self.dropout_prob > 0:
            ranges[rng.random(ranges.shape) < self.dropout_prob] = np.nan
        # dense safety scan: deterministic (does not touch the RNG, so recordings replay exactly).
        # No extra noise offset here: the safety layer's lateral_margin is the noise budget
        # (a 3-sigma offset on top of it was measured to block corridor driving: A* 96% -> 26%).
        dense = raycast(x, y, self.safety_angles + theta, world.rects, world.mover_circles,
                        world.width, world.height, self.max_range)
        return SensorReading(ranges, self.angles.copy(), self.max_range, timestamp,
                             safety_ranges=dense, safety_angles=self.safety_angles.copy())
