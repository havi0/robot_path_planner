"""REST routes for NEXUS 2.0 research features: scenarios, episodes & behaviours,
counterfactuals, risk explorer, benchmarks, model registry, experiment
designer, background jobs, copilot, search and export bundles."""
import asyncio
import io
import json
import os
import time
import zipfile
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from evaluation.behavior import RULES
from scenarios.generator import SCENARIO_TYPES
from server.catalog import compatibility_issues
from server.reliability import model_validation, reliability_report
from server.research import BENCHMARK_ID


class GenerateReq(BaseModel):
    type: str
    seed: Optional[int] = None
    size: float = 6.0
    save: bool = False
    name: Optional[str] = None


class SaveCurrentReq(BaseModel):
    name: str


class SetReq(BaseModel):
    name: str
    types: List[str]
    per_type: int = 3
    role: str = "evaluation"
    size: float = 6.0
    base_seed: Optional[int] = None


class CounterfactualReq(BaseModel):
    step: int
    modification: Dict[str, Any]


class RegionReq(BaseModel):
    scenario_id: str
    rect: List[float]
    run_id: Optional[str] = None
    model_id: Optional[str] = None


class RunReq(BaseModel):
    set_id: str = BENCHMARK_ID
    entries: List[Dict[str, Any]]
    repeats: int = 3
    sensor_noise: float = 0.02
    motion_noise: float = 0.05
    shield: bool = False
    label: Optional[str] = None


class BenchmarkReq(BaseModel):
    policy: str = "dqn_recovery"
    repeats: int = 2


class DesignReq(BaseModel):
    name: Optional[str] = None
    spec: Dict[str, Any]


class AskReq(BaseModel):
    intent: str
    params: Dict[str, Any] = {}
    question: Optional[str] = None
    narrate: bool = True


def register(app):
    def S(request):
        return request.app.state.svc

    # ------------------------------------------------------------------ scenarios
    @app.get("/api/scenarios/types")
    def scenario_types():
        return SCENARIO_TYPES

    @app.post("/api/scenarios/generate")
    async def scenario_generate(req: GenerateReq, request: Request):
        r = S(request)["research"]
        return await asyncio.to_thread(r.generate, req.type, req.seed, req.size, req.save, req.name)

    @app.post("/api/scenarios/analyze")
    async def scenario_analyze(request: Request, body: Dict[str, Any]):
        r = S(request)["research"]
        if "world" not in body:
            raise HTTPException(400, "world is required")
        return await asyncio.to_thread(r.analyze_world_dict, body["world"])

    @app.get("/api/sim/analyze")
    async def sim_analyze(request: Request):
        sim = S(request)["sim"]
        from scenarios.io import world_to_dict
        with sim.lock:
            wd = world_to_dict(sim.base_world)
        return await asyncio.to_thread(S(request)["research"].analyze_world_dict, wd)

    @app.get("/api/scenarios")
    def scenarios(request: Request, include_members: bool = False):
        out = []
        for d in S(request)["scenarios"].list():
            if d.get("set_member") and not include_members:
                continue
            out.append({k: d[k] for k in ("id", "name", "type", "seed", "size", "difficulty", "split", "created") if k in d})
        return out

    @app.get("/api/scenarios/{sid}")
    def scenario(sid: str, request: Request):
        return S(request)["scenarios"].get(sid)

    @app.delete("/api/scenarios/{sid}")
    def scenario_delete(sid: str, request: Request):
        if sid.startswith("bench-"):
            raise HTTPException(409, "benchmark scenarios are read-only")
        S(request)["scenarios"].delete(sid)
        return {"ok": True}

    @app.post("/api/scenarios/{sid}/load")
    def scenario_load(sid: str, request: Request):
        doc = S(request)["scenarios"].get(sid)
        sim = S(request)["sim"]
        if sim.status == "running":
            raise HTTPException(409, "pause the simulation first")
        sim.load_world(doc["world"], {"id": doc["id"], "type": doc["type"], "name": doc["name"],
                                      "difficulty": doc["difficulty"]["score"]})
        S(request)["events"].emit("info", "scenario", f"Scenario '{doc['name']}' loaded into the simulator")
        return {"ok": True}

    @app.post("/api/scenarios/save-current")
    async def scenario_save_current(req: SaveCurrentReq, request: Request):
        svc = S(request)
        from scenarios.io import world_to_dict
        with svc["sim"].lock:
            wd = world_to_dict(svc["sim"].base_world)
        analysis = await asyncio.to_thread(svc["research"].analyze_world_dict, wd)
        if not analysis["route_exists"]:
            raise HTTPException(400, "no collision-free route exists on this map")
        doc = {"id": svc["scenarios"].new_id(req.name), "name": req.name.strip()[:80] or "custom map", "type": "custom",
               "seed": int(svc["sim"].config["seed"]), "size": wd["width"], "world": wd, "analysis": analysis,
               "difficulty": analysis["difficulty"], "split": "custom", "created": time.time()}
        svc["scenarios"].save(doc)
        return doc

    # ------------------------------------------------------------------ scenario sets
    @app.get("/api/scenario-sets")
    def sets(request: Request):
        return S(request)["sets"].list()

    @app.get("/api/scenario-sets/{set_id}")
    def set_get(set_id: str, request: Request):
        s = S(request)["sets"].get(set_id)
        sc = S(request)["scenarios"]
        s["scenarios"] = [{k: d[k] for k in ("id", "name", "type", "difficulty", "seed")} for d in (sc.get(i) for i in s["scenario_ids"])]
        return s

    @app.post("/api/scenario-sets")
    def set_create(req: SetReq, request: Request):
        r = S(request)["research"]
        if not req.name.strip():
            raise HTTPException(400, "name is required")
        types, base = r.validate_set(req.types, req.per_type, req.role, req.size, req.base_seed)
        job = S(request)["jobs"].submit("scenario_set", f"Build scenario set '{req.name}'",
                                        lambda j: r.build_set(j, req.name.strip(), types, req.per_type, req.role,
                                                              req.size, base)["id"], req.model_dump())
        return job.as_dict()

    @app.post("/api/scenario-sets/benchmark")
    def benchmark_set(request: Request):
        r = S(request)["research"]
        job = S(request)["jobs"].submit("scenario_set", "Build NEXUS benchmark v1", lambda j: r.ensure_benchmark(j)["id"])
        return job.as_dict()

    @app.delete("/api/scenario-sets/{set_id}")
    def set_delete(set_id: str, request: Request):
        if set_id == BENCHMARK_ID:
            raise HTTPException(409, "the shared benchmark is read-only")
        S(request)["sets"].delete(set_id)
        return {"ok": True}

    # ------------------------------------------------------------------ episodes & behaviour
    @app.get("/api/episodes")
    def episodes(request: Request, source: str = None, policy: str = None, model_id: str = None, scenario_id: str = None,
                 scenario_type: str = None, outcome: str = None, behavior: str = None, run_id: str = None,
                 q: str = None, limit: int = 300):
        return S(request)["episodes"].query(source=source, policy=policy, model_id=model_id, scenario_id=scenario_id,
                                            scenario_type=scenario_type, outcome=outcome, behavior=behavior, run_id=run_id,
                                            q=q, limit=min(max(limit, 1), 2000))

    @app.get("/api/episodes/{ep_id}")
    def episode(ep_id: str, request: Request):
        return S(request)["episodes"].get(ep_id)

    @app.get("/api/episodes/{ep_id}/step/{k}")
    async def episode_step(ep_id: str, k: int, request: Request):
        return await asyncio.to_thread(S(request)["research"].episode_step, ep_id, k)

    @app.post("/api/episodes/{ep_id}/counterfactual")
    async def counterfactual(ep_id: str, req: CounterfactualReq, request: Request):
        return await asyncio.to_thread(S(request)["research"].counterfactual, ep_id, req.step, req.modification)

    @app.get("/api/behavior/rules")
    def behavior_rules():
        return RULES

    # ------------------------------------------------------------------ risk explorer
    @app.get("/api/risk/summary")
    async def risk_summary(request: Request, run_id: str = None, model_id: str = None, policy: str = None):
        return await asyncio.to_thread(S(request)["research"].risk_summary, run_id, model_id, policy)

    @app.get("/api/risk/map")
    async def risk_map(request: Request, scenario_id: str, run_id: str = None, model_id: str = None):
        return await asyncio.to_thread(S(request)["research"].risk_map, scenario_id, run_id, model_id)

    @app.post("/api/risk/region")
    async def risk_region(req: RegionReq, request: Request):
        if len(req.rect) != 4:
            raise HTTPException(400, "rect must be [x0, y0, x1, y1]")
        return await asyncio.to_thread(S(request)["research"].risk_region, req.scenario_id, req.rect, req.run_id, req.model_id)

    # ------------------------------------------------------------------ benchmark runs
    @app.get("/api/runs")
    def runs(request: Request):
        return S(request)["runs"].list()

    @app.get("/api/runs/{run_id}")
    def run_get(run_id: str, request: Request):
        return S(request)["runs"].get(run_id)

    @app.post("/api/runs")
    def run_create(req: RunReq, request: Request):
        r = S(request)["research"]
        if not req.entries:
            raise HTTPException(400, "add at least one policy/model")
        for e in req.entries:
            if e.get("model_id"):
                m = S(request)["catalog"].get(e["model_id"])
                issues = compatibility_issues(m["interface"], S(request)["cfg"])
                if issues:
                    raise HTTPException(409, f"incompatible model {e['model_id']}: " + "; ".join(issues))
        job = S(request)["jobs"].submit("benchmark", f"Benchmark: {req.label or req.set_id}",
                                        lambda j: r.run_benchmark(j, req.set_id, req.entries, req.repeats, req.sensor_noise,
                                                                  req.motion_noise, req.shield, req.label), req.model_dump())
        return job.as_dict()

    @app.delete("/api/runs/{run_id}")
    def run_delete(run_id: str, request: Request):
        S(request)["runs"].get(run_id)
        S(request)["episodes"].delete_run(run_id)
        S(request)["runs"].delete(run_id)
        return {"ok": True}

    # ------------------------------------------------------------------ model registry
    @app.get("/api/models")
    def models(request: Request):
        cfg = S(request)["cfg"]
        active = S(request)["models"].describe()
        active_paths = {os.path.normcase(v["path"]) for v in active.values() if v}
        out = []
        for m in S(request)["catalog"].list():
            m["compatibility_issues"] = compatibility_issues(m["interface"], cfg)
            m["checkpoint_exists"] = os.path.exists(m["checkpoint"])
            m["active"] = os.path.normcase(m["checkpoint"]) in active_paths
            m["validation"] = model_validation(m, cfg.validation)
            out.append(m)
        return out

    @app.get("/api/models/{mid}")
    def model(mid: str, request: Request):
        m = S(request)["catalog"].get(mid)
        m["compatibility_issues"] = compatibility_issues(m["interface"], S(request)["cfg"])
        m["episodes"] = len(S(request)["episodes"].query(model_id=mid, limit=100000))
        m["validation"] = model_validation(m, S(request)["cfg"].validation)
        return m

    @app.get("/api/reliability")
    def reliability(request: Request, model_id: str = None, window: int = 200):
        svc = S(request)
        return reliability_report(svc["episodes"], svc["catalog"], svc["models"], svc["training"], svc["cfg"],
                                  model_id, min(max(window, 10), 5000))

    @app.post("/api/models/{mid}/load")
    def model_load(mid: str, request: Request):
        svc = S(request)
        m = svc["catalog"].get(mid)
        issues = compatibility_issues(m["interface"], svc["cfg"])
        if issues:
            raise HTTPException(409, "Refusing to load an incompatible model: " + "; ".join(issues))
        if not os.path.exists(m["checkpoint"]):
            raise HTTPException(404, "checkpoint file is missing")
        info = svc["models"].load(m["algorithm"], m["checkpoint"], {"experiment_id": m.get("experiment_id"), "label": m["label"]})
        sim = svc["sim"]
        with sim.lock:
            sim._use_model_observation()
            sim._reset_episode()
        svc["events"].emit("success", "registry", f"Model {mid} loaded into the simulator")
        return {**info, "model_id": mid}

    @app.post("/api/models/{mid}/benchmark")
    def model_benchmark(mid: str, req: BenchmarkReq, request: Request):
        m = S(request)["catalog"].get(mid)
        policy = req.policy if m["algorithm"] == "dqn" else "qlearning"
        if m["algorithm"] == "dqn" and policy not in ("dqn", "dqn_recovery"):
            raise HTTPException(400, "policy must be dqn or dqn_recovery for a DQN model")
        return run_create(RunReq(entries=[{"policy": policy, "model_id": mid}], repeats=req.repeats,
                                 label=f"{m['label']} ({policy})"), request)

    @app.get("/api/models/{a}/compare/{b}")
    def model_compare(a: str, b: str, request: Request):
        svc = S(request)
        ma, mb = svc["catalog"].get(a), svc["catalog"].get(b)
        diffs = []

        def walk(x, y, path):
            if isinstance(x, dict) and isinstance(y, dict):
                for k in sorted(set(x) | set(y)):
                    walk(x.get(k), y.get(k), f"{path}.{k}" if path else k)
            elif x != y:
                diffs.append({"key": path, "a": x, "b": y})
        for key in ("algorithm", "architecture", "training_config", "seed", "env_version"):
            walk(ma.get(key), mb.get(key), key)
        bench = None
        ba = [x for x in ma.get("benchmarks", []) if x["set_id"] == BENCHMARK_ID]
        bb = [x for x in mb.get("benchmarks", []) if x["set_id"] == BENCHMARK_ID]
        if ba and bb:
            sa, sb = ba[-1]["summary"], bb[-1]["summary"]
            bench = svc["research"].compare_entries({"overall": sa}, {"overall": sb}, "success")
            bench["comparable"] = ba[-1]["conditions"] == bb[-1]["conditions"]
        return {"a": ma, "b": mb, "differences": diffs, "benchmark": bench,
                "compatible_with_each_other": ma["env_version"] == mb["env_version"]}

    # ------------------------------------------------------------------ experiment designer
    @app.post("/api/designs/plan")
    def design_plan(req: DesignReq, request: Request):
        return S(request)["research"].plan_design(req.spec)

    @app.post("/api/designs")
    def design_create(req: DesignReq, request: Request):
        svc = S(request)
        plan = svc["research"].plan_design(req.spec)
        if not plan["within_budget"]:
            raise HTTPException(400, f"estimated {plan['estimated_minutes']} min exceeds the budget of {plan['budget_minutes']} min")
        name = (req.name or plan["question"])[:80]
        doc = {"id": svc["designs"].new_id(name), "name": name, "spec": req.spec, "plan": plan, "status": "queued",
               "created": time.time(), "results": [], "summary": None}
        svc["designs"].save(doc)
        r = svc["research"]

        def work(job):
            try:
                return r.run_design(job, doc["id"])
            except Exception:
                svc["designs"].update(doc["id"], status="failed" if not job._cancel.is_set() else "cancelled")
                raise
        job = svc["jobs"].submit("design", f"Design: {name}", work, {"design_id": doc["id"]})
        svc["designs"].update(doc["id"], job_id=job.id)
        return {**doc, "job_id": job.id}

    @app.get("/api/designs")
    def designs(request: Request):
        return S(request)["designs"].list()

    @app.get("/api/designs/{did}")
    def design(did: str, request: Request):
        return S(request)["designs"].get(did)

    @app.delete("/api/designs/{did}")
    def design_delete(did: str, request: Request):
        d = S(request)["designs"].get(did)
        if d["status"] in ("queued", "running"):
            raise HTTPException(409, "cancel the design's job first")
        S(request)["designs"].delete(did)
        return {"ok": True}

    # ------------------------------------------------------------------ jobs
    @app.get("/api/jobs")
    def jobs(request: Request):
        return S(request)["jobs"].list()

    @app.post("/api/jobs/{job_id}/cancel")
    def job_cancel(job_id: str, request: Request):
        try:
            return S(request)["jobs"].cancel(job_id)
        except ValueError as e:
            raise HTTPException(400, str(e))

    # ------------------------------------------------------------------ copilot
    @app.get("/api/copilot/status")
    def copilot_status(request: Request):
        c = S(request)["copilot"]
        return {**c.provider.status(), "concepts": c.concepts()}

    @app.post("/api/copilot/ask")
    async def copilot_ask(req: AskReq, request: Request):
        c = S(request)["copilot"]
        try:
            return await asyncio.to_thread(c.ask, req.intent, req.params, req.question, req.narrate)
        except TypeError as e:
            raise HTTPException(400, f"invalid parameters for intent '{req.intent}': {e}")
        except ValueError as e:
            raise HTTPException(400, str(e))

    # ------------------------------------------------------------------ search
    @app.get("/api/search")
    def search(request: Request, q: str = ""):
        svc = S(request)
        ql = q.strip().lower()
        if not ql:
            return []
        out = []
        for e in svc["store"].list():
            if ql in e["name"].lower() or ql in e["id"].lower():
                out.append({"kind": "experiment", "id": e["id"], "title": e["name"], "subtitle": f"{e['algorithm'].upper()} · {e['status']}"})
        for m in svc["catalog"].list():
            if ql in m["label"].lower() or ql in m["model_id"].lower():
                out.append({"kind": "model", "id": m["model_id"], "title": m["label"], "subtitle": m["model_id"]})
        for d in svc["scenarios"].list():
            if ql in d["name"].lower() or ql in d["type"]:
                out.append({"kind": "scenario", "id": d["id"], "title": d["name"], "subtitle": d["type"]})
        for s in svc["episodes"].query(q=ql, limit=20):
            out.append({"kind": "episode", "id": s["id"], "title": f"{s['policy_name']} · {s['outcome']}",
                        "subtitle": s.get("scenario_name") or s["id"]})
        for d in svc["designs"].list():
            if ql in d["name"].lower():
                out.append({"kind": "design", "id": d["id"], "title": d["name"], "subtitle": d["status"]})
        return out[:60]

    # ------------------------------------------------------------------ export bundle
    @app.get("/api/experiments/{exp_id}/bundle")
    def experiment_bundle(exp_id: str, request: Request):
        svc = S(request)
        store, catalog = svc["store"], svc["catalog"]
        meta = store.get(exp_id)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("experiment.json", json.dumps(meta, indent=2, default=str))
            mp = store.metrics_csv_path(exp_id)
            if os.path.exists(mp):
                z.write(mp, "metrics.csv")
            run = store.run_dir(exp_id)
            if os.path.exists(os.path.join(run, "config.yaml")):
                z.write(os.path.join(run, "config.yaml"), "config.yaml")
            cards = []
            for c in meta["checkpoints"]:
                z.write(c["path"], f"checkpoints/{c['name']}")
                mid = catalog.id_for_path(c["path"])
                if mid:
                    cards.append(catalog.get(mid))
            z.writestr("model_cards.json", json.dumps(cards, indent=2, default=str))
            z.writestr("README.txt",
                       f"NEXUS experiment bundle: {meta['name']} ({exp_id})\n\n"
                       f"Algorithm: {meta['algorithm']}  Seed: {meta['seed']}\n"
                       "Reproduce: copy config.yaml into the project and run\n"
                       "    python main.py --config config.yaml train-dqn     (or train-qlearning)\n"
                       "Checkpoints are PyTorch files; model_cards.json lists their registry ids (SHA-256 based).\n")
        return Response(buf.getvalue(), media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="{exp_id}-bundle.zip"'})
