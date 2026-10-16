"""Observation builder shared by simulation and hardware.

Observation vector (float32), all values roughly in [-1, 1]:
    [0 : N]   normalised range per beam        (range / max_range)
    [N]       distance to goal                 (dist / max_goal_dist, clipped to 1)
    [N+1]     sin(goal bearing)                 bearing = goal direction relative to robot heading
    [N+2]     cos(goal bearing)
    [N+3]     last linear command              (v / max_linear)
    [N+4]     last angular command             (w / max_angular)

Everything is expressed in the robot's own frame, so the same policy can be
fed from a simulator or from real odometry + LiDAR.
"""
import math

import numpy as np

from sensors.processing import fill_invalid, wrap_angle


class ObservationBuilder:
    def __init__(self, num_beams, max_range, max_goal_dist, max_linear, max_angular):
        self.num_beams = num_beams
        self.max_range = max_range
        self.max_goal_dist = max_goal_dist
        self.max_linear = max_linear
        self.max_angular = max_angular

    @property
    def dim(self):
        return self.num_beams + 5

    def build(self, reading, pose, goal, last_cmd):
        if len(reading.ranges) != self.num_beams:
            raise ValueError(f"expected {self.num_beams} beams, got {len(reading.ranges)}")
        ranges = fill_invalid(reading.ranges, self.max_range) / self.max_range
        dx, dy = goal[0] - pose.x, goal[1] - pose.y
        dist = math.hypot(dx, dy)
        bearing = wrap_angle(math.atan2(dy, dx) - pose.theta)
        extra = [
            min(dist / self.max_goal_dist, 1.0),
            math.sin(bearing),
            math.cos(bearing),
            last_cmd.v / self.max_linear,
            last_cmd.w / self.max_angular,
        ]
        return np.concatenate([ranges, extra]).astype(np.float32)


def observation_builder_from_config(cfg):
    max_v = max(abs(a[0]) for a in cfg.actions.values()) or 1.0
    max_w = max(abs(a[1]) for a in cfg.actions.values()) or 1.0
    return ObservationBuilder(
        num_beams=cfg.sensor.num_beams,
        max_range=cfg.sensor.max_range,
        max_goal_dist=math.hypot(cfg.world.width, cfg.world.height),
        max_linear=max_v,
        max_angular=max_w,
    )
