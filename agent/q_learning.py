"""Tabular Q-learning baseline on a discretised version of the SAME observation
vector the DQN uses (so it is trained on identical information)."""
import numpy as np


class ObservationDiscretizer:
    """Discretises the observation into:
        goal bearing      : 8 sectors
        goal distance     : 3 bins (near / mid / far)
        front, left, right: 3 clearance bins each (blocked / close / free)
    -> 8 * 3 * 27 = 648 states
    """

    def __init__(self, num_beams, beam_angles, max_range, max_goal_dist):
        self.n = num_beams
        self.max_range = max_range
        self.max_goal_dist = max_goal_dist
        a = np.asarray(beam_angles)
        self.front = np.abs(a) <= np.deg2rad(30)
        self.left = (a > np.deg2rad(30)) & (a <= np.deg2rad(100))
        self.right = (a < -np.deg2rad(30)) & (a >= -np.deg2rad(100))
        self.range_bins = np.array([0.35, 0.8]) / max_range        # normalised
        self.dist_bins = np.array([0.6, 2.0]) / max_goal_dist
        self.n_states = 8 * 3 * 27

    def __call__(self, obs):
        ranges = obs[: self.n]
        dist, s, c = obs[self.n], obs[self.n + 1], obs[self.n + 2]
        bearing = np.arctan2(s, c)
        b = int(((bearing + np.pi) / (2 * np.pi) * 8 + 0.5) % 8)
        d = int(np.digitize(dist, self.dist_bins))
        f = int(np.digitize(ranges[self.front].min(), self.range_bins))
        l_ = int(np.digitize(ranges[self.left].min(), self.range_bins))
        r = int(np.digitize(ranges[self.right].min(), self.range_bins))
        return ((b * 3 + d) * 3 + f) * 9 + l_ * 3 + r


class QLearningAgent:
    def __init__(self, discretizer, n_actions, qcfg, seed=0):
        self.disc = discretizer
        self.cfg = qcfg
        self.n_actions = n_actions
        self.Q = np.zeros((discretizer.n_states, n_actions))
        self.rng = np.random.default_rng(seed)

    def epsilon(self, episode):
        c = self.cfg
        frac = min(1.0, episode / c.eps_decay_episodes)
        return c.eps_start + frac * (c.eps_end - c.eps_start)

    def act(self, obs, epsilon=0.0):
        if epsilon > 0 and self.rng.random() < epsilon:
            return int(self.rng.integers(self.n_actions))
        q = self.Q[self.disc(obs)]
        return int(self.rng.choice(np.flatnonzero(q == q.max())))

    def update(self, obs, action, reward, next_obs, terminated):
        s, s2 = self.disc(obs), self.disc(next_obs)
        target = reward if terminated else reward + self.cfg.gamma * self.Q[s2].max()
        self.Q[s, action] += self.cfg.alpha * (target - self.Q[s, action])
