"""Navigation reliability: policy validation status and failure analysis, computed only
from recorded evaluation episodes and benchmark runs.

Four event types are kept distinct:
  * simulator-detected collision  - the robot footprint touched an obstacle (episode ends)
  * safety-layer intervention     - a commanded motion was rejected/modified before execution
  * failed navigation episode     - evaluation episode that ended in collision or timeout
  * unfinished training episode   - training episode (with exploration) that did not reach the goal
"""
import collections

from evaluation.metrics import wilson_interval

EVAL_SOURCES = ("benchmark", "live")


def _ci(k, n):
    lo, hi = wilson_interval(k, n)
    return {"rate": k / n if n else None, "k": k, "n": n, "ci_low": lo, "ci_high": hi}


def validation_status(model, policy, vcfg):
    """Status of one (model, policy) pair from its benchmark history."""
    runs = [b for b in model.get("benchmarks", []) if b["set_id"] == vcfg.benchmark_set and b["policy"] == policy
            and not b["conditions"].get("shield") and b["summary"]["episodes"] >= vcfg.min_episodes]
    criteria = (f"shared benchmark without shield, >= {vcfg.min_episodes} episodes: collision 95% upper bound "
                f"<= {vcfg.max_collision_upper_ci:.0%} and success 95% lower bound >= {vcfg.min_success_lower_ci:.0%}")
    if not runs:
        return {"status": "not_validated", "label": "Policy not yet validated", "reasons": ["no qualifying benchmark run"],
                "criteria": criteria, "evidence": None}
    b = runs[-1]["summary"]
    reasons = []
    if b["collision"]["ci_high"] > vcfg.max_collision_upper_ci:
        reasons.append(f"collision rate {b['collision']['rate']:.0%} (upper bound {b['collision']['ci_high']:.0%}) "
                       f"exceeds {vcfg.max_collision_upper_ci:.0%}")
    if b["success"]["ci_low"] < vcfg.min_success_lower_ci:
        reasons.append(f"success rate {b['success']['rate']:.0%} (lower bound {b['success']['ci_low']:.0%}) "
                       f"below {vcfg.min_success_lower_ci:.0%}")
    ok = not reasons
    return {"status": "validated" if ok else "failed", "label": "Validated" if ok else "Failed validation",
            "reasons": reasons, "criteria": criteria,
            "evidence": {"run_id": runs[-1]["run_id"], "episodes": b["episodes"], "success": b["success"],
                         "collision": b["collision"], "timeout": b["timeout"]}}


def model_validation(model, vcfg):
    policies = ["dqn", "dqn_recovery"] if model["algorithm"] == "dqn" else ["qlearning"]
    return {p: validation_status(model, p, vcfg) for p in policies}


def reliability_report(episodes, catalog, models, training, cfg, model_id=None, window=200):
    vcfg = cfg.validation
    active = models.get("dqn")
    if model_id is None and active:
        model_id = catalog.id_for_path(active[2]["path"])
    validation = None
    if model_id:
        try:
            validation = model_validation(catalog.get(model_id), vcfg)
        except KeyError:
            validation = None

    flt = {"model_id": model_id} if model_id else {}
    recs = [s for s in episodes.query(limit=100000, **flt) if s["source"] in EVAL_SOURCES][:window]
    n = len(recs)
    outcome = collections.Counter(s["outcome"] for s in recs)
    by_shield = {}
    for key, label in ((True, "shield_on"), (False, "shield_off")):
        xs = [s for s in recs if bool(s.get("shield")) == key]
        by_shield[label] = {"episodes": len(xs),
                            "collision": _ci(sum(s["outcome"] == "collision" for s in xs), len(xs)),
                            "success": _ci(sum(s["outcome"] == "success" for s in xs), len(xs))}
    causes = collections.Counter(s.get("collision_cause") or "unclassified (recorded before cause logging)"
                                 for s in recs if s["outcome"] == "collision")
    interventions = [s.get("safety_interventions") or 0 for s in recs]
    failures = [{"id": s["id"], "time": s["created"], "outcome": s["outcome"], "cause": s.get("collision_cause"),
                 "policy": s["policy_name"], "scenario": s.get("scenario_name") or "random map", "source": s["source"],
                 "shield": bool(s.get("shield")), "behaviors": s.get("behaviors", [])}
                for s in recs if s["outcome"] != "success"][:25]

    tr = training.summary()
    t_eps = training.episodes_since(0)[-window:]
    training_block = {"status": tr["status"], "episodes": len(t_eps),
                      "not_reaching_goal": sum(e["outcome"] != "success" for e in t_eps),
                      "collisions": sum(e["outcome"] == "collision" for e in t_eps),
                      "note": "Training episodes use epsilon-greedy exploration; they are not evaluation results."}

    baseline = None
    astar = [s for s in episodes.query(policy="astar", source="benchmark", limit=100000)]
    if astar:
        static = [s for s in astar if s.get("scenario_type") != "moving"]
        baseline = {"episodes": len(astar),
                    "success": _ci(sum(s["outcome"] == "success" for s in astar), len(astar)),
                    "static_map_collisions": _ci(sum(s["outcome"] == "collision" for s in static), len(static)),
                    "note": "A* plans on the known static map; collisions on maps without moving obstacles would "
                            "indicate a navigability or collision-system problem."}
    return {
        "model_id": model_id, "active_model": active[2] if active else None, "validation": validation,
        "window": window, "episodes": n,
        "outcomes": {"success": _ci(outcome["success"], n), "collision": _ci(outcome["collision"], n),
                     "timeout": _ci(outcome["timeout"], n)},
        "by_shield": by_shield,
        "safety": {"total_interventions": sum(interventions), "episodes_with_interventions": sum(1 for v in interventions if v),
                   "per_episode": (sum(interventions) / n) if n else None},
        "collision_causes": causes.most_common(),
        "failures": failures, "training": training_block, "baseline": baseline,
        "definitions": {
            "collision": "simulator detected the robot footprint touching an obstacle (episode ends)",
            "intervention": "safety layer rejected or modified a commanded motion before execution (not a collision)",
            "failed_episode": "evaluation episode ending in collision or timeout",
            "training_unfinished": "training episode that did not reach the goal (includes exploration)",
        },
    }
