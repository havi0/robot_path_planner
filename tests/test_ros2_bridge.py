"""ROS 2 bridge integration test (skipped unless rclpy is importable).

Runs tests/ros2_stub_robot.py in a separate process and drives the real
HardwareBackend over DDS: connection, scan resampling, odometry, command
publishing, stop and the motor watchdog.
"""
import math
import os
import subprocess
import sys
import time

import numpy as np
import pytest

from backends.hardware_backend import ros2_available

pytestmark = pytest.mark.skipif(not ros2_available(), reason="ROS 2 (rclpy) not installed")


@pytest.fixture
def cfg():
    from config import load_config
    return load_config()


STUB = os.path.join(os.path.dirname(__file__), "ros2_stub_robot.py")


def _wait(cond, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


@pytest.fixture
def bridge(cfg):
    from backends.hardware_backend import HardwareBackend
    from config import load_robot_profile
    env = dict(os.environ, ROS_DOMAIN_ID=os.environ.get("ROS_DOMAIN_ID", "42"))
    os.environ["ROS_DOMAIN_ID"] = env["ROS_DOMAIN_ID"]
    proc = subprocess.Popen([sys.executable, STUB], env=env)
    hw = HardwareBackend(load_robot_profile(), cfg.sensor)
    try:
        hw.connect()
        assert _wait(lambda: hw.is_connected() and hw.read_sensors() is not None), "no /odom or /scan from stub"
        yield hw
    finally:
        hw.disconnect()
        proc.terminate()
        proc.wait(timeout=10)


def test_bridge_reads_scan_and_odom(bridge, cfg):
    reading = bridge.read_sensors()
    assert len(reading.ranges) == cfg.sensor.num_beams
    fwd = int(np.argmin(np.abs(reading.angles)))
    assert reading.ranges[fwd] == pytest.approx(1.0, abs=0.03)          # wall 1 m ahead
    # safety scan = raw returns only (no-return beams dropped): the wall's ~147 hits
    assert reading.safety_ranges is not None and len(reading.safety_ranges) > 100
    assert float(np.min(reading.safety_ranges)) == pytest.approx(1.0, abs=0.01)
    pose = bridge.get_pose()
    assert abs(pose.x) < 0.05 and abs(pose.y) < 0.05


def test_bridge_commands_move_robot_then_stop(bridge):
    from navigation.actions import VelocityCommand as Command
    x0 = bridge.get_pose().x
    end = time.monotonic() + 1.0
    while time.monotonic() < end:                      # keep feeding so the watchdog stays quiet
        bridge.send_command(Command(0.2, 0.0))
        time.sleep(0.1)
    assert bridge.get_pose().x - x0 > 0.1
    bridge.stop()
    time.sleep(0.3)
    x1 = bridge.get_pose().x
    time.sleep(0.5)
    assert abs(bridge.get_pose().x - x1) < 0.01


def test_bridge_watchdog_stops_motors(bridge):
    from navigation.actions import VelocityCommand as Command
    bridge.send_command(Command(0.2, 0.0))             # then go silent
    time.sleep(0.5 + 0.4)                              # > command_timeout + timer period
    assert bridge.last_sent.v == 0.0 and bridge.last_sent.w == 0.0
    x1 = bridge.get_pose().x
    time.sleep(0.4)
    assert abs(bridge.get_pose().x - x1) < 0.01
    assert not math.isnan(x1)
