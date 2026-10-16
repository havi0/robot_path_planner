# NEXUS — Autonomous Robotics Intelligence Studio

Web studio for the project: a React/TypeScript frontend on top of a FastAPI
backend that runs the real simulator, DQN/Q-learning training, classical
planners, safety layer and hardware bridge from this repository.
Nothing in the UI is simulated on the client: every number, path and robot
pose comes from the Python backend.

## Running it

```bash
# one-time
pip install -r requirements.txt
cd studio && npm install && npm run build && cd ..

# start (serves API + built UI)
python main.py studio                 # http://127.0.0.1:8000
python main.py studio --host 0.0.0.0  # reachable from other machines on the LAN
```

### Frontend development (hot reload)
```bash
python main.py studio                 # terminal 1: backend on :8000
cd studio && npm run dev              # terminal 2: UI on http://localhost:5173 (proxies /api and /ws)
npm run typecheck                     # strict TypeScript check
```

### Tests
```bash
python -m pytest tests                # 67 tests: environment, safety, planners, API, training, hardware safety, WebSocket, NEXUS 2.0 research features
```

## Architecture

```
 Browser (React + TS)                         Python backend (FastAPI, server/)
 ┌──────────────────────────┐   REST /api/*   ┌──────────────────────────────────────────────┐
 │ pages/  Overview, Live   │ ──────────────► │ app.py        routes, validation, JSON-safe   │
 │ Simulation, Training Lab,│   commands      │                                                │
 │ Experiments, Planner,    │                 │ sim_session.py      live sim (thread)  ─┐      │
 │ Hardware, Analytics,     │ ◄────────────── │ training_manager.py DQN / Q-learning   │      │
 │ Settings                 │  WebSocket /ws  │                     (thread)            ├─► NavigationEnv / NavigationCore
 │                          │  15 Hz ticks:   │ planner_service.py  A*, Dijkstra, RL    │      SafetyLayer, policies, A*
 │ lib/live.ts  store fed   │  sim, training, │ hardware_service.py bridge (thread) ────┘      RobotBackend (sim | ROS 2)
 │ only by the socket       │  hardware,      │ experiments.py      data/experiments/<id>/     │
 │ (auto-reconnect)         │  events,        │ events.py           event log                  │
 │ components/sim/SimCanvas │  new episodes   │ models.py           active checkpoints         │
 └──────────────────────────┘                 └──────────────────────────────────────────────┘
```

* **Simulation, physics, collisions, rewards and policy decisions** run in
  `SimSession` (Python). The canvas only renders snapshots; between snapshots
  it interpolates the robot toward the latest backend pose (never beyond it),
  and sensor rays are always drawn from the true backend pose.
* **Training** runs in a background thread (`TrainingManager`) through the
  same `NavigationEnv` as the CLI. Per-episode metrics are kept in memory,
  streamed over the WebSocket and appended to `metrics.csv`. Pause/resume use
  an event flag; stop saves `last.pt` and never deletes checkpoints.
* **Evaluation** runs greedy policies on held-out test maps in a separate thread
  and stores results in `experiment.json`.
* **Blocking work never runs on the asyncio loop**: snapshots for the socket are
  built with `asyncio.to_thread`, planner comparisons and hardware connects are
  offloaded the same way.
* **Experiments** persist under `data/experiments/<id>/` (`experiment.json`,
  `metrics.csv`, `run/` with config snapshot and checkpoints). The two models
  used in REPORT.md are imported read-only as reference experiments.

### Message flow (example: pressing *Start* on Live Simulation)
1. UI → `POST /api/sim/control {"action":"start"}`.
2. `SimSession.control` sets status `running`; its thread advances the robot at
   the selected rate (policy → action → SafetyLayer (if shield) → backend).
3. The broadcaster pushes a `tick` with the new snapshot ~15×/s; `lib/live.ts`
   updates the store; `SimCanvas` animates the pose; telemetry panels re-render.
4. On goal/collision/timeout the session emits an event (shown in *Recent activity*).

## Hardware bridge safety model

| Rule | Where enforced |
|---|---|
| No motion unless operating mode = hardware, backend connected, robot armed | `HardwareBridge._require_motion_allowed` (server) |
| Arming needs typed confirmation `ARM` (+ UI checklist) | server + UI |
| ROS 2 connect fails unless rclpy is installed **and** `/odom` + `/scan` arrive within 3 s | `HardwareBridge.connect` |
| Every command passes `SafetyLayer` (limits, proximity, stale/invalid scan, e-stop) | control loop |
| Manual commands expire after 0.5 s (dead-man) | control loop |
| Link loss → stop + disarm; e-stop → stop + disarm, must re-arm | control loop / `set_estop` |
| Leaving hardware mode disarms | `POST /api/mode` |
| Loopback backend is always reported as `simulated` | snapshot + UI badges |

The software e-stop does not replace a physical emergency stop (see docs/HARDWARE.md).

## API summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health`, `/api/state`, `/api/events` | status, full snapshot, event log |
| POST | `/api/mode` | `simulation` / `hardware` |
| POST | `/api/sim/control` | `start pause resume reset step regenerate` |
| POST | `/api/sim/speed`, `/policy`, `/shield`, `/config`, `/goal`, `/start`, `/obstacles` | simulation controls |
| POST | `/api/training/start`, `/pause`, `/resume`, `/stop`, `/checkpoint` | training lifecycle |
| GET | `/api/training/state`, `/api/training/episodes?since=` | training status / metrics |
| POST | `/api/evaluate`, `/api/checkpoints/load` | evaluate / load a checkpoint |
| GET/PATCH/DELETE | `/api/experiments[/{id}]`, `/{id}/metrics`, `/{id}/export?format=csv\|json` | experiment store |
| POST | `/api/planner/compare` | same-map algorithm comparison (+ repeated trials) |
| GET/POST | `/api/hardware/state`, `/profile`, `/connect`, `/disconnect`, `/arm`, `/disarm`, `/estop`, `/manual`, `/deploy`, `/stop` | hardware bridge |
| WS | `/ws` | `hello` then `tick` messages |

Interactive OpenAPI docs: http://127.0.0.1:8000/docs

## Frontend structure

```
studio/src/
  lib/        api.ts (typed REST), live.ts (WebSocket store), types.ts, prefs.ts (localStorage), format.ts
  components/ ui/ (buttons, panels, inputs, dialogs, toasts, metrics), layout/ (sidebar, top bar),
              sim/SimCanvas.tsx (canvas renderer: pan/zoom, interpolation, tools), charts/LineChartCard.tsx
  pages/      Overview, LiveSimulation, TrainingLab, Experiments, PathPlanner, HardwareBridge, Analytics, Settings
```

Design tokens live in `studio/src/index.css` (`@theme`). Chart series colours
(violet `#9085e9`, orange `#d95926`, aqua `#199e70`) were validated for
colour-vision deficiencies on the dark surface; status colours are only used
together with a text label.

## NEXUS 2.0

Research features (copilot, scenarios & curriculum, map analyzer, behaviour profiler, counterfactuals, risk explorer,
experiment designer, model registry, command palette, jobs) are documented in [NEXUS2.md](NEXUS2.md).
Their routes live in `server/routes_research.py`; services in `server/research.py`, `server/copilot.py`,
`server/catalog.py`, `server/jobs.py`, `server/stores.py`.
