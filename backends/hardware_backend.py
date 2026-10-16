"""Physical robot backend over ROS 2.

    subscribes:  sensor_msgs/LaserScan  (profile.ros2.scan_topic)
                 nav_msgs/Odometry      (profile.ros2.odom_topic)
    publishes:   geometry_msgs/Twist    (profile.ros2.cmd_vel_topic)

Works with any differential-drive robot that exposes these standard topics
(TurtleBot3, a Raspberry Pi robot running a motor-driver node, etc.).
ROS 2 is optional: rclpy is imported only when connect() is called.

NOTE: this backend has not been tested against real hardware in this project.
Follow docs/HARDWARE.md (bench test with wheels off the ground first).
"""
import math
import threading
import time

import numpy as np

from backends.base import RobotBackend
from navigation.actions import STOP
from sensors.processing import resample_scan
from sensors.types import Pose, SensorReading, beam_angles


def ros2_available():
    try:
        import rclpy  # noqa: F401
        return True
    except ImportError:
        return False


class HardwareBackend(RobotBackend):
    name = "hardware-ros2"

    def __init__(self, profile, sensor_cfg):
        self.profile = profile
        self.target_angles = beam_angles(sensor_cfg.num_beams, sensor_cfg.fov_deg)
        self.max_range = sensor_cfg.max_range
        self._lock = threading.Lock()
        self._scan = None
        self._pose = None
        self._last_cmd_time = 0.0
        self._next_tick = None
        self._node = None
        self._executor = None
        self._thread = None
        self.last_sent = STOP
        self.errors = []

    # ---------- lifecycle ----------
    def connect(self):
        if not ros2_available():
            raise RuntimeError(
                "ROS 2 (rclpy) is not installed. HardwareBackend needs a sourced ROS 2 "
                "environment; simulation mode does not. See docs/HARDWARE.md.")
        import rclpy
        from geometry_msgs.msg import Twist
        from nav_msgs.msg import Odometry
        from rclpy.executors import SingleThreadedExecutor
        from rclpy.qos import qos_profile_sensor_data
        from sensor_msgs.msg import LaserScan

        self._Twist = Twist
        if not rclpy.ok():
            rclpy.init()
        r = self.profile.ros2
        self._node = rclpy.create_node(r.node_name)
        self._pub = self._node.create_publisher(Twist, r.cmd_vel_topic, r.qos_depth)
        self._node.create_subscription(LaserScan, r.scan_topic, self._on_scan, qos_profile_sensor_data)
        self._node.create_subscription(Odometry, r.odom_topic, self._on_odom, r.qos_depth)
        self._node.create_timer(0.1, self._watchdog)
        self._executor = SingleThreadedExecutor()
        self._executor.add_node(self._node)
        self._thread = threading.Thread(target=self._executor.spin, daemon=True)
        self._thread.start()
        self._last_cmd_time = time.monotonic()

    def disconnect(self):
        try:
            self.stop()
        finally:
            if self._executor:
                self._executor.shutdown()
            if self._node:
                self._node.destroy_node()
            import rclpy
            if rclpy.ok():
                rclpy.shutdown()

    # ---------- ROS callbacks (executor thread) ----------
    def _on_scan(self, msg):
        try:
            ranges = np.asarray(msg.ranges, dtype=np.float64)
            ranges[ranges > msg.range_max] = np.inf      # no return
            ranges[ranges < msg.range_min] = np.nan      # invalid
            resampled = resample_scan(
                ranges, msg.angle_min, msg.angle_increment, self.target_angles, self.max_range,
                min_valid_range=self.profile.sensor.min_valid_range,
                angle_offset=math.radians(self.profile.sensor.scan_angle_offset_deg))
            raw_ang = (msg.angle_min + math.radians(self.profile.sensor.scan_angle_offset_deg)
                       + msg.angle_increment * np.arange(len(ranges)))
            raw_ok = np.isfinite(ranges) & (ranges > self.profile.sensor.min_valid_range)
            reading = SensorReading(resampled, self.target_angles.copy(), self.max_range, time.monotonic(),
                                    safety_ranges=np.minimum(ranges[raw_ok], self.max_range),
                                    safety_angles=(raw_ang[raw_ok] + np.pi) % (2 * np.pi) - np.pi)
            with self._lock:
                self._scan = reading
        except Exception as e:  # never let a bad message kill the executor
            self.errors.append(f"scan: {e}")

    def _on_odom(self, msg):
        q = msg.pose.pose.orientation
        yaw = math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))
        p = msg.pose.pose.position
        with self._lock:
            self._pose = Pose(p.x, p.y, yaw, time.monotonic())

    def _watchdog(self):
        """Second line of defence: if the control loop stalls, stop the motors."""
        if time.monotonic() - self._last_cmd_time > self.profile.watchdog.command_timeout:
            self._publish(STOP)

    # ---------- RobotBackend interface ----------
    def is_connected(self):
        import rclpy
        with self._lock:
            pose = self._pose
        return (self._node is not None and rclpy.ok() and pose is not None
                and time.monotonic() - pose.timestamp < self.profile.watchdog.odom_timeout)

    def read_sensors(self):
        with self._lock:
            return self._scan

    def get_pose(self):
        with self._lock:
            return self._pose

    def send_command(self, cmd):
        lim, cal = self.profile.limits, self.profile.calibration
        v = float(np.clip(cmd.v, -lim.max_linear_speed, lim.max_linear_speed))
        w = float(np.clip(cmd.w, -lim.max_angular_speed, lim.max_angular_speed))
        # calibration: robot really moves `scale` x commanded, so pre-compensate
        v, w = v / cal.linear_scale, w / cal.angular_scale
        self._publish(type(cmd)(v, w))
        self._last_cmd_time = time.monotonic()

    def _publish(self, cmd):
        if self._node is None:
            return
        msg = self._Twist()
        msg.linear.x, msg.angular.z = float(cmd.v), float(cmd.w)
        self._pub.publish(msg)
        self.last_sent = cmd

    def stop(self):
        for _ in range(3):              # repeat in case a message is dropped
            self._publish(STOP)
        self._last_cmd_time = time.monotonic()

    def wait(self, dt):
        """Keep a fixed control rate."""
        now = time.monotonic()
        self._next_tick = (self._next_tick or now) + dt
        if self._next_tick > now:
            time.sleep(self._next_tick - now)
        else:
            self._next_tick = now     # loop overran; don't try to catch up

    def now(self):
        return time.monotonic()
