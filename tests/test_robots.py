"""Robot selection: kinematics, action sets, safety for holonomic motion, policy
compatibility, live-session integration, exact replay and the API."""
import copy
import math
import os
import sys
import warnings

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
warnings.filterwarnings("ignore")

from config import load_config  # noqa: E402
from environment.robot import DiffDriveModel, HolonomicModel, RobotState, SkidSteerModel, make_motion_model  # noqa: E402
from navigation import robots as R  # noqa: E402
from navigation.actions import DiscreteActionSpace, VelocityCommand  # noqa: E402
from safety.safety_layer import SafetyLayer  # noqa: E402
from sensors.types import SensorReading  # noqa: E402


@pytest.fixture
def cfg():
    return load_config()


# ------------------------------------------------------------------ catalog / config boundary
def test_reference_profile_is_a_no_op(cfg):
    before = copy.deepcopy(cfg)
    R.apply_profile(cfg, R.get_profile("diff_drive"))
    assert cfg == before


def test_every_catalog_robot_has_accurate_interface(cfg):
    ids = [r["id"] for r in R.catalog()]
    assert ids == ["diff_drive", "skid_steer", "mecanum", "delivery", "custom"]
    for rid in ids:
        p = R.get_profile(rid)
        c = R.apply_profile(copy.deepcopy(cfg), p)
        acts = DiscreteActionSpace.from_config(c)
        assert p["sensor"] == R.SENSOR
        if p["action_set"] == "holonomic8":
            assert any(cmd.vy for cmd in acts.commands) and not p["training"]
        else:
            assert acts.names == ["forward", "turn_left", "turn_right", "stop"]
            assert all(cmd.vy == 0 for cmd in acts.commands)
        assert c.robot.radius == p["radius"]


def test_custom_robot_validation():
    p = R.get_profile("custom", {"drive": "skid_steer", "radius": 0.25, "max_linear": 0.2, "max_angular": 1.0,
                                 "visual": {"color": "#ff8800", "body": "box", "height": 0.3}})
    assert p["kinematics"] == "skid_steer" and p["radius"] == 0.25 and p["visual"]["color"] == "#ff8800"
    for bad in ({"radius": 0.5}, {"max_linear": 2.0}, {"drive": "mecanum"}, {"visual": {"color": "red"}},
                {"visual": {"height": 3}}, {"radius": "abc"}):
        with pytest.raises(R.RobotError):
            R.get_profile("custom", bad)


def test_action_space_parses_optional_vy():
    a = DiscreteActionSpace({"forward": (0.3, 0.0), "strafe_left": (0.0, 0.0, 0.25)})
    assert a.commands[0] == VelocityCommand(0.3, 0.0) and a.commands[0].vy == 0.0
    assert a.commands[1].vy == 0.25


# ------------------------------------------------------------------ kinematics
def test_diff_drive_factory_is_the_original_model():
    m = make_motion_model("diff_drive", 0.15)
    assert type(m) is DiffDriveModel
    assert type(make_motion_model(None, 0.15)) is DiffDriveModel


def test_skid_steer_achieves_reduced_yaw_rate():
    m = SkidSteerModel(0.2, yaw_efficiency=0.8)
    s = m.integrate(RobotState(0, 0, 0), 0.0, 1.0, 1.0)
    assert s.theta == pytest.approx(0.8)
    s = m.integrate(RobotState(0, 0, 0), 0.3, 0.0, 1.0)
    assert (s.x, s.y) == pytest.approx((0.3, 0.0))


def test_holonomic_strafe_and_exact_integration():
    m = HolonomicModel(0.18)
    s = m.integrate(RobotState(1, 1, math.pi / 2), 0.0, 0.0, 1.0, 0.3)       # facing +y, strafe left -> -x
    assert (s.x, s.y, s.theta) == pytest.approx((0.7, 1.0, math.pi / 2))
    # translating while rotating: closed form vs. fine numerical integration
    v, vy, w, T = 0.25, -0.1, 0.9, 1.3
    exact = m.integrate(RobotState(0, 0, 0.4), v, w, T, vy)
    x, y, th, n = 0.0, 0.0, 0.4, 20000
    for _ in range(n):
        x += (v * math.cos(th) - vy * math.sin(th)) * T / n
        y += (v * math.sin(th) + vy * math.cos(th)) * T / n
        th += w * T / n
    assert (exact.x, exact.y) == pytest.approx((x, y), abs=1e-4)


# ------------------------------------------------------------------ safety layer, holonomic branch
def _wall_reading(x_wall_left):
    """Dense scan of a wall at y = +x_wall_left (to the robot's left)."""
    ang = np.linspace(-math.pi, math.pi, 720, endpoint=False)
    rng = np.where(np.sin(ang) > 1e-6, x_wall_left / np.maximum(np.sin(ang), 1e-6), np.inf)
    rng = np.minimum(rng, 3.0)
    return SensorReading(rng, ang, 3.0, 0.0, safety_ranges=rng.copy(), safety_angles=ang.copy())


def test_safety_blocks_strafing_into_wall_but_allows_away(cfg):
    sl = SafetyLayer(cfg.safety, 0.18)
    near = _wall_reading(0.27)                       # wall 9 cm beyond the footprint, on the left
    d = sl.filter(VelocityCommand(0.0, 0.0, 0.25), near, 0.0, True, 0.25)
    assert "proximity_stop" in d.reasons and d.command.vy == 0 and d.command.v == 0
    sl.reset_motion_state()
    d = sl.filter(VelocityCommand(0.0, 0.0, -0.25), near, 0.0, True, 0.25)
    assert "proximity_stop" not in d.reasons and d.command.vy < 0
    far = _wall_reading(2.5)
    sl.reset_motion_state()
    d = sl.filter(VelocityCommand(0.0, 0.0, 0.25), far, 0.0, True, 0.25)
    assert "proximity_stop" not in d.reasons


def test_safety_unchanged_for_unicycle_commands(cfg):
    """vy = 0 must take exactly the original path and return an identical command object."""
    sl = SafetyLayer(cfg.safety, 0.15)
    r = _wall_reading(1.0)
    d = sl.filter(VelocityCommand(0.3, 0.5), r, 0.0, True, 0.25)
    assert d.command == VelocityCommand(d.command.v, d.command.w) and d.command.vy == 0


# ------------------------------------------------------------------ policy compatibility (explicit, not assumed)
def test_policy_compatibility_verdicts(cfg):
    model_cfg = copy.deepcopy(cfg)                  # a policy trained on the reference robot
    ref, skid, mec, dlv = (R.get_profile(k) for k in ("diff_drive", "skid_steer", "mecanum", "delivery"))
    assert R.policy_compatibility("dqn", ref, model_cfg)["status"] == "trained"
    assert R.policy_compatibility("dqn", skid, model_cfg)["status"] == "unvalidated"
    assert R.policy_compatibility("dqn", dlv, model_cfg)["status"] == "unvalidated"
    assert R.policy_compatibility("dqn", mec, model_cfg)["status"] == "incompatible"
    assert R.policy_compatibility("dqn", ref, None)["status"] == "unavailable"
    assert R.policy_compatibility("astar", mec, model_cfg)["status"] == "planner"
    # a policy trained FOR the skid-steer robot is "trained" there and unvalidated on the reference
    skid_cfg = R.apply_profile(copy.deepcopy(cfg), skid)
    assert R.policy_compatibility("dqn", skid, skid_cfg)["status"] == "trained"
    assert R.policy_compatibility("dqn", ref, skid_cfg)["status"] == "unvalidated"
    # changing the reference robot's speed in the live sim makes the bundled policy unvalidated
    assert R.policy_compatibility("dqn", ref, model_cfg, 0.2, 1.2)["status"] == "unvalidated"


# ------------------------------------------------------------------ live session
class _Events:
    def __init__(self):
        self.items = []

    def emit(self, level, cat, msg):
        self.items.append((level, cat, msg))


class _Models:
    def __init__(self, entries):
        self.entries = entries

    def get(self, k):
        return self.entries.get(k)


@pytest.fixture
def session(cfg):
    from server.sim_session import SimSession
    ref_cfg = copy.deepcopy(cfg)
    return SimSession(cfg, _Models({"dqn": (object(), ref_cfg, {"path": "x"})}), _Events())


def _run(sess, max_steps=600):
    sess.control("start")
    sess.status = "paused"                     # drive it synchronously (no thread in tests)
    for _ in range(max_steps):
        if sess.outcome:
            break
        sess._step()
    return sess.outcome


def test_session_mecanum_switches_controller_and_reaches_goal(session):
    assert session.policy_key == "dqn_recovery"
    notes = session.select_robot("mecanum", regenerate=True)
    assert session.policy_key == "astar" and any("cannot drive" in n for n in notes)
    assert session.env.backend.model.__class__.__name__ == "HolonomicModel"
    assert session.cfg.robot.radius == 0.18 and "strafe_left" in session.env.action_set.names
    snap = session.snapshot()
    assert snap["robot_profile"]["id"] == "mecanum" and snap["policy_compat"]["dqn"]["status"] == "incompatible"
    from server.sim_session import ValidationError
    with pytest.raises(ValidationError):
        session.set_policy("dqn")              # refused, not silently run
    assert _run(session) == "success"
    assert not session.collisions
    used = set(session.rec["action"])
    assert used & {"forward_left", "forward_right", "strafe_left", "strafe_right"}   # it really moved holonomically
    assert session.rec_conditions["robot"]["id"] == "mecanum"


def test_session_keeps_map_when_robot_fits_and_refuses_when_not(session):
    from server.sim_session import RobotFitError
    rects = session.base_world.rects.copy()
    session.select_robot("skid_steer")
    assert np.array_equal(session.base_world.rects, rects)          # environment preserved
    assert session.cfg.robot.kinematics == "skid_steer"
    assert session.policy_compat("dqn")["status"] == "unvalidated"
    w = session.base_world
    w.goal = (w.width - 0.24, w.height / 2)                           # fits 0.20 m, not 0.30 m
    with pytest.raises(RobotFitError):
        session.select_robot("custom", {"radius": 0.30})
    assert session.robot["id"] == "skid_steer"                        # unchanged after refusal


def test_reference_robot_session_unchanged(session, cfg):
    session.select_robot("delivery", regenerate=True)
    session.select_robot("diff_drive", regenerate=True)
    assert session.cfg.robot.get("kinematics") is None and session.cfg.robot.radius == cfg.robot.radius
    assert "robot" not in session.rec_conditions


# ------------------------------------------------------------------ exact replay with a non-reference robot
def test_mecanum_episode_replays_exactly(cfg, session):
    from evaluation.recorder import record_episode, resimulate_to
    from scenarios.io import world_to_dict
    session.select_robot("mecanum", regenerate=True)
    cond = dict(session.rec_conditions)
    ep = record_episode(cfg, world_to_dict(session.base_world), "astar", cond, int(session.config["seed"]), source="test")
    assert ep["outcome"] == "success"
    k = len(ep["steps"]["action"])
    _, rest = resimulate_to(cfg, ep, k)
    assert rest["exact"], rest


# ------------------------------------------------------------------ API
def test_robot_api_and_training_boundary(tmp_path):
    from fastapi.testclient import TestClient
    from server.app import create_app
    app = create_app(data_dir=str(tmp_path), broadcast_hz=5)
    with TestClient(app) as c:
        r = c.get("/api/robots").json()
        assert [x["id"] for x in r["robots"]][:4] == ["diff_drive", "skid_steer", "mecanum", "delivery"]
        assert r["selected"]["id"] == "diff_drive"
        r = c.post("/api/robots/select", json={"id": "mecanum", "regenerate": True}).json()
        assert r["selected"]["id"] == "mecanum" and r["compatibility"]["astar"]["ok"]
        assert c.get("/api/sim/state").json()["robot_profile"]["id"] == "mecanum"
        assert c.post("/api/robots/select", json={"id": "nope"}).status_code == 400
        bad = c.post("/api/training/start", json={"name": "omni", "episodes": 5, "robot": {"id": "mecanum"}})
        assert bad.status_code == 400 and "not available" in bad.json()["detail"]
        assert os.path.exists(os.path.join(str(tmp_path), "robot_selection.json"))
    # selection survives a restart
    with TestClient(create_app(data_dir=str(tmp_path), broadcast_hz=5)) as c:
        assert c.get("/api/robots").json()["selected"]["id"] == "mecanum"
