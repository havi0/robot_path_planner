"""Motion calibration: how far/fast does the robot REALLY move per command?

Drives a fixed distance and a fixed rotation, compares commanded vs. measured
motion and reports scale factors for config/robot_profile.yaml.

On hardware the operator measures the true distance/angle (tape measure,
floor markings) because wheel odometry shares the very errors being calibrated.
In simulation the true pose is known, so the procedure can be verified: the
estimated scale must match the randomised scale hidden in the simulator.
"""
import math

from environment.world import World
from navigation.actions import STOP, VelocityCommand
from safety.safety_layer import SafetyLayer
from sensors.processing import wrap_angle


def _drive(backend, safety, cmd, duration, dt):
    turned = 0.0
    last = backend.get_pose()
    for _ in range(round(duration / dt)):
        d = safety.filter(cmd, backend.read_sensors(), backend.now(), backend.is_connected(), dt)
        backend.send_command(d.command)
        backend.wait(dt)
        p = backend.get_pose()
        turned += wrap_angle(p.theta - last.theta)
        last = p
        if d.intervened and "accel_limited" not in d.reasons:
            backend.stop()
            raise RuntimeError(f"Calibration aborted by safety layer: {d.reasons}")
    backend.send_command(STOP)
    backend.wait(dt)
    return turned


def calibrate(backend, cfg, distance=1.0, angle_deg=360.0, interactive=False):
    dt = cfg.robot.control_dt
    safety = SafetyLayer(cfg.safety, cfg.robot.radius)
    v = cfg.actions.forward[0]
    w = cfg.actions.turn_left[1]
    is_sim = hasattr(backend, "new_episode")
    if is_sim:   # empty arena so nothing is in the way; motion scales are randomised
        backend.new_episode(map_seed=12345, randomize=True,
                            world=World(cfg.world.width, cfg.world.height, [], (1.0, 3.0, 0.0), (5.0, 3.0)))
    if interactive:
        input(f"Clear at least {distance + 0.5:.1f} m in front of the robot, then press Enter "
              "(Ctrl+C aborts)...")

    p0 = backend.get_pose()
    t_lin = distance / v
    _drive(backend, safety, VelocityCommand(v, 0.0), t_lin, dt)
    p1 = backend.get_pose()
    commanded_dist = v * round(t_lin / dt) * dt
    measured = float(input("Measured distance travelled (m): ")) if interactive else \
        math.hypot(p1.x - p0.x, p1.y - p0.y)

    t_rot = math.radians(angle_deg) / w
    turned = _drive(backend, safety, VelocityCommand(0.0, w), t_rot, dt)
    commanded_rot = w * round(t_rot / dt) * dt
    measured_rot = math.radians(float(input("Measured rotation (deg): "))) if interactive else turned

    lin_scale, ang_scale = measured / commanded_dist, measured_rot / commanded_rot
    print(f"Linear : commanded {commanded_dist:.3f} m, measured {measured:.3f} m -> linear_scale = {lin_scale:.3f}")
    print(f"Angular: commanded {math.degrees(commanded_rot):.1f} deg, measured {math.degrees(measured_rot):.1f} deg"
          f" -> angular_scale = {ang_scale:.3f}")
    if is_sim:
        truth = backend.model
        print(f"(simulation ground truth: linear_scale = {truth.linear_scale:.3f}, "
              f"angular_scale = {truth.angular_scale:.3f})")
    print("Put these values under `calibration:` in config/robot_profile.yaml.")
    return lin_scale, ang_scale
