"""Live simulation session behind the 'Live Simulation' page.

A background thread advances the robot at the requested speed. All physics,
collision detection, sensing, rewards and policy decisions run here (Python);
the frontend only renders snapshots of this state.
"""
import copy
import math
import threading
import time

import numpy as np

from baselines.grid_planners import astar, dijkstra
from environment.nav_env import NavigationEnv
from environment.world import World
from evaluation.evaluate import plan_with_fallback
from navigation import robots as R
from navigation.policies import DQNPolicy, QTablePolicy, RecoveryWrapper, path_follower
from evaluation.recorder import Runner, classify_collision, make_episode
from scenarios.io import world_to_dict
from sensors.observation import observation_builder_from_config
from sensors.types import beam_angles

POLICIES = {
    "dqn_recovery": "DQN + recovery",
    "dqn": "DQN",
    "qlearning": "Q-learning",
    "astar": "A* (known map)",
    "dijkstra": "Dijkstra (known map)",
}

LIMITS = {
    "width": (3.0, 12.0), "height": (3.0, 12.0), "density": (0.0, 0.35), "num_obstacles": (0, 80),
    "dynamic_obstacles": (0, 8), "max_linear": (0.05, 0.3), "max_angular": (0.3, 1.5),
    "speed": (0.5, 400.0),
}


class ValidationError(ValueError):
    pass


class RobotFitError(ValidationError):
    """The selected robot's footprint does not fit the current map's start or goal."""


def _check(name, value):
    lo, hi = LIMITS[name]
    if value is None or not (lo <= value <= hi):
        raise ValidationError(f"{name} must be between {lo} and {hi} (got {value})")
    return value


class SimSession:
    def __init__(self, base_cfg, models, events):
        self.base_cfg = base_cfg
        self.models = models
        self.events = events
        self.lock = threading.RLock()
        self.config = {
            "width": base_cfg.world.width, "height": base_cfg.world.height,
            "density": base_cfg.world.obstacle_density, "num_obstacles": None,
            "dynamic_obstacles": 0, "seed": base_cfg.evaluation.heldout_seed_offset,
            "max_linear": base_cfg.actions.forward[0], "max_angular": base_cfg.actions.turn_left[1],
        }
        self.robot = R.get_profile(R.REFERENCE)   # selected simulated robot (reference = original behaviour)
        self.on_robot_change = None              # callback(selection) - set by the app to persist the choice
        self.policy_key = "dqn_recovery" if models.get("dqn") else "astar"
        self.shield = True              # safety layer ON by default; switch off only to study the raw policy
        self.speed = 8.0                    # decisions per second (4 = real time)
        self.status = "idle"                # idle | running | paused | finished
        self.world_version = 0
        self.episode = 0
        self.on_episode = None          # callback(episode_dict) - set by the app to persist recordings
        self.model_meta = None          # callback(policy_key) -> model provenance dict
        self.scenario_meta = None       # set when a saved scenario is loaded
        self._stop = threading.Event()
        self._steps_times = []
        self._build_world(self.config["seed"])
        self._thread = threading.Thread(target=self._loop, name="sim-loop", daemon=True)

    # ------------------------------------------------------------ lifecycle
    def start_thread(self):
        self._thread.start()

    def shutdown(self):
        self._stop.set()
        self._thread.join(timeout=2)

    def _loop(self):
        last = time.perf_counter()
        budget = 0.0
        while not self._stop.is_set():
            now = time.perf_counter()
            dt, last = now - last, now
            with self.lock:
                if self.status == "running":
                    budget = min(budget + self.speed * dt, 50)
                    while budget >= 1 and self.status == "running":
                        budget -= 1
                        self._step()
                else:
                    budget = 0.0
            time.sleep(0.005)

    # ------------------------------------------------------------ building
    def _cfg(self):
        cfg = copy.deepcopy(self.base_cfg)
        c = self.config
        cfg.world.width, cfg.world.height = float(c["width"]), float(c["height"])
        cfg.world.obstacle_density = float(c["density"])
        cfg.world.min_start_goal_dist = min(cfg.world.min_start_goal_dist, 0.45 * min(c["width"], c["height"]))
        cfg.actions.forward = [float(c["max_linear"]), 0.0]
        cfg.actions.turn_left = [0.0, float(c["max_angular"])]
        cfg.actions.turn_right = [0.0, -float(c["max_angular"])]
        R.apply_profile(cfg, self.robot, c["max_linear"], c["max_angular"])   # no-op for the reference robot
        return cfg

    def _build_world(self, seed):
        self.cfg = self._cfg()
        self.env = NavigationEnv(self.cfg, mode="eval", use_safety=True)
        self._use_model_observation()
        goal_obs = self.env.reset(options={"map_seed": int(seed), "num_movers": int(self.config["dynamic_obstacles"]),
                                           "num_obstacles": self.config["num_obstacles"]})
        del goal_obs
        self.base_world = copy.deepcopy(self.env.backend.world)
        self.scenario_meta = None
        self.world_version += 1
        self._reset_episode()

    def _use_model_observation(self):
        """Learned policies must see observations normalised exactly as in training,
        even if the user changes the map size here."""
        entry = self.models.get("dqn") or self.models.get("qlearning")
        if entry:
            builder = observation_builder_from_config(entry[1])
            self.env.obs_builder = builder
            self.env.core.obs_builder = builder

    def policy_compat(self, key):
        entry = self.models.get("dqn" if key in ("dqn", "dqn_recovery") else "qlearning") if key in R.LEARNED else None
        return R.policy_compatibility(key, self.robot, entry[1] if entry else None,
                                      self.config["max_linear"], self.config["max_angular"])

    def _make_policy(self):
        acts = self.env.action_set
        key = self.policy_key
        compat = self.policy_compat(key)
        if compat["status"] == "incompatible":
            raise ValidationError(f"{POLICIES[key]} cannot drive the {self.robot['name']}: {compat['detail']}")
        if key in ("dqn", "dqn_recovery"):
            entry = self.models.get("dqn")
            if not entry:
                raise ValidationError("No DQN model loaded - train one or load a checkpoint")
            pol = DQNPolicy(entry[0])
            if key == "dqn_recovery":
                pol = RecoveryWrapper(pol, acts, beam_angles(self.cfg.sensor.num_beams, self.cfg.sensor.fov_deg),
                                      self.cfg.sensor.max_range)
            return pol
        if key == "qlearning":
            entry = self.models.get("qlearning")
            if not entry:
                raise ValidationError("No Q-learning model loaded")
            return QTablePolicy(entry[0])
        return path_follower(acts, POLICIES[key])

    def _reset_episode(self):
        world = copy.deepcopy(self.base_world)
        self.obs, _ = self.env.reset(options={"map_seed": int(self.config["seed"]), "world": world})
        self.env.core.safety = self.env.safety if self.shield else None
        self.policy = self._make_policy()
        self.planned_path = []
        self.plan_info = None
        ctx = {}
        if self.policy_key in ("astar", "dijkstra"):
            plan = plan_with_fallback(self.cfg, astar if self.policy_key == "astar" else dijkstra,
                                      self.env.backend.world, self.env.core.goal)
            self.planned_path = plan.path
            self.plan_info = {"length": plan.length if plan.path else None, "time_ms": plan.plan_time_ms,
                              "nodes_expanded": plan.expanded, "found": bool(plan.path)}
            ctx = {"path": plan.path}
        self.policy.reset(**ctx)
        entry = self.models.get("qlearning") if self.policy_key == "qlearning" else None
        if entry is not None:
            entry[0].rng = np.random.default_rng(int(self.config["seed"]))   # deterministic ties (exact replay)
        ref = plan_with_fallback(self.cfg, astar, self.env.backend.world, self.env.core.goal)
        self.reference_path = ref.path
        self.reference_length = max(ref.length - self.cfg.world.goal_radius, 0) if ref.path else None
        p = self.env.core.last_pose
        self.trail = [(p.x, p.y)]
        self.collisions = []
        self.ep_reward = 0.0
        self.steps = 0
        self.turns = 0
        self.prev_action = None
        self.current_action = None
        self.min_clearance = None
        self.outcome = None
        self.safety_reasons = []
        self.status = "idle"
        self.episode += 1
        self.rec_world = world_to_dict(self.base_world)
        self.rec_conditions = {"sensor_noise": self.cfg.sensor.noise_std, "dropout": self.cfg.sensor.dropout_prob,
                               "motion_noise": 0.0, "shield": self.shield, "max_linear": self.config["max_linear"],
                               "max_angular": self.config["max_angular"], "shield_toggles": []}
        if self.robot["id"] != R.REFERENCE:      # recordings of the reference robot keep their original format
            self.rec_conditions["robot"] = {"id": self.robot["id"], "custom": self.robot.get("custom")}
        self.rec = {k: [] for k in ("x", "y", "theta", "dist", "min_range", "action", "reward", "v", "w", "safety")}
        self.rec_terms, self.rec_interventions, self.rec_collision = {}, 0, None
        self._rec_state()

    # ------------------------------------------------------------ stepping
    def _step(self):
        if self.outcome:
            self.status = "finished"
            return
        core = self.env.core
        action = self.policy.act(self.obs, core.last_pose, core.goal)
        pre_pose, pre_reading = core.last_pose, core.last_reading
        self.obs, r, term, trunc, info = self.env.step(action)
        for k, v in info["reward_terms"].items():
            self.rec_terms[k] = round(self.rec_terms.get(k, 0.0) + float(v), 5)
        if info["safety_intervened"]:
            self.rec_interventions += 1
        if info.get("collision_info"):
            self.rec_collision = classify_collision(info["collision_info"], pre_pose, pre_reading,
                                                    self.env.action_set.names[action], self.cfg.robot.radius)
        name = self.env.action_set.names[action]
        if name.startswith("turn") and name != self.prev_action:
            self.turns += 1
        self.prev_action = self.current_action = name
        self.ep_reward += r
        self.steps += 1
        p = core.last_pose
        self.trail.append((p.x, p.y))
        ranges = core.last_reading.ranges
        valid = ranges[np.isfinite(ranges)]
        if valid.size:
            c = float(valid.min()) - self.cfg.robot.radius
            self.min_clearance = c if self.min_clearance is None else min(self.min_clearance, c)
        self.safety_reasons = info["safety_reasons"]
        self._steps_times.append(time.perf_counter())
        ex = core.last_cmd
        self.rec["action"].append(name)
        self.rec["reward"].append(round(float(r), 5))
        self.rec["v"].append(round(float(ex.v), 4))
        self.rec["w"].append(round(float(ex.w), 4))
        self.rec["safety"].append(info["safety_reasons"])
        self._rec_state()
        if term or trunc:
            self.outcome = "success" if info["is_success"] else "collision" if info["collision"] else "timeout"
            if self.outcome == "collision":
                ci = info.get("collision_info") or {}
                self.collisions.append((ci.get("x", p.x), ci.get("y", p.y)))
            self.status = "finished"
            level = {"success": "success", "collision": "error", "timeout": "warning"}[self.outcome]
            msg = {"success": f"Goal reached in {self.steps} steps ({core.path_length:.2f} m)",
                   "collision": f"Collision detected at ({p.x:.2f}, {p.y:.2f})",
                   "timeout": f"Episode timed out after {self.steps} steps"}[self.outcome]
            self.events.emit(level, "simulation", f"{POLICIES[self.policy_key]}: {msg}")
            self._save_recording()

    def _rec_state(self):
        p = self.env.core.last_pose
        rr = self.env.core.last_reading.ranges
        valid = rr[np.isfinite(rr)]
        self.rec["x"].append(round(float(p.x), 6))
        self.rec["y"].append(round(float(p.y), 6))
        self.rec["theta"].append(round(float(p.theta), 6))
        self.rec["dist"].append(round(float(self.env.core.distance_to_goal(p)), 6))
        self.rec["min_range"].append(round(float(valid.min()), 5) if valid.size else None)

    def _save_recording(self):
        """Persist the finished episode with everything needed to re-simulate it exactly."""
        if self.on_episode is None:
            return
        try:
            run = type("LiveRun", (), {})()
            run.steps, run.cfg, run.planned = self.rec, self.cfg, self.planned_path
            run.outcome, run.reference_length = self.outcome, self.reference_length
            run.reward_terms, run.interventions, run.collision_info = self.rec_terms, self.rec_interventions, self.rec_collision
            run.result = lambda: Runner.result(run)
            model = self.model_meta(self.policy_key) if self.model_meta else None
            ep = make_episode(run, source="live", world_dict=self.rec_world, policy_key=self.policy_key,
                              conditions=self.rec_conditions, seed=int(self.config["seed"]), model=model,
                              scenario=self.scenario_meta)
            self.on_episode(ep)
        except Exception as e:      # recording must never break the simulator
            self.events.emit("warning", "simulation", f"Episode recording failed: {e}")

    # ------------------------------------------------------------ controls
    def control(self, action):
        with self.lock:
            if action == "start":
                if self.status == "finished":
                    self._reset_episode()
                self.status = "running"
            elif action == "pause":
                if self.status == "running":
                    self.status = "paused"
            elif action == "resume":
                if self.status == "paused":
                    self.status = "running"
            elif action == "reset":
                self._reset_episode()
            elif action == "step":
                if self.status == "running":
                    raise ValidationError("Pause the simulation before stepping")
                if self.status == "finished":
                    raise ValidationError("Episode finished - reset first")
                self._step()
                if self.status != "finished":
                    self.status = "paused"
            elif action == "regenerate":
                self.config["seed"] = int(self.config["seed"]) + 1
                self._build_world(self.config["seed"])
            else:
                raise ValidationError(f"unknown action {action}")

    def set_speed(self, sps):
        with self.lock:
            self.speed = float(_check("speed", sps))

    def set_policy(self, key):
        if key not in POLICIES:
            raise ValidationError(f"unknown policy {key}")
        with self.lock:
            old = self.policy_key
            self.policy_key = key
            try:
                self._reset_episode()
            except ValidationError:
                self.policy_key = old
                self._reset_episode()
                raise

    def set_shield(self, on):
        with self.lock:
            self.shield = bool(on)
            self.env.core.safety = self.env.safety if self.shield else None
            if self.steps == 0:
                self.rec_conditions["shield"] = self.shield
            else:
                self.rec_conditions["shield_toggles"].append({"step": self.steps, "enabled": self.shield})

    def apply_config(self, cfg):
        with self.lock:
            new = dict(self.config)
            for k in ("width", "height", "density", "max_linear", "max_angular"):
                if k in cfg and cfg[k] is not None:
                    new[k] = float(_check(k, float(cfg[k])))
            if "dynamic_obstacles" in cfg and cfg["dynamic_obstacles"] is not None:
                new["dynamic_obstacles"] = int(_check("dynamic_obstacles", int(cfg["dynamic_obstacles"])))
            if "num_obstacles" in cfg:
                v = cfg["num_obstacles"]
                new["num_obstacles"] = None if v in (None, "") else int(_check("num_obstacles", int(v)))
            if "seed" in cfg and cfg["seed"] is not None:
                if not (0 <= int(cfg["seed"]) < 2 ** 31):
                    raise ValidationError("seed must be a non-negative integer")
                new["seed"] = int(cfg["seed"])
            old = self.config
            self.config = new
            try:
                self._build_world(new["seed"])
            except RuntimeError as e:
                self.config = old
                self._build_world(old["seed"])
                raise ValidationError(f"Could not generate a solvable map: {e}")
            self.events.emit("info", "simulation", f"Environment regenerated (seed {new['seed']}, "
                                                   f"{new['width']:g}x{new['height']:g} m)")

    def _mark_modified(self):
        if self.scenario_meta and not self.scenario_meta.get("modified"):
            self.scenario_meta = {**self.scenario_meta, "modified": True, "name": self.scenario_meta.get("name", "") + " (edited)"}

    def load_world(self, world_dict, scenario_meta=None):
        """Replay a saved scenario in the live simulator."""
        from scenarios.io import world_from_dict
        with self.lock:
            w = world_from_dict(world_dict)
            self.config.update(width=w.width, height=w.height, dynamic_obstacles=len(w.movers))
            self.cfg = self._cfg()
            self.env = NavigationEnv(self.cfg, mode="eval", use_safety=True)
            self._use_model_observation()
            self.base_world = w
            self.scenario_meta = scenario_meta
            self.world_version += 1
            self._reset_episode()

    # ------------------------------------------------------------ robot selection
    def select_robot(self, robot_id, custom=None, regenerate=False):
        """Switch the simulated robot. Keeps the current map when the new footprint fits its start
        and goal; otherwise raises RobotFitError unless `regenerate` asks for a new map.
        Returns a list of notes (e.g. the controller had to change)."""
        with self.lock:
            if self.status == "running":
                raise ValidationError("Pause the simulation before changing the robot")
            try:
                prof = R.get_profile(robot_id, custom)
            except R.RobotError as e:
                raise ValidationError(str(e)) from None
            w, r = self.base_world, prof["radius"]
            fits = all(0 < x - r and x + r < w.width and 0 < y - r and y + r < w.height and not w.collides(x, y, r + 0.02)
                       for x, y in (w.start[:2], w.goal))
            if not fits and not regenerate:
                raise RobotFitError(f"The {prof['name']}'s {r:.2f} m footprint does not fit the current map's start or goal. "
                                    "Generate a new map for it, or move the start/goal in the 2D editor first.")
            old = (self.robot, dict(self.config), self.policy_key)
            notes = []
            self.robot = prof
            self.config["max_linear"], self.config["max_angular"] = prof["max_linear"], prof["max_angular"]
            if self.policy_compat(self.policy_key)["status"] == "incompatible":
                notes.append(f"{POLICIES[self.policy_key]} cannot drive the {prof['name']} (different action space) - "
                             f"switched the controller to {POLICIES['astar']}.")
                self.policy_key = "astar"
            try:
                if fits:
                    self.cfg = self._cfg()
                    self.env = NavigationEnv(self.cfg, mode="eval", use_safety=True)
                    self._use_model_observation()
                    self.world_version += 1
                    self._reset_episode()
                else:
                    self.config["seed"] = int(self.config["seed"]) + 1
                    self._build_world(self.config["seed"])
                    notes.append(f"Generated a new map (seed {self.config['seed']}) that fits the {r:.2f} m footprint.")
            except Exception:
                self.robot, self.config, self.policy_key = old
                self._build_world(self.config["seed"])
                raise
            self.events.emit("info", "robot", f"Robot selected: {prof['name']} ({prof['kind']})")
            for n in notes:
                self.events.emit("warning", "robot", n)
            if self.on_robot_change:
                try:
                    self.on_robot_change({"id": prof["id"], "custom": prof.get("custom")})
                except Exception as e:
                    self.events.emit("warning", "robot", f"Could not save the robot selection: {e}")
            return notes

    def robot_state(self):
        with self.lock:
            return {"selected": R.public(self.robot),
                    "compatibility": {k: self.policy_compat(k) for k in POLICIES},
                    "speed_limits": {"max_linear": self.config["max_linear"], "max_angular": self.config["max_angular"]}}

    def _free(self, x, y, margin=0.05, world=None):
        w = world or self.base_world
        return 0 < x < w.width and 0 < y < w.height and not w.collides(x, y, self.cfg.robot.radius + margin)

    def set_goal(self, x, y):
        with self.lock:
            if not self._free(x, y):
                raise ValidationError("Goal must be inside the map and clear of obstacles")
            self.base_world.goal = (float(x), float(y))
            self._mark_modified()
            self.world_version += 1
            self._reset_episode()

    def set_start(self, x, y, theta=None):
        with self.lock:
            if not self._free(x, y):
                raise ValidationError("Start must be inside the map and clear of obstacles")
            th = self.base_world.start[2] if theta is None else float(theta)
            self.base_world.start = (float(x), float(y), th)
            self._mark_modified()
            self.world_version += 1
            self._reset_episode()

    def add_obstacle(self, rect):
        with self.lock:
            xmin, ymin, xmax, ymax = sorted(rect[0::2])[0], sorted(rect[1::2])[0], \
                sorted(rect[0::2])[1], sorted(rect[1::2])[1]
            if xmax - xmin < 0.05 or ymax - ymin < 0.05:
                raise ValidationError("Obstacle is too small (minimum 5 cm)")
            w = self.base_world
            xmin, ymin = max(0.0, xmin), max(0.0, ymin)
            xmax, ymax = min(w.width, xmax), min(w.height, ymax)
            trial = World(w.width, w.height, np.vstack([w.rects, [[xmin, ymin, xmax, ymax]]]), w.start, w.goal,
                          w.movers.copy(), w.mover_radius)
            if not self._free(*w.start[:2], 0.0, trial) or not self._free(*w.goal, 0.0, trial):
                raise ValidationError("Obstacle would cover the start or the goal")
            self.base_world = trial
            self._mark_modified()
            self.world_version += 1
            self._reset_episode()

    def remove_obstacle(self, x, y):
        with self.lock:
            w = self.base_world
            hit = [i for i, (a, b, c, d) in enumerate(w.rects) if a <= x <= c and b <= y <= d]
            if not hit:
                raise ValidationError("No obstacle at that point")
            w.rects = np.delete(w.rects, hit[-1], axis=0)
            self._mark_modified()
            self.world_version += 1
            self._reset_episode()

    def clear_obstacles(self):
        with self.lock:
            self.base_world.rects = np.zeros((0, 4))
            self._mark_modified()
            self.world_version += 1
            self._reset_episode()

    # ------------------------------------------------------------ snapshot
    def snapshot(self):
        with self.lock:
            core = self.env.core
            world = self.env.backend.world
            p = core.last_pose
            reading = core.last_reading
            now = time.perf_counter()
            self._steps_times = [t for t in self._steps_times if now - t < 1.0]
            dist = core.distance_to_goal(p)
            return {
                "status": self.status, "episode": self.episode, "outcome": self.outcome,
                "policy": self.policy_key, "policies": POLICIES, "shield": self.shield, "speed": self.speed,
                "robot_profile": R.public(self.robot),
                "policy_compat": {k: self.policy_compat(k) for k in POLICIES},
                "config": dict(self.config), "world_version": self.world_version,
                "world": {"width": world.width, "height": world.height, "rects": world.rects.round(4).tolist(),
                          "movers": world.movers[:, :2].round(4).tolist(), "mover_radius": world.mover_radius,
                          "start": list(self.base_world.start), "goal": list(core.goal),
                          "goal_radius": self.cfg.world.goal_radius, "robot_radius": self.cfg.robot.radius},
                "robot": {"x": p.x, "y": p.y, "theta": p.theta, "collided": bool(self.env.backend.collided)},
                "sensor": {"ranges": [None if not np.isfinite(r) else round(float(r), 4) for r in reading.ranges],
                           "angles": [round(float(a), 5) for a in reading.angles], "max_range": reading.max_range},
                "trail": [[round(x, 4), round(y, 4)] for x, y in self.trail[-1500:]],
                "planned_path": [[round(x, 4), round(y, 4)] for x, y in self.planned_path],
                "reference_path": [[round(x, 4), round(y, 4)] for x, y in self.reference_path],
                "collisions": [list(c) for c in self.collisions],
                "collision_cause": self.rec_collision,
                "interventions": self.rec_interventions,
                "reward_terms": self.rec_terms,
                "telemetry": {
                    "x": p.x, "y": p.y, "heading_deg": math.degrees(p.theta), "distance_to_goal": dist,
                    "action": self.current_action, "reward": self.ep_reward, "steps": self.steps,
                    "max_steps": self.cfg.training.max_episode_steps, "collision": bool(self.env.backend.collided),
                    "sim_hz": len(self._steps_times), "safety": self.safety_reasons,
                },
                "analysis": {
                    "traveled": core.path_length, "turns": self.turns, "min_clearance": self.min_clearance,
                    "reference_length": self.reference_length,
                    "path_ratio": (core.path_length / self.reference_length
                                   if self.outcome == "success" and self.reference_length else None),
                    "plan": self.plan_info,
                },
            }
