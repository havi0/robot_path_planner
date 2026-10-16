"""Minimal stand-in ROS 2 robot used ONLY by tests/test_ros2_bridge.py.

It is not a robot and not a simulator for evaluation: it integrates /cmd_vel into a
pose (unicycle), publishes that pose on /odom and publishes a 360-beam /scan with a
wall 1.0 m in front of the robot's start position. It exists so the ROS 2 bridge
(HardwareBackend) can be exercised over real DDS topics without hardware.

    python tests/ros2_stub_robot.py          (needs a sourced ROS 2 environment)
"""
import math

import rclpy
from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan

WALL_X = 1.0
DT = 0.05


def main():
    rclpy.init()
    node = rclpy.create_node("nexus_stub_robot")
    state = {"x": 0.0, "y": 0.0, "th": 0.0, "v": 0.0, "w": 0.0}
    odom_pub = node.create_publisher(Odometry, "/odom", 10)
    scan_pub = node.create_publisher(LaserScan, "/scan", qos_profile_sensor_data)

    def on_cmd(msg):
        state["v"], state["w"] = msg.linear.x, msg.angular.z
    node.create_subscription(Twist, "/cmd_vel", on_cmd, 10)

    def tick():
        s = state
        s["x"] += s["v"] * math.cos(s["th"]) * DT
        s["y"] += s["v"] * math.sin(s["th"]) * DT
        s["th"] += s["w"] * DT
        now = node.get_clock().now().to_msg()
        od = Odometry()
        od.header.stamp, od.header.frame_id, od.child_frame_id = now, "odom", "base_link"
        od.pose.pose.position.x, od.pose.pose.position.y = s["x"], s["y"]
        od.pose.pose.orientation.z, od.pose.pose.orientation.w = math.sin(s["th"] / 2), math.cos(s["th"] / 2)
        od.twist.twist.linear.x, od.twist.twist.angular.z = s["v"], s["w"]
        odom_pub.publish(od)
        sc = LaserScan()
        sc.header.stamp, sc.header.frame_id = now, "base_scan"
        sc.angle_min, sc.angle_max = -math.pi, math.pi
        sc.angle_increment = 2 * math.pi / 360
        sc.range_min, sc.range_max = 0.12, 3.5
        ranges = []
        for i in range(360):
            a = s["th"] + sc.angle_min + i * sc.angle_increment
            c = math.cos(a)
            d = (WALL_X - s["x"]) / c if c > 1e-6 else float("inf")
            ranges.append(d if d <= sc.range_max else float("inf"))
        sc.ranges = ranges
        scan_pub.publish(sc)

    node.create_timer(DT, tick)
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, rclpy.executors.ExternalShutdownException):
        pass


if __name__ == "__main__":
    main()
