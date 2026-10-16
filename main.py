"""Sim-to-Real Autonomous Robot Path Planning with Deep Reinforcement Learning.

Commands (run `python main.py <command> -h` for options):
    train-dqn        train the DQN agent in simulation
    train-qlearning  train the tabular Q-learning baseline
    evaluate         evaluate methods on held-out (unseen) maps
    experiments      run the full experiment suite and write results/
    demo             interactive Pygame simulator (train / evaluate live)
    safety-test      validate the safety layer with injected faults (no hardware)
    calibrate        estimate linear/angular motion scale factors
    monitor          monitoring window for a robot backend (sim or ROS 2)
    deploy           run a trained policy on a backend (sim or ROS 2 hardware)
    studio           NEXUS web studio (FastAPI backend + React UI) on http://127.0.0.1:8000
"""
import argparse
import os
import sys
import warnings

warnings.filterwarnings("ignore", message="pkg_resources is deprecated")
os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import load_config  # noqa: E402


def cmd_studio(args, cfg):
    import uvicorn
    from server.app import create_app
    if not os.path.isdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "studio", "dist")):
        print("Frontend not built yet: run `npm install && npm run build` in studio/ (API still starts).")
    print(f"NEXUS studio -> http://{args.host}:{args.port}")
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="warning")


def cmd_train_dqn(args, cfg):
    from training.train_dqn import train_dqn
    from visualization.plots import plot_training_run
    if args.steps:
        cfg.training.total_steps = args.steps
    trainer = train_dqn(cfg, args.run_dir, export_to=args.export)
    plot_training_run(trainer.run_dir, "DQN")
    print(f"Training plots saved in {trainer.run_dir}")


def cmd_train_qlearning(args, cfg):
    from training.train_qlearning import train_qlearning
    from visualization.plots import plot_training_run
    if args.episodes:
        cfg.qlearning.episodes = args.episodes
    run_dir = train_qlearning(cfg, args.run_dir, export_to=args.export)
    plot_training_run(run_dir, "Q-learning")


def _load_methods(names, cfg, dqn_path, q_path):
    from evaluation.evaluate import dqn_method, load_dqn, load_qlearning, planner_methods, qlearning_method
    methods = []
    if "dqn" in names:
        methods.append(dqn_method(load_dqn(dqn_path)[0]))
    if "qlearning" in names:
        methods.append(qlearning_method(load_qlearning(q_path)[0]))
    planners = {m.name.lower().replace("*", "star"): m for m in planner_methods(cfg)}
    methods += [planners[n] for n in ("astar", "dijkstra") if n in names]
    return methods


def cmd_evaluate(args, cfg):
    from evaluation.evaluate import evaluate_method, heldout_seeds
    names = ["dqn", "qlearning", "astar", "dijkstra"] if "all" in args.methods else args.methods
    seeds = heldout_seeds(cfg, args.episodes)
    print(f"Evaluating on {len(seeds)} held-out maps (density={args.density or cfg.world.obstacle_density}, "
          f"safety shield={'on' if args.safety else 'off'})")
    print(f"{'method':<12}{'success':>9}{'95% CI':>15}{'collision':>11}{'timeout':>9}"
          f"{'path/opt':>10}{'steps':>8}{'infer ms':>10}{'plan ms':>9}")
    for m in _load_methods(names, cfg, args.model, args.qmodel):
        s, _ = evaluate_method(cfg, m, seeds, use_safety=args.safety, density=args.density,
                               sensor_noise=args.sensor_noise, motion_noise=args.motion_noise,
                               num_movers=args.movers)
        print(f"{m.name:<12}{s['success_rate']:>9.2f}   [{s['success_ci_low']:.2f}, {s['success_ci_high']:.2f}]"
              f"{s['collision_rate']:>11.2f}{s['timeout_rate']:>9.2f}{s['mean_path_ratio_success']:>10.2f}"
              f"{s['mean_steps_success']:>8.1f}{s['mean_inference_ms']:>10.3f}{s['mean_planning_ms']:>9.1f}")


def cmd_experiments(args, cfg):
    from evaluation.experiments import run_all
    if args.episodes:
        cfg.evaluation.episodes_per_setting = args.episodes
    run_all(cfg, args.model, args.qmodel, args.out, args.only,
            run_dirs={"DQN": args.dqn_run, "Q-learning": args.q_run})


def cmd_demo(args, cfg):
    from visualization.pygame_app import SimulatorApp
    SimulatorApp(cfg, args.model, args.qmodel).run()


def cmd_safety_test(args, cfg):
    from evaluation.safety_validation import run_safety_validation
    ok = run_safety_validation(cfg, args.model)
    sys.exit(0 if ok else 1)


def _make_backend(name, cfg, profile_path=None):
    if name == "sim":
        from backends.simulation_backend import SimulationBackend
        backend = SimulationBackend(cfg)
        backend.new_episode(map_seed=cfg.evaluation.heldout_seed_offset + 999, randomize=True)
        return backend
    from backends.hardware_backend import HardwareBackend
    from config import load_robot_profile
    backend = HardwareBackend(load_robot_profile(profile_path), cfg.sensor)
    backend.connect()
    return backend


def cmd_calibrate(args, cfg):
    from navigation.calibration import calibrate
    backend = _make_backend(args.backend, cfg, args.profile)
    try:
        calibrate(backend, cfg, distance=args.distance, angle_deg=args.angle,
                  interactive=args.backend != "sim")
    finally:
        backend.disconnect()


def cmd_monitor(args, cfg):
    from visualization.hardware_monitor import HardwareMonitor
    backend = _make_backend(args.backend, cfg, args.profile)
    try:
        HardwareMonitor(backend, cfg, args.model if args.drive else None).run()
    finally:
        backend.disconnect()


def cmd_deploy(args, cfg):
    from evaluation.evaluate import Method, load_dqn, with_recovery
    from navigation.actions import DiscreteActionSpace
    from navigation.controller import NavigationController
    from navigation.policies import DQNPolicy
    from safety.safety_layer import SafetyLayer
    from sensors.observation import observation_builder_from_config

    agent, train_cfg = load_dqn(args.model)    # use the TRAINING config for obs/actions
    policy = DQNPolicy(agent)
    if not args.no_recovery:
        policy = with_recovery(Method("DQN", policy), train_cfg).policy
    backend = _make_backend(args.backend, train_cfg, args.profile)
    goal = tuple(args.goal) if args.goal else backend.world.goal
    safety = SafetyLayer(cfg.safety, train_cfg.robot.radius)       # safety is never optional here
    ctrl = NavigationController(backend, policy, observation_builder_from_config(train_cfg),
                                DiscreteActionSpace.from_config(train_cfg), train_cfg.robot.control_dt,
                                train_cfg.world.goal_radius, safety)
    print(f"Deploying on '{backend.name}' to goal {goal}. Ctrl+C = emergency stop.")
    try:
        res = ctrl.run(goal, args.max_steps,
                       on_step=lambda r: print(f"\rpose=({r.pose.x:.2f},{r.pose.y:.2f}) "
                                               f"dist={r.distance_to_goal:.2f} cmd=({r.executed.v:.2f},{r.executed.w:.2f}) "
                                               f"{','.join(r.safety.reasons) if r.safety else ''}      ", end="")
                       if r.pose else None)
        print(f"\nResult: {res.outcome} after {res.steps} steps, path {res.path_length:.2f} m, "
              f"safety interventions {res.safety_interventions} {res.safety_reasons}")
    except KeyboardInterrupt:
        safety.estop.trigger("keyboard")
        backend.stop()
        print("\nEMERGENCY STOP: robot stopped.")
    finally:
        backend.disconnect()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--config", default=None, help="YAML config (default: config/default.yaml)")
    p.add_argument("--set", action="append", default=[], metavar="KEY=VAL",
                   help="override a config value (repeatable), e.g. --set training.total_steps=1000")
    sub = p.add_subparsers(dest="command", required=True)

    def model_args(sp):
        sp.add_argument("--model", default="models/dqn.pt")
        sp.add_argument("--qmodel", default="models/qlearning.pt")

    sp = sub.add_parser("train-dqn")
    sp.add_argument("--steps", type=int)
    sp.add_argument("--run-dir")
    sp.add_argument("--export", default="models/dqn.pt")
    sp.set_defaults(func=cmd_train_dqn)

    sp = sub.add_parser("train-qlearning")
    sp.add_argument("--episodes", type=int)
    sp.add_argument("--run-dir")
    sp.add_argument("--export", default="models/qlearning.pt")
    sp.set_defaults(func=cmd_train_qlearning)

    sp = sub.add_parser("evaluate")
    model_args(sp)
    sp.add_argument("--methods", nargs="+", default=["all"],
                    choices=["all", "dqn", "qlearning", "astar", "dijkstra"])
    sp.add_argument("--episodes", type=int, default=100)
    sp.add_argument("--density", type=float)
    sp.add_argument("--sensor-noise", type=float)
    sp.add_argument("--motion-noise", type=float)
    sp.add_argument("--movers", type=int, help="number of moving obstacles")
    sp.add_argument("--safety", action="store_true", help="run with the safety shield")
    sp.set_defaults(func=cmd_evaluate)

    sp = sub.add_parser("experiments")
    model_args(sp)
    sp.add_argument("--episodes", type=int, help="episodes per setting")
    sp.add_argument("--out", default="results")
    sp.add_argument("--only", nargs="*",
                    help="subset of: training comparison density generalization noise dynamic")
    sp.add_argument("--dqn-run", help="DQN training run dir (for training curves)")
    sp.add_argument("--q-run", help="Q-learning training run dir (for training curves)")
    sp.set_defaults(func=cmd_experiments)

    sp = sub.add_parser("demo")
    model_args(sp)
    sp.set_defaults(func=cmd_demo)

    sp = sub.add_parser("studio")
    sp.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to allow other machines on the network")
    sp.add_argument("--port", type=int, default=8000)
    sp.set_defaults(func=cmd_studio)

    sp = sub.add_parser("safety-test")
    model_args(sp)
    sp.set_defaults(func=cmd_safety_test)

    for name, fn in (("calibrate", cmd_calibrate), ("monitor", cmd_monitor), ("deploy", cmd_deploy)):
        sp = sub.add_parser(name)
        sp.add_argument("--backend", choices=["sim", "ros2"], default="sim")
        sp.add_argument("--profile", default=None, help="robot profile YAML (hardware)")
        model_args(sp)
        if name == "calibrate":
            sp.add_argument("--distance", type=float, default=1.0)
            sp.add_argument("--angle", type=float, default=360.0)
        if name == "monitor":
            sp.add_argument("--drive", action="store_true", help="let the DQN drive while monitoring")
        if name == "deploy":
            sp.add_argument("--goal", type=float, nargs=2, metavar=("X", "Y"))
            sp.add_argument("--max-steps", type=int, default=400)
            sp.add_argument("--no-recovery", action="store_true", help="disable stuck-recovery behaviour")
        sp.set_defaults(func=fn)

    args = p.parse_args()
    cfg = load_config(args.config, args.set)
    args.func(args, cfg)


if __name__ == "__main__":
    main()
