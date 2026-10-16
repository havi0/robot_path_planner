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


class SkidSteerModel(DiffDriveModel):
    """Four-wheel skid-steer approximation: unicycle kinematics in which only a fraction
    (`yaw_efficiency`) of the commanded yaw rate is achieved, because the wheels must
    scrub sideways to turn. A deliberately simple, documented model - not a tyre model."""

    def __init__(self, radius, linear_scale=1.0, angular_scale=1.0, noise_std=0.0, rng=None, yaw_efficiency=0.8):
        super().__init__(radius, linear_scale, angular_scale * yaw_efficiency, noise_std, rng)
        self.yaw_efficiency = yaw_efficiency


class HolonomicModel(DiffDriveModel):
    """Omnidirectional (mecanum) kinematics: body-frame velocity (v forward, vy left) and
    yaw rate w.  x' = v cos(th) - vy sin(th),  y' = v sin(th) + vy cos(th),  th' = w,
    integrated exactly for constant body velocities over the step."""

    def integrate(self, s, v_cmd, w_cmd, dt, vy_cmd=0.0):
        v = v_cmd * self.linear_scale
        vy = vy_cmd * self.linear_scale
        w = w_cmd * self.angular_scale
        if self.noise_std > 0 and self.rng is not None:
            v *= 1.0 + self.rng.normal(0, self.noise_std)
            vy *= 1.0 + self.rng.normal(0, self.noise_std)
            w = w * (1.0 + self.rng.normal(0, self.noise_std)) + self.rng.normal(0, self.noise_std * 0.2)
        c, sn = math.cos(s.theta), math.sin(s.theta)
        if abs(w) < 1e-6:
            x = s.x + (v * c - vy * sn) * dt
            y = s.y + (v * sn + vy * c) * dt
        else:
            th2 = s.theta + w * dt
            c2, s2 = math.cos(th2), math.sin(th2)
            x = s.x + (v * (s2 - sn) + vy * (c2 - c)) / w
            y = s.y + (v * (c - c2) + vy * (s2 - sn)) / w
        theta = (s.theta + w * dt + math.pi) % (2 * math.pi) - math.pi
        return RobotState(x, y, theta)


def make_motion_model(kind, radius, linear_scale=1.0, angular_scale=1.0, noise_std=0.0, rng=None, params=None):
    """Motion model for a robot profile's kinematics ("diff_drive" is the original model)."""
    params = params or {}
    if kind in (None, "diff_drive"):
        return DiffDriveModel(radius, linear_scale, angular_scale, noise_std, rng)
    if kind == "skid_steer":
        return SkidSteerModel(radius, linear_scale, angular_scale, noise_std, rng, float(params.get("yaw_efficiency", 0.8)))
    if kind == "holonomic":
        return HolonomicModel(radius, linear_scale, angular_scale, noise_std, rng)
    raise ValueError(f"unknown kinematics '{kind}'")


def twist_to_wheel_speeds(v, w, wheel_base, wheel_radius):
    """Body velocity -> (left, right) wheel angular speeds in rad/s."""
    return (v - w * wheel_base / 2) / wheel_radius, (v + w * wheel_base / 2) / wheel_radius


def wheel_speeds_to_twist(w_left, w_right, wheel_base, wheel_radius):
    vl, vr = w_left * wheel_radius, w_right * wheel_radius
    return (vl + vr) / 2, (vr - vl) / wheel_base
