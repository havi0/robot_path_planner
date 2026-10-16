"""Data types shared by every backend (simulated or physical)."""
from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass
class Pose:
    x: float
    y: float
    theta: float          # heading, radians, CCW from +x
    timestamp: float = 0.0


@dataclass
class SensorReading:
    """One range scan already resampled to the training beam layout.

    ranges: distance (m) from the robot centre per beam. Invalid beams
            (no return, dropout, hardware glitch) are np.nan.
    angles: beam angles relative to the robot heading (radians).
    """
    ranges: np.ndarray
    angles: np.ndarray
    max_range: float
    timestamp: float
    # Optional DENSE scan used only by the safety layer (not the policy): many rays at fine
    # angular resolution, so obstacle corners between the 24 policy beams are not missed.
    # Simulation: sub-rays per beam; hardware: the raw LiDAR scan.
    safety_ranges: Optional[np.ndarray] = None
    safety_angles: Optional[np.ndarray] = None

    @property
    def valid_mask(self):
        return np.isfinite(self.ranges)

    @property
    def valid_fraction(self):
        return float(self.valid_mask.mean()) if len(self.ranges) else 0.0


def beam_angles(num_beams, fov_deg):
    """Beam layout used in both simulation and hardware (0 = straight ahead)."""
    fov = np.deg2rad(fov_deg)
    if fov_deg >= 360:
        return np.linspace(-np.pi, np.pi, num_beams, endpoint=False)
    return np.linspace(-fov / 2, fov / 2, num_beams)
