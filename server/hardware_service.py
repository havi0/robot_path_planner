"""Hardware bridge: the same navigation stack, driven through a RobotBackend.

Backends:
  ros2      - physical robot via HardwareBackend (needs a sourced ROS 2 install)
  loopback  - SimulationBackend behind the SAME bridge, for testing the bridge
              without hardware. Always labelled as simulated; never reported
              as a physical connection.

Safety rules enforced here (server side, not just in the UI):
  * no motion unless the app is in HARDWARE mode, a backend is connected and
    an operator has explicitly ARMED the robot with a typed confirmation;
  * every command passes the SafetyLayer (limits, proximity, timeouts, e-stop);
  * manual commands are dead-man: they expire after 0.5 s;
  * link loss -> stop + disarm; e-stop -> stop + disarm (must re-arm).
A software e-stop does NOT replace a physical emergency stop.
"""
import copy
import math
import threading
import time
import traceback

import numpy as np

from backends.hardware_backend import HardwareBackend, ros2_available
from backends.simulation_backend import SimulationBackend
from navigation.actions import STOP, DiscreteActionSpace, VelocityCommand
from navigation.core import NavigationCore
from navigation.policies import DQNPolicy, RecoveryWrapper
from safety.safety_layer import SafetyLayer
from sensors.observation import observation_builder_from_config
from sensors.types import beam_angles

ARM_PHRASE = "ARM"
MANUAL_TIMEOUT = 0.5


class HardwareError(ValueError):
    pass


class _PacedOutside:
    """Wraps a hardware backend so wait() is a no-op: the bridge loop paces the
    control rate itself, outside its lock, so status reads never block."""

    def __init__(self, inner):
        self.inner = inner

    def __getattr__(self, item):
        return getattr(self.inner, item)

    def wait(self, dt):
        pass


class HardwareBridge:
    def __init__(self, cfg, profile, models, events, app_state):
        self.cfg = cfg
        self.profile = profile
        self.models = models
        self.events = events
        self.app_state = app_state                  # holds operating_mode
        self.lock = threading.RLock()
        self.backend = None
        self.drive = None
        self.kind = None
        self.status = "disconnected"                # disconnected | connected | error
        self.last_error = None
        self.armed = False
        self.mode = "idle"                          # idle | manual | autonomous
        self.safety = SafetyLayer(cfg.safety, cfg.robot.radius)
        self.manual_cmd, self.manual_time = STOP, 0.0
        self.last_decision = None
        self.goal = None
        self.core = None
        self.policy = None
        self.deploy_outcome = None
        self.trail = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="hardware-bridge", daemon=True)

    def start_thread(self):
        self._thread.start()

    def shutdown(self):
        self._stop.set()
        with self.lock:
            self._safe_stop()
        self._thread.join(timeout=2)

    # ------------------------------------------------------------ connection
    def connect(self, kind):
        with self.lock:
            if self.status == "connected":
                raise HardwareError("Already connected - disconnect first")
            if kind == "ros2":
                if not ros2_available():
                    self.status, self.last_error = "disconnected", "ROS 2 (rclpy) is not installed on this machine"
                    raise HardwareError(self.last_error + ". Source a ROS 2 environment and restart the server.")
                backend = HardwareBackend(self.profile, self.cfg.sensor)
                try:
                    backend.connect()
                    deadline = time.time() + 3.0
                    while time.time() < deadline and (backend.get_pose() is None or backend.read_sensors() is None):
                        time.sleep(0.05)
                    if backend.get_pose() is None or backend.read_sensors() is None:
                        raise HardwareError("No /odom or /scan data received within 3 s - is the robot driver running?")
                except Exception as e:
                    try:
                        backend.disconnect()
                    except Exception:
                        pass
                    self.status, self.last_error = "error", str(e)
                    self.events.emit("error", "hardware", f"Connection failed: {e}")
                    raise HardwareError(str(e))
            elif kind == "loopback":
                backend = SimulationBackend(self.cfg)
                backend.new_episode(map_seed=self.cfg.evaluation.heldout_seed_offset + 4242)
            else:
                raise HardwareError("backend must be 'ros2' or 'loopback'")
            self.backend, self.kind, self.status, self.last_error = backend, kind, "connected", None
            self.drive = _PacedOutside(backend) if kind == "ros2" else backend   # sim wait() integrates physics
            self.armed, self.mode, self.trail = False, "idle", []
            self.safety = SafetyLayer(self.cfg.safety, self.cfg.robot.radius)
        label = "ROS 2 robot" if kind == "ros2" else "simulation loopback (no hardware)"
        self.events.emit("success" if kind == "ros2" else "info", "hardware", f"Connected: {label}")

    def disconnect(self):
        with self.lock:
            if self.backend is None:
                raise HardwareError("Not connected")
            self._safe_stop()
            try:
                self.backend.disconnect()
            finally:
                self.backend, self.drive, self.kind, self.status = None, None, None, "disconnected"
                self.armed, self.mode = False, "idle"
        self.events.emit("info", "hardware", "Disconnected")

    # ------------------------------------------------------------ operator actions
    def _require_motion_allowed(self):
        if self.app_state["operating_mode"] != "hardware":
            raise HardwareError("Switch the application to Hardware mode first")
        if self.status != "connected":
            raise HardwareError("No robot backend connected")

    def arm(self, confirmation):
        with self.lock:
            self._require_motion_allowed()
            if confirmation != ARM_PHRASE:
                raise HardwareError(f"Type {ARM_PHRASE} to confirm that the area is clear and an operator "
                                    "is at the physical emergency stop")
            if self.safety.estop.engaged:
                raise HardwareError("Release the emergency stop before arming")
            self.armed = True
        self.events.emit("warning", "hardware", f"Robot ARMED ({self.kind}) - motion commands enabled")

    def disarm(self, reason="operator"):
        with self.lock:
            self.armed = False
            self.mode = "idle"
            self._safe_stop()
        self.events.emit("info", "hardware", f"Robot disarmed ({reason})")

    def set_estop(self, engaged):
        with self.lock:
            if engaged:
                self.safety.estop.trigger("operator")
                self.armed, self.mode = False, "idle"
                self._safe_stop()
            else:
                self.safety.estop.reset()
        self.events.emit("error" if engaged else "info", "hardware",
                         "SOFTWARE EMERGENCY STOP engaged" if engaged else "Emergency stop released (robot stays disarmed)")

    def manual(self, v, w):
        with self.lock:
            self._require_motion_allowed()
            if not self.armed:
                raise HardwareError("Arm the robot first")
            if not (math.isfinite(v) and math.isfinite(w)):
                raise HardwareError("invalid command")
            if self.mode == "autonomous":
                self.mode = "manual"            # manual override always wins
                self.events.emit("warning", "hardware", "Manual override: autonomous navigation interrupted")
            self.mode = "manual"
            self.manual_cmd = VelocityCommand(float(v), float(w))
            self.manual_time = time.time()

    def deploy(self, goal=None):
        with self.lock:
            self._require_motion_allowed()
            if not self.armed:
                raise HardwareError("Arm the robot first")
            entry = self.models.get("dqn")
            if not entry:
                raise HardwareError("No DQN model loaded")
            agent, train_cfg = entry[0], entry[1]
            if goal is None:
                if self.kind != "loopback":
                    raise HardwareError("A goal (x, y) in the odometry frame is required")
                goal = self.backend.world.goal
            acts = DiscreteActionSpace.from_config(train_cfg)
            self.policy = RecoveryWrapper(DQNPolicy(agent), acts,
                                          beam_angles(train_cfg.sensor.num_beams, train_cfg.sensor.fov_deg),
                                          train_cfg.sensor.max_range)
            self.policy.reset()
            self.core = NavigationCore(self.drive, observation_builder_from_config(train_cfg), acts,
                                       train_cfg.robot.control_dt, train_cfg.world.goal_radius, self.safety)
            self.core.begin(tuple(goal))
            self.goal, self.mode, self.deploy_outcome, self.trail = tuple(goal), "autonomous", None, []
        self.events.emit("warning", "hardware", f"Autonomous navigation started to goal ({goal[0]:.2f}, {goal[1]:.2f})")

    def stop_motion(self):
        with self.lock:
            self.mode = "idle"
            self._safe_stop()
        self.events.emit("info", "hardware", "Motion stopped by operator")

    def _safe_stop(self):
        if self.backend is not None:
            try:
                self.backend.stop()
            except Exception:
                pass

    # ------------------------------------------------------------ control loop
    def _loop(self):
        dt = self.cfg.robot.control_dt
        while not self._stop.is_set():
            t0 = time.time()
            try:
                with self.lock:
                    self._tick(dt)
            except Exception as e:
                traceback.print_exc()
                with self.lock:
                    self.armed, self.mode = False, "idle"
                    self._safe_stop()
                self.events.emit("error", "hardware", f"Control loop error, robot stopped: {e}")
            time.sleep(max(0.0, dt - (time.time() - t0)))      # fixed control rate, outside the lock

    def _tick(self, dt):
        b = self.drive if self.backend is not None else None
        if b is None:
            return
        if not b.is_connected():
            if self.armed or self.mode != "idle":
                self.events.emit("error", "hardware", "Communication lost - robot stopped and disarmed")
            self.armed, self.mode, self.status, self.last_error = False, "idle", "error", "communication lost"
            self._safe_stop()
            return
        if self.mode == "autonomous" and self.armed and self.core is not None:
            obs = self.core._observe(self.core.last_reading, self.core.last_pose)
            action = self.policy.act(obs, self.core.last_pose, self.goal) if obs is not None \
                else self.core.actions.index_of("stop")
            res = self.core.step(action)
            self.last_decision = res.safety
            if res.pose:
                self.trail.append([round(res.pose.x, 3), round(res.pose.y, 3)])
            if res.reached or res.collided:
                self.deploy_outcome = "success" if res.reached else "collision"
                self.mode = "idle"
                self._safe_stop()
                self.events.emit("success" if res.reached else "error", "hardware",
                                 "Goal reached" if res.reached else "Collision during autonomous run - stopped")
            return
        cmd = STOP
        if self.armed and self.mode == "manual" and time.time() - self.manual_time < MANUAL_TIMEOUT:
            cmd = self.manual_cmd
        self.safety.override.release()
        d = self.safety.filter(cmd, b.read_sensors(), b.now(), b.is_connected(), dt)
        b.send_command(d.command)
        b.wait(dt)
        self.last_decision = d
        p = b.get_pose()
        if p and (self.mode != "idle" or not self.trail):
            self.trail.append([round(p.x, 3), round(p.y, 3)])
        self.trail = self.trail[-1500:]

    # ------------------------------------------------------------ snapshot
    def snapshot(self):
        with self.lock:
            b = self.backend
            tel = None
            world = None
            if b is not None:
                pose, reading, now = b.get_pose(), b.read_sensors(), b.now()
                d = self.last_decision
                tel = {
                    "pose": None if pose is None else {"x": pose.x, "y": pose.y, "theta": pose.theta,
                                                       "age": now - pose.timestamp},
                    "sensor": None if reading is None else {
                        "valid_fraction": reading.valid_fraction, "age": now - reading.timestamp,
                        "min_range": float(np.nanmin(reading.ranges)) if reading.valid_mask.any() else None,
                        "ranges": [None if not np.isfinite(r) else round(float(r), 3) for r in reading.ranges],
                        "angles": [round(float(a), 4) for a in reading.angles], "max_range": reading.max_range},
                    "requested": None if d is None else {"v": d.requested.v, "w": d.requested.w},
                    "executed": None if d is None else {"v": d.command.v, "w": d.command.w},
                    "safety": [] if d is None else d.reasons,
                }
                if self.kind == "loopback":
                    w = b.world
                    world = {"width": w.width, "height": w.height, "rects": w.rects.round(3).tolist(),
                             "goal": list(w.goal), "start": list(w.start), "movers": [],
                             "mover_radius": w.mover_radius, "goal_radius": self.cfg.world.goal_radius,
                             "robot_radius": self.cfg.robot.radius}
            return {
                "status": self.status, "kind": self.kind, "simulated": self.kind == "loopback",
                "ros2_available": ros2_available(), "last_error": self.last_error, "armed": self.armed,
                "estop": self.safety.estop.engaged, "mode": self.mode, "goal": self.goal,
                "deploy_outcome": self.deploy_outcome, "telemetry": tel, "world": world,
                "trail": self.trail[-800:], "arm_phrase": ARM_PHRASE,
                "limits": {"max_linear": self.cfg.safety.max_linear_speed,
                           "max_angular": self.cfg.safety.max_angular_speed,
                           "profile_max_linear": self.profile.limits.max_linear_speed,
                           "profile_max_angular": self.profile.limits.max_angular_speed,
                           "stop_distance": self.cfg.safety.stop_distance,
                           "sensor_timeout": self.cfg.safety.sensor_timeout,
                           "manual_timeout": MANUAL_TIMEOUT},
            }
