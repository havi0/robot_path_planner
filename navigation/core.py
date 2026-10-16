"""NavigationCore: the single sense -> decide -> (safety) -> act step used by BOTH
the Gymnasium training environment and the deployment controller. Because
training and deployment share this code path, the observation and action
definitions cannot drift apart between simulation and hardware."""
import math
from dataclasses import dataclass

from navigation.actions import STOP


@dataclass
class StepResult:
    observation: object       # np.ndarray, or None if sensors/pose unavailable
    requested: object         # VelocityCommand chosen by the policy
    executed: object          # VelocityCommand actually sent (after safety)
    safety: object            # SafetyDecision or None
    reading: object
    pose: object
    distance_to_goal: float
    reached: bool
    collided: bool


class NavigationCore:
    def __init__(self, backend, obs_builder, action_space, control_dt, goal_radius, safety=None):
        self.backend = backend
        self.obs_builder = obs_builder
        self.actions = action_space
        self.control_dt = control_dt
        self.goal_radius = goal_radius
        self.safety = safety
        self.goal = None
        self.last_cmd = STOP
        self.last_reading = None
        self.last_pose = None
        self.path_length = 0.0

    def begin(self, goal):
        self.goal = goal
        self.last_cmd = STOP
        self.path_length = 0.0
        if self.safety:
            self.safety.reset_motion_state()
        self.last_pose = self.backend.get_pose()
        self.last_reading = self.backend.read_sensors()
        return self._observe(self.last_reading, self.last_pose)

    def distance_to_goal(self, pose):
        return math.hypot(self.goal[0] - pose.x, self.goal[1] - pose.y)

    def step(self, action):
        requested = self.actions.to_command(action)
        decision = None
        cmd = requested
        if self.safety:
            decision = self.safety.filter(requested, self.last_reading, self.backend.now(),
                                          self.backend.is_connected(), self.control_dt)
            cmd = decision.command
        self.backend.send_command(cmd)
        self.backend.wait(self.control_dt)

        pose = self.backend.get_pose()
        reading = self.backend.read_sensors()
        if pose is not None and self.last_pose is not None:
            self.path_length += math.hypot(pose.x - self.last_pose.x, pose.y - self.last_pose.y)
        self.last_cmd = cmd
        self.last_pose, self.last_reading = pose, reading

        dist = self.distance_to_goal(pose) if pose is not None else float("inf")
        return StepResult(
            observation=self._observe(reading, pose),
            requested=requested, executed=cmd, safety=decision, reading=reading, pose=pose,
            distance_to_goal=dist, reached=dist <= self.goal_radius,
            collided=self.backend.collision_detected(),
        )

    def _observe(self, reading, pose):
        if reading is None or pose is None:
            return None
        return self.obs_builder.build(reading, pose, self.goal, self.last_cmd)
