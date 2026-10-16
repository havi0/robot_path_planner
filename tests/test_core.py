import math
import os
import sys
import warnings

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
warnings.filterwarnings("ignore")

from backends.fault_injection import FaultInjectionBackend  # noqa: E402
from backends.simulation_backend import SimulationBackend  # noqa: E402
from baselines.grid_planners import astar, dijkstra  # noqa: E402
from config import load_config  # noqa: E402
from environment.geometry import raycast  # noqa: E402
from environment.nav_env import NavigationEnv  # noqa: E402
from environment.robot import DiffDriveModel, RobotState, twist_to_wheel_speeds, wheel_speeds_to_twist  # noqa: E402
from environment.world import World, generate_world  # noqa: E402
from navigation.actions import STOP, VelocityCommand  # noqa: E402
from safety.safety_layer import SafetyLayer  # noqa: E402
from sensors.processing import resample_scan  # noqa: E402
from sensors.types import SensorReading, beam_angles  # noqa: E402


@pytest.fixture
def cfg():
    return load_config()


def reading(ranges, ts=0.0, fov=360):
    r = np.asarray(ranges, dtype=float)
    return SensorReading(r, beam_angles(len(r), fov), 3.0, ts)


# ---------------- geometry / kinematics ----------------
def test_raycast_box_and_boundary():
    rects = np.array([[2.0, 0.0, 3.0, 6.0]])
    d = raycast(1.0, 3.0, np.array([0.0, math.pi, math.pi / 2]), rects, np.zeros((0, 3)), 6, 6, 10)
    assert d[0] == pytest.approx(1.0)        # obstacle face at x=2
    assert d[1] == pytest.approx(1.0)        # arena wall at x=0
    assert d[2] == pytest.approx(3.0)        # arena wall at y=6


def test_raycast_circle():
    d = raycast(0.5, 1.0, np.array([0.0]), np.zeros((0, 4)), np.array([[2.0, 1.0, 0.5]]), 6, 6, 10)
    assert d[0] == pytest.approx(1.0)


def test_unicycle_straight_and_turn():
    m = DiffDriveModel(0.15)
    s = m.integrate(RobotState(0, 0, 0), 1.0, 0.0, 1.0)
    assert (s.x, s.y) == pytest.approx((1.0, 0.0))
    s = m.integrate(RobotState(0, 0, 0), 0.0, math.pi / 2, 1.0)
    assert s.theta == pytest.approx(math.pi / 2)
    assert (s.x, s.y) == pytest.approx((0.0, 0.0))


def test_wheel_conversion_roundtrip():
    wl, wr = twist_to_wheel_speeds(0.2, 0.7, 0.23, 0.033)
    assert wheel_speeds_to_twist(wl, wr, 0.23, 0.033) == pytest.approx((0.2, 0.7))


def test_generated_world_is_solvable(cfg):
    rng = np.random.default_rng(3)
    for _ in range(5):
        w = generate_world(cfg.world, cfg.robot.radius, rng, density=0.25)
        assert not w.collides(*w.start[:2], cfg.robot.radius)
        assert astar(w, w.start[:2], w.goal, 0.05, cfg.robot.radius + 0.02).path


# ---------------- sensors ----------------
def test_resample_scan_takes_sector_minimum():
    src = np.full(360, 2.0)
    src[0] = 0.5                                   # obstacle straight ahead
    src[90] = np.inf                               # no return
    out = resample_scan(src, 0.0, math.radians(1), beam_angles(4, 360), 3.0)
    ahead = int(np.argmin(np.abs(beam_angles(4, 360))))
    assert out[ahead] == pytest.approx(0.5)
    assert np.all(out <= 3.0)


# ---------------- safety layer ----------------
def test_velocity_clamped(cfg):
    s = SafetyLayer(cfg.safety, cfg.robot.radius)
    s.last_output = VelocityCommand(cfg.safety.max_linear_speed, cfg.safety.max_angular_speed)
    d = s.filter(VelocityCommand(3.0, 9.0), reading([3.0] * 24), 0.0, True, 0.25)
    assert d.command.v <= cfg.safety.max_linear_speed and d.command.w <= cfg.safety.max_angular_speed
    assert "velocity_limited" in d.reasons


def test_obstacle_ahead_blocks_forward_but_allows_turning(cfg):
    s = SafetyLayer(cfg.safety, cfg.robot.radius)
    r = [3.0] * 24
    r[12] = 0.2                                     # beam index 12 = 0 rad (ahead) for 24 beams/360 deg
    assert beam_angles(24, 360)[12] == pytest.approx(0.0)
    assert s.filter(VelocityCommand(0.3, 0.0), reading(r), 0.0, True, 0.25).command.v == 0.0
    assert s.filter(VelocityCommand(0.0, 1.2), reading(r), 0.0, True, 0.25).command.w != 0.0


def test_side_corner_in_swept_corridor_blocks(cfg):
    s = SafetyLayer(cfg.safety, cfg.robot.radius)
    r = [3.0] * 24
    r[12 - 4] = 0.19                                # -60 deg, inside the body's swept corridor
    assert s.filter(VelocityCommand(0.3, 0.0), reading(r), 0.0, True, 0.25).command.v == 0.0


def test_stale_sensor_and_comm_loss_stop(cfg):
    s = SafetyLayer(cfg.safety, cfg.robot.radius)
    fwd = VelocityCommand(0.3, 0.0)
    assert s.filter(fwd, reading([3.0] * 24, ts=0.0), 5.0, True, 0.25).command == STOP
    assert s.filter(fwd, reading([3.0] * 24), 0.0, False, 0.25).command == STOP
    assert s.filter(fwd, None, 0.0, True, 0.25).command == STOP
    assert s.filter(fwd, reading([np.nan] * 24), 0.0, True, 0.25).command == STOP


def test_estop_latches_until_reset(cfg):
    s = SafetyLayer(cfg.safety, cfg.robot.radius)
    s.estop.trigger("test")
    for _ in range(3):
        assert s.filter(VelocityCommand(0.3, 0), reading([3.0] * 24), 0.0, True, 0.25).command == STOP
    s.estop.reset()
    assert s.filter(VelocityCommand(0.3, 0), reading([3.0] * 24), 0.0, True, 0.25).command.v > 0


def test_nan_command_rejected(cfg):
    s = SafetyLayer(cfg.safety, cfg.robot.radius)
    assert s.filter(VelocityCommand(float("nan"), 0), reading([3.0] * 24), 0.0, True, 0.25).command == STOP


def test_acceleration_limit_ramps_up_but_stops_immediately(cfg):
    s = SafetyLayer(cfg.safety, cfg.robot.radius)
    dt = 0.05
    d = s.filter(VelocityCommand(0.3, 0), reading([3.0] * 24), 0.0, True, dt)
    assert d.command.v == pytest.approx(cfg.safety.max_linear_accel * dt)
    s.last_output = VelocityCommand(0.3, 0)
    assert s.filter(STOP, reading([3.0] * 24), 0.0, True, dt).command == STOP


# ---------------- planners ----------------
def test_astar_and_dijkstra_agree_on_length(cfg):
    w = generate_world(cfg.world, cfg.robot.radius, np.random.default_rng(7), density=0.2)
    a = astar(w, w.start[:2], w.goal, 0.05, 0.2)
    d = dijkstra(w, w.start[:2], w.goal, 0.05, 0.2)
    assert a.path and d.path
    assert a.length == pytest.approx(d.length, rel=0.05)
    assert a.expanded <= d.expanded


def test_planner_reports_no_path_when_blocked():
    w = World(6, 6, [[2.9, 0, 3.1, 6]], (1, 3, 0), (5, 3))
    assert astar(w, (1, 3), (5, 3), 0.05, 0.17).path == []


# ---------------- environment / backend interface ----------------
def test_gymnasium_api(cfg):
    from gymnasium.utils.env_checker import check_env
    check_env(NavigationEnv(cfg), skip_render_check=True)


def test_episode_reproducible_from_seed(cfg):
    a, b = SimulationBackend(cfg), SimulationBackend(cfg)
    assert a.new_episode(map_seed=42) == b.new_episode(map_seed=42)
    assert np.allclose(a.world.rects, b.world.rects)


def test_collision_terminates_episode(cfg):
    env = NavigationEnv(cfg, mode="eval")
    env.reset(options={"map_seed": 1, "world": World(6, 6, [[2.0, 0, 2.2, 6]], (1.6, 3, 0), (5, 3))})
    fwd = env.action_set.index_of("forward")
    for _ in range(20):
        _, r, term, _, info = env.step(fwd)
        if term:
            break
    assert info["collision"] and r < 0


def test_fault_injection_backend_satisfies_interface(cfg):
    b = SimulationBackend(cfg)
    b.new_episode(map_seed=0)
    f = FaultInjectionBackend(b, comm_loss_at=0.5)
    assert f.is_connected()
    f.wait(0.5)
    assert not f.is_connected()


def test_hardware_backend_fails_cleanly_without_ros(cfg):
    from backends.hardware_backend import HardwareBackend, ros2_available
    from config import load_robot_profile
    if ros2_available():
        pytest.skip("ROS 2 installed")
    with pytest.raises(RuntimeError, match="ROS 2"):
        HardwareBackend(load_robot_profile(), cfg.sensor).connect()
