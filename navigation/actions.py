"""Discrete action set -> bounded velocity commands.

The policy only ever chooses an action index. Translating it into a velocity
command happens here, and the command then passes through the safety layer
before any backend sees it.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class VelocityCommand:
    v: float = 0.0   # linear, m/s (forward positive)
    w: float = 0.0   # angular, rad/s (counter-clockwise positive)
    vy: float = 0.0  # sideways, m/s (left positive) - holonomic robots only; 0 for every other robot


STOP = VelocityCommand(0.0, 0.0)


class DiscreteActionSpace:
    def __init__(self, actions):
        """actions: mapping name -> (v, w) or (v, w, vy), e.g. {"forward": (0.3, 0.0), ...}"""
        self.names = list(actions.keys())
        self.commands = [VelocityCommand(float(a[0]), float(a[1]), float(a[2]) if len(a) > 2 else 0.0) for a in actions.values()]

    @classmethod
    def from_config(cls, cfg):
        return cls(cfg.actions)

    @property
    def n(self):
        return len(self.commands)

    def to_command(self, index):
        return self.commands[int(index)]

    def index_of(self, name):
        return self.names.index(name)

    def describe(self):
        return {n: (c.v, c.w) for n, c in zip(self.names, self.commands)}
