"""Differential-drive (unicycle) kinematics with actuator imperfections."""
import math
from dataclasses import dataclass


@dataclass
class RobotState:
    x: float
    y: float
    theta: float


class DiffDriveModel:
    """x' = v cos(theta), y' = v sin(theta), theta' = w

    `linear_scale` / `angular_scale` model miscalibrated wheels (the real robot
    moves faster or slower than commanded); `noise_std` adds relative
    velocity noise every integration step (wheel slip, uneven floor).
    """

    def __init__(self, radius, linear_scale=1.0, angular_scale=1.0, noise_std=0.0, rng=None):
        self.radius = radius
        self.linear_scale = linear_scale
        self.angular_scale = angular_scale
        self.noise_std = noise_std
        self.rng = rng

    def integrate(self, s, v_cmd, w_cmd, dt):
        v = v_cmd * self.linear_scale
        w = w_cmd * self.angular_scale
        if self.noise_std > 0 and self.rng is not None:
            v *= 1.0 + self.rng.normal(0, self.noise_std)
            w = w * (1.0 + self.rng.normal(0, self.noise_std)) + self.rng.normal(0, self.noise_std * 0.2)
        if abs(w) < 1e-6:
            x = s.x + v * math.cos(s.theta) * dt
            y = s.y + v * math.sin(s.theta) * dt
        else:  # exact arc integration
            th2 = s.theta + w * dt
            x = s.x + v / w * (math.sin(th2) - math.sin(s.theta))
            y = s.y - v / w * (math.cos(th2) - math.cos(s.theta))
        theta = (s.theta + w * dt + math.pi) % (2 * math.pi) - math.pi
        return RobotState(x, y, theta)


def twist_to_wheel_speeds(v, w, wheel_base, wheel_radius):
    """Body velocity -> (left, right) wheel angular speeds in rad/s."""
    return (v - w * wheel_base / 2) / wheel_radius, (v + w * wheel_base / 2) / wheel_radius


def wheel_speeds_to_twist(w_left, w_right, wheel_base, wheel_radius):
    vl, vr = w_left * wheel_radius, w_right * wheel_radius
    return (vl + vr) / 2, (vr - vl) / wheel_base
