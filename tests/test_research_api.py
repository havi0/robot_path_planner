"""API integration tests for NEXUS 2.0 research features (isolated data directory)."""
import io
import os
import sys
import time
import warnings
import zipfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
warnings.filterwarnings("ignore")

from fastapi.testclient import TestClient  # noqa: E402

from server.app import create_app  # noqa: E402


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    app = create_app(data_dir=str(tmp_path_factory.mktemp("nexus2")), broadcast_hz=20)
    with TestClient(app) as c:
        yield c


def wait_job(c, job_id, timeout=300):
    end = time.time() + timeout
    while time.time() < end:
        j = next(x for x in c.get("/api/jobs").json() if x["id"] == job_id)
        if j["status"] in ("completed", "failed", "cancelled"):
            return j
        time.sleep(0.25)
    raise AssertionError("job timed out")


@pytest.fixture(scope="module")
def eval_set(client):
    j = client.post("/api/scenario-sets", json={"name": "pytest eval", "types": ["open", "u_trap"], "per_type": 2,
                                                "role": "evaluation"}).json()
    j = wait_job(client, j["id"])
    assert j["status"] == "completed"
    return j["result"]


@pytest.fixture(scope="module")
def dqn_id(client):
    return next(m for m in client.get("/api/models").json() if m["algorithm"] == "dqn")["model_id"]


def test_reference_models_registered_and_compatible(client):
    ms = client.get("/api/models").json()
    assert {m["algorithm"] for m in ms} >= {"dqn", "qlearning"}
    assert all(m["model_id"].startswith("m-") and m["compatibility_issues"] == [] for m in ms)


def test_set_validation_happens_before_queuing(client):
    r = client.post("/api/scenario-sets", json={"name": "x", "types": ["open"], "per_type": 1, "role": "training",
                                                "base_seed": 3_000_000})
    assert r.status_code == 400
    assert client.post("/api/scenario-sets", json={"name": "x", "types": ["nope"], "per_type": 1}).status_code == 400


def test_benchmark_records_traceable_episodes(client, eval_set, dqn_id):
    j = wait_job(client, client.post("/api/runs", json={"set_id": eval_set, "repeats": 2, "label": "pytest",
                                                         "entries": [{"policy": "dqn", "model_id": dqn_id}, {"policy": "astar"}]}).json()["id"])
    assert j["status"] == "completed"
    run_id = j["result"]["run_id"]
    eps = client.get(f"/api/episodes?run_id={run_id}").json()
    assert len(eps) == 2 * 4 * 2
    assert all(e["model_id"] == dqn_id for e in eps if e["policy"] == "dqn")         # provenance
    run = client.get(f"/api/runs/{run_id}").json()
    s = run["results"][f"dqn:{dqn_id}"]["overall"]["success"]
    assert s["n"] == 8 and s["ci_low"] <= s["rate"] <= s["ci_high"]
    assert client.get(f"/api/models/{dqn_id}").json()["benchmarks"][-1]["run_id"] == run_id
    summ = client.get(f"/api/risk/summary?run_id={run_id}").json()
    assert summ["episodes"] == 16 and set(summ["by_type"]) == {"open", "u_trap"}
    sid = summ["scenarios"][0]["scenario_id"]
    m = client.get(f"/api/risk/map?scenario_id={sid}&run_id={run_id}").json()
    assert m["episodes"] == 4 and len(m["layers"]["visits"]) == m["ny"]
    reg = client.post("/api/risk/region", json={"scenario_id": sid, "rect": [0, 0, 100, 100], "run_id": run_id}).json()
    assert reg["passing"] == 4


def test_behaviour_filter_and_episode_counterfactual(client, eval_set, dqn_id):
    eps = client.get(f"/api/episodes?policy=dqn&model_id={dqn_id}").json()
    ep = eps[0]
    for b in ep["behaviors"]:
        assert ep["id"] in [e["id"] for e in client.get(f"/api/episodes?behavior={b}").json()]
    detail = client.get(f"/api/episodes/{ep['id']}/step/2").json()
    assert detail["restoration"]["exact"] and set(detail["q_values"]) == {"forward", "turn_left", "turn_right", "stop"}
    assert detail["recorded_action"] == max(detail["q_values"], key=detail["q_values"].get)   # greedy DQN
    cf = client.post(f"/api/episodes/{ep['id']}/counterfactual", json={"step": 2, "modification": {"type": "shield", "enabled": True}}).json()
    assert cf["restoration"]["exact"] and cf["episode"]["parent"]["episode_id"] == ep["id"]
    assert cf["episode"]["label"] == "COUNTERFACTUAL"
    # the shared prefix is identical to the original recording
    orig = client.get(f"/api/episodes/{ep['id']}").json()
    assert cf["episode"]["steps"]["x"][:3] == orig["steps"]["x"][:3]
    bad = client.post(f"/api/episodes/{ep['id']}/counterfactual", json={"step": 2, "modification": {"type": "teleport"}})
    assert bad.status_code == 400


def test_live_simulation_episodes_replay_exactly(client):
    client.post("/api/sim/policy", json={"policy": "dqn_recovery"})
    client.post("/api/sim/config", json={"seed": 1000002, "density": 0.1})
    client.post("/api/sim/shield", json={"enabled": False})
    client.post("/api/sim/speed", json={"steps_per_second": 400})
    client.post("/api/sim/control", json={"action": "start"})
    for _ in range(200):
        if client.get("/api/sim/state").json()["status"] == "finished":
            break
        time.sleep(0.1)
    live = client.get("/api/episodes?source=live").json()
    assert live, "live episode was not recorded"
    ep = live[0]
    k = max(0, ep["steps"] // 2)
    d = client.get(f"/api/episodes/{ep['id']}/step/{k}").json()
    assert d["restoration"]["exact"], d["restoration"]


def test_scenario_generate_save_load_and_analyze(client):
    g = client.post("/api/scenarios/generate", json={"type": "temporary_blockage", "seed": 3_100_000, "save": True}).json()
    assert g["analysis"]["temporary_blockages"] == 1 and g["split"] == "evaluation"
    assert client.post(f"/api/scenarios/{g['id']}/load").status_code == 200
    st = client.get("/api/sim/state").json()
    assert st["world"]["rects"] and client.get("/api/sim/analyze").json()["route_exists"]
    assert client.post("/api/scenarios/generate", json={"type": "nope"}).status_code == 400


def test_designer_plan_budget_and_evaluate_run(client, eval_set, dqn_id):
    plan = client.post("/api/designs/plan", json={"spec": {"question": "lr?", "parameters": [{"name": "lr", "values": [0.001, 0.0001]}],
                                                           "seeds": 3, "episodes_per_run": 100}}).json()
    assert len(plan["cells"]) == 3 and plan["runs"] == 9 and plan["cells"][0].get("baseline")
    too_big = client.post("/api/designs", json={"spec": {"question": "big", "parameters": [{"name": "lr", "values": [0.001]}],
                                                          "seeds": 10, "episodes_per_run": 5000, "budget_minutes": 1}})
    assert too_big.status_code == 400
    assert client.post("/api/designs/plan", json={"spec": {"question": "x", "parameters": [{"name": "lr", "values": [5]}]}}).status_code == 400
    d = client.post("/api/designs", json={"spec": {"question": "Does recovery help?", "design_type": "evaluate", "seeds": 2,
                                                    "eval_set": eval_set, "models": [{"policy": "dqn", "model_id": dqn_id},
                                                                                     {"policy": "dqn_recovery", "model_id": dqn_id}]}}).json()
    assert wait_job(client, d["job_id"])["status"] == "completed"
    doc = client.get(f"/api/designs/{d['id']}").json()
    assert doc["status"] == "completed" and len(doc["results"]) == 4 and doc["summary"]["conclusion"]


def test_copilot_is_grounded_and_provider_optional(client, dqn_id):
    st = client.get("/api/copilot/status").json()
    assert st["provider"] == "none" and not st["enabled"]
    ep = client.get("/api/episodes?limit=1").json()[0]
    r = client.post("/api/copilot/ask", json={"intent": "episode", "params": {"episode_id": ep["id"]}}).json()
    assert r["narrative"] is None and r["facts"] and all("source" in f for f in r["facts"])
    assert any(ep["outcome"] in f["text"] for f in r["facts"])
    s = client.post("/api/copilot/ask", json={"intent": "summary"}).json()
    assert any("recorded episodes" in f["text"] for f in s["facts"])
    assert client.post("/api/copilot/ask", json={"intent": "concept", "params": {"term": "nope"}}).status_code == 400


def test_model_load_compatibility_and_bundle(client, dqn_id):
    assert client.post(f"/api/models/{dqn_id}/load").status_code == 200
    r = client.post("/api/training/start", json={"name": "bundle", "episodes": 2, "eval_every": 1000000})
    exp_id = r.json()["id"]
    for _ in range(200):
        if client.get("/api/training/state").json()["status"] == "completed":
            break
        time.sleep(0.2)
    names = zipfile.ZipFile(io.BytesIO(client.get(f"/api/experiments/{exp_id}/bundle").content)).namelist()
    assert {"experiment.json", "metrics.csv", "config.yaml", "model_cards.json"} <= set(names)
    assert any(m.get("experiment_id") == exp_id for m in client.get("/api/models").json())    # auto-registered


def test_job_cancellation(client):
    j = client.post("/api/scenario-sets", json={"name": "cancel me", "types": list(client.get("/api/scenarios/types").json()),
                                                "per_type": 20, "role": "evaluation"}).json()
    client.post(f"/api/jobs/{j['id']}/cancel")
    assert wait_job(client, j["id"])["status"] == "cancelled"
