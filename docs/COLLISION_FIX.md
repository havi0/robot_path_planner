# Navigation reliability fix — root causes, fixes and measured results

All numbers below come from recorded runs in this repository (`data/`, `results/`).
Benchmark = the shared 45 unseen evaluation scenarios × 2 repeats (90 episodes per
policy), sensor noise 0.02 m, motion noise 0.05.

## 1. Diagnosis

Every recorded collision was re-simulated exactly and classified from the contact
point and the scan taken one step before contact.

| Check | Finding |
|---|---|
| Collisions checked only at the end of a move | **No** at nominal speed (5 checks / action = 1.5 cm). **Yes, latent:** the number of checks did not scale with speed — a robot at 15 m/s passed through a 2 cm wall; at 8 m/s a collision was reported with the robot left 35 cm short. |
| Robot footprint / radius | Correct in the simulator (disc, r = 0.15 m). **Visual mismatch:** wheels were drawn up to 1.09 r, outside the collision disc. |
| Coordinate transforms | Correct (verified by exact re-simulation of all recorded episodes). |
| Observations | Adequate: 24 ranges + goal distance/bearing + last command. In 39/40 recorded collisions the obstacle **was** measured on the step before contact. Unchanged (no retraining / checkpoint invalidation needed). |
| Action magnitude | 7.5 cm or 17° per decision — fine. |
| Termination / reset | Correct; regression tests added. |
| DQN update | Bellman target, terminal masking (truncation still bootstraps), replay storage, target sync, ε-greedy, greedy evaluation — verified; unit tests added. |
| **Safety layer** | **Disabled by default in Live Simulation** — the policy's crashes reached the user unfiltered (9/100 collisions off vs. 0/100 on, default maps). Its check modelled straight-line motion only (no arcs), and it used the same 24 beams as the policy, so **box corners between beams were missed** (2 recorded shielded collisions: corner at 0.171 m while the neighbouring beams read 0.229/0.300 m). |
| **Reward** | Collision −10 equalled the discounted cost of waiting next to an obstacle (0.10/step → −10 at γ = 0.99); dithering (−20) and stopping (−60) loops were *more* expensive than crashing. Measured per episode: timeouts cost ≈ −58, collisions ≈ −12. |
| **Policy behaviour** | All static collisions happened while driving `forward`; ~70% were side contacts (corners 35–80° off the heading) while making progress (~58 steps into the episode) — not deliberate exits from traps. |
| Frontend | Straight-line interpolation across several actions at high sim speed drew chords that cut obstacle corners. |
| Moving obstacles | A static plan (A*) and a sensor-based stop cannot avoid an obstacle that drives into the robot. |

## 2. Fixes

| # | Fix | Where |
|---|---|---|
| 1 | Speed-adaptive collision checking (≤ 2 cm / 0.1 rad between checks) + time-of-impact bisection: the robot stops at the last collision-free pose on its own path (≤ 1 mm from contact), never inside an obstacle, never teleported. Collision kind and real contact point recorded. | `backends/simulation_backend.py` |
| 2 | Safety layer predicts the commanded motion: footprint swept along the (v, ω) arc against sensed points; translation removed if unsafe (turning in place kept — justified for the circular footprint); full stop on stale/invalid data. | `safety/safety_layer.py` |
| 3 | Dense safety scan (7 sub-rays per beam in simulation; the raw LiDAR scan on hardware) used only by the safety layer — the policy observation is unchanged. | `sensors/range_sensor.py`, `sensors/types.py`, `backends/hardware_backend.py` |
| 4 | Safety shield ON by default in Live Simulation (still switchable to study the raw policy). | `server/sim_session.py` |
| 5 | Reward components logged per step/episode; collision −40, stop −0.25 so crashing is never the cheapest outcome. | `environment/nav_env.py`, `config/default.yaml` |
| 6 | Collision causes, safety interventions and reward terms recorded with every episode. | `evaluation/recorder.py`, `server/stores.py` |
| 7 | Policy validation status with configurable criteria (shared benchmark without shield; collision upper 95% bound ≤ 5%, success lower bound ≥ 60%). | `server/reliability.py`, `config/default.yaml` |
| 8 | Navigation Reliability page + validation chip in Live Simulation; collision banner states the classified cause. | `studio/src/pages/Reliability.tsx` |
| 9 | Robot drawn strictly inside its collision disc; interpolation only across exactly one action. | `studio/src/components/sim/SimCanvas.tsx` |

## 3. Measured results

**Reward change** (`results/collision_fix_comparison.md`, 3 training seeds each, no shield):
collision 16.7% → 15.9% (p = 0.81), success 68.9% → 65.6% (p = 0.67). **No measurable
improvement** — the incentive flaw was real but is not what causes these collisions.
The corrected reward is kept for future training (removes the incentive at no
measured cost); the existing, best-validated model remains active.

**Safety layer** (shared benchmark, same model `m-cb207c6335`):

| Configuration | Success | Collisions | Static-obstacle collisions |
|---|---|---|---|
| DQN + recovery, shield off | 66.7% [56–76] | 14/90 | 12 |
| DQN + recovery, shield on (final) | 77.8% [68–85] | 2/90 | **0** (both moving obstacles) |
| A* (known map), shield on | 93.3% [86–97] | 4/90 | **0** (all moving obstacles) |

Intermediate attempt, recorded and reverted: subtracting a 3σ noise margin from the
dense scan blocked corridor driving (A* fell to 25.6%); the margin was double-counted
with the safety layer's `lateral_margin`. Those superseded runs were deleted from the
reliability data.

**Validation status:** the learned policy alone is reported as **Failed validation**
(collision upper bound 24–26% > 5%; success lower bound 55–56% < 60%). It is not
claimed to be trained/reliable; the safety layer is what prevents static collisions.

## 4. Tests

`tests/test_collision.py` (34 tests): driving into a wall at 4 speeds; 5 approach
angles; thin wall at 0.3–50 m/s (tunnelling regression); turning next to a corner;
narrow passage (passable / blocked); map boundary in 5 directions; all motions unsafe;
arc sweep; moving away from a close obstacle; adversarial random commands behind the
shield on 80 maps incl. small clutter (0 static collisions); between-beam corner
regression; mid-step collision; reset after collision; 40-map overlap fuzz; Bellman
targets & terminal masking; replay storage; reward terms sum; reward incentive
regression. Full suite: `python -m pytest tests` → 101 passed. Safety validation:
`python main.py safety-test` → all checks pass.

## 5. Remaining limitations

* **Moving obstacles** still cause collisions (2/90 shielded): the sensor-based stop
  cannot prevent an obstacle driving into a stopped robot. Needs velocity estimation
  and evasive manoeuvres.
* **The learned policy is not validated**: it gets stuck in U-traps (0%) and dead ends
  (20%) even with the shield; the shield converts collisions into timeouts there.
* The safety check assumes a **circular footprint** (turning in place is always safe);
  a non-circular robot would need the rotation swept too.
* Obstacles thinner than the dense-scan spacing (≈ 2° → < 1 cm at 0.2 m) could still be missed.
* Training remains unstable after ε reaches its floor; checkpoint selection on validation maps is required.
