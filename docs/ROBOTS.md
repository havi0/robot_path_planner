# Robot selection

The studio's **Explore Robots** page (`/robots`) selects the robot the simulator,
training and episode replays use. The choice is functional, not cosmetic: it changes
the motion model, collision footprint, action set and speed limits. The catalog lives
in `navigation/robots.py`.

| Robot | Type | Kinematics | Footprint | Speed / turn | Actions | RL training |
|---|---|---|---|---|---|---|
| Scout | Differential drive (reference) | Unicycle, exact arcs (original model) | 0.15 m | 0.30 m/s / 1.20 rad/s | 4 (v, ω) | Yes |
| Hauler | Four-wheel skid-steer | Unicycle with 80% yaw-rate efficiency (wheel scrub) | 0.20 m | 0.30 / 1.20 | 4 (v, ω) | Yes |
| Glide | Mecanum, omnidirectional | Holonomic (v, v_y, ω), exact integration | 0.18 m | 0.25 / 1.20 | 8 incl. diagonals and strafing | No (see below) |
| Courier | Indoor delivery base | Differential drive | 0.22 m | 0.22 / 1.00 | 4 (v, ω) | Yes |
| Custom | Differential or skid-steer | As chosen | 0.10–0.30 m | 0.05–0.30 / 0.30–1.50 | 4 (v, ω) | Yes |

All robots use the same 24-beam, 360°, 3 m LiDAR: learned policies take exactly that
scan as input. For the custom robot, colour, body shape and height are visual only.

## What is *not* implemented

* **Courier:** no delivery tasks, payload handling or scheduling. It navigates point to point like the others.
* **Glide:** no RL training. The DQN pipeline and its observation were designed and
  validated for 4 (v, ω) actions; an 8-action holonomic setup has not been validated.
  Glide runs with the holonomic A*/Dijkstra path follower.
* **Skid-steer model:** a documented kinematic approximation, not a tyre-slip model.
* **Collision footprints:** every robot collides as a disc. Bodies are drawn inside that disc.
* **Hardware:** robot selection does not change the Hardware Bridge, which uses `config/robot_profile.yaml`.

## Configuration boundary and policy compatibility

`policy_compatibility()` compares the configuration a checkpoint was trained with
(stored in the checkpoint) against the selected robot:

* **Trained for this robot:** same kinematics, footprint, speeds, action set and sensor.
* **Not validated on this robot:** same 29-value observation and 4 actions, but a
  different robot. It runs, but its behaviour there is untested; retrain or validate first.
* **Incompatible:** different action space (Glide). These policies are refused by the
  backend and disabled in the controller list. Selecting Glide while a learned policy is
  active switches to A* and says so.
* **Planner:** A*/Dijkstra plan with the robot's footprint and use the matching follower.

Training in the Training Lab uses the selected robot, and the resulting checkpoint is
"trained" for it.

## Preservation of existing behaviour

* **Reference robot:** the Scout profile is a no-op. The configuration is untouched,
  `VelocityCommand.vy` defaults to 0, and the safety layer's (v, ω) path is unchanged.
  Recordings of the reference robot keep their original format.
* **Tests and safety:** all pre-existing tests pass unchanged, and `python main.py safety-test`
  gives the same results as before (shield 0/100 collisions, no shield 9/100).
* **Replay:** recordings of other robots store the robot, and `episode_cfg` rebuilds it, so
  replays and counterfactuals stay exact (tested for Glide).
* **Map preservation:** selecting a robot keeps the current map when its footprint fits the
  start and goal. Otherwise the backend returns 409, and the UI offers to generate a fitting map.
* **Persistence:** the selection is saved in `data/robot_selection.json`.

## Measured check (30 held-out maps, safety shield on)

`results/robot_selection_check.json`:

| Robot | A* follower | Bundled DQN + recovery | DQN verdict |
|---|---|---|---|
| Scout | 29 success / 1 timeout | 27 / 3 | Trained |
| Hauler | 29 / 1 | 27 / 3 | Not validated |
| Courier | 28 / 2 | 24 / 6 | Not validated |
| Glide | 28 / 2 | — (incompatible) | Incompatible |

There were no collisions in any configuration. The DQN's lower success on the Courier
is why transferred policies are labelled "not validated" rather than assumed to work.

While testing, the first holonomic follower deadlocked on a dense 12 × 12 m map. It
translated along the nearest 45° direction and drifted into an obstacle, and the safety
layer blocked it 395 times. The fix is to rotate until a translation direction lines up
with the path. It is covered by a regression test.
