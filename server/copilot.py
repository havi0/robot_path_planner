"""AI Research Copilot.

Two layers:
1. A deterministic FACT ENGINE that reads recorded data (experiments, episodes,
   benchmark runs, designs) and returns measured facts, rule-based hypotheses
   and recommendations - each clearly labelled. This always works, offline.
2. An OPTIONAL language-model provider (behind `CopilotProvider`) that turns the
   fact sheet into a narrative. It only receives the computed facts and is
   instructed never to introduce numbers that are not in them.

Provider selection (server-side environment variables, never the browser):
    NEXUS_COPILOT_PROVIDER = none (default) | anthropic
    NEXUS_COPILOT_MODEL    = claude-opus-5-5 (default)
Anthropic credentials are resolved by the official SDK (ANTHROPIC_API_KEY, or an
`ant auth login` profile).
"""
import json
import math
import os

import numpy as np
from scipy import stats

from evaluation.behavior import RULES
from evaluation.metrics import wilson_interval
from server.research import BENCHMARK_ID, two_proportion_test

GLOSSARY = {
    "exploration": "Exploration means trying actions that are not currently believed to be best, so the agent can discover "
                   "better behaviour. In this project the DQN uses epsilon-greedy exploration: with probability epsilon it takes "
                   "a random action; epsilon decays linearly from eps_start to eps_end over eps_decay steps. Evaluation always "
                   "uses the greedy policy (epsilon = 0), which is why training success and evaluation success differ.",
    "reward shaping": "Reward shaping adds intermediate rewards so learning does not depend only on the rare goal reward. Here the "
                      "reward includes progress toward the goal, a time penalty, and penalties for stopping, left/right "
                      "dithering and proximity. Shaping speeds learning but can create unintended optima - e.g. the original "
                      "reward made loitering in place nearly free, which produced timeouts (documented in REPORT.md).",
    "convergence": "Convergence means the learning curves stop improving systematically. For DQN it is not guaranteed: value "
                   "estimates can oscillate once exploration is low. The project therefore selects checkpoints on separate "
                   "validation maps rather than trusting the last checkpoint.",
    "generalization": "Generalisation is performance on situations not seen in training. All evaluation maps here use seeds "
                      "disjoint from training seeds, and scenario sets with role 'evaluation' use seeds >= 3,000,000.",
    "epsilon": "Epsilon is the probability of a random (exploratory) action in epsilon-greedy policies.",
    "replay buffer": "Experience replay stores past transitions and trains on random mini-batches of them, breaking the strong "
                     "correlation between consecutive steps and reusing data.",
    "target network": "A periodically-synchronised copy of the Q-network used to compute bootstrap targets, which stabilises "
                      "DQN training.",
    "double dqn": "Double DQN selects the next action with the online network but evaluates it with the target network, "
                  "reducing over-estimation of Q-values.",
    "wilson interval": "A confidence interval for a proportion (e.g. success rate) that stays well-behaved for small samples and "
                       "rates near 0 or 1. A 95% interval means the procedure covers the true rate 95% of the time under "
                       "repeated sampling - it is not a guarantee for a single map.",
    "counterfactual": "A counterfactual re-runs an episode from an exactly restored state with one change (e.g. a different "
                      "action) to see how the outcome would differ. Exactness is verified by deterministic re-simulation.",
    "overfitting": "Overfitting is learning behaviour that works on training maps but not on new ones. It shows up as a gap "
                   "between training and held-out performance.",
    "local minimum": "A local minimum trap is a map region where moving closer to the goal in a straight line leads into a dead "
                     "end. Reactive policies without memory are especially prone to getting stuck there.",
    "q-value": "Q(s, a) estimates the discounted return of taking action a in state s and then following the policy. The DQN "
               "picks the action with the highest Q-value.",
}


class CopilotProvider:
    name = "none"

    def status(self):
        return {"provider": self.name, "enabled": False, "reason": "AI narrative disabled (NEXUS_COPILOT_PROVIDER=none)."}

    def narrate(self, facts, question):
        return None


class AnthropicProvider(CopilotProvider):
    name = "anthropic"

    def __init__(self, model):
        self.model = model
        self._client = None
        self.error = None
        try:
            import anthropic  # noqa: F401
        except ImportError:
            self.error = "the 'anthropic' Python package is not installed"

    def status(self):
        if self.error:
            return {"provider": self.name, "enabled": False, "model": self.model, "reason": self.error}
        return {"provider": self.name, "enabled": True, "model": self.model,
                "reason": "Narratives generated by Claude from the measured fact sheet only."}

    SYSTEM = (
        "You are the NEXUS Research Copilot for a reinforcement-learning robot navigation project. You receive a JSON "
        "fact sheet computed from recorded experiments, and optionally a user question. Rules: (1) Use only numbers and "
        "results that appear in the fact sheet; never invent experiments, metrics or results. (2) Structure the answer "
        "with the headings 'Measured facts', 'Hypotheses' and 'Recommendations'. (3) Present anything causal as a "
        "hypothesis unless the fact sheet shows a controlled comparison with a significance test. (4) If the facts are "
        "insufficient to answer, say so plainly. Be concise and technical."
    )

    def narrate(self, facts, question):
        import anthropic
        if self._client is None:
            self._client = anthropic.Anthropic()
        content = "FACT SHEET (JSON):\n" + json.dumps(facts, default=str)[:180_000]
        if question:
            content += f"\n\nQUESTION: {question}"
        try:
            resp = self._client.beta.messages.create(
                model=self.model, max_tokens=16000, system=self.SYSTEM,
                output_config={"effort": "medium"},
                betas=["server-side-fallback-2026-07-01"], fallbacks="default",
                messages=[{"role": "user", "content": content}],
            )
        except anthropic.AuthenticationError:
            return {"error": "Anthropic authentication failed - set ANTHROPIC_API_KEY on the server or run `ant auth login`."}
        except anthropic.RateLimitError:
            return {"error": "Rate limited by the Anthropic API - try again shortly."}
        except anthropic.APIStatusError as e:
            return {"error": f"Anthropic API error {e.status_code}: {e.message}"}
        except anthropic.APIConnectionError:
            return {"error": "Could not reach the Anthropic API (network)."}
        if resp.stop_reason == "refusal":
            return {"error": "The model declined this request."}
        text = "".join(b.text for b in resp.content if b.type == "text")
        return {"text": text, "model": resp.model}


def make_provider():
    name = os.environ.get("NEXUS_COPILOT_PROVIDER", "none").strip().lower()
    if name == "anthropic":
        return AnthropicProvider(os.environ.get("NEXUS_COPILOT_MODEL", "claude-opus-5-5"))
    return CopilotProvider()


def _fact(text, source):
    return {"text": text, "source": source}


def _pct(x):
    return "n/a" if x is None else f"{100 * x:.0f}%"


class Copilot:
    def __init__(self, research, store, episodes, catalog, runs, designs, provider=None):
        self.research, self.store, self.episodes = research, store, episodes
        self.catalog, self.runs, self.designs = catalog, runs, designs
        self.provider = provider or make_provider()

    # ------------------------------------------------------------------ entry
    def ask(self, intent, params=None, question=None, narrate=True):
        params = params or {}
        fn = {"summary": self.summary, "episode": self.explain_episode, "compare": self.compare_experiments,
              "correlations": self.correlations, "suggest": self.suggest, "concept": self.concept,
              "question": self.question}.get(intent)
        if fn is None:
            raise ValueError("unknown intent")
        out = fn(**params) if intent != "question" else fn(question or "", **params)
        out["intent"] = intent
        out["provider"] = self.provider.status()
        out["narrative"] = None
        if narrate and self.provider.status()["enabled"] and intent != "concept":
            sheet = {k: out[k] for k in ("title", "facts", "hypotheses", "recommendations", "data") if k in out}
            out["narrative"] = self.provider.narrate(sheet, question)
        return out

    # ------------------------------------------------------------------ summary
    def summary(self):
        exps = self.store.list()
        facts, data = [], {"experiments": [], "models": [], "runs": []}
        facts.append(_fact(f"{len(exps)} experiments recorded "
                           f"({sum(e['status'] == 'completed' for e in exps)} completed).", "experiment store"))
        for e in exps[:15]:
            vals = [v["success_rate"] for v in e.get("evaluations", []) if v.get("kind") == "validation"]
            best = max(vals) if vals else None
            data["experiments"].append({"id": e["id"], "name": e["name"], "algorithm": e["algorithm"],
                                        "episodes": e["episodes"], "best_validation_success": best, "status": e["status"]})
            if best is not None:
                facts.append(_fact(f"{e['name']} ({e['algorithm'].upper()}, {e['episodes']} episodes): best validation "
                                   f"success {_pct(best)} over {len(vals)} validation checks.", f"experiment {e['id']}"))
        for m in self.catalog.list():
            if m.get("benchmarks"):
                b = m["benchmarks"][-1]["summary"]["success"]
                data["models"].append({"model_id": m["model_id"], "label": m["label"], "benchmark_success": b})
                facts.append(_fact(f"Model {m['model_id']} ({m['label']}): {_pct(b['rate'])} success on "
                                   f"{m['benchmarks'][-1]['set_name']} (n={b['n']}, 95% CI {_pct(b['ci_low'])}-{_pct(b['ci_high'])}).",
                                   f"model registry {m['model_id']}"))
        eps = self.episodes.all_summaries()
        if eps:
            by = {}
            for s in eps:
                by[s["outcome"]] = by.get(s["outcome"], 0) + 1
            facts.append(_fact(f"{len(eps)} recorded episodes: " + ", ".join(f"{k} {v}" for k, v in sorted(by.items())) + ".",
                               "episode store"))
        for d in self.designs.list():
            if d.get("summary"):
                facts.append(_fact(f"Design '{d['name']}': {d['summary']['conclusion']}", f"design {d['id']}"))
        return {"title": "Summary of recorded results", "facts": facts, "hypotheses": [], "recommendations": [], "data": data}

    # ------------------------------------------------------------------ episode
    def explain_episode(self, episode_id):
        ep = self.episodes.get(episode_id)
        m, beh, st = ep["metrics"], ep["behavior"], ep["steps"]
        n = len(st["action"])
        clearance_txt = "n/a" if m.get("min_clearance") is None else "%.3f m" % m["min_clearance"]
        facts = [
            _fact(f"Outcome: {ep['outcome']} after {n} of {ep['max_steps']} actions; driven {m['path_length']:.2f} m"
                  + (f" vs shortest feasible {m['reference_length']:.2f} m." if m.get("reference_length") else "."), "telemetry"),
            _fact(f"Policy {ep['policy_name']}" + (f", model {ep['model']['model_id']}" if ep.get("model") else "")
                  + f"; conditions: sensor noise {ep['conditions'].get('sensor_noise', 0)}, motion noise "
                    f"{ep['conditions'].get('motion_noise', 0)}, shield {'on' if ep['conditions'].get('shield') else 'off'}.", "episode metadata"),
            _fact(f"Final distance to goal {st['dist'][-1]:.2f} m; minimum clearance {clearance_txt}.", "telemetry"),
            _fact("Last actions: " + ", ".join(st["action"][-8:]) + ".", "telemetry"),
        ]
        for lab in beh["labels"]:
            facts.append(_fact(f"{lab['name']} {lab['status']}: measured {lab['value']} (threshold {lab['threshold']}, "
                               f"rule: {lab['rule']}).", "behaviour profiler"))
        interventions = sum(1 for s in st["safety"] if s)
        if interventions:
            facts.append(_fact(f"Safety layer intervened on {interventions} steps.", "telemetry"))
        analysis = None
        sid = (ep.get("scenario") or {}).get("id")
        if sid:
            try:
                sc = self.research.scenarios.get(sid)
                analysis = sc["analysis"]
                facts.append(_fact(f"Scenario '{sc['name']}' ({sc['type']}): geometric difficulty {sc['difficulty']['score']} "
                                   f"({sc['difficulty']['band']}), local-minimum trap: {analysis.get('local_minimum_trap')}, "
                                   f"narrow passages on route: {analysis.get('narrow_on_route')}.", f"scenario {sid}"))
            except KeyError:
                pass
        hyps, recs = [], []
        nearest = self._nearest_obstacle(ep)
        if ep["outcome"] == "collision":
            if nearest:
                facts.append(_fact(f"At the end, the nearest static obstacle surface was {nearest['distance']:.3f} m from the robot "
                                   f"centre at a bearing of {nearest['bearing_deg']:.0f} deg relative to the heading.", "geometry"))
                side = abs(nearest["bearing_deg"]) > 35
                if st["action"] and st["action"][-1] == "forward" and side:
                    hyps.append({"text": "The robot probably clipped an obstacle beside it while driving straight: the contact point "
                                         "lies outside the +/-35 deg front sector.", "basis": "final geometry + last action"})
                elif not side:
                    hyps.append({"text": "The robot drove into an obstacle ahead; the policy did not turn away in time.",
                                 "basis": "final geometry"})
            if ep["world"].get("movers"):
                hyps.append({"text": "A moving obstacle may have been involved (mover trajectories are not recorded, so this "
                                     "cannot be confirmed).", "basis": "scenario has moving obstacles"})
            k = max(0, n - 3)
            recs.append({"text": f"Run a counterfactual from step {k} with the safety shield enabled to test whether the shield "
                                 "would have prevented this collision.",
                         "action": {"page": "episodes", "episode_id": episode_id, "step": k,
                                    "modification": {"type": "shield", "enabled": True}}})
        if ep["outcome"] == "timeout":
            loops = [l for l in beh["detected"] if l in ("stagnation", "oscillation", "repeated_turning", "idle_stop")]
            if loops:
                hyps.append({"text": "The policy entered a behavioural loop (" + ", ".join(loops) + ") and could not escape "
                                     "within the step limit.", "basis": "behaviour profiler"})
            if analysis and analysis.get("local_minimum_trap"):
                hyps.append({"text": "The map contains a local-minimum trap (greedy goal-seeking gets stuck), which a "
                                     "memoryless reactive policy is prone to.", "basis": "map analyzer"})
            if ep["policy"] == "dqn":
                recs.append({"text": "Evaluate the same model with the recovery behaviour (DQN + recovery) on this scenario.",
                             "action": {"page": "designer", "prefill": {"design_type": "evaluate"}}})
            recs.append({"text": "Train with a curriculum that includes u_trap and dead_end scenarios.",
                         "action": {"page": "training", "curriculum": ["u_trap", "dead_end"]}})
        if "excessive_detour" in beh["detected"]:
            hyps.append({"text": "The route was much longer than necessary; the policy explored a detour before finding the "
                                 "way around.", "basis": "path ratio"})
        if "near_miss" in beh["detected"]:
            recs.append({"text": "Clearance fell below the near-miss threshold; consider a stronger proximity penalty or "
                                 "the safety shield for deployment.", "action": None})
        return {"title": f"Episode {episode_id}", "facts": facts, "hypotheses": hyps, "recommendations": recs,
                "data": {"episode_id": episode_id, "outcome": ep["outcome"], "behavior": beh["detected"]}}

    @staticmethod
    def _nearest_obstacle(ep):
        rects = ep["world"].get("rects") or []
        if not rects:
            return None
        x, y, th = ep["steps"]["x"][-1], ep["steps"]["y"][-1], ep["steps"]["theta"][-1]
        best = None
        for a, b, c, d in rects:
            cx, cy = min(max(x, a), c), min(max(y, b), d)
            dist = math.hypot(cx - x, cy - y)
            if best is None or dist < best[0]:
                best = (dist, cx, cy)
        bearing = math.degrees((math.atan2(best[2] - y, best[1] - x) - th + math.pi) % (2 * math.pi) - math.pi)
        return {"distance": best[0], "bearing_deg": bearing}

    # ------------------------------------------------------------------ compare
    def compare_experiments(self, a, b):
        ea, eb = self.store.get(a), self.store.get(b)
        diffs = []

        def walk(x, y, path):
            if isinstance(x, dict) and isinstance(y, dict):
                for k in sorted(set(x) | set(y)):
                    walk(x.get(k), y.get(k), f"{path}.{k}" if path else k)
            elif x != y:
                diffs.append({"key": path, "a": x, "b": y})
        walk({"algorithm": ea["algorithm"], "seed": ea["seed"], "hyperparameters": ea["hyperparameters"],
              "environment": ea["environment"]},
             {"algorithm": eb["algorithm"], "seed": eb["seed"], "hyperparameters": eb["hyperparameters"],
              "environment": eb["environment"]}, "")
        facts = [_fact(f"{len(diffs)} configuration differences: " + "; ".join(f"{d['key']}: {d['a']} -> {d['b']}" for d in diffs[:12])
                       + (" ..." if len(diffs) > 12 else ""), "experiment configs")]
        res = {}
        for tag, e in (("a", ea), ("b", eb)):
            ms = self.store.metrics(e["id"])[-100:]
            k = sum(r["outcome"] == "success" for r in ms)
            vals = [v["success_rate"] for v in e.get("evaluations", []) if v.get("kind") == "validation"]
            res[tag] = {"k": k, "n": len(ms), "best_val": max(vals) if vals else None}
            lo, hi = wilson_interval(k, len(ms)) if ms else (None, None)
            facts.append(_fact(f"{e['name']}: training success over its last {len(ms)} episodes {_pct(k / len(ms) if ms else None)} "
                               f"(95% CI {_pct(lo)}-{_pct(hi)}); best validation {_pct(res[tag]['best_val'])}.", f"experiment {e['id']}"))
        p = two_proportion_test(res["a"]["k"], res["a"]["n"], res["b"]["k"], res["b"]["n"])
        if p is not None:
            facts.append(_fact(f"Two-proportion test on last-100 training success: p = {p:.3f} "
                               f"({'significant' if p < 0.05 else 'not significant'} at 0.05; training episodes include exploration).",
                               "statistics"))
        hyps = []
        cfg_keys = [d for d in diffs if d["key"] != "seed"]
        if len(cfg_keys) == 1:
            hyps.append({"text": f"The outcome difference may be due to {cfg_keys[0]['key']}, but with one seed per side it is "
                                 "confounded with run-to-run variance.", "basis": "single configuration difference"})
        elif len(cfg_keys) > 1:
            hyps.append({"text": "Several factors changed at once, so the difference cannot be attributed to any single one.",
                         "basis": f"{len(cfg_keys)} differing settings"})
        recs = [{"text": "Run a controlled comparison in the Experiment Designer with >= 3 seeds per configuration.",
                 "action": {"page": "designer"}}]
        return {"title": f"{ea['name']} vs {eb['name']}", "facts": facts, "hypotheses": hyps, "recommendations": recs,
                "data": {"differences": diffs, "metrics": res}}

    # ------------------------------------------------------------------ correlations
    def correlations(self):
        rows = []
        for e in self.store.list():
            if e.get("cell_params") is not None:
                continue                      # design runs are analysed separately below
            vals = [v["success_rate"] for v in e.get("evaluations", []) if v.get("kind") == "validation"]
            ms = self.store.metrics(e["id"])[-100:]
            if not vals and len(ms) < 20:
                continue
            y = max(vals) if vals else sum(r["outcome"] == "success" for r in ms) / len(ms)
            feats = {}
            for k, v in (e.get("hyperparameters") or {}).items():
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    feats[f"hp.{k}"] = v
            for k, v in ((e.get("environment") or {}).get("reward") or {}).items():
                if isinstance(v, (int, float)):
                    feats[f"reward.{k}"] = v
            rows.append((feats, y))
        facts, out = [], []
        facts.append(_fact(f"{len(rows)} uncontrolled experiments with an outcome metric (best validation success, or "
                           "training success over the last 100 episodes).", "experiment store"))
        keys = sorted({k for f, _ in rows for k in f})
        for k in keys:
            pts = [(f[k], y) for f, y in rows if k in f]
            xs = [p[0] for p in pts]
            if len(pts) < 3 or len(set(xs)) < 2:
                continue
            rho, p = stats.spearmanr(xs, [p[1] for p in pts])
            if not np.isfinite(rho):
                continue
            out.append({"parameter": k, "n": len(pts), "spearman_rho": float(rho), "p_value": float(p),
                        "reliable": len(pts) >= 6 and p < 0.05})
        out.sort(key=lambda r: -abs(r["spearman_rho"]))
        for r in out[:8]:
            facts.append(_fact(f"{r['parameter']}: Spearman rho = {r['spearman_rho']:+.2f} (n={r['n']}, p={r['p_value']:.2f})"
                               + ("" if r["reliable"] else " - insufficient evidence"), "correlation analysis"))
        design_facts = []
        for d in self.designs.list():
            if d.get("summary"):
                for c in d["summary"]["comparisons"]:
                    design_facts.append(_fact(f"Design '{d['name']}' {c['cell_id']} vs {c['vs']}: {c['verdict']}", f"design {d['id']}"))
        facts += design_facts
        hyps = [{"text": "Correlations across uncontrolled experiments do not establish causation: settings changed together "
                         "and each run has a single seed. Use the Experiment Designer for controlled tests.",
                 "basis": "study design"}]
        if not out:
            hyps.append({"text": "Not enough varied experiments to estimate any correlation.", "basis": "data volume"})
        return {"title": "Reward and hyperparameter correlations", "facts": facts, "hypotheses": hyps,
                "recommendations": [{"text": "Sweep the parameter with the strongest correlation in a controlled design.",
                                     "action": {"page": "designer", "prefill": {"parameter": out[0]["parameter"].split(".", 1)[1]}} if out else None}],
                "data": {"correlations": out}}

    # ------------------------------------------------------------------ suggestions
    def suggest(self, run_id=None):
        runs = [r for r in self.runs.list() if r.get("status") == "completed"]
        if run_id:
            runs = [r for r in runs if r["id"] == run_id]
        if not runs:
            return {"title": "Suggested experiments", "facts": [_fact("No completed benchmark run yet.", "benchmark runs")],
                    "hypotheses": [], "recommendations": [{"text": "Evaluate a model on the shared benchmark first.",
                                                           "action": {"page": "models"}}], "data": {}}
        run = runs[0]
        summ = self.research.risk_summary(run_id=run["id"])
        facts = [_fact(f"Benchmark run '{run['label']}' ({summ['episodes']} episodes).", f"run {run['id']}")]
        worst = sorted(summ["by_type"].items(), key=lambda kv: kv[1]["success"]["rate"] or 0)
        for t, v in worst[:4]:
            s = v["success"]
            facts.append(_fact(f"{t}: success {_pct(s['rate'])} (n={s['n']}, 95% CI {_pct(s['ci_low'])}-{_pct(s['ci_high'])}), "
                               f"collision {_pct(v['collision']['rate'])}, timeout {_pct(v['timeout']['rate'])}.", "risk summary"))
        beh = sorted(summ["behaviors"].items(), key=lambda kv: -kv[1])
        if beh:
            facts.append(_fact("Most frequent behaviours: " + ", ".join(f"{k} ({v})" for k, v in beh[:5]) + ".", "behaviour profiler"))
        recs = []
        bset = dict(beh)
        for t, v in worst[:3]:
            if (v["timeout"]["rate"] or 0) >= 0.2 and t in ("u_trap", "dead_end", "multi_route", "narrow_passage", "temporary_blockage"):
                recs.append({"text": f"Timeouts dominate on {t} ({_pct(v['timeout']['rate'])}): train with a curriculum that "
                                     f"includes {t} scenarios.", "basis": f"{t} timeout rate",
                             "action": {"page": "training", "curriculum": [t]}})
            if (v["collision"]["rate"] or 0) >= 0.2:
                recs.append({"text": f"Collisions on {t} ({_pct(v['collision']['rate'])}): sweep the collision penalty in a "
                                     "controlled design.", "basis": f"{t} collision rate",
                             "action": {"page": "designer", "prefill": {"parameter": "collision_penalty", "values": [-10, -20, -40]}}})
        if bset.get("oscillation", 0) >= 3:
            recs.append({"text": "Oscillation is frequent: sweep turn_reversal_penalty.", "basis": "behaviour counts",
                         "action": {"page": "designer", "prefill": {"parameter": "turn_reversal_penalty", "values": [0.0, -0.1, -0.3]}}})
        if bset.get("stagnation", 0) >= 3:
            recs.append({"text": "Stagnation is frequent: compare DQN with and without the recovery behaviour.",
                         "basis": "behaviour counts", "action": {"page": "designer", "prefill": {"design_type": "evaluate"}}})
        hyps = [{"text": "These suggestions follow fixed rules applied to the measured failure pattern; their benefit is "
                         "untested until the suggested experiment is run.", "basis": "rule-based"}]
        return {"title": "Suggested experiments", "facts": facts, "hypotheses": hyps, "recommendations": recs,
                "data": {"run_id": run["id"], "by_type": summ["by_type"]}}

    # ------------------------------------------------------------------ concepts / free questions
    def concept(self, term):
        t = (term or "").strip().lower()
        if t not in GLOSSARY:
            raise ValueError(f"unknown concept; choose one of {sorted(GLOSSARY)}")
        return {"title": t.title(), "facts": [], "hypotheses": [], "recommendations": [],
                "background": GLOSSARY[t], "data": {"term": t}}

    def question(self, question, **context):
        base = self.summary()
        if context.get("episode_id"):
            ep = self.explain_episode(context["episode_id"])
            base["facts"] += ep["facts"]
            base["hypotheses"] += ep["hypotheses"]
        q = question.lower()
        hits = [t for t in GLOSSARY if t in q]
        base["title"] = "Question"
        if hits:
            base["background"] = " ".join(GLOSSARY[t] for t in hits[:2])
        return base

    def concepts(self):
        return sorted(GLOSSARY)

    def rules(self):
        return RULES

    BENCHMARK = BENCHMARK_ID
