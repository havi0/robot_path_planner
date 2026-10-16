"""Backend that drives the virtual differential-drive robot."""
import math

import numpy as np

from backends.base import RobotBackend
from environment.robot import RobotState, make_motion_model
from environment.world import generate_world
from navigation.actions import STOP
from sensors.range_sensor import SimulatedRangeSensor
from sensors.types import Pose


class SimulationBackend(RobotBackend):
    name = "simulation"

    def __init__(self, cfg, seed=None):
        self.cfg = cfg
        self.rng = np.random.default_rng(seed)
        self.sensor = SimulatedRangeSensor(cfg.sensor.num_beams, cfg.sensor.fov_deg, cfg.sensor.max_range,
                                           cfg.sensor.noise_std, cfg.sensor.dropout_prob)
        self.model = make_motion_model(cfg.robot.get("kinematics"), cfg.robot.radius, rng=self.rng,
                                       params=cfg.robot.get("kinematics_params"))
        self.sub_dt = cfg.robot.control_dt / cfg.robot.physics_substeps
        self.world = None
        self.state = None
        self.sim_time = 0.0
        self.collided = False
        self.collision_info = None
        self._cmd = STOP
        self.episode_params = {}

    # ---------- episode management (simulation only) ----------
    def new_episode(self, map_seed=None, world=None, density=None, randomize=False,
                    sensor_noise=None, dropout=None, motion_noise=None, num_movers=None,
                    num_obstacles=None):
        """Create a new map (or reuse `world`) and place the robot at the start.
        Everything random in the episode is derived from `map_seed`, so an
        episode is exactly reproducible."""
        self.rng = np.random.default_rng(map_seed)
        rcfg = self.cfg.randomization
        p = {
            "density": self.cfg.world.obstacle_density,
            "linear_scale": 1.0,
            "angular_scale": 1.0,
            "motion_noise": 0.0,
            "sensor_noise": self.cfg.sensor.noise_std,
            "dropout": self.cfg.sensor.dropout_prob,
        }
        if randomize:
            p["density"] = self.rng.uniform(*rcfg.obstacle_density)
            p["linear_scale"] = self.rng.uniform(*rcfg.linear_scale)
            p["angular_scale"] = self.rng.uniform(*rcfg.angular_scale)
            p["motion_noise"] = rcfg.motion_noise_std
            p["sensor_noise"] = self.rng.uniform(*rcfg.sensor_noise_std)
            p["dropout"] = self.rng.uniform(*rcfg.sensor_dropout_prob)
        for key, val in (("density", density), ("sensor_noise", sensor_noise),
                         ("dropout", dropout), ("motion_noise", motion_noise)):
            if val is not None:
                p[key] = val
        self.episode_params = p

        self.world = world or generate_world(self.cfg.world, self.cfg.robot.radius, self.rng,
                                             density=p["density"], num_movers=num_movers,
                                             num_obstacles=num_obstacles)
        self.model = make_motion_model(self.cfg.robot.get("kinematics"), self.cfg.robot.radius, p["linear_scale"],
                                       p["angular_scale"], p["motion_noise"], self.rng, self.cfg.robot.get("kinematics_params"))
        self.sensor.noise_std = p["sensor_noise"]
        self.sensor.dropout_prob = p["dropout"]
        self.state = RobotState(*self.world.start)
        self.sim_time = 0.0
        self.collided = False
        self.collision_info = None
        self._cmd = STOP
        return self.world.goal

    # ---------- RobotBackend interface ----------
    def is_connected(self):
        return self.world is not None

    def read_sensors(self):
        s = self.state
        return self.sensor.scan(self.world, s.x, s.y, s.theta, self.sim_time, self.rng)

    def get_pose(self):
        s = self.state
        return Pose(s.x, s.y, s.theta, self.sim_time)

    def send_command(self, cmd):
        self._cmd = cmd

    # Collision checking resolution: the footprint is tested at least every MAX_CHECK_TRANSLATION
    # metres and MAX_CHECK_ROTATION radians of motion, whatever the commanded speed, so the robot
    # can never skip over an obstacle between checks (no tunnelling).
    MAX_CHECK_TRANSLATION = 0.02
    MAX_CHECK_ROTATION = 0.1

    def substeps_for(self, dt):
        """Number of collision-checked integration steps for one command of duration dt.
        Never fewer than configured (keeps existing recordings bit-exact at nominal speeds)."""
        m = self.model
        trans = math.hypot(self._cmd.v, self._cmd.vy) * max(m.linear_scale, 1.0) * (1 + 3 * m.noise_std) * dt
        rot = abs(self._cmd.w) * max(m.angular_scale, 1.0) * (1 + 3 * m.noise_std) * dt
        base = max(1, round(dt / self.sub_dt))
        return max(base, math.ceil(trans / self.MAX_CHECK_TRANSLATION), math.ceil(rot / self.MAX_CHECK_ROTATION))

    def wait(self, dt):
        r = self.cfg.robot.radius
        n = self.substeps_for(dt)
        h = dt / n
        for _ in range(n):
            if self.collided:
                break
            if self._cmd.vy:          # holonomic robots only
                new = self.model.integrate(self.state, self._cmd.v, self._cmd.w, h, self._cmd.vy)
            else:
                new = self.model.integrate(self.state, self._cmd.v, self._cmd.w, h)
            self.world.step_movers(h)
            if self.world.collides(new.x, new.y, r):
                self._record_collision(self.state, new, r)
            else:
                self.state = new
        self.sim_time += dt

    def _record_collision(self, before, after, r):
        """Find the time of impact inside the sub-step by bisection and stop the robot at the
        last collision-free pose on its own path (never inside an obstacle, never teleported)."""
        lo, hi = 0.0, 1.0

        def pose(f):
            th = before.theta + ((after.theta - before.theta + math.pi) % (2 * math.pi) - math.pi) * f
            return RobotState(before.x + (after.x - before.x) * f, before.y + (after.y - before.y) * f, th)

        if not self.world.collides(before.x, before.y, r):
            for _ in range(14):
                mid = (lo + hi) / 2
                p = pose(mid)
                if self.world.collides(p.x, p.y, r):
                    hi = mid
                else:
                    lo = mid
        contact = pose(hi)
        w = self.world
        c = contact                                     # robot centre at first contact
        # actual contact point = nearest point of the touched geometry to the robot centre
        cands = []
        if c.x - r < 0 or c.y - r < 0 or c.x + r > w.width or c.y + r > w.height:
            for px, py in ((0.0, c.y), (w.width, c.y), (c.x, 0.0), (c.x, w.height)):
                cands.append((math.hypot(px - c.x, py - c.y), "boundary", px, py))
        for xmin, ymin, xmax, ymax in w.rects:
            px, py = min(max(c.x, xmin), xmax), min(max(c.y, ymin), ymax)
            cands.append((math.hypot(px - c.x, py - c.y), "static_obstacle", px, py))
        for mx, my, mr in w.mover_circles:
            d = math.hypot(mx - c.x, my - c.y)
            k = (d - mr) / d if d > 1e-9 else 0.0
            cands.append((max(0.0, d - mr), "moving_obstacle", c.x + (mx - c.x) * k, c.y + (my - c.y) * k))
        _, kind, cx, cy = min(cands) if cands else (0.0, "unknown", c.x, c.y)
        moved = math.hypot(after.x - before.x, after.y - before.y) > 1e-9
        self.state = pose(lo) if moved else before
        self.collided = True
        self._cmd = STOP
        self.collision_info = {"kind": kind, "x": cx, "y": cy, "robot_x": c.x, "robot_y": c.y,
                               "time": self.sim_time, "robot_moving": moved}

    def now(self):
        return self.sim_time

    def collision_detected(self):
        return self.collided

    def distance_to_goal(self):
        return math.hypot(self.world.goal[0] - self.state.x, self.world.goal[1] - self.state.y)
