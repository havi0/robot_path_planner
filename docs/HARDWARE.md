# Hardware integration guide (optional)

The project is fully functional without hardware. This document describes how
the same trained policy can be connected to a physical differential-drive
robot, and the safety procedure that must be followed first.

> **Status:** `HardwareBackend` (ROS 2) is implemented against the standard ROS 2
> message types but has **not been tested on a physical robot** in this project.
> Treat it as a starting point and validate every step below.
> The ROS 2 bridge itself (DDS topics, scan resampling, odometry, command
> publishing, stop, motor watchdog) is covered by `tests/test_ros2_bridge.py`
> against a stand-in node (`tests/ros2_stub_robot.py`), not a real robot.

## 0. ROS 2 on this Windows machine (installed via WSL2)

ROS 2 **Jazzy** (`ros-jazzy-ros-base`, official apt packages) is installed in the
WSL2 distro `Ubuntu` (24.04). The NEXUS server must run *inside* WSL with ROS
sourced so `rclpy` is importable; a Python venv with all project dependencies
is at `~/nexus-venv` (created with `--system-site-packages` so it sees `rclpy`).

```bash
# from Windows:  wsl -d Ubuntu
bash /mnt/c/Users/vhavi/rl-robot-path-planning/scripts/studio_ros2.sh          # Studio on :8000 with ROS 2
bash /mnt/c/Users/vhavi/rl-robot-path-planning/scripts/studio_ros2.sh pytest tests/test_ros2_bridge.py
```

Open `http://localhost:8000` in the Windows browser (WSL2 forwards localhost).
Stop the Windows-side server first if it also uses port 8000. Hardware Bridge →
backend **ros2** now connects when a robot driver publishes `/scan` and `/odom`.
To reach a robot on your LAN from WSL2, enable mirrored networking
(`networkingMode=mirrored` in `%UserProfile%\.wslconfig`) so DDS discovery works,
and use the same `ROS_DOMAIN_ID` as the robot.

## 1. Reference hardware

| Component | Example | Purpose |
|---|---|---|
| Onboard computer | Raspberry Pi 4/5 (4 GB+) running Ubuntu 22.04/24.04 + ROS 2 Humble/Jazzy | runs the policy, safety layer, ROS 2 |
| Motor driver | dual H-bridge (e.g. TB6612FNG, L298N) or a smart controller (OpenCR, RoboClaw) | drives the two DC motors |
| Motors | 2 x geared DC motors with quadrature encoders | differential drive + odometry |
| Range sensor | 2D LiDAR (RPLIDAR A1/A2, LDS-01/02) or 3+ ultrasonic sensors | obstacle detection |
| Motor controller MCU | Arduino / ESP32 / OpenCR | PWM, encoder counting, **hardware watchdog** |
| Power | separate battery for motors and computer, common ground, fuse | |
| E-stop | physical mushroom switch that cuts motor power | independent of all software |

A TurtleBot3 Burger satisfies all of this out of the box (it publishes `/scan`
and `/odom` and subscribes to `/cmd_vel`).

## 2. Software architecture on the robot

```
 DQN policy ──► action index ──► DiscreteActionSpace ──► VelocityCommand
                                                            │
                                     SafetyLayer.filter() ◄─┘  (limits, e-stop, proximity,
                                                            │   sensor timeout, link loss,
                                                            │   manual override)
                                     HardwareBackend ◄──────┘
                                       ├─ publishes  /cmd_vel   geometry_msgs/Twist
                                       ├─ subscribes /scan      sensor_msgs/LaserScan
                                       ├─ subscribes /odom      nav_msgs/Odometry
                                       └─ watchdog timer: publishes zero velocity if the
                                          control loop stops sending commands
 Motor controller firmware: second watchdog — stops motors if /cmd_vel stops arriving.
 Physical e-stop: cuts motor power regardless of software state.
```

The policy never talks to motors. It only produces an action index; every
command passes through `SafetyLayer` and the backend clamps it again to the
robot profile limits.

## 3. Interface contract (`backends/base.py`)

| Method | Simulation | Hardware (ROS 2) |
|---|---|---|
| `connect()` / `disconnect()` | no-op | start/stop ROS node, executor thread |
| `is_connected()` | always true | ROS ok **and** odometry younger than `watchdog.odom_timeout` |
| `read_sensors()` | ray-cast LiDAR | latest `/scan`, resampled to the training beam layout (min-pooling per sector) |
| `get_pose()` | ground truth | `/odom` pose (x, y, yaw) |
| `send_command(cmd)` | sets wheel command | clamps to profile limits, applies calibration, publishes `/cmd_vel` |
| `stop()` | zero command | publishes zero velocity 3x |
| `wait(dt)` | integrates physics for `dt` | sleeps to keep a fixed control rate |
| `now()` | simulation clock | `time.monotonic()` (same clock as sensor timestamps) |

To support another platform (e.g. serial link to an Arduino without ROS),
subclass `RobotBackend` and implement these methods. Use
`environment/robot.py: twist_to_wheel_speeds()` to convert (v, w) into wheel speeds.

## 4. Robot profile (`config/robot_profile.yaml`)

* `geometry.radius` **must** equal `robot.radius` used in training.
* `limits` are hard caps applied inside the backend (in addition to the safety layer).
  Start with low values (e.g. 0.1 m/s) for first tests.
* `calibration.linear_scale / angular_scale` come from `python main.py calibrate --backend ros2`.
* `sensor.scan_angle_offset_deg` rotates the LiDAR scan so 0 deg = robot forward.
* `ros2.*` topic names.

### Sensor consistency
The policy was trained on `sensor.num_beams` beams over `sensor.fov_deg` with
`sensor.max_range`. The hardware scan is resampled to exactly this layout by
taking the **minimum** range per angular sector (conservative). Readings beyond
`max_range` are clipped; missing returns are `NaN`. The policy treats NaN as
free space, the safety layer treats a high fraction of NaN as a sensor fault.

With ultrasonic sensors instead of a LiDAR, publish a synthetic `LaserScan`
(one sector per sensor, other sectors `inf`) — but note the policy was trained
with full 360-degree coverage, so performance will degrade; retrain with a
matching `sensor.num_beams` / `sensor.fov_deg` if possible.

## 5. Mandatory test procedure before autonomous operation

1. **Simulation gate** – `python main.py safety-test` must report *ALL SAFETY CHECKS PASSED*.
2. **Unit tests** – `python -m pytest tests`.
3. **Bench test (wheels off the ground)**
   * `python main.py monitor --backend ros2` – confirm connection, pose, scan, beam directions
     (place a box in front: the *forward* beams must shorten).
   * Drive with arrow keys (manual override). Confirm directions and that SPACE (e-stop) stops the wheels.
   * Kill the monitor process while driving: the wheels must stop within `watchdog.command_timeout`
     (backend watchdog) — then unplug the computer link: the **firmware** watchdog must stop them.
   * Cover the LiDAR / unplug it: safety layer must report `sensor_timeout` / `sensor_fault`.
4. **Physical e-stop** – verify it cuts motor power.
5. **Calibration** – on the floor, clear area: `python main.py calibrate --backend ros2`; enter the
   measured distance/rotation; copy the scale factors into the profile.
6. **Controlled-area trials** – small enclosed area, soft obstacles, low speed limit, operator
   holding the e-stop. Start with `python main.py monitor --backend ros2 --drive` (press D to
   enable autonomy, any arrow key to take over).
7. **Deployment** – `python main.py deploy --backend ros2 --goal X Y` (goal in the odometry frame).
   Ctrl+C triggers an emergency stop.

## 6. Sim-to-real measures already in the software

| Gap | Measure |
|---|---|
| Different obstacle layouts | random map per training episode, densities 0.05–0.25 |
| Wheel/motor miscalibration | per-episode random linear/angular scale ±10 %, calibration tool |
| Slip, uneven floor | per-step multiplicative velocity noise |
| Sensor noise / dropouts | per-episode random range noise (0–3 cm) and beam dropout (0–2 %) |
| Sensor format differences | robot-frame observation, fixed beam layout, conservative resampling, normalisation |
| Unsafe learned behaviour | independent safety layer, backend limits, two watchdogs, physical e-stop |

## 7. Known sim-to-real gaps (not modelled)

* Odometry drift (simulation uses the true pose; the goal is given in the odometry frame on hardware).
* Motor dynamics / latency (simulation reaches commanded velocity instantly).
* LiDAR artefacts: glass, black surfaces, sunlight, rotating-scan motion distortion.
* Non-rectangular, moving and deformable obstacles (people), floor transitions.
* A reactive policy without a map can get trapped in dead ends (see REPORT.md).

## 8. Evaluating sim vs. real

Run the same goals in simulation and on the robot and record, per trial: outcome
(success / collision / timeout / e-stop), time to goal, driven path length
(from odometry, cross-checked with floor markings), number and type of safety
interventions (`RunResult.safety_reasons`). Compare with the simulation results
for the same layout (rebuild the test arena as a `World` in simulation).
