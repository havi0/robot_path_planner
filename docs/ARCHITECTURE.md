# Architecture

## Directory structure

```
rl-robot-path-planning/
├── main.py                    CLI entry point (train / evaluate / experiments / demo / deploy ...)
├── config/
│   ├── default.yaml           world, robot, sensor, actions, reward, randomisation, safety, DQN, training
│   ├── robot_profile.yaml     physical robot: geometry, limits, calibration, ROS 2 topics, watchdog
│   └── __init__.py            YAML loading + command-line overrides
├── environment/               SIMULATION
│   ├── geometry.py            vectorised collision tests and ray casting
│   ├── world.py               arena, static/moving obstacles, random solvable map generation
│   ├── robot.py               differential-drive kinematics, actuator scale + noise
│   └── nav_env.py             Gymnasium env = NavigationCore + rewards + episode management
├── sensors/                   OBSERVATIONS (shared sim/hardware)
│   ├── types.py               Pose, SensorReading, beam layout
│   ├── range_sensor.py        simulated LiDAR (noise, dropouts)
│   ├── processing.py          real-scan resampling, invalid-reading handling
│   └── observation.py         ObservationBuilder: robot-frame, normalised observation vector
├── navigation/                DECISION -> COMMAND (shared sim/hardware)
│   ├── actions.py             discrete actions -> VelocityCommand
│   ├── core.py                NavigationCore: sense -> act -> safety -> backend (ONE code path)
│   ├── controller.py          NavigationController: runs any policy on any backend
│   ├── policies.py            DQN / Q-table / path-follower policies (common interface)
│   └── calibration.py         motion calibration procedure
├── backends/                  HARDWARE ABSTRACTION LAYER
│   ├── base.py                RobotBackend interface
│   ├── simulation_backend.py  virtual robot
│   ├── hardware_backend.py    ROS 2 robot (/scan, /odom -> /cmd_vel), watchdog
│   └── fault_injection.py     wraps any backend: sensor freeze/blackout, link loss, robot watchdog
├── safety/
│   └── safety_layer.py        limits, e-stop, corridor proximity stop, timeouts, manual override
├── agent/
│   ├── dqn.py                 Q-network, replay buffer, target network, (Double) DQN
│   └── q_learning.py          tabular Q-learning on a discretised observation
├── training/
│   ├── train_dqn.py           DQNTrainer (step-wise, used by CLI and live UI), checkpoints
│   ├── train_qlearning.py
│   └── logger.py              CSV logs, run directories
├── baselines/
│   └── grid_planners.py       A*, Dijkstra (8-connected, inflated grid, path smoothing)
├── evaluation/
│   ├── metrics.py             per-episode metrics, aggregation, Wilson CI
│   ├── evaluate.py            run any method on held-out maps via NavigationController
│   ├── experiments.py         experiment suite -> results/
│   └── safety_validation.py   scripted safety scenarios with fault injection
├── visualization/
│   ├── pygame_app.py          interactive simulator (train / evaluate)
│   ├── hardware_monitor.py    robot monitor + teleoperation (any backend)
│   ├── renderer.py            shared Pygame drawing
│   └── plots.py               Matplotlib figures
├── tests/test_core.py         unit tests
├── models/                    exported trained models (dqn.pt, qlearning.pt)
├── runs/                      training runs (config snapshot, CSV logs, checkpoints, curves)
├── results/                   experiment outputs (CSV, PNG, RESULTS.md, safety_validation.md)
└── docs/                      ARCHITECTURE.md, HARDWARE.md
```

## Data flow

```
             ┌───────────────────────── RobotBackend (HAL) ─────────────────────────┐
             │  SimulationBackend  |  HardwareBackend (ROS 2)  |  FaultInjection(*)  │
             └──────┬──────────────────────────────▲────────────────────────────────┘
   read_sensors()   │ get_pose()                   │ send_command(cmd)   wait(dt)
                    ▼                              │
            ObservationBuilder               SafetyLayer.filter()  ◄── EmergencyStop
         (robot frame, normalised)                 ▲                ◄── ManualOverride
                    │                              │
                    ▼                       DiscreteActionSpace.to_command()
               Policy.act() ───── action index ────┘
        (DQN | Q-learning | A*/Dijkstra follower)

 NavigationCore wraps exactly this loop. NavigationEnv (training) and
 NavigationController (evaluation + deployment) both call NavigationCore.step().
```

## Key interfaces

| Interface | Defined in | Implemented by |
|---|---|---|
| `RobotBackend` | `backends/base.py` | `SimulationBackend`, `HardwareBackend`, `FaultInjectionBackend` |
| `Policy.act(obs, pose, goal) -> int` | `navigation/policies.py` | `DQNPolicy`, `QTablePolicy`, `PathFollowerPolicy` |
| `SafetyLayer.filter(cmd, reading, now, connected, dt) -> SafetyDecision` | `safety/safety_layer.py` | — |
| `ObservationBuilder.build(reading, pose, goal, last_cmd) -> np.ndarray` | `sensors/observation.py` | — |

## Design decisions

* **One code path.** Training (Gymnasium) and deployment (controller) share `NavigationCore`,
  so observations, action semantics and safety handling cannot diverge.
* **Robot-frame observations.** Ranges + goal distance/bearing + last command. No absolute
  coordinates, so the policy is map-independent and the same on odometry-based hardware.
* **Checkpoints carry their config.** `load_dqn()` rebuilds the observation/action definition
  from the checkpoint, not from whatever YAML is currently on disk.
* **Safety is outside the learned component**, applied to every command, and tested
  independently with an adversarial (always-forward / random) policy.
* **Held-out evaluation.** Training map seeds < 1,000,000 ≤ evaluation map seeds.
* **ROS 2 optional.** `rclpy` is imported only inside `HardwareBackend.connect()`.
