# Sim-to-Real Autonomous Robot Path Planning and Obstacle Avoidance Using Deep Reinforcement Learning

A differential-drive robot learns to reach a goal while avoiding obstacles using
a Deep Q-Network trained entirely in a 2D simulation. The navigation stack is
built around a hardware abstraction layer and an independent safety layer, so
the same policy and code path can later drive a physical robot (ROS 2) —
**but no hardware is required**: training, evaluation, visualisation and
safety validation all run on an ordinary computer.

* Methodology, experiments, results and limitations: [REPORT.md](REPORT.md)
* Architecture and interfaces: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
* Hardware integration + safety procedure: [docs/HARDWARE.md](docs/HARDWARE.md)
* Web studio architecture, API and dev setup: [docs/STUDIO.md](docs/STUDIO.md)
* Collision & navigation reliability fix (root causes, measurements): [docs/COLLISION_FIX.md](docs/COLLISION_FIX.md)
* Robot selection (catalog, kinematics, policy compatibility): [docs/ROBOTS.md](docs/ROBOTS.md)
* NEXUS 2.0 research features (copilot, scenarios, counterfactuals, risk, designer, registry): [docs/NEXUS2.md](docs/NEXUS2.md)
* Raw experiment output: [results/RESULTS.md](results/RESULTS.md), [results/safety_validation.md](results/safety_validation.md)

## NEXUS studio (web application)

A premium web interface for the whole project: live simulation, Training Lab,
experiments, algorithm comparison, analytics and the hardware bridge — plus
NEXUS 2.0 research tools: scenario generator & curriculum, map analyzer,
behaviour profiler, exact counterfactuals, risk explorer, experiment designer,
model registry and a grounded Research Copilot. All backed by the real Python stack. Details: [docs/STUDIO.md](docs/STUDIO.md).

```bash
cd studio && npm install && npm run build && cd ..   # one-time frontend build
python main.py studio                                 # open http://127.0.0.1:8000
```

## Install

```bash
pip install -r requirements.txt
```
Python 3.10+; CPU is enough (DQN training takes ~10 minutes).

## Quick start

```bash
python main.py demo                      # interactive simulator (uses models/dqn.pt)
python main.py evaluate --episodes 100   # DQN vs Q-learning vs A* vs Dijkstra on unseen maps
python main.py safety-test               # safety validation with fault injection
python -m pytest tests                   # unit tests
```

### Train
```bash
python main.py train-dqn                 # -> runs/dqn_<time>/, best model copied to models/dqn.pt
python main.py train-qlearning           # -> models/qlearning.pt
python main.py --set training.total_steps=100000 --set world.obstacle_density=0.2 train-dqn
```

### Experiments (all numbers in the report come from here)
```bash
python main.py experiments --dqn-run runs/<dqn run> --q-run runs/<q-learning run>
```
Writes CSVs, figures and `results/RESULTS.md`: method comparison, obstacle-density
sweep, generalisation to out-of-distribution maps, sensor/motion-noise sweeps,
moving obstacles.

### Simulator controls (`python main.py demo`)
| Key / button | Action |
|---|---|
| SPACE / *Start / Pause* | start, pause, resume |
| R / *Reset map*, N / *Next map* | restart episode / new unseen map |
| M / *Mode* | switch EVALUATE ⇄ TRAIN (live DQN training) |
| P / *Policy* | DQN, Q-learning, A*, Dijkstra |
| S / *Shield* | safety layer on/off |
| X | emergency stop (latched) |
| UP / DOWN | obstacle density |
| O, G | moving obstacles, obstacle shapes (normal / clutter / walls) |
| L, + / − | LiDAR beams, simulation speed |
| mouse click | move the goal |

### Robot-side tools (work with the simulator; `--backend ros2` for hardware)
```bash
python main.py monitor --drive           # monitor + teleop (arrows), D = autonomous, SPACE = e-stop
python main.py calibrate                 # motion calibration (sim verifies against hidden ground truth)
python main.py deploy --backend sim      # run the policy through the full deployment path
```

## How it works (short)

* **Robot:** circular differential drive (r = 0.15 m), unicycle kinematics,
  4 discrete actions: forward 0.3 m/s, turn left/right 1.2 rad/s in place, stop;
  one decision every 0.25 s.
* **Observation (29 values, robot frame):** 24 LiDAR ranges (360°, 3 m), goal
  distance, sin/cos of goal bearing, last linear/angular command.
* **Reward:** +10 goal, −10 collision, time penalty, progress toward goal,
  penalties for stopping, near-obstacle proximity and left/right dithering.
* **DQN:** 2×128 MLP, Double DQN, replay buffer, target network, ε-greedy.
* **Domain randomisation:** new random map per episode, density, wheel
  calibration error, motion noise, sensor noise and dropouts.
* **Baselines:** tabular Q-learning (same observations, discretised); A* and
  Dijkstra on the **known** map, executed by a path follower using the same actions.
* **Safety layer:** velocity/acceleration limits, latched e-stop, swept-corridor
  proximity stop, sensor timeout/fault, link loss, manual override, plus
  backend and firmware watchdogs.
