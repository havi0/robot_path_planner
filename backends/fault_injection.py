"""Wraps any backend and injects failures, so the safety layer can be tested
without hardware: frozen sensors (timeout), sensor blackout, lost link."""
import numpy as np

from backends.base import RobotBackend
from navigation.actions import STOP


class FaultInjectionBackend(RobotBackend):
    def __init__(self, inner, sensor_freeze_at=None, sensor_blackout_at=None, comm_loss_at=None,
                 robot_watchdog=None):
        """robot_watchdog: if set, models a watchdog ON THE ROBOT (motor controller
        firmware) that stops the motors when no command arrives for this long.
        Without it, a robot that loses its link keeps executing the last command."""
        self.inner = inner
        self.name = f"fault-injection({inner.name})"
        self.sensor_freeze_at = sensor_freeze_at
        self.sensor_blackout_at = sensor_blackout_at
        self.comm_loss_at = comm_loss_at
        self.robot_watchdog = robot_watchdog
        self._frozen = None
        self._last_received = inner.now()
        self.commands_dropped = 0

    def __getattr__(self, item):            # expose world, state, ... of the inner backend
        return getattr(self.inner, item)

    def _after(self, t):
        return t is not None and self.inner.now() >= t

    def is_connected(self):
        return not self._after(self.comm_loss_at) and self.inner.is_connected()

    def read_sensors(self):
        if self._after(self.sensor_freeze_at):
            if self._frozen is None:
                self._frozen = self.inner.read_sensors()
            return self._frozen               # timestamp stops advancing
        reading = self.inner.read_sensors()
        if self._after(self.sensor_blackout_at):
            reading.ranges = np.full_like(reading.ranges, np.nan)
        return reading

    def get_pose(self):
        return self.inner.get_pose()

    def send_command(self, cmd):
        if self._after(self.comm_loss_at):
            self.commands_dropped += 1        # command never reaches the robot
            return
        self._last_received = self.inner.now()
        self.inner.send_command(cmd)

    def wait(self, dt):
        if self.robot_watchdog is not None and self.inner.now() - self._last_received >= self.robot_watchdog:
            self.inner.send_command(STOP)
        self.inner.wait(dt)

    def now(self):
        return self.inner.now()

    def collision_detected(self):
        return self.inner.collision_detected()
