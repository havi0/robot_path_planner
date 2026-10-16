"""Deep Q-Network: experience replay, target network, epsilon-greedy, optional Double DQN."""
import numpy as np
import torch
import torch.nn as nn


class QNetwork(nn.Module):
    def __init__(self, obs_dim, n_actions, hidden=(128, 128)):
        super().__init__()
        layers, d = [], obs_dim
        for h in hidden:
            layers += [nn.Linear(d, h), nn.ReLU()]
            d = h
        layers.append(nn.Linear(d, n_actions))
        self.net = nn.Sequential(*layers)

    def forward(self, x):
        return self.net(x)


class ReplayBuffer:
    """Fixed-size ring buffer stored in pre-allocated numpy arrays."""

    def __init__(self, capacity, obs_dim, rng):
        self.capacity = capacity
        self.obs = np.zeros((capacity, obs_dim), dtype=np.float32)
        self.next_obs = np.zeros((capacity, obs_dim), dtype=np.float32)
        self.actions = np.zeros(capacity, dtype=np.int64)
        self.rewards = np.zeros(capacity, dtype=np.float32)
        self.dones = np.zeros(capacity, dtype=np.float32)
        self.pos = 0
        self.size = 0
        self.rng = rng

    def add(self, obs, action, reward, next_obs, terminated):
        i = self.pos
        self.obs[i], self.actions[i], self.rewards[i] = obs, action, reward
        self.next_obs[i], self.dones[i] = next_obs, float(terminated)
        self.pos = (self.pos + 1) % self.capacity
        self.size = min(self.size + 1, self.capacity)

    def sample(self, batch_size):
        idx = self.rng.integers(0, self.size, size=batch_size)
        return (torch.from_numpy(self.obs[idx]), torch.from_numpy(self.actions[idx]),
                torch.from_numpy(self.rewards[idx]), torch.from_numpy(self.next_obs[idx]),
                torch.from_numpy(self.dones[idx]))

    def __len__(self):
        return self.size


class DQNAgent:
    def __init__(self, obs_dim, n_actions, dcfg, seed=0):
        torch.manual_seed(seed)
        self.rng = np.random.default_rng(seed)
        self.cfg = dcfg
        self.obs_dim, self.n_actions = obs_dim, n_actions
        self.q = QNetwork(obs_dim, n_actions, dcfg.hidden)
        self.q_target = QNetwork(obs_dim, n_actions, dcfg.hidden)
        self.q_target.load_state_dict(self.q.state_dict())
        self.q_target.eval()
        self.opt = torch.optim.Adam(self.q.parameters(), lr=dcfg.lr)
        self.buffer = ReplayBuffer(dcfg.buffer_size, obs_dim, self.rng)
        self.updates = 0

    def epsilon(self, step):
        c = self.cfg
        frac = min(1.0, step / c.eps_decay_steps)
        return c.eps_start + frac * (c.eps_end - c.eps_start)

    def act(self, obs, epsilon=0.0):
        if epsilon > 0 and self.rng.random() < epsilon:
            return int(self.rng.integers(self.n_actions))
        with torch.no_grad():
            return int(self.q(torch.as_tensor(obs, dtype=torch.float32).unsqueeze(0)).argmax(1).item())

    def q_values(self, obs):
        with torch.no_grad():
            return self.q(torch.as_tensor(obs, dtype=torch.float32).unsqueeze(0)).squeeze(0).numpy()

    def td_targets(self, rew, nxt, done):
        """Bellman targets: r + gamma * (1 - terminal) * Q_target(s', a*), where a* is chosen by the
        online network (Double DQN) or the target network (plain DQN). `done` is 1 only for TRUE
        terminal states (goal / collision); time-limit truncations are stored with done = 0 so
        they still bootstrap."""
        c = self.cfg
        with torch.no_grad():
            if c.double_dqn:
                best = self.q(nxt).argmax(1, keepdim=True)
                q_next = self.q_target(nxt).gather(1, best).squeeze(1)
            else:
                q_next = self.q_target(nxt).max(1).values
            return rew + c.gamma * (1.0 - done) * q_next

    def update(self):
        c = self.cfg
        obs, act, rew, nxt, done = self.buffer.sample(c.batch_size)
        q_sa = self.q(obs).gather(1, act.unsqueeze(1)).squeeze(1)
        target = self.td_targets(rew, nxt, done)
        loss = nn.functional.smooth_l1_loss(q_sa, target)
        self.opt.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(self.q.parameters(), c.grad_clip)
        self.opt.step()
        self.updates += 1
        if self.updates % c.target_update_interval == 0:
            self.q_target.load_state_dict(self.q.state_dict())
        return float(loss.item())

    def state_dict(self):
        return {"q": self.q.state_dict(), "q_target": self.q_target.state_dict(),
                "opt": self.opt.state_dict(), "updates": self.updates}

    def load_state_dict(self, sd, weights_only=False):
        self.q.load_state_dict(sd["q"])
        self.q_target.load_state_dict(sd.get("q_target", sd["q"]))
        if not weights_only and "opt" in sd:
            self.opt.load_state_dict(sd["opt"])
            self.updates = sd.get("updates", 0)
