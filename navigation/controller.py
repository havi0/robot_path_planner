"""Deployment controller: runs any Policy on any RobotBackend through the
safety layer. Used for simulated evaluation AND for real-robot deployment."""
import time
from dataclasses import dataclass, field

from navigation.core import NavigationCore


@dataclass
class RunResult:
    outcome: str                      # success | collision | timeout | aborted
    steps: int
    path_length: float
    duration: float
    mean_inference_ms: float
    safety_interventions: int
    safety_reasons: dict = field(default_factory=dict)
    trajectory: list = field(default_factory=list)
    abort_reason: str = ""


class NavigationController:
    def __init__(self, backend, policy, obs_builder, action_space, control_dt, goal_radius, safety=None):
        self.backend = backend
        self.policy = policy
        self.safety = safety
        self.core = NavigationCore(backend, obs_builder, action_space, control_dt, goal_radius, safety)
        self.stop_requested = False

    def run(self, goal, max_steps, on_step=None, policy_context=None):
        """Drive to `goal`. `on_step(step_result)` is called after every step (for UIs / logging).
        Returns a RunResult. The robot is always stopped on exit."""
        self.policy.reset(**(policy_context or {}))
        obs = self.core.begin(goal)
        start_t = self.backend.now()
        traj = [(self.core.last_pose.x, self.core.last_pose.y)] if self.core.last_pose else []
        infer_ms, interventions, reasons = [], 0, {}
        outcome, abort_reason, steps = "timeout", "", 0
        try:
            for steps in range(1, max_steps + 1):
                if self.stop_requested:
                    outcome, abort_reason = "aborted", "stop requested"
                    break
                if obs is None:
                    # no sensor/pose data: the safety layer will command a stop
                    action = self.core.actions.index_of("stop")
                else:
                    t0 = time.perf_counter()
                    action = self.policy.act(obs, self.core.last_pose, goal)
                    infer_ms.append((time.perf_counter() - t0) * 1000)
                res = self.core.step(action)
                obs = res.observation
                if res.safety and res.safety.intervened:
                    interventions += 1
                    for r in res.safety.reasons:
                        reasons[r] = reasons.get(r, 0) + 1
                if res.pose:
                    traj.append((res.pose.x, res.pose.y))
                if on_step:
                    on_step(res)
                if res.collided:
                    outcome = "collision"
                    break
                if res.reached:
                    outcome = "success"
                    break
                if self.safety and self.safety.estop.engaged:
                    outcome, abort_reason = "aborted", f"emergency stop: {self.safety.estop.reason}"
                    break
        finally:
            self.backend.stop()
        return RunResult(outcome, steps, self.core.path_length, self.backend.now() - start_t,
                         sum(infer_ms) / len(infer_ms) if infer_ms else 0.0,
                         interventions, reasons, traj, abort_reason)
