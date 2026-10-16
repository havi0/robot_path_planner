"""Policies all share one interface:  act(observation, pose, goal) -> action index.

Learned policies (DQN, Q-learning) use only the observation (local sensors +
goal direction). The planner-follower uses the pose and a precomputed global
path, i.e. it assumes a known map.
"""
import math

from sensors.processing import wrap_angle


class Policy:
    name = "policy"

    def reset(self, **context):
        """Called at the start of every episode."""

    def act(self, observation, pose, goal):
        raise NotImplementedError


class DQNPolicy(Policy):
    name = "DQN"

    def __init__(self, agent):
        self.agent = agent

    def act(self, observation, pose, goal):
        return self.agent.act(observation, epsilon=0.0)


class QTablePolicy(Policy):
    name = "Q-learning"

    def __init__(self, agent):
        self.agent = agent

    def act(self, observation, pose, goal):
        return self.agent.act(observation, epsilon=0.0)


class RecoveryWrapper(Policy):
    """Navigation-layer recovery behaviour around any reactive policy.

    A memoryless policy can get trapped in a fixed point (e.g. 'stop' forever
    or turning back and forth in place). If the robot has moved less than
    `min_progress` metres during the last `window` steps, it performs
    `duration` randomised escape actions: random turns, and forward only when
    the observation shows free space ahead. Comparable to the recovery
    behaviours of classical navigation stacks (e.g. ROS 2 Nav2).
    """

    def __init__(self, inner, action_space, beam_angles, max_range, window=12, min_progress=0.05,
                 duration=8, front_clearance=0.45, seed=0):
        import numpy as np
        self.inner = inner
        self.name = f"{inner.name} + recovery"
        self.fwd = action_space.index_of("forward")
        self.turns = [action_space.index_of("turn_left"), action_space.index_of("turn_right")]
        self.front = np.abs(np.asarray(beam_angles)) <= np.deg2rad(40)
        self.n_beams = len(beam_angles)
        self.max_range = max_range
        self.window, self.min_progress, self.duration = window, min_progress, duration
        self.front_clearance = front_clearance
        self.seed = seed
        self.rng = np.random.default_rng(seed)
        self.recoveries = 0

    def reset(self, **context):
        import numpy as np
        self.inner.reset(**context)
        self.rng = np.random.default_rng(self.seed)   # reproducible per episode
        self.history = []
        self.remaining = 0
        self.turn_dir = self.turns[0]

    def act(self, observation, pose, goal):
        self.history = (self.history + [(pose.x, pose.y)])[-self.window:]
        if self.remaining == 0 and len(self.history) == self.window:
            x0, y0 = self.history[0]
            if max(math.hypot(x - x0, y - y0) for x, y in self.history) < self.min_progress:
                self.remaining = self.duration
                self.turn_dir = self.turns[int(self.rng.integers(2))]
                self.recoveries += 1
                self.history = []
        if self.remaining > 0:
            self.remaining -= 1
            front = observation[: self.n_beams][self.front].min() * self.max_range
            if front > self.front_clearance and self.rng.random() < 0.6:
                return self.fwd
            return self.turn_dir
        return self.inner.act(observation, pose, goal)


class PathFollowerPolicy(Policy):
    """Follows a waypoint path using the same discrete action set as the RL agent:
    rotate toward a look-ahead point, then drive forward."""

    def __init__(self, action_space, name, lookahead=0.2, heading_tolerance=0.15, spacing=0.05):
        self.name = name
        self.fwd = action_space.index_of("forward")
        self.left = action_space.index_of("turn_left")
        self.right = action_space.index_of("turn_right")
        self.stop = action_space.index_of("stop")
        self.lookahead = lookahead
        self.tol = heading_tolerance
        self.spacing = spacing
        self.path = []
        self.idx = 0

    def reset(self, path=None, **context):
        """Densify the waypoint path so the look-ahead point slides smoothly
        around corners instead of jumping to the next (distant) waypoint."""
        self.path, self.idx = [], 0
        path = list(path or [])
        for (x0, y0), (x1, y1) in zip(path, path[1:]):
            n = max(1, int(math.hypot(x1 - x0, y1 - y0) / self.spacing))
            self.path += [(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n) for k in range(n)]
        if path:
            self.path.append(path[-1])

    def act(self, observation, pose, goal):
        if not self.path:
            return self.stop
        # advance along the path to the first point beyond the look-ahead distance
        while self.idx < len(self.path) - 1 and \
                math.hypot(self.path[self.idx][0] - pose.x, self.path[self.idx][1] - pose.y) < self.lookahead:
            self.idx += 1
        tx, ty = self.path[self.idx]
        err = wrap_angle(math.atan2(ty - pose.y, tx - pose.x) - pose.theta)
        if err > self.tol:
            return self.left
        if err < -self.tol:
            return self.right
        return self.fwd
