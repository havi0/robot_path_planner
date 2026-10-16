"""Evaluate any navigation method on held-out simulated maps through the SAME
NavigationController that is used for real-robot deployment."""
import math

import torch

from agent.dqn import DQNAgent
from agent.q_learning import ObservationDiscretizer, QLearningAgent
from backends.simulation_backend import SimulationBackend
from baselines.grid_planners import astar, dijkstra
from config import Config
from evaluation.metrics import EpisodeMetrics, aggregate
from navigation.actions import DiscreteActionSpace
from navigation.controller import NavigationController
from navigation.policies import DQNPolicy, PathFollowerPolicy, QTablePolicy, RecoveryWrapper
from safety.safety_layer import SafetyLayer
from sensors.observation import observation_builder_from_config
from sensors.types import beam_angles


class Method:
    """A named navigation method: a policy plus (optionally) a global planner."""

    def __init__(self, name, policy, planner=None):
        self.name = name
        self.policy = policy
        self.planner = planner          # None = acts on local observations only

    @property
    def uses_known_map(self):
        return self.planner is not None


# ---------- loading trained models ----------
def load_checkpoint(path):
    return torch.load(path, map_location="cpu", weights_only=True)


def load_dqn(path):
    ckpt = load_checkpoint(path)
    cfg = Config.wrap(ckpt["config"])
    obs_dim = observation_builder_from_config(cfg).dim
    agent = DQNAgent(obs_dim, DiscreteActionSpace.from_config(cfg).n, cfg.dqn)
    agent.load_state_dict(ckpt["agent"], weights_only=True)
    agent.q.eval()
    return agent, cfg


def make_discretizer(cfg):
    return ObservationDiscretizer(cfg.sensor.num_beams, beam_angles(cfg.sensor.num_beams, cfg.sensor.fov_deg),
                                  cfg.sensor.max_range, math.hypot(cfg.world.width, cfg.world.height))


def load_qlearning(path):
    ckpt = load_checkpoint(path)
    cfg = Config.wrap(ckpt["config"])
    agent = QLearningAgent(make_discretizer(cfg), DiscreteActionSpace.from_config(cfg).n, cfg.qlearning)
    agent.Q = ckpt["q_table"].numpy()
    return agent, cfg


def dqn_method(agent):
    return Method("DQN", DQNPolicy(agent))


def with_recovery(method, cfg):
    p = RecoveryWrapper(method.policy, DiscreteActionSpace.from_config(cfg),
                        beam_angles(cfg.sensor.num_beams, cfg.sensor.fov_deg), cfg.sensor.max_range)
    return Method(p.name, p)


def qlearning_method(agent):
    return Method("Q-learning", QTablePolicy(agent))


def planner_methods(cfg):
    actions = DiscreteActionSpace.from_config(cfg)
    return [Method("A*", PathFollowerPolicy(actions, "A*"), astar),
            Method("Dijkstra", PathFollowerPolicy(actions, "Dijkstra"), dijkstra)]


# ---------- running episodes ----------
def plan_with_fallback(cfg, planner, world, goal):
    """Plan with a safety margin around obstacles; if narrow passages make that
    impossible, retry with smaller margins down to robot radius + 2 cm.
    Reported planning time / expansions include all attempts."""
    ev = cfg.evaluation
    total_ms, total_expanded = 0.0, 0
    for margin in sorted({ev.planner_inflation, 0.05, 0.02}, reverse=True):
        res = planner(world, world.start[:2], goal, ev.planner_resolution, cfg.robot.radius + margin)
        total_ms += res.plan_time_ms
        total_expanded += res.expanded
        if res.path:
            break
    res.plan_time_ms, res.expanded = total_ms, total_expanded
    return res


def run_episode(cfg, method, map_seed, use_safety=False, density=None, sensor_noise=None,
                dropout=None, motion_noise=None, num_movers=None, on_step=None, backend=None,
                world=None, obs_cfg=None):
    """world: run on this exact map instead of generating one from map_seed.
    obs_cfg: config whose observation normalisation the policy was trained with."""
    backend = backend or SimulationBackend(cfg)
    goal = backend.new_episode(map_seed=map_seed, density=density, sensor_noise=sensor_noise,
                               dropout=dropout, motion_noise=motion_noise, num_movers=num_movers, world=world)
    world = backend.world
    reference = plan_with_fallback(cfg, astar, world, goal)

    context, planning_ms, expanded = {}, 0.0, 0
    if method.planner is not None:
        plan = reference if method.planner is astar else plan_with_fallback(cfg, method.planner, world, goal)
        context, planning_ms, expanded = {"path": plan.path}, plan.plan_time_ms, plan.expanded

    p = backend.episode_params
    # the robot only has to reach the goal circle, not its centre
    ref_len = max(reference.length - cfg.world.goal_radius, 1e-6)
    common = dict(method=method.name, map_seed=map_seed, density=p["density"],
                  sensor_noise=p["sensor_noise"], motion_noise=p["motion_noise"],
                  reference_length=ref_len, planning_ms=planning_ms, nodes_expanded=expanded)
    if method.planner is not None and not context["path"]:
        return EpisodeMetrics(outcome="no_path", steps=0, path_length=0.0, inference_ms=0.0,
                              safety_interventions=0, **common)

    safety = SafetyLayer(cfg.safety, cfg.robot.radius) if use_safety else None
    controller = NavigationController(backend, method.policy, observation_builder_from_config(obs_cfg or cfg),
                                      DiscreteActionSpace.from_config(cfg), cfg.robot.control_dt,
                                      cfg.world.goal_radius, safety)
    rr = controller.run(goal, cfg.training.max_episode_steps, on_step=on_step, policy_context=context)
    return EpisodeMetrics(outcome=rr.outcome, steps=rr.steps, path_length=rr.path_length,
                          inference_ms=rr.mean_inference_ms,
                          safety_interventions=rr.safety_interventions, **common)


VALIDATION_START = 500_000   # validation maps (checkpoint selection) never overlap the test maps


def heldout_seeds(cfg, n, start=0):
    """Test maps: offset .. offset+n. Never used in training or model selection."""
    off = cfg.evaluation.heldout_seed_offset
    return list(range(off + start, off + start + n))


def validation_seeds(cfg, n):
    """Validation maps for checkpoint selection during training (disjoint from test maps)."""
    return heldout_seeds(cfg, n, start=VALIDATION_START)


def evaluate_method(cfg, method, seeds, **kwargs):
    episodes = [run_episode(cfg, method, s, **kwargs) for s in seeds]
    return aggregate(episodes), episodes
