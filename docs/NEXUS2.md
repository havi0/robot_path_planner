# NEXUS 2.0 — research feature expansion

This document records the audit, the mapping of each requested feature onto the
existing architecture, what was implemented, how correctness is guaranteed,
and what was deliberately deferred.

## 1. Audit of the existing codebase (before 2.0)

| Existing component | Reused for |
|---|---|
| `environment/world.py`, `generate_world` | scenario generator (extended with timed obstacles and an exact obstacle count) |
| `NavigationEnv` / `NavigationCore` | every recorded episode, counterfactual branch and curriculum episode — no second simulator |
| `SimulationBackend` (all randomness from one seeded RNG) | the basis for **exact** state restoration by deterministic re-simulation |
| `baselines/grid_planners.py` (A*, Dijkstra, smoothing) | route-existence and shortest-path checks in the map analyzer |
| `evaluation/metrics.wilson_interval` | every success/collision rate in the UI carries a 95% CI |
| `ExperimentStore`, `TrainingManager`, `DQNTrainer` | model registry sync, curriculum training, experiment-designer training runs |
| FastAPI app + WebSocket broadcaster | new REST routes (`server/routes_research.py`) and live job status |
| React design system (`components/ui`, `SimCanvas`, charts) | all new pages; `SimCanvas` gained heatmap, markers, region select, timed obstacles |

## 2. Feature mapping

| # | Feature | Backend | Frontend |
|---|---|---|---|
| 1 | AI Research Copilot | `server/copilot.py` (fact engine + `CopilotProvider` interface; `AnthropicProvider` optional) | `components/workflow/CopilotPanel.tsx` (Ctrl J) |
| 2 | Scenario generator + curriculum | `scenarios/generator.py` (9 types), `scenarios/curriculum.py`, curriculum in `TrainingManager` | Scenario Lab; Training Lab curriculum section |
| 3 | Navigation risk explorer | `ResearchService.risk_summary / risk_map / risk_region` | Risk Explorer |
| 4 | Counterfactual studio | `evaluation/recorder.py` (`resimulate_to`, `run_counterfactual`) | Episodes → Counterfactual studio |
| 5 | Automated experiment designer | `ResearchService.plan_design / run_design / summarize_design` | Experiment Designer |
| 6 | Behaviour profiler | `evaluation/behavior.py` (`RULES`, `profile_episode`) | Episodes → timeline & classification |
| 7 | Map difficulty & coverage analyzer | `scenarios/analyzer.py` | Scenario Lab analysis panel |
| 8 | Model registry | `server/catalog.py` (content-hash ids, interface spec, compatibility checks) | Model Registry |
| 9 | Workflow & accessibility | job manager (`server/jobs.py`), search API, export bundles | command palette (Ctrl K), shortcuts (?), jobs tray, saved workspace layouts, configurable telemetry, search, toasts |

Shared foundation added first: the **episode recorder** (full per-step
telemetry + model provenance), the **episode store** (gzip + index), JSON
stores for scenarios / sets / runs / designs, and the **background job manager**.

## 3. How results stay grounded and verifiable

* **Recorded data only.** Risk maps, behaviour labels, benchmark tables, the
  designer's statistics and the copilot's facts are computed from recorded
  episodes (`data/episodes/`), experiments and runs. Empty states are shown
  when no data exists.
* **Uncertainty everywhere.** Proportions use 95% Wilson intervals; designer
  cells use t-intervals across seeds; model/version comparisons use a
  two-proportion test; designer comparisons use Welch's t-test. A winner is
  declared only when the best configuration's CI does not overlap the
  runner-up; otherwise the conclusion says the evidence is insufficient.
* **Exact counterfactuals.** The simulator, the noise, the moving obstacles
  and the greedy policies are deterministic given the recorded inputs. A branch
  re-simulates the recorded prefix and verifies, step by step, that the policy
  picks the recorded action and that the pose matches (max deviation reported).
  Only then is the branch labelled `COUNTERFACTUAL`; otherwise it is labelled
  `APPROXIMATE RERUN` with the measured deviation. World serialisation is
  lossless, so live-simulation recordings replay exactly too (tested).
* **Behaviour rules are explicit.** Each rule has a detection threshold and an
  "uncertain" band (`evaluation/behavior.py::RULES`); the measured value,
  threshold and step segments are shown for every label.
* **Geometric ≠ RL difficulty.** The map analyzer's score is a transparent
  weighted sum of measured properties and is labelled "geometric difficulty
  only"; how hard a map is for a policy is measured by benchmark runs.
* **Train/evaluation separation.** Training maps and curriculum scenarios use
  seeds < 1,000,000; validation maps 1,500,000+; test maps 1,000,000+;
  evaluation scenario sets ≥ 3,000,000. Benchmarks refuse non-evaluation sets.
* **Model compatibility.** Each model stores its observation/action interface
  and an `env_version` hash; loading or benchmarking a model whose sensor
  layout, action set, control period or robot radius differs from the
  simulator is refused with the list of differences (HTTP 409).
* **Copilot honesty.** The fact engine runs without any AI. If an AI provider
  is enabled, it only receives the computed fact sheet and is instructed to use
  only those numbers and to keep facts, hypotheses and recommendations
  separate. API keys live only in the server environment.

## 4. Verification

* `tests/test_research.py` — analyzer (narrow gap, local-minimum trap,
  unsolvable maps), all 9 generators solvable and reproducible, lossless
  serialisation, timed obstacles, behaviour thresholds incl. uncertain band,
  exact re-simulation with noise + moving obstacles, divergence detection,
  curriculum promotion rule, content-hash model ids, compatibility detection,
  statistics refusing to crown a winner.
* `tests/test_research_api.py` — registry, synchronous validation, benchmark
  provenance and CIs, risk endpoints, behaviour filters, counterfactual via API,
  **live-simulation episodes replay exactly**, scenario load/analyze, designer
  plan/budget/run, copilot grounding with no provider, model loading + bundle
  export, job cancellation.
* Headless-browser walkthrough of every page (no console errors).

Run everything: `python -m pytest tests` (67 tests).

## 5. First real findings (shared benchmark, 45 scenarios × 2 repeats)

From `Reference models on shared benchmark` (recorded in this repository's
`data/`): DQN + recovery 67% success [56–76%], DQN 66% [55–75%] — not
distinguishable; Q-learning 31% [22–41%]; A* (known map) 96% [89–98%]. The
learned policy fails on U-traps (0% for DQN in that run) and dead ends (20%),
exactly the maps the analyzer flags as local-minimum traps, while A* solves
them. Re-run the benchmark from the Model Registry to reproduce.

## 6. Deferred / limitations

| Item | Reason |
|---|---|
| Worker *processes* for jobs | Jobs and training run in background threads (never on the event loop). CPU-heavy jobs share the GIL with the API; processes would need model/state serialisation across process boundaries. |
| Cross-map spatial risk heatmaps | Positions on different maps are not comparable; risk maps are per scenario, aggregated statistics are per scenario type. |
| Exact homotopy-class route counting | "Route alternatives" is an estimate (block-and-replan); labelled as such. |
| Moving-obstacle trajectories in recordings | Not recorded (re-derivable by re-simulation); the copilot says so when it matters. |
| Curriculum for tabular Q-learning | Curriculum is implemented for DQN only and rejected for Q-learning with a clear error. |
| Light theme | Dark is the only theme; the option is shown disabled. |
