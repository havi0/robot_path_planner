"""Safety layer: every command from the policy (or a human) passes through
SafetyLayer.filter() before reaching a backend. The policy cannot bypass it.

Checks, in priority order:
    1. emergency stop latched             -> stop
    2. communication lost                 -> stop
    3. sensor data missing / stale        -> stop
    4. too many invalid beams             -> stop
    5. manual override active             -> use operator's command instead of the policy's
    6. velocity limits                    -> clamp
    7. predicted motion unsafe            -> the footprint is swept along the arc the (v, w) command
                                             produces; if it would come within the clearance of a sensed
                                             obstacle, translation is removed (stop / turn in place)
    8. acceleration limits                -> ramp speed-ups (stopping is never delayed)
"""
import math
from dataclasses import dataclass, field

import numpy as np

from navigation.actions import STOP, VelocityCommand


@dataclass
class SafetyDecision:
    command: VelocityCommand
    requested: VelocityCommand
    reasons: list = field(default_factory=list)

    @property
    def intervened(self):
        return bool(self.reasons)

    @property
    def stopped(self):
        return self.command.v == 0 and self.command.w == 0 and \
            (self.requested.v != 0 or self.requested.w != 0)


class EmergencyStop:
    """Latching e-stop: once triggered it stays engaged until explicitly reset."""

    def __init__(self):
        self.engaged = False
        self.reason = None

    def trigger(self, reason="manual"):
        self.engaged = True
        self.reason = reason

    def reset(self):
        self.engaged = False
        self.reason = None


class ManualOverride:
    def __init__(self):
        self.active = False
        self.command = STOP

    def engage(self, cmd=STOP):
        self.active, self.command = True, cmd

    def release(self):
        self.active, self.command = False, STOP


class SafetyLayer:
    def __init__(self, scfg, robot_radius):
        self.cfg = scfg
        self.robot_radius = robot_radius
        self.estop = EmergencyStop()
        self.override = ManualOverride()
        self.last_output = STOP
        self.intervention_count = 0

    def reset_motion_state(self):
        self.last_output = STOP

    def filter(self, requested, reading, now, connected, dt):
        reasons = []
        cmd = self._check(requested, reading, now, connected, dt, reasons)
        if reasons:
            self.intervention_count += 1
        self.last_output = cmd
        return SafetyDecision(cmd, requested, reasons)

    def _check(self, requested, reading, now, connected, dt, reasons):
        c = self.cfg
        if self.estop.engaged:
            reasons.append(f"emergency_stop({self.estop.reason})")
            return STOP
        if not connected:
            reasons.append("communication_lost")
            return STOP
        if reading is None or now - reading.timestamp > c.sensor_timeout:
            reasons.append("sensor_timeout")
            return STOP
        if reading.valid_fraction < c.min_valid_beam_fraction:
            reasons.append("sensor_fault")
            return STOP

        cmd = requested
        if self.override.active:
            cmd = self.override.command
            reasons.append("manual_override")

        v, w = cmd.v, cmd.w
        if not (math.isfinite(v) and math.isfinite(w)):
            reasons.append("invalid_command")
            return STOP
        if not c.allow_reverse and v < 0 and not self.override.active:
            v = 0.0
            reasons.append("reverse_blocked")
        v_lim = float(np.clip(v, -c.max_linear_speed, c.max_linear_speed))
        w_lim = float(np.clip(w, -c.max_angular_speed, c.max_angular_speed))
        if (v_lim, w_lim) != (v, w):
            reasons.append("velocity_limited")
        v, w = v_lim, w_lim

        if v != 0 and self.motion_blocked(reading, v, w, dt):
            v = 0.0                       # keep only the rotation: safe for a circular footprint
            reasons.append("proximity_stop")

        # acceleration limits on speeding up only
        last = self.last_output
        if abs(v) > abs(last.v):
            dv = c.max_linear_accel * dt
            v_r = float(np.clip(v, last.v - dv, last.v + dv))
            if v_r != v:
                reasons.append("accel_limited")
            v = v_r
        if abs(w) > abs(last.w):
            dw = c.max_angular_accel * dt
            w_r = float(np.clip(w, last.w - dw, last.w + dw))
            if w_r != w:
                reasons.append("accel_limited")
            w = w_r
        return VelocityCommand(v, w)

    def motion_blocked(self, reading, v, w, dt):
        """Predict the motion produced by (v, w) and test it against the sensed obstacles.

        The robot is a disc of radius r. Its centre follows an arc of curvature w / v. We
        sample poses every 1 cm along the path for the distance travelled this control
        period (|v| dt), but at least `stop_distance - lateral_margin` so the stopping
        margin is kept. Motion is unsafe if any sensed obstacle point would be closer than
        r + lateral_margin to a sampled pose AND closer than it is now (moving away from a
        nearby obstacle stays allowed).

        Pure rotation (v = 0) is never blocked: a circular footprint turning in place
        occupies exactly the same disc, so it cannot newly intersect anything. A robot with
        a non-circular footprint would need the rotation swept as well.
        """
        if v == 0:
            return False
        c = self.cfg
        if reading.safety_ranges is not None:      # dense scan: corners between policy beams are seen
            ok = np.isfinite(reading.safety_ranges)
            r, a = reading.safety_ranges[ok], reading.safety_angles[ok]
        else:
            ok = reading.valid_mask
            r, a = reading.ranges[ok], reading.angles[ok]
        if r.size == 0:
            return False
        px, py = r * np.cos(a), r * np.sin(a)
        clear = self.robot_radius + c.lateral_margin
        length = max(abs(v) * dt, c.stop_distance - c.lateral_margin)
        s = np.linspace(0.0, length, max(2, int(np.ceil(length / 0.01)) + 1))[1:] * np.sign(v)
        if abs(w) < 1e-6:
            xs, ys = s, np.zeros_like(s)
        else:
            k = w / v                              # curvature (rad per metre, sign-aware)
            xs, ys = np.sin(k * s) / k, (1 - np.cos(k * s)) / k
        d_now = np.hypot(px, py)
        d = np.hypot(px[None, :] - xs[:, None], py[None, :] - ys[:, None])      # poses x points
        return bool(np.any((d < clear) & (d < d_now[None, :] - 1e-9)))
