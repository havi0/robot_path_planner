"""Hardware abstraction layer: the ONLY interface the navigation stack uses to
talk to a robot. Simulation and real hardware implement the same methods."""
from abc import ABC, abstractmethod

from navigation.actions import STOP


class RobotBackend(ABC):
    name = "abstract"

    def connect(self):
        """Open connections / start drivers. No-op for simulation."""

    def disconnect(self):
        self.stop()

    @abstractmethod
    def is_connected(self) -> bool:
        """False if communication with the robot is lost."""

    @abstractmethod
    def read_sensors(self):
        """Latest SensorReading in the training beam layout, or None if unavailable."""

    @abstractmethod
    def get_pose(self):
        """Latest Pose estimate (odometry / localisation), or None if unavailable."""

    @abstractmethod
    def send_command(self, cmd):
        """Send a VelocityCommand that has ALREADY passed the safety layer."""

    def stop(self):
        self.send_command(STOP)

    @abstractmethod
    def wait(self, dt):
        """Advance one control period (simulation: integrate physics; hardware: sleep)."""

    @abstractmethod
    def now(self) -> float:
        """Current time on the clock used for sensor timestamps."""

    def collision_detected(self) -> bool:
        """True if the robot has collided (simulation, or a bumper on hardware)."""
        return False
