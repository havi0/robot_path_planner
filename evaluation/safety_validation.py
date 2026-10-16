"""Safety validation without hardware: scripted scenarios + fault injection.

Each scenario states an expected safe behaviour and checks it in simulation.
This is the gate that must pass BEFORE any real-robot deployment (docs/HARDWARE.md).
"""
import math
import os

import numpy as np

from backends.fault_injection import FaultInjectionBackend
from backends.simulation_backend import SimulationBackend
from environment.world import World
from evaluation.evaluate import load_dqn
from navigation.actions import DiscreteActionSpace, VelocityCommand
from navigation.controller import NavigationController
from navigation.policies import DQNPolicy, Policy
from safety.safety_layer import SafetyLayer
from sensors.observation import observation_builder_from_config


class ConstantPolicy(Policy):
    """Adversarial test policy: always picks the same action (e.g. drive forward)."""

    def __init__(self, action):
        self.name = f"constant({action})"
        self.action = action

    def act(self, observation, pose, goal):
        return self.action


class RandomPolicy(Policy):
    name = "random"

    def __init__(self, n, seed=0):
        self.n, self.rng = n, np.random.default_rng(seed)

    def act(self, observation, pose, goal):
        return int(self.rng.integers(self.n))


def _controller(cfg, backend, policy, safety):
    return NavigationController(backend, policy, observation_builder_from_config(cfg),
                                DiscreteActionSpace.from_config(cfg), cfg.robot.control_dt,
                                cfg.world.goal_radius, safety)


def _wall_world(cfg):
    # robot at x=2.6 facing +x, wall face at x=3.0 (0.4 m ahead of the centre)
    return World(cfg.world.width, cfg.world.height, [[3.0, 0.0, 3.3, cfg.world.height]],
                 start=(2.6, 3.0, 0.0), goal=(5.0, 3.0))


def _sim(cfg, world=None, seed=0):
    b = SimulationBackend(cfg)
    b.new_episode(map_seed=seed, world=world)
    return b


def run_safety_validation(cfg, dqn_path=None, out_dir="results"):
    acts = DiscreteActionSpace.from_config(cfg)
    fwd = acts.index_of("forward")
    dt = cfg.robot.control_dt
    sc = cfg.safety
    results = []

    def record(name, expected, passed, detail):
        results.append((name, expected, passed, detail))
        print(f"[{'PASS' if passed else 'FAIL'}] {name}: {detail}")

    # 0. configuration sanity: robot must not travel further than the stop margin in one step
    travel = max(abs(c.v) for c in acts.commands) * dt
    record("Stop margin vs. step length", "stop_distance > max speed x control period",
           sc.stop_distance > travel, f"stop_distance={sc.stop_distance} m, max travel/step={travel:.3f} m")

    # 1. velocity limits
    safety = SafetyLayer(sc, cfg.robot.radius)
    b = _sim(cfg)
    safety.last_output = VelocityCommand(sc.max_linear_speed, sc.max_angular_speed)
    d = safety.filter(VelocityCommand(5.0, -9.0), b.read_sensors(), b.now(), True, dt)
    ok = abs(d.command.v) <= sc.max_linear_speed + 1e-9 and abs(d.command.w) <= sc.max_angular_speed + 1e-9
    record("Velocity limits", "commands clamped", ok, f"requested (5.0, -9.0) -> ({d.command.v:.2f}, {d.command.w:.2f})")

    # 2. proximity stop with an adversarial always-forward policy
    b = _sim(cfg, _wall_world(cfg))
    safety = SafetyLayer(sc, cfg.robot.radius)
    res = _controller(cfg, b, ConstantPolicy(fwd), safety).run(b.world.goal, 40)
    gap = 3.0 - (b.state.x + cfg.robot.radius)
    record("Proximity stop (always-forward policy, wall ahead)", "no collision, robot halts before wall",
           res.outcome != "collision" and not b.collided,
           f"outcome={res.outcome}, final gap to wall={gap:.3f} m, interventions={res.safety_reasons}")
    b = _sim(cfg, _wall_world(cfg))
    res = _controller(cfg, b, ConstantPolicy(fwd), None).run(b.world.goal, 40)
    record("  control: same policy WITHOUT shield", "collides (shows the shield is what prevents it)",
           res.outcome == "collision", f"outcome={res.outcome}")

    # 3. random policy on many maps, with and without the shield
    n = 50
    coll = {True: 0, False: 0}
    for use in (True, False):
        for s in range(n):
            b = _sim(cfg, seed=cfg.evaluation.heldout_seed_offset + 5000 + s)
            safety = SafetyLayer(sc, cfg.robot.radius) if use else None
            res = _controller(cfg, b, RandomPolicy(acts.n, s), safety).run(b.world.goal, 200)
            coll[use] += res.outcome == "collision"
    record("Random policy on 50 maps", "shield greatly reduces collisions",
           coll[True] <= max(1, coll[False] // 10),
           f"collisions with shield {coll[True]}/{n}, without {coll[False]}/{n}")

    # 4. sensor timeout (sensor stream freezes at t=2 s)
    b = _sim(cfg, World(cfg.world.width, cfg.world.height, [], (1.0, 3.0, 0.0), (5.5, 3.0)))
    fb = FaultInjectionBackend(b, sensor_freeze_at=2.0)
    safety = SafetyLayer(sc, cfg.robot.radius)
    x_at_fault = []
    res = _controller(cfg, fb, ConstantPolicy(fwd), safety).run(
        b.world.goal, 40, on_step=lambda r: x_at_fault.append(r.pose.x) if abs(r.pose.timestamp - 2.0) < 1e-6 else None)
    moved_after = b.state.x - x_at_fault[0] if x_at_fault else float("nan")
    bound = travel * (math.ceil(sc.sensor_timeout / dt) + 1)
    record("Sensor timeout", f"robot stops within sensor_timeout ({sc.sensor_timeout}s)",
           moved_after <= bound + 1e-6 and "sensor_timeout" in res.safety_reasons,
           f"moved {moved_after:.3f} m after freeze (bound {bound:.3f} m), reasons={res.safety_reasons}")

    # 5. sensor blackout (all beams invalid)
    b = _sim(cfg, World(cfg.world.width, cfg.world.height, [], (1.0, 3.0, 0.0), (5.5, 3.0)))
    fb = FaultInjectionBackend(b, sensor_blackout_at=1.0)
    safety = SafetyLayer(sc, cfg.robot.radius)
    res = _controller(cfg, fb, ConstantPolicy(fwd), safety).run(b.world.goal, 30)
    record("Sensor blackout", "stop on invalid sensor data", "sensor_fault" in res.safety_reasons and b.state.x < 2.0,
           f"final x={b.state.x:.2f} (would reach goal at 5.2 without fault), reasons={res.safety_reasons}")

    # 6. communication loss: robot-side watchdog must stop the motors
    for wd in (sc.sensor_timeout, None):
        b = _sim(cfg, World(cfg.world.width, cfg.world.height, [], (0.5, 3.0, 0.0), (5.8, 3.0)))
        fb = FaultInjectionBackend(b, comm_loss_at=1.0, robot_watchdog=wd)
        safety = SafetyLayer(sc, cfg.robot.radius)
        _controller(cfg, fb, ConstantPolicy(fwd), safety).run(b.world.goal, 30)
        x_loss = 0.5 + 1.0 * acts.commands[fwd].v
        drift = b.state.x - x_loss
        if wd is not None:
            record("Communication loss + robot watchdog", "motors stop within watchdog timeout",
                   drift <= acts.commands[fwd].v * (wd + dt) + 1e-6,
                   f"travelled {drift:.2f} m after link loss (watchdog {wd}s)")
        else:
            record("  control: communication loss WITHOUT robot watchdog",
                   "robot keeps going (why a hardware watchdog is mandatory)",
                   drift > 1.0, f"travelled {drift:.2f} m after link loss")

    # 7. emergency stop: latches and aborts the run
    b = _sim(cfg, World(cfg.world.width, cfg.world.height, [], (1.0, 3.0, 0.0), (5.5, 3.0)))
    safety = SafetyLayer(sc, cfg.robot.radius)
    ctrl = _controller(cfg, b, ConstantPolicy(fwd), safety)
    res = ctrl.run(b.world.goal, 40, on_step=lambda r: safety.estop.trigger("test") if r.pose.timestamp >= 1.0 else None)
    x_after = b.state.x
    d = safety.filter(VelocityCommand(0.3, 0.0), b.read_sensors(), b.now(), True, dt)
    record("Emergency stop", "immediate stop, latched until reset, run aborted",
           res.outcome == "aborted" and d.command.v == 0 and x_after < 1.0 + 1.0 * 0.3 + 1e-6,
           f"outcome={res.outcome} ({res.abort_reason}), still blocked after: {d.command.v == 0}")
    safety.estop.reset()
    d = safety.filter(VelocityCommand(0.3, 0.0), b.read_sensors(), b.now(), True, dt)
    record("  e-stop reset", "motion allowed again only after explicit reset", d.command.v > 0,
           f"after reset command v={d.command.v:.2f}")

    # 8. manual override replaces the policy's command
    safety = SafetyLayer(sc, cfg.robot.radius)
    safety.override.engage(VelocityCommand(0.0, 0.5))
    d = safety.filter(VelocityCommand(0.3, 0.0), b.read_sensors(), b.now(), True, dt)
    record("Manual override", "operator command replaces policy command",
           d.command == VelocityCommand(0.0, 0.5), f"policy asked (0.3, 0.0) -> sent ({d.command.v}, {d.command.w})")

    # 9. trained DQN with shield on held-out maps
    if dqn_path and os.path.exists(dqn_path):
        agent, _ = load_dqn(dqn_path)
        n = 100
        outcomes = {True: [], False: []}
        for use in (True, False):
            for s in range(n):
                b = _sim(cfg, seed=cfg.evaluation.heldout_seed_offset + s)
                safety = SafetyLayer(sc, cfg.robot.radius) if use else None
                outcomes[use].append(_controller(cfg, b, DQNPolicy(agent), safety).run(
                    b.world.goal, cfg.training.max_episode_steps).outcome)
        c_on, c_off = outcomes[True].count("collision"), outcomes[False].count("collision")
        record("Trained DQN on 100 held-out maps", "shield does not increase collisions", c_on <= c_off,
               f"collisions: shield {c_on}/{n}, no shield {c_off}/{n}; success: shield "
               f"{outcomes[True].count('success')}/{n}, no shield {outcomes[False].count('success')}/{n}")

    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "safety_validation.md"), "w", encoding="utf-8") as f:
        f.write("# Safety validation (simulation + fault injection)\n\n"
                "Generated by `python main.py safety-test`.\n\n"
                "| Scenario | Expected | Result | Detail |\n|---|---|---|---|\n")
        for name, exp, ok, det in results:
            f.write(f"| {name.strip()} | {exp} | {'PASS' if ok else 'FAIL'} | {det} |\n")
    passed = all(ok for _, _, ok, _ in results)
    print(f"\n{'ALL SAFETY CHECKS PASSED' if passed else 'SOME SAFETY CHECKS FAILED'} "
          f"-> {os.path.join(out_dir, 'safety_validation.md')}")
    return passed
