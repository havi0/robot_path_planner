"""Research services: scenarios & sets, benchmarks, risk aggregation,
counterfactual branches and the experiment designer. Long-running parts run
as background jobs (server/jobs.py)."""
import copy
import itertools
import math
import time

import numpy as np
from scipy import stats

from evaluation.evaluate import load_dqn, load_qlearning
from evaluation.metrics import wilson_interval
from evaluation.recorder import LEARNED, POLICY_NAMES, make_episode, record_episode, resimulate_to, run_counterfactual
from scenarios.analyzer import analyze_world
from scenarios.generator import EVAL_SEED_OFFSET, SCENARIO_TYPES, TRAIN_SEED_LIMIT, generate_scenario
from scenarios.io import world_from_dict, world_to_dict
from server.catalog import compatibility_issues

BENCHMARK_ID = "benchmark-v1"


class ResearchError(ValueError):
    pass


def ci(k, n):
    lo, hi = wilson_interval(k, n)
    return {"rate": k / n if n else None, "k": k, "n": n, "ci_low": lo, "ci_high": hi}


def mean_ci(values, conf=0.95):
    v = [x for x in values if x is not None and np.isfinite(x)]
    n = len(v)
    if n == 0:
        return {"mean": None, "n": 0, "ci_low": None, "ci_high": None, "std": None}
    m = float(np.mean(v))
    if n == 1:
        return {"mean": m, "n": 1, "ci_low": None, "ci_high": None, "std": None}
    s = float(np.std(v, ddof=1))
    h = float(stats.t.ppf(0.5 + conf / 2, n - 1) * s / math.sqrt(n))
    return {"mean": m, "n": n, "ci_low": m - h, "ci_high": m + h, "std": s}


def two_proportion_test(k1, n1, k2, n2):
    if min(n1, n2) == 0:
        return None
    p = (k1 + k2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    if se == 0:
        return 1.0
    z = (k1 / n1 - k2 / n2) / se
    return float(2 * (1 - stats.norm.cdf(abs(z))))


class ResearchService:
    def __init__(self, cfg, episodes, scenarios, sets, runs, designs, catalog, store, models, jobs, events):
        self.cfg = cfg
        self.episodes, self.scenarios, self.sets, self.runs, self.designs = episodes, scenarios, sets, runs, designs
        self.catalog, self.store, self.models, self.jobs, self.events = catalog, store, models, jobs, events
        self._agents = {}

    # ------------------------------------------------------------------ models
    def agent_for(self, model_id):
        """Load (and cache) the exact checkpoint behind a model id."""
        if model_id in self._agents:
            return self._agents[model_id]
        m = self.catalog.get(model_id)
        issues = compatibility_issues(m["interface"], self.cfg)
        if issues:
            raise ResearchError(f"Model {model_id} is incompatible with this simulator: " + "; ".join(issues))
        agent, acfg = (load_dqn if m["algorithm"] == "dqn" else load_qlearning)(m["checkpoint"])
        self._agents[model_id] = (agent, acfg)
        return agent, acfg

    def model_meta(self, model_id):
        return self.catalog.provenance(model_id) if model_id else None

    # ------------------------------------------------------------------ scenarios
    def generate(self, kind, seed=None, size=6.0, save=False, name=None):
        if kind not in SCENARIO_TYPES:
            raise ResearchError(f"type must be one of {list(SCENARIO_TYPES)}")
        if not 4.0 <= float(size) <= 12.0:
            raise ResearchError("size must be between 4 and 12 m")
        seed = int(seed if seed is not None else np.random.default_rng().integers(EVAL_SEED_OFFSET, EVAL_SEED_OFFSET + 10**6))
        world, analysis, info = generate_scenario(kind, seed, self.cfg.robot.radius, size)
        doc = {"id": None, "name": name or f"{kind.replace('_', ' ')} #{seed % 100000}", "type": kind, "seed": seed,
               "size": size, "world": world_to_dict(world), "analysis": analysis, "difficulty": analysis["difficulty"],
               "split": "evaluation" if seed >= EVAL_SEED_OFFSET else "training", "created": time.time(),
               "generator": {"attempts": info["attempts"]}}
        if save:
            doc["id"] = self.scenarios.new_id(kind)
            self.scenarios.save(doc)
        return doc

    def analyze_world_dict(self, world_dict):
        return analyze_world(world_from_dict(world_dict), self.cfg.robot.radius)

    def validate_set(self, types, per_type, role, size=6.0, base_seed=None):
        """Synchronous validation (called before queuing the job). Returns (types, base_seed)."""
        if role not in ("training", "evaluation"):
            raise ResearchError("role must be training or evaluation")
        unknown = [t for t in types if t not in SCENARIO_TYPES]
        if unknown or not types:
            raise ResearchError(f"unknown or missing scenario types: {unknown or 'none selected'}")
        if not 1 <= int(per_type) <= 50:
            raise ResearchError("1-50 scenarios per type")
        if not 4.0 <= float(size) <= 12.0:
            raise ResearchError("size must be between 4 and 12 m")
        lo = EVAL_SEED_OFFSET if role == "evaluation" else 0
        base = int(base_seed if base_seed is not None else lo + np.random.default_rng().integers(0, 400_000))
        if role == "evaluation" and base < EVAL_SEED_OFFSET:
            raise ResearchError("evaluation sets must use seeds >= 3,000,000 (never used for training)")
        if role == "training" and (base < 0 or base + len(types) * 7919 + per_type * 7 >= TRAIN_SEED_LIMIT):
            raise ResearchError("training set seeds must stay in [0, 1,000,000) so they never overlap evaluation seeds")
        return list(types), base

    def build_set(self, job, name, types, per_type, role, size=6.0, base_seed=None):
        types, base = self.validate_set(types, per_type, role, size, base_seed)
        ids, total = [], len(types) * per_type
        for ti, t in enumerate(types):
            for i in range(per_type):
                job.progress(len(ids), total, f"generating {t} ({i + 1}/{per_type})")
                doc = self.generate(t, base + ti * 7919 + i * 7, size)
                doc["id"] = self.scenarios.new_id(t)
                doc["set_member"] = True
                self.scenarios.save(doc)
                ids.append(doc["id"])
        return self._save_set(name, role, ids, {"types": types, "per_type": per_type, "base_seed": base, "size": size})

    def _save_set(self, name, role, ids, recipe, set_id=None):
        docs = [self.scenarios.get(i) for i in ids]
        bands, by_type = {}, {}
        for d in docs:
            b = d["difficulty"]["band"]
            bands[b] = bands.get(b, 0) + 1
            by_type.setdefault(d["type"], {}).setdefault(b, 0)
            by_type[d["type"]][b] += 1
        doc = {"id": set_id or self.sets.new_id(name), "name": name, "role": role, "scenario_ids": ids, "recipe": recipe,
               "created": time.time(), "composition": {"bands": bands, "by_type": by_type, "count": len(ids)},
               "difficulty_scores": [d["difficulty"]["score"] for d in docs]}
        self.sets.save(doc)
        self.events.emit("success", "scenario", f"Scenario set '{name}' saved ({len(ids)} {role} scenarios)")
        return doc

    def ensure_benchmark(self, job=None):
        """The shared benchmark: 5 evaluation scenarios of each type, fixed seeds."""
        if self.sets.exists(BENCHMARK_ID):
            return self.sets.get(BENCHMARK_ID)
        ids, types = [], list(SCENARIO_TYPES)
        for ti, t in enumerate(types):
            for i in range(5):
                if job:
                    job.progress(len(ids), len(types) * 5, f"building benchmark: {t}")
                doc = self.generate(t, EVAL_SEED_OFFSET + 900_000 + ti * 101 + i, 6.0)
                doc["id"] = f"bench-{t}-{i}"
                doc["name"] = f"Benchmark {t.replace('_', ' ')} {i + 1}"
                self.scenarios.save(doc)
                ids.append(doc["id"])
        return self._save_set("NEXUS benchmark v1", "evaluation", ids,
                              {"types": types, "per_type": 5, "fixed": True}, set_id=BENCHMARK_ID)

    # ------------------------------------------------------------------ benchmark runs
    def run_benchmark(self, job, set_id, entries, repeats=3, sensor_noise=0.02, motion_noise=0.05, shield=False, label=None):
        """entries: [{"policy": key, "model_id": id|None}]. Records every episode."""
        if set_id == BENCHMARK_ID:
            self.ensure_benchmark(job)
        sset = self.sets.get(set_id)
        if sset["role"] != "evaluation":
            raise ResearchError("benchmarks must use an EVALUATION scenario set")
        if not 1 <= int(repeats) <= 20:
            raise ResearchError("repeats must be 1-20")
        run_id = self.runs.new_id(label or "benchmark")
        run = {"id": run_id, "label": label or sset["name"], "set_id": set_id, "set_name": sset["name"], "entries": entries,
               "repeats": repeats, "conditions": {"sensor_noise": sensor_noise, "motion_noise": motion_noise, "shield": shield},
               "status": "running", "created": time.time(), "results": {}}
        self.runs.save(run)
        scenarios = [self.scenarios.get(i) for i in sset["scenario_ids"]]
        total = len(scenarios) * len(entries) * repeats
        done = 0
        per = {}
        for e in entries:
            key, mid = e["policy"], e.get("model_id")
            if key in LEARNED and not mid:
                raise ResearchError(f"{key} needs a model_id")
            agent, acfg = self.agent_for(mid) if key in LEARNED else (None, None)
            meta = self.model_meta(mid) if key in LEARNED else None
            ek = f"{key}:{mid}" if mid else key
            recs = []
            for sc in scenarios:
                for r in range(repeats):
                    job.progress(done, total, f"{POLICY_NAMES[key]} on {sc['name']} (run {r + 1})")
                    seed = 10_000 * (1 + r) + (sc["seed"] % 10_000)
                    cond = {"sensor_noise": sensor_noise, "motion_noise": motion_noise, "shield": shield}
                    ep = record_episode(self.cfg, sc["world"], key, cond, seed, agent, acfg, source="benchmark",
                                        model=meta, scenario={"id": sc["id"], "type": sc["type"], "name": sc["name"],
                                                              "difficulty": sc["difficulty"]["score"]}, run_id=run_id)
                    s = self.episodes.save(ep)
                    recs.append(s)
                    done += 1
            per[ek] = self._aggregate(recs, key, mid)
            if mid:
                self.catalog.add_benchmark(mid, {"run_id": run_id, "set_id": set_id, "set_name": sset["name"], "policy": key,
                                                 "time": time.time(), "repeats": repeats, "conditions": run["conditions"],
                                                 "summary": per[ek]["overall"]})
        run.update(status="completed", finished=time.time(), results=per)
        self.runs.save(run)
        return {"run_id": run_id, "episodes": total}

    def _aggregate(self, recs, key, mid):
        n = len(recs)
        k = lambda o: sum(r["outcome"] == o for r in recs)
        by_type = {}
        for r in recs:
            by_type.setdefault(r["scenario_type"], []).append(r)
        ratios = [r["path_ratio"] for r in recs if r["path_ratio"]]
        beh = {}
        for r in recs:
            for b in r["behaviors"]:
                beh[b] = beh.get(b, 0) + 1
        return {"policy": key, "model_id": mid, "name": POLICY_NAMES[key],
                "overall": {"episodes": n, "success": ci(k("success"), n), "collision": ci(k("collision"), n),
                            "timeout": ci(k("timeout"), n), "path_ratio": mean_ci(ratios)},
                "by_type": {t: {"success": ci(sum(x["outcome"] == "success" for x in xs), len(xs)),
                                "collision": ci(sum(x["outcome"] == "collision" for x in xs), len(xs))}
                            for t, xs in sorted(by_type.items())},
                "behaviors": beh}

    def compare_entries(self, a, b, metric="success"):
        ka, na = a["overall"][metric]["k"], a["overall"][metric]["n"]
        kb, nb = b["overall"][metric]["k"], b["overall"][metric]["n"]
        p = two_proportion_test(ka, na, kb, nb)
        return {"metric": metric, "a": a["overall"][metric], "b": b["overall"][metric], "p_value": p,
                "verdict": ("insufficient data" if p is None else
                            f"significant difference (p={p:.3f})" if p < 0.05 else f"no significant difference (p={p:.2f})")}

    # ------------------------------------------------------------------ risk explorer
    def risk_summary(self, run_id=None, model_id=None, policy=None):
        flt = {"source": "benchmark"}
        if run_id:
            flt["run_id"] = run_id
        if model_id:
            flt["model_id"] = model_id
        if policy:
            flt["policy"] = policy
        recs = self.episodes.query(limit=100000, **flt)
        if not recs:
            return {"episodes": 0}
        by_type, by_scenario, clear, beh = {}, {}, [], {}
        for r in recs:
            by_type.setdefault(r["scenario_type"], []).append(r)
            by_scenario.setdefault(r["scenario_id"], []).append(r)
            if r["min_clearance"] is not None:
                clear.append(r["min_clearance"])
            for b in r["behaviors"]:
                beh[b] = beh.get(b, 0) + 1
        hist_edges = [-0.2, 0.0, 0.03, 0.06, 0.1, 0.15, 0.2, 0.3, 0.5, 1.0, 3.0]
        hist = np.histogram(np.clip(clear, -0.2, 3.0), bins=hist_edges)[0].tolist() if clear else []
        scen = []
        for sid, xs in by_scenario.items():
            n = len(xs)
            fails = sum(x["outcome"] != "success" for x in xs)
            scen.append({"scenario_id": sid, "name": xs[0]["scenario_name"], "type": xs[0]["scenario_type"], "episodes": n,
                         "failure": ci(fails, n), "collision": ci(sum(x["outcome"] == "collision" for x in xs), n)})
        scen.sort(key=lambda s: -(s["failure"]["rate"] or 0))
        return {"episodes": len(recs),
                "by_type": {t: {"success": ci(sum(x["outcome"] == "success" for x in xs), len(xs)),
                                "collision": ci(sum(x["outcome"] == "collision" for x in xs), len(xs)),
                                "timeout": ci(sum(x["outcome"] == "timeout" for x in xs), len(xs))} for t, xs in sorted(by_type.items())},
                "clearance_hist": {"edges": hist_edges, "counts": hist, "n": len(clear)},
                "behaviors": beh, "scenarios": scen,
                "note": "Rates are empirical frequencies over recorded benchmark episodes with 95% Wilson intervals; "
                        "they are estimates for these scenarios and conditions, not guaranteed probabilities."}

    def risk_map(self, scenario_id, run_id=None, model_id=None, cell=0.25, min_visits=3):
        flt = {"scenario_id": scenario_id}
        if run_id:
            flt["run_id"] = run_id
        if model_id:
            flt["model_id"] = model_id
        recs = self.episodes.query(limit=5000, **flt)
        sc = self.scenarios.get(scenario_id)
        W, H = sc["world"]["width"], sc["world"]["height"]
        nx, ny = int(math.ceil(W / cell)), int(math.ceil(H / cell))
        visits = np.zeros((ny, nx), int)
        fail_visits = np.zeros((ny, nx), int)
        collisions = np.zeros((ny, nx), int)
        stuck = np.zeros((ny, nx), int)
        trajs, routes = [], {}
        for r in recs:
            ep = self.episodes.get(r["id"])
            xs, ys = ep["steps"]["x"], ep["steps"]["y"]
            cells = {(min(int(y / cell), ny - 1), min(int(x / cell), nx - 1)) for x, y in zip(xs, ys)}
            failed = ep["outcome"] != "success"
            for c in cells:
                visits[c] += 1
                fail_visits[c] += failed
            if ep["outcome"] == "collision":
                collisions[min(int(ys[-1] / cell), ny - 1), min(int(xs[-1] / cell), nx - 1)] += 1
            for lab in ep["behavior"]["labels"]:
                if lab["label"] == "stagnation" and lab["status"] == "detected":
                    for a, b in lab["segments"]:
                        i = min((a + b) // 2, len(xs) - 1)
                        stuck[min(int(ys[i] / cell), ny - 1), min(int(xs[i] / cell), nx - 1)] += 1
            # route signature: ordered 1 m cells visited (consecutive duplicates removed)
            sig, last = [], None
            for x, y in zip(xs, ys):
                c = (int(x), int(y))
                if c != last:
                    sig.append(c)
                    last = c
            key = ">".join(f"{a},{b}" for a, b in sig)
            routes.setdefault(key, []).append(ep["id"])
            step = max(1, len(xs) // 120)
            trajs.append({"id": ep["id"], "outcome": ep["outcome"], "policy": ep["policy_name"], "model_id": r["model_id"],
                          "points": [[round(xs[i], 3), round(ys[i], 3)] for i in range(0, len(xs), step)] + [[xs[-1], ys[-1]]],
                          "behaviors": ep["behavior"]["detected"], "route": key})
        route_list = []
        for key, ids in routes.items():
            outs = [t["outcome"] for t in trajs if t["route"] == key]
            route_list.append({"route": key, "episodes": ids, "failure": ci(sum(o != "success" for o in outs), len(outs))})
        route_list.sort(key=lambda r: (-r["failure"]["n"], -(r["failure"]["rate"] or 0)))
        ratio = np.where(visits >= min_visits, fail_visits / np.maximum(visits, 1), np.nan)
        return {"scenario": {k: sc[k] for k in ("id", "name", "type", "world", "difficulty")}, "episodes": len(recs),
                "cell": cell, "nx": nx, "ny": ny, "min_visits": min_visits,
                "layers": {"visits": visits.tolist(), "collisions": collisions.tolist(), "stuck": stuck.tolist(),
                           "failure_ratio": [[None if np.isnan(v) else round(float(v), 3) for v in row] for row in ratio]},
                "trajectories": trajs, "routes": route_list[:12],
                "note": f"Failure ratio shown only for cells visited by >= {min_visits} episodes. Route = ordered sequence of 1 m cells."}

    def risk_region(self, scenario_id, rect, run_id=None, model_id=None):
        x0, y0, x1, y1 = min(rect[0], rect[2]), min(rect[1], rect[3]), max(rect[0], rect[2]), max(rect[1], rect[3])
        flt = {"scenario_id": scenario_id}
        if run_id:
            flt["run_id"] = run_id
        if model_id:
            flt["model_id"] = model_id
        out = []
        for r in self.episodes.query(limit=5000, **flt):
            ep = self.episodes.get(r["id"])
            idx = [i for i, (x, y) in enumerate(zip(ep["steps"]["x"], ep["steps"]["y"])) if x0 <= x <= x1 and y0 <= y <= y1]
            if not idx:
                continue
            ended_inside = idx[-1] == len(ep["steps"]["x"]) - 1
            out.append({**r, "steps_in_region": len(idx), "first_step_in_region": idx[0],
                        "ended_in_region": ended_inside, "failed_in_region": ended_inside and r["outcome"] != "success"})
        n = len(out)
        return {"episodes": out, "passing": n, "failure": ci(sum(o["outcome"] != "success" for o in out), n),
                "failed_inside": sum(o["failed_in_region"] for o in out)}

    # ------------------------------------------------------------------ counterfactuals
    def episode_step(self, ep_id, k):
        """Inspect the recorded observation & decision at step k (re-simulated exactly)."""
        ep = self.episodes.get(ep_id)
        n = len(ep["steps"]["action"])
        if not 0 <= k < n:
            raise ResearchError(f"step must be in [0, {n - 1}]")
        agent, acfg = self._agent_for_episode(ep)
        runner, rest = resimulate_to(self.cfg, ep, k, agent, acfg)
        detail = runner.observation_detail()
        q = None
        if ep["policy"] in ("dqn", "dqn_recovery") and agent is not None:
            qv = agent.q_values(runner.obs)
            q = {name: round(float(v), 4) for name, v in zip(runner.env.action_set.names, qv)}
        return {"step": k, "recorded_action": ep["steps"]["action"][k], "pose": {"x": ep["steps"]["x"][k], "y": ep["steps"]["y"][k],
                "theta": ep["steps"]["theta"][k]}, "observation": detail, "q_values": q, "restoration": rest,
                "actions": runner.env.action_set.names}

    def _agent_for_episode(self, ep):
        if ep["policy"] not in LEARNED:
            return None, None
        mid = (ep.get("model") or {}).get("model_id")
        if not mid:
            raise ResearchError("This episode has no recorded model id, so its policy cannot be restored")
        try:
            return self.agent_for(mid)
        except KeyError:
            raise ResearchError(f"Model {mid} is no longer in the registry (checkpoint missing)")

    def counterfactual(self, ep_id, k, modification):
        ep = self.episodes.get(ep_id)
        agent, acfg = self._agent_for_episode(ep)
        try:
            runner, rest = run_counterfactual(self.cfg, ep, int(k), modification, agent, acfg)
        except ValueError as e:
            raise ResearchError(str(e))
        cf = make_episode(runner, source="counterfactual", world_dict=ep["world"], policy_key=ep["policy"],
                          conditions=ep["conditions"], seed=ep["seed"], model=ep.get("model"), scenario=ep.get("scenario"),
                          parent={"episode_id": ep_id, "branch_step": int(k), "modification": modification},
                          restoration=rest, label="COUNTERFACTUAL" if rest["exact"] else "APPROXIMATE RERUN")
        s = self.episodes.save(cf)
        o, c = ep["metrics"], cf["metrics"]
        diff = {key: {"original": o.get(key), "counterfactual": c.get(key),
                      "delta": (c[key] - o[key]) if isinstance(o.get(key), (int, float)) and isinstance(c.get(key), (int, float)) else None}
                for key in ("outcome", "steps_taken", "reward", "path_length", "collisions", "path_ratio")}
        self.events.emit("info", "counterfactual", f"Counterfactual of {ep_id} at step {k}: {o['outcome']} -> {c['outcome']}"
                         + ("" if rest["exact"] else " (approximate rerun)"))
        return {"episode": cf, "summary": s, "comparison": diff, "restoration": rest}

    # ------------------------------------------------------------------ experiment designer
    DESIGN_PARAMS = {
        "lr": ("dqn.lr", float, (1e-5, 1e-2)), "gamma": ("dqn.gamma", float, (0.8, 0.999)),
        "eps_decay": ("dqn.eps_decay_steps", int, (1000, 1_000_000)), "batch_size": ("dqn.batch_size", int, (16, 512)),
        "target_update": ("dqn.target_update_interval", int, (100, 20000)),
        "progress_scale": ("reward.progress_scale", float, (0.0, 10.0)), "step_penalty": ("reward.step", float, (-1.0, 0.0)),
        "turn_reversal_penalty": ("reward.turn_reversal_penalty", float, (-2.0, 0.0)),
        "stop_penalty": ("reward.stop_penalty", float, (-2.0, 0.0)), "collision_penalty": ("reward.collision", float, (-100.0, 0.0)),
        "density_max": ("randomization.obstacle_density", float, (0.05, 0.35)),
    }

    def plan_design(self, spec):
        q = (spec.get("question") or "").strip()
        if not q:
            raise ResearchError("State the research question")
        dtype = spec.get("design_type", "train")
        seeds = int(spec.get("seeds", 2))
        if not 1 <= seeds <= 10:
            raise ResearchError("seeds must be 1-10")
        eval_set = spec.get("eval_set") or BENCHMARK_ID
        if eval_set != BENCHMARK_ID:
            if self.sets.get(eval_set)["role"] != "evaluation":
                raise ResearchError("the evaluation map set must have role 'evaluation' (separate from training)")
        metric = spec.get("metric", "success_rate")
        if metric not in ("success_rate", "collision_rate", "path_ratio", "reward"):
            raise ResearchError("unknown metric")
        eval_repeats = int(spec.get("eval_repeats", 1))
        n_eval_scen = 45 if eval_set == BENCHMARK_ID else len(self.sets.get(eval_set)["scenario_ids"])
        cells = []
        if dtype == "evaluate":
            models = spec.get("models") or []
            if len(models) < 1:
                raise ResearchError("select at least one model")
            for m in models:
                self.catalog.get(m["model_id"]) if m.get("model_id") else None
                cells.append({"params": {"policy": m["policy"], "model_id": m.get("model_id")},
                              "purpose": f"Evaluate {POLICY_NAMES[m['policy']]}" + (f" ({m['model_id']})" if m.get("model_id") else "")})
            cost_steps = len(cells) * seeds * n_eval_scen * eval_repeats * 150
            per_step_s = 1 / 2500
        else:
            params = spec.get("parameters") or []
            if not params:
                raise ResearchError("add at least one parameter to investigate")
            clean = []
            for p in params:
                if p["name"] not in self.DESIGN_PARAMS:
                    raise ResearchError(f"unsupported parameter {p['name']}")
                path, typ, (lo, hi) = self.DESIGN_PARAMS[p["name"]]
                vals = [typ(v) for v in p["values"]]
                if not vals or any(not lo <= v <= hi for v in vals):
                    raise ResearchError(f"{p['name']} values must be within [{lo}, {hi}]")
                clean.append((p["name"], vals))
            baseline = {n: self._default_param(n) for n, _ in clean}
            if spec.get("mode", "one_factor") == "factorial":
                for combo in itertools.product(*[v for _, v in clean]):
                    pr = dict(zip([n for n, _ in clean], combo))
                    cells.append({"params": pr, "purpose": "factorial cell: " + ", ".join(f"{k}={v}" for k, v in pr.items())})
            else:
                cells.append({"params": dict(baseline), "purpose": "baseline (report configuration)", "baseline": True})
                for n, vals in clean:
                    for v in vals:
                        if v == baseline[n]:
                            continue
                        pr = dict(baseline)
                        pr[n] = v
                        cells.append({"params": pr, "purpose": f"effect of {n} = {v} (all other parameters at baseline {baseline[n]} -> {v})"})
            episodes = int(spec.get("episodes_per_run", 300))
            if not 20 <= episodes <= 5000:
                raise ResearchError("episodes_per_run must be 20-5000")
            cost_steps = len(cells) * seeds * (episodes * 110 + n_eval_scen * eval_repeats * 150)
            per_step_s = 1 / 450
        budget = float(spec.get("budget_minutes", 30))
        est_min = cost_steps * per_step_s / 60
        for i, c in enumerate(cells):
            c["cell_id"] = f"c{i}"
        return {"question": q, "design_type": dtype, "cells": cells, "seeds": seeds, "eval_set": eval_set, "metric": metric,
                "eval_repeats": eval_repeats, "episodes_per_run": spec.get("episodes_per_run", 300),
                "runs": len(cells) * seeds, "estimated_env_steps": int(cost_steps), "estimated_minutes": round(est_min, 1),
                "budget_minutes": budget, "within_budget": est_min <= budget,
                "separation": "Training uses random maps (seeds < 1,000,000); evaluation uses the selected evaluation "
                              "scenario set (seeds >= 3,000,000). They never overlap.",
                "mode": spec.get("mode", "one_factor")}

    def _default_param(self, name):
        path = self.DESIGN_PARAMS[name][0]
        a, b = path.split(".")
        v = self.cfg[a][b]
        return v[1] if name == "density_max" else v

    def run_design(self, job, design_id):
        from training.train_dqn import DQNTrainer
        d = self.designs.get(design_id)
        plan = d["plan"]
        if plan["eval_set"] == BENCHMARK_ID:
            self.ensure_benchmark(job)
        sset = self.sets.get(plan["eval_set"])
        scen = [self.scenarios.get(i) for i in sset["scenario_ids"]]
        results = []
        total = plan["runs"]
        n = 0
        for cell in plan["cells"]:
            for s in range(plan["seeds"]):
                seed = 1000 + s
                job.progress(n, total, f"{cell['cell_id']} seed {seed}: {cell['purpose'][:60]}")
                if plan["design_type"] == "evaluate":
                    key, mid = cell["params"]["policy"], cell["params"].get("model_id")
                    agent, acfg = self.agent_for(mid) if mid else (None, None)
                    meta = self.model_meta(mid) if mid else None
                    model_id = mid
                else:
                    cfg = copy.deepcopy(self.cfg)
                    for name, v in cell["params"].items():
                        a, b = self.DESIGN_PARAMS[name][0].split(".")
                        if name == "density_max":
                            cfg[a][b] = [cfg[a][b][0], v]
                        else:
                            cfg[a][b] = v
                    cfg.training.seed = seed
                    cfg.training.eval_every = 10 ** 9
                    exp = self.store.create(f"{d['name']} · {cell['cell_id']} · seed {seed}", "dqn", dict(cfg.dqn),
                                            {"world": dict(cfg.world), "randomization": dict(cfg.randomization),
                                             "reward": dict(cfg.reward)}, seed,
                                            {"design_id": design_id, "cell_id": cell["cell_id"], "cell_params": cell["params"]})
                    t0 = time.time()
                    self.store.update(exp["id"], status="running", started_at=t0)
                    trainer = DQNTrainer(cfg, run_dir=self.store.run_dir(exp["id"]), seed=seed, quiet=True)
                    rows = []
                    while trainer.episode < int(plan["episodes_per_run"]):
                        job.check()
                        summ = trainer.step()
                        if summ:
                            rows.append({"episode": summ["episode"], "total_steps": summ["total_steps"], "reward": summ["return"],
                                         "length": summ["length"], "outcome": summ["outcome"], "epsilon": summ["epsilon"],
                                         "loss": summ["loss"], "throughput": None, "time": round(time.time() - t0, 2)})
                    trainer.save("last.pt")
                    trainer.ep_log.close()
                    trainer.eval_log.close()
                    self.store.append_metrics(exp["id"], rows)
                    self.store.update(exp["id"], status="completed", finished_at=time.time(), duration_s=time.time() - t0,
                                      episodes=len(rows), total_steps=trainer.total_steps)
                    entry = self.catalog.register(self.store.checkpoint_path(exp["id"], "last.pt"), self.store.get(exp["id"]))
                    model_id, key = entry["model_id"], "dqn"
                    agent, acfg = trainer.agent, cfg
                    meta = self.model_meta(model_id)
                recs = []
                for sc in scen:
                    for r in range(plan["eval_repeats"]):
                        job.check()
                        ep = record_episode(self.cfg, sc["world"], key, {"sensor_noise": 0.02, "motion_noise": 0.05, "shield": False},
                                            10_000 * (1 + r) + seed + (sc["seed"] % 1000), agent, acfg, source="benchmark",
                                            model=meta, scenario={"id": sc["id"], "type": sc["type"], "name": sc["name"],
                                                                  "difficulty": sc["difficulty"]["score"]}, run_id=design_id)
                        recs.append(self.episodes.save(ep))
                m = len(recs)
                val = {"success_rate": sum(x["outcome"] == "success" for x in recs) / m,
                       "collision_rate": sum(x["outcome"] == "collision" for x in recs) / m,
                       "path_ratio": float(np.mean([x["path_ratio"] for x in recs if x["path_ratio"]])) if any(x["path_ratio"] for x in recs) else None,
                       "reward": float(np.mean([x["reward"] for x in recs]))}
                results.append({"cell_id": cell["cell_id"], "seed": seed, "model_id": model_id, "metrics": val, "episodes": m})
                n += 1
                self.designs.update(design_id, results=results, status="running")
        summary = self.summarize_design(plan, results)
        self.designs.update(design_id, results=results, summary=summary, status="completed", finished=time.time())
        return {"design_id": design_id, "runs": len(results)}

    def summarize_design(self, plan, results):
        metric = plan["metric"]
        higher_better = metric != "collision_rate" and metric != "path_ratio"
        cells = []
        for c in plan["cells"]:
            vals = [r["metrics"][metric] for r in results if r["cell_id"] == c["cell_id"]]
            cells.append({"cell_id": c["cell_id"], "purpose": c["purpose"], "params": c["params"], "values": vals, **mean_ci(vals)})
        base = next((c for c, pc in zip(cells, plan["cells"]) if pc.get("baseline")), None)
        comparisons = []
        for c in cells:
            if base is None or c is base:
                continue
            a, b = c["values"], base["values"]
            if len(a) >= 2 and len(b) >= 2 and (np.std(a) > 0 or np.std(b) > 0):
                p = float(stats.ttest_ind(a, b, equal_var=False).pvalue)
            else:
                p = None
            verdict = ("insufficient evidence (need >= 2 seeds per cell with variation)" if p is None or not np.isfinite(p) else
                       ("better than baseline" if (np.mean(a) > np.mean(b)) == higher_better else "worse than baseline")
                       + f" (Welch t-test p={p:.3f})" if p < 0.05 else f"no significant difference from baseline (p={p:.2f})")
            comparisons.append({"cell_id": c["cell_id"], "vs": base["cell_id"], "p_value": p, "verdict": verdict})
        ranked = sorted([c for c in cells if c["mean"] is not None], key=lambda c: c["mean"], reverse=higher_better)
        winner = None
        if len(ranked) >= 2 and ranked[0]["ci_low"] is not None and ranked[1]["ci_high"] is not None:
            separated = ranked[0]["ci_low"] > ranked[1]["ci_high"] if higher_better else ranked[0]["ci_high"] < ranked[1]["ci_low"]
            winner = ranked[0]["cell_id"] if separated else None
        conclusion = (f"Cell {winner} is best on {metric} with a 95% CI that does not overlap the runner-up."
                      if winner else "No configuration is clearly best: confidence intervals overlap or there are too few seeds.")
        return {"metric": metric, "higher_is_better": higher_better, "cells": cells, "comparisons": comparisons,
                "winner": winner, "conclusion": conclusion}
