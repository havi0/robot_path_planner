"""Robot catalog: the single source of truth for every selectable simulated robot.

A robot profile fixes everything that changes how navigation actually behaves:
footprint (collision disc), motion model, action set and speed limits. The sensor is
the same 24-beam 360 deg LiDAR for every robot, because learned policies take that
exact scan as input.

Configuration boundary (see policy_compatibility):
  * "unicycle4" robots (differential, skid-steer, delivery, custom) share the RL
    interface: 29-value observation, 4 actions (forward / turn left / turn right / stop)
    expressed as (v, w). DQN / Q-learning policies can run on them, but a policy is
    only "trained for" the robot whose geometry and dynamics it was trained with.
  * "holonomic8" (mecanum) adds sideways velocity. Policies trained on unicycle4
    cannot drive it; it runs with the holonomic A*/Dijkstra path follower, and RL
    training for it is not offered (the DQN pipeline has not been validated on it).

The reference robot ("diff_drive") is applied as a no-op: the configuration is left
exactly as loaded, so existing behaviour, recordings and checkpoints are unchanged.
"""
import copy
import math

REFERENCE = "diff_drive"
SENSOR = {"num_beams": 24, "fov_deg": 360, "max_range": 3.0}

_BASE = {
    "diff_drive": {
        "name": "Scout",
        "kind": "Differential-drive mobile robot",
        "tagline": "The reference robot every bundled policy was trained on.",
        "description": "Two powered wheels with a passive caster. It drives forward or turns in place; "
                       "it cannot move sideways. Uses the original unicycle kinematics of this project.",
        "drive": "differential", "kinematics": "diff_drive", "action_set": "unicycle4",
        "radius": 0.15, "max_linear": 0.30, "max_angular": 1.20,
        "visual": {"model": "scout", "color": "#eceef4", "length": 0.30, "width": 0.30, "height": 0.14},
        "capabilities": ["Forward motion and in-place rotation", "Exact unicycle kinematics (arc integration)",
                         "Runs DQN, DQN + recovery, Q-learning and A*/Dijkstra followers"],
        "limitations": ["No sideways motion", "No reversing (blocked by the safety layer)"],
        "training": True,
    },
    "skid_steer": {
        "name": "Hauler",
        "kind": "Four-wheeled skid-steer robot",
        "tagline": "Four driven wheels; steers by running left and right sides at different speeds.",
        "description": "Skid-steer, not omnidirectional: like a differential drive it moves forward and turns in place, "
                       "but its wheels scrub sideways when turning, so only part of the commanded turn rate is achieved. "
                       "Modelled as unicycle kinematics with 80% yaw-rate efficiency and a larger 0.20 m footprint.",
        "drive": "skid_steer", "kinematics": "skid_steer", "action_set": "unicycle4",
        "radius": 0.20, "max_linear": 0.30, "max_angular": 1.20,
        "kinematics_params": {"yaw_efficiency": 0.8},
        "visual": {"model": "hauler", "color": "#d7dae3", "length": 0.36, "width": 0.28, "height": 0.16},
        "capabilities": ["Forward motion and in-place rotation (with wheel scrub)", "Larger, sturdier footprint",
                         "Runs learned policies (not trained for it unless you train one) and A*/Dijkstra followers"],
        "limitations": ["No sideways motion", "Turns ~20% slower than commanded (scrub model)",
                        "Collision footprint is the 0.20 m bounding circle of the body"],
        "training": True,
    },
    "mecanum": {
        "name": "Glide",
        "kind": "Omnidirectional mecanum robot",
        "tagline": "Holonomic: slides sideways and diagonally without turning.",
        "description": "Four mecanum wheels let it translate in any direction while keeping its heading. It uses an "
                       "8-action holonomic set (forward, diagonals, strafe left/right, turn, stop) and holonomic kinematics.",
        "drive": "mecanum", "kinematics": "holonomic", "action_set": "holonomic8",
        "radius": 0.18, "max_linear": 0.25, "max_angular": 1.20,
        "visual": {"model": "glide", "color": "#e4e6ee", "length": 0.32, "width": 0.30, "height": 0.13},
        "capabilities": ["Forward, diagonal and sideways translation", "In-place rotation",
                         "Holonomic A*/Dijkstra path follower (moves toward waypoints without turning)",
                         "Safety layer sweeps the true holonomic path before every move"],
        "limitations": ["DQN / Q-learning policies cannot drive it (different action space)",
                        "RL training for this robot is not offered yet"],
        "training": False,
        "training_note": "The DQN pipeline and its observation were designed and validated for 4 (v, w) actions; "
                         "an 8-action holonomic training setup has not been validated.",
    },
    "delivery": {
        "name": "Courier",
        "kind": "Indoor delivery robot",
        "tagline": "A taller differential-drive base with a cargo bay, tuned for calm indoor speeds.",
        "description": "Differential-drive base with a 0.22 m footprint, 0.22 m/s top speed and gentler 1.0 rad/s turns. "
                       "It navigates point to point like the other robots - delivery tasks, payload handling and "
                       "scheduling are not implemented.",
        "drive": "differential", "kinematics": "diff_drive", "action_set": "unicycle4",
        "radius": 0.22, "max_linear": 0.22, "max_angular": 1.00,
        "visual": {"model": "courier", "color": "#f1f2f6", "length": 0.42, "width": 0.40, "height": 0.42},
        "capabilities": ["Forward motion and in-place rotation", "Larger footprint, lower speed limits",
                         "Runs learned policies (not trained for it unless you train one) and A*/Dijkstra followers"],
        "limitations": ["No delivery/payload logic - navigation only", "No sideways motion",
                        "Needs wider gaps than the Scout"],
        "training": True,
    },
}

CUSTOM_LIMITS = {"radius": (0.10, 0.30), "max_linear": (0.05, 0.30), "max_angular": (0.30, 1.50)}
CUSTOM_DRIVES = ("differential", "skid_steer")
VISUAL_KEYS = ("color", "body", "height")


class RobotError(ValueError):
    pass


def catalog():
    """Public description of every robot (custom shown with its defaults)."""
    out = [dict(public(get_profile(k)), id=k) for k in _BASE]
    out.append(dict(public(custom_profile({})), id="custom"))
    return out


def get_profile(robot_id, custom=None):
    if robot_id == "custom":
        return custom_profile(custom or {})
    if robot_id not in _BASE:
        raise RobotError(f"Unknown robot '{robot_id}'")
    p = copy.deepcopy(_BASE[robot_id])
    p.update(id=robot_id, sensor=dict(SENSOR))
    return p


def custom_profile(c):
    """User-defined robot. Only parameters the simulator models are accepted; everything
    under `visual` is cosmetic and never reaches the physics."""
    drive = c.get("drive", "differential")
    if drive not in CUSTOM_DRIVES:
        raise RobotError(f"drive must be one of {', '.join(CUSTOM_DRIVES)}")
    vals = {}
    defaults = {"radius": 0.15, "max_linear": 0.30, "max_angular": 1.20}
    for k, (lo, hi) in CUSTOM_LIMITS.items():
        v = c.get(k, defaults[k])
        try:
            v = float(v)
        except (TypeError, ValueError):
            raise RobotError(f"{k} must be a number") from None
        if not (lo <= v <= hi) or not math.isfinite(v):
            raise RobotError(f"{k} must be between {lo} and {hi} (got {v})")
        vals[k] = round(v, 3)
    vis = c.get("visual") or {}
    color = str(vis.get("color", "#c9c3ff"))
    if not (len(color) == 7 and color.startswith("#") and all(ch in "0123456789abcdefABCDEF" for ch in color[1:])):
        raise RobotError("visual.color must be a #rrggbb colour")
    body = vis.get("body", "round")
    if body not in ("round", "box"):
        raise RobotError("visual.body must be 'round' or 'box'")
    height = float(vis.get("height", 0.16))
    if not 0.08 <= height <= 0.5:
        raise RobotError("visual.height must be between 0.08 and 0.5 m")
    name = str(c.get("name") or "Custom robot")[:40]
    skid = drive == "skid_steer"
    return {
        "id": "custom", "name": name, "kind": "Custom robot",
        "tagline": "Your own footprint, speed limits and look.",
        "description": "Navigation parameters (drive type, footprint radius, speed limits) change the simulation. "
                       "Colour, body shape and height are visual only. The LiDAR stays the standard 24-beam scanner "
                       "so learned policies keep a valid input.",
        "drive": drive, "kinematics": "skid_steer" if skid else "diff_drive", "action_set": "unicycle4",
        **vals,
        **({"kinematics_params": {"yaw_efficiency": 0.8}} if skid else {}),
        "visual": {"model": "custom", "color": color, "body": body, "height": round(height, 3),
                   "length": vals["radius"] * 2, "width": vals["radius"] * 2},
        "capabilities": ["Forward motion and in-place rotation"] + (["Skid-steer scrub model (80% yaw efficiency)"] if skid else []),
        "limitations": ["No sideways motion", "Sensor configuration is fixed (24-beam LiDAR, 3 m)"],
        "training": True, "sensor": dict(SENSOR),
        "custom": {"drive": drive, **vals, "name": name, "visual": {"color": color, "body": body, "height": round(height, 3)}},
    }


def public(p):
    keys = ("id", "name", "kind", "tagline", "description", "drive", "kinematics", "action_set", "radius",
            "max_linear", "max_angular", "visual", "capabilities", "limitations", "training", "training_note",
            "sensor", "kinematics_params", "custom")
    out = {k: p[k] for k in keys if k in p}
    out["actions"] = list(action_dict(p, p["max_linear"], p["max_angular"]).keys())
    out["reference"] = p["id"] == REFERENCE
    return out


def action_dict(p, max_linear, max_angular):
    """Discrete action set for a profile; each action is [v, w] or [v, w, vy]."""
    L, W = float(max_linear), float(max_angular)
    if p["action_set"] == "holonomic8":
        d = L / math.sqrt(2)
        return {"forward": [L, 0.0, 0.0], "forward_left": [d, 0.0, d], "forward_right": [d, 0.0, -d],
                "strafe_left": [0.0, 0.0, L], "strafe_right": [0.0, 0.0, -L],
                "turn_left": [0.0, W, 0.0], "turn_right": [0.0, -W, 0.0], "stop": [0.0, 0.0, 0.0]}
    return {"forward": [L, 0.0], "turn_left": [0.0, W], "turn_right": [0.0, -W], "stop": [0.0, 0.0]}


def apply_profile(cfg, profile, max_linear=None, max_angular=None):
    """Apply a robot profile to a config copy in place. The reference robot is a no-op."""
    if profile["id"] == REFERENCE:
        return cfg
    L = float(max_linear if max_linear is not None else profile["max_linear"])
    W = float(max_angular if max_angular is not None else profile["max_angular"])
    cfg.robot.radius = float(profile["radius"])
    cfg.robot.kinematics = profile["kinematics"]
    cfg.robot.kinematics_params = dict(profile.get("kinematics_params") or {})
    cfg.robot.profile_id = profile["id"]
    from config import Config
    cfg.actions = Config.wrap(action_dict(profile, L, W))
    cfg.safety.max_linear_speed = L
    cfg.safety.max_angular_speed = max(W, 0.3)
    return cfg


def robot_signature(cfg):
    """What a policy trained with `cfg` was trained on (geometry + dynamics + interface)."""
    acts = cfg.actions
    holo = any(len(list(a)) > 2 for a in acts.values())
    return {
        "kinematics": cfg.robot.get("kinematics", "diff_drive"),
        "yaw_efficiency": float((cfg.robot.get("kinematics_params") or {}).get("yaw_efficiency", 1.0)),
        "radius": round(float(cfg.robot.radius), 4),
        "max_linear": round(float(acts["forward"][0]), 4),
        "max_angular": round(float(acts["turn_left"][1]), 4),
        "action_set": "holonomic8" if holo else "unicycle4",
        "actions": list(acts.keys()),
        "sensor": {"num_beams": int(cfg.sensor.num_beams), "fov_deg": float(cfg.sensor.fov_deg), "max_range": float(cfg.sensor.max_range)},
    }


def profile_signature(p, max_linear=None, max_angular=None):
    return {
        "kinematics": p["kinematics"],
        "yaw_efficiency": float((p.get("kinematics_params") or {}).get("yaw_efficiency", 1.0)),
        "radius": round(float(p["radius"]), 4),
        "max_linear": round(float(max_linear if max_linear is not None else p["max_linear"]), 4),
        "max_angular": round(float(max_angular if max_angular is not None else p["max_angular"]), 4),
        "action_set": p["action_set"],
        "actions": list(action_dict(p, 1, 1).keys()),
        "sensor": {k: (float(v) if k != "num_beams" else int(v)) for k, v in p["sensor"].items()},
    }


LEARNED = ("dqn", "dqn_recovery", "qlearning")


def policy_compatibility(policy_key, profile, model_cfg, max_linear=None, max_angular=None):
    """Explicit compatibility verdict for running `policy_key` on `profile`.

    status: "trained"      - the model was trained for exactly this robot configuration
            "unvalidated"  - same observation/action interface, different robot: it will run,
                             but behaviour is untested (retrain or validate before relying on it)
            "incompatible" - different interface; the policy cannot drive this robot
            "planner"      - classical planner + path follower suited to the robot's kinematics
            "unavailable"  - no model loaded
    """
    if policy_key not in LEARNED:
        follower = "holonomic path follower" if profile["action_set"] == "holonomic8" else "turn-then-drive path follower"
        return {"status": "planner", "ok": True, "detail": f"Plans on the known map with this robot's {profile['radius']:.2f} m footprint; executed by the {follower}."}
    if model_cfg is None:
        return {"status": "unavailable", "ok": False, "detail": "No model of this type is loaded."}
    trained = robot_signature(model_cfg)
    want = profile_signature(profile, max_linear, max_angular)
    if trained["action_set"] != want["action_set"] or trained["actions"] != want["actions"]:
        return {"status": "incompatible", "ok": False,
                "detail": f"The policy outputs {len(trained['actions'])} {trained['action_set']} actions; the {profile['name']} uses "
                          f"{len(want['actions'])} {want['action_set']} actions. A policy trained for this action space is required."}
    if trained["sensor"] != want["sensor"]:
        return {"status": "incompatible", "ok": False, "detail": "The policy was trained with a different LiDAR configuration."}
    diffs = []
    if trained["kinematics"] != want["kinematics"] or abs(trained["yaw_efficiency"] - want["yaw_efficiency"]) > 1e-6:
        diffs.append(f"{trained['kinematics'].replace('_', ' ')} kinematics (this robot: {want['kinematics'].replace('_', ' ')})")
    if abs(trained["radius"] - want["radius"]) > 1e-6:
        diffs.append(f"a {trained['radius']:.2f} m footprint (this robot: {want['radius']:.2f} m)")
    if abs(trained["max_linear"] - want["max_linear"]) > 1e-6 or abs(trained["max_angular"] - want["max_angular"]) > 1e-6:
        diffs.append(f"{trained['max_linear']:.2f} m/s / {trained['max_angular']:.2f} rad/s actions "
                     f"(this robot: {want['max_linear']:.2f} / {want['max_angular']:.2f})")
    if not diffs:
        return {"status": "trained", "ok": True, "detail": "Trained for this robot configuration."}
    return {"status": "unvalidated", "ok": True,
            "detail": "Same observation and action interface, but the policy was trained with " + "; ".join(diffs) +
                      ". It will run, but its behaviour on this robot has not been validated - retrain it for this robot "
                      "in the Training Lab or check it on the Reliability page before relying on it."}
