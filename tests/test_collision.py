"""Collision, safety-layer and learning-correctness tests (navigation reliability fix).

Every committed robot pose must keep the circular footprint outside obstacle
geometry and inside the arena; collisions must be detected along the path, at
any speed, and the robot must stop at the contact point (never inside an
obstacle, never teleported)."""
import math
import os
import sys
import warnings

import numpy as np
import pytest
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
warnings.filterwarnings("ignore")

from agent.dqn import DQNAgent  # noqa: E402
from backends.simulation_backend import SimulationBackend  # noqa: E402
from config import load_config  # noqa: E402
from environment.nav_env import NavigationEnv  # noqa: E402
from environment.world import World  # noqa: E402
from navigation.actions import VelocityCommand  # noqa: E402
from safety.safety_layer import SafetyLayer  # noqa: E402
from sensors.types import SensorReading, beam_angles  # noqa: E402

CFG = load_config()
R = CFG.robot.radius
DT = CFG.robot.control_dt


def backend(world):
    b = SimulationBackend(CFG)
    b.new_episode(map_seed=1, world=world)
    return b


def footprint_ok(b):
    """Footprint does not overlap static obstacles or leave the arena."""
    return not b.world.collides(b.state.x, b.state.y, R - 1e-9, include_movers=False)


def drive(b, v, w=0.0, steps=40):
    for _ in range(steps):
        b.send_command(VelocityCommand(v, w))
        b.wait(DT)
        assert footprint_ok(b), "committed pose overlaps an obstacle"
        if b.collided:
            break
    return b


# 1. moving directly toward a wall, several speeds
@pytest.mark.parametrize("v", [0.1, 0.3, 1.0, 5.0])
def test_drive_straight_into_wall(v):
    b = drive(backend(World(6, 6, [[3.0, 0, 3.3, 6]], (1.0, 3.0, 0.0), (5.5, 3))), v, steps=400)
    assert b.collided and b.collision_info["kind"] == "static_obstacle"
    assert 0 <= 3.0 - (b.state.x + R) < 1e-3                 # stopped AT the contact point


# 2. approaching an obstacle at an angle, several headings
@pytest.mark.parametrize("deg", [-60, -30, 20, 45, 70])
def test_approach_at_angle(deg):
    th = math.radians(deg)
    b = drive(backend(World(6, 6, [[3.0, 0, 3.3, 6]], (2.3, 3.0, th), (5.5, 3))), 0.3, steps=200)
    assert b.collided and footprint_ok(b)
    assert abs(b.collision_info["x"] - 3.0) < 1e-6           # contact point lies on the wall face


# 3. thin obstacle at high speed: no tunnelling (regression: fixed sub-step count tunnelled at 15 m/s)
@pytest.mark.parametrize("v", [0.3, 3.0, 15.0, 50.0])
def test_no_tunnelling_through_thin_wall(v):
    b = backend(World(6, 6, [[3.0, 0, 3.01, 6]], (2.5, 3.0, 0.0), (5.5, 3)))
    b.send_command(VelocityCommand(v, 0))
    b.wait(DT)
    assert b.state.x + R <= 3.0 + 1e-9, "robot passed through the wall"
    if v * DT > 0.35:
        assert b.collided


# 4. turning in place close to a corner (circular footprint: rotation never sweeps new area)
def test_turning_next_to_a_corner_is_collision_free():
    w = World(6, 6, [[3.0, 3.0, 4.0, 4.0]], (3.0 - R - 0.001, 3.0 - R - 0.001, 0.0), (0.5, 0.5))
    b = backend(w)
    x0, y0 = b.state.x, b.state.y
    drive(b, 0.0, 1.2, steps=30)
    assert not b.collided and (b.state.x, b.state.y) == (x0, y0)


# 5. narrow passage: passable when wider than the robot, blocked when narrower
@pytest.mark.parametrize("gap,passable", [(2 * R + 0.04, True), (2 * R - 0.02, False)])
def test_narrow_passage(gap, passable):
    y0, y1 = 3.0 - gap / 2, 3.0 + gap / 2
    w = World(6, 6, [[2.5, 0.0, 3.5, y0], [2.5, y1, 3.5, 6.0]], (1.5, 3.0, 0.0), (5.5, 3.0))
    b = drive(backend(w), 0.3, steps=40)             # 3 m: through the passage, short of the far wall
    assert (b.state.x > 3.5) == passable and b.collided != passable


# 6. map edges in every direction
@pytest.mark.parametrize("deg", [0, 90, 180, 270, 45])
def test_map_boundary(deg):
    b = drive(backend(World(4, 4, [], (2.0, 2.0, math.radians(deg)), (3.5, 3.5))), 0.3, steps=100)
    assert b.collided and b.collision_info["kind"] == "boundary"
    s = b.state
    assert R - 1e-6 <= s.x <= 4 - R + 1e-6 and R - 1e-6 <= s.y <= 4 - R + 1e-6


# 7. every translation unsafe -> no translation (stop / rotate in place); invalid data -> full stop
def reading(ranges, ts=0.0):
    r = np.asarray(ranges, dtype=float)
    return SensorReading(r, beam_angles(len(r), 360), 3.0, ts)


def test_all_movements_unsafe():
    s = SafetyLayer(CFG.safety, R)
    boxed = reading([R + 0.03] * 24)
    for v, w in ((0.3, 0.0), (0.3, 1.0), (-0.2, 0.0), (0.3, -1.2)):
        s.last_output = VelocityCommand(0, 0)
        d = s.filter(VelocityCommand(v, w), boxed, 0.0, True, DT)
        assert d.command.v == 0.0 and ({"proximity_stop", "reverse_blocked"} & set(d.reasons))
    blind = s.filter(VelocityCommand(0.3, 1.0), reading([np.nan] * 24), 0.0, True, DT)
    assert blind.command == VelocityCommand(0.0, 0.0)


def test_safety_layer_sweeps_arcs_not_just_straight_lines():
    s = SafetyLayer(CFG.safety, R)
    ang = beam_angles(24, 360)
    r = np.full(24, 3.0)
    i = int(np.argmin(np.abs(ang - math.radians(60))))       # obstacle 60 deg to the LEFT
    r[i] = 0.24
    rd = SensorReading(r, ang, 3.0, 0.0)
    assert s.filter(VelocityCommand(0.3, 0.0), rd, 0.0, True, DT).command.v == 0.3     # straight past it: clear
    s.last_output = VelocityCommand(0.3, 0)
    assert s.filter(VelocityCommand(0.3, 1.5), rd, 0.0, True, DT).command.v == 0.0    # arc into it: blocked


def test_moving_away_from_close_obstacle_is_allowed():
    s = SafetyLayer(CFG.safety, R)
    r = np.full(24, 3.0)
    r[0] = R + 0.02                                            # obstacle directly BEHIND (angle -180)
    assert s.filter(VelocityCommand(0.3, 0.0), reading(r), 0.0, True, DT).command.v > 0


@pytest.mark.parametrize("sizes", [(0.3, 1.0), (0.12, 0.3)])
def test_shielded_motion_never_collides_with_static_obstacles(sizes):
    """Adversarial random commands behind the safety layer, incl. small clutter whose corners fall
    between policy beams (regression: corner clipping with the 24-beam-only safety check)."""
    import copy
    cfg = copy.deepcopy(CFG)
    cfg.world.obstacle_size = list(sizes)
    hits = 0
    for seed in range(40):
        b = SimulationBackend(cfg)
        b.new_episode(map_seed=seed, density=0.3)
        s = SafetyLayer(cfg.safety, R)
        rng = np.random.default_rng(seed)
        for _ in range(150):
            req = VelocityCommand(float(rng.choice([0.3, 0.3, 0.0])), float(rng.choice([-1.2, 0.0, 1.2])))
            d = s.filter(req, b.read_sensors(), b.now(), True, DT)
            b.send_command(d.command)
            b.wait(DT)
            assert footprint_ok(b)
            if b.collided:
                hits += 1
                break
    assert hits == 0, f"{hits} static collisions with the safety layer active"


def test_corner_between_policy_beams_is_seen_by_the_safety_scan():
    """Regression for a recorded shielded collision: a box corner 0.17 m away at -53 deg, between the
    -60 and -45 deg policy beams (which both read farther). The dense safety scan must block forward."""
    from sensors.range_sensor import SimulatedRangeSensor
    cx, cy = 3.0 + 0.171 * math.cos(math.radians(-53)), 3.0 + 0.171 * math.sin(math.radians(-53))
    w = World(6, 6, [[cx, cy - 0.6, cx + 0.6, cy]], (3.0, 3.0, 0.0), (5.5, 5.5))
    sensor = SimulatedRangeSensor(24, 360, 3.0)
    rd = sensor.scan(w, 3.0, 3.0, 0.0, 0.0)
    s = SafetyLayer(CFG.safety, R)
    assert s.motion_blocked(rd, 0.3, 0.0, DT)


# 8. collision detected during an intermediate part of the movement
def test_collision_detected_mid_step():
    b = backend(World(6, 6, [[2.6, 0, 2.7, 6]], (2.38, 3.0, 0.0), (5.5, 3)))   # contact after 7 cm of a 7.5 cm move
    b.send_command(VelocityCommand(0.3, 0))
    b.wait(DT)
    assert b.collided and 0.06 < b.state.x - 2.38 < 0.075 and footprint_ok(b)


# 9. reset after collision
def test_reset_after_collision():
    env = NavigationEnv(CFG, mode="eval")
    env.reset(options={"map_seed": 1, "world": World(6, 6, [[2.0, 0, 2.2, 6]], (1.6, 3, 0), (5, 3))})
    fwd = env.action_set.index_of("forward")
    for _ in range(20):
        _, r, term, _, info = env.step(fwd)
        if term:
            break
    assert info["collision"] and info["collision_info"]["kind"] == "static_obstacle" and info["reward_terms"]["collision"] < 0
    obs, _ = env.reset(options={"map_seed": 2})
    b = env.backend
    assert not b.collided and b.collision_info is None and (b.state.x, b.state.y) == tuple(b.world.start[:2])
    _, _, term, _, info = env.step(env.action_set.index_of("turn_left"))
    assert not info["collision"]


# 10. committed poses never overlap, random driving on random maps with timed obstacles
def test_committed_poses_never_overlap_fuzz():
    rng = np.random.default_rng(0)
    for seed in range(40):
        b = SimulationBackend(CFG)
        b.new_episode(map_seed=seed, density=float(rng.uniform(0.05, 0.35)))
        for _ in range(120):
            b.send_command(VelocityCommand(float(rng.choice([0.3, 0.0, 1.5])), float(rng.choice([-1.2, 0.0, 1.2]))))
            b.wait(DT)
            assert footprint_ok(b)
            if b.collided:
                break


# ---------------------------------------------------------------- learning correctness
def test_bellman_targets_terminal_and_double_dqn():
    torch.manual_seed(0)
    agent = DQNAgent(29, 4, CFG.dqn, seed=0)
    nxt = torch.randn(5, 29)
    rew = torch.tensor([1.0, -10.0, 0.5, 0.0, 2.0])
    done = torch.tensor([0.0, 1.0, 0.0, 1.0, 0.0])
    t = agent.td_targets(rew, nxt, done)
    with torch.no_grad():
        best = agent.q(nxt).argmax(1)
        qn = agent.q_target(nxt)[torch.arange(5), best]
    expected = rew + CFG.dqn.gamma * (1 - done) * qn
    assert torch.allclose(t, expected)
    assert t[1] == -10.0 and t[3] == 0.0                      # terminal transitions do not bootstrap


def test_replay_buffer_stores_transitions_exactly():
    agent = DQNAgent(4, 2, CFG.dqn, seed=0)
    agent.buffer.add(np.ones(4, np.float32), 1, -2.5, np.zeros(4, np.float32), True)
    o, a, r, n, d = agent.buffer.sample(3)
    assert torch.all(a == 1) and torch.all(r == -2.5) and torch.all(d == 1.0) and torch.all(o == 1) and torch.all(n == 0)


def test_reward_terms_sum_to_reward():
    env = NavigationEnv(CFG, mode="eval")
    env.reset(options={"map_seed": 3})
    for a in (0, 1, 2, 1, 3, 0):
        _, r, term, trunc, info = env.step(a)
        assert abs(sum(info["reward_terms"].values()) - r) < 1e-9
        if term:
            break


def test_crashing_is_never_cheaper_than_failing_slowly():
    """Regression for the measured reward flaw: the collision penalty must exceed the discounted
    cost of any non-terminal behaviour (waiting/dithering/stopping next to an obstacle)."""
    rc, g = CFG.reward, CFG.dqn.gamma
    near = abs(rc.step) + abs(rc.proximity_penalty)
    worst_loop = max(near + abs(rc.turn_reversal_penalty), near + abs(rc.stop_penalty)) / (1 - g)
    assert abs(rc.collision) > worst_loop, (rc.collision, worst_loop)
