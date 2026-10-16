"""Integration tests for the NEXUS studio backend (FastAPI + simulation + training + safety)."""
import json
import os
import sys
import time
import warnings

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
warnings.filterwarnings("ignore")

from fastapi.testclient import TestClient  # noqa: E402

from server.app import create_app  # noqa: E402


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    app = create_app(data_dir=str(tmp_path_factory.mktemp("nexus")), broadcast_hz=20)
    with TestClient(app) as c:
        yield c


def wait_for(fn, timeout=60, interval=0.2):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(interval)
    raise AssertionError("timed out")


def test_health_and_full_state(client):
    h = client.get("/api/health").json()
    assert h["status"] == "ok"
    s = client.get("/api/state").json()
    assert s["operating_mode"] == "simulation"
    assert s["sim"]["world"]["width"] > 0 and s["hardware"]["status"] == "disconnected"


def test_sim_step_changes_state_and_controls_validate(client):
    client.post("/api/sim/control", json={"action": "reset"})
    s0 = client.get("/api/sim/state").json()
    r = client.post("/api/sim/control", json={"action": "step"})
    assert r.status_code == 200
    s1 = r.json()
    assert s1["telemetry"]["steps"] == s0["telemetry"]["steps"] + 1 and s1["status"] == "paused"
    assert len(s1["trail"]) == len(s0["trail"]) + 1
    client.post("/api/sim/control", json={"action": "resume"})
    assert client.post("/api/sim/control", json={"action": "step"}).status_code == 400   # cannot step while running
    client.post("/api/sim/control", json={"action": "reset"})
    assert client.post("/api/sim/control", json={"action": "fly"}).status_code == 400


def test_sim_runs_to_an_outcome(client):
    client.post("/api/sim/policy", json={"policy": "astar"})
    client.post("/api/sim/speed", json={"steps_per_second": 400})
    client.post("/api/sim/control", json={"action": "start"})
    s = wait_for(lambda: (lambda x: x if x["status"] == "finished" else None)(client.get("/api/sim/state").json()), 30)
    assert s["outcome"] == "success" and s["analysis"]["traveled"] > 0 and s["analysis"]["plan"]["found"]
    client.post("/api/sim/policy", json={"policy": "dqn_recovery"})


def test_map_editing_and_validation(client):
    s = client.get("/api/sim/state").json()
    n = len(s["world"]["rects"])
    assert client.post("/api/sim/goal", json={"x": -1, "y": 1}).status_code == 400
    gx, gy = s["world"]["goal"]
    assert client.post("/api/sim/obstacles", json={"action": "add", "rect": [gx - 0.3, gy - 0.3, gx + 0.3, gy + 0.3]}).status_code == 400
    # add a small box in free space next to an existing configuration, then remove it again
    sx, sy = s["world"]["start"][:2]
    box = [sx + 0.35, sy - 0.05, sx + 0.45, sy + 0.05] if sx < s["world"]["width"] - 0.6 else [sx - 0.45, sy - 0.05, sx - 0.35, sy + 0.05]
    assert client.post("/api/sim/obstacles", json={"action": "add", "rect": box}).status_code == 200
    assert len(client.get("/api/sim/state").json()["world"]["rects"]) == n + 1
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    assert client.post("/api/sim/obstacles", json={"action": "remove", "x": cx, "y": cy}).status_code == 200
    assert len(client.get("/api/sim/state").json()["world"]["rects"]) == n
    assert client.post("/api/sim/config", json={"width": 50}).status_code == 400
    r = client.post("/api/sim/config", json={"num_obstacles": 4, "seed": 1000321})
    assert r.status_code == 200 and r.json()["config"]["seed"] == 1000321 and len(r.json()["world"]["rects"]) == 4
    client.post("/api/sim/config", json={"num_obstacles": None, "density": 0.15, "seed": 1000000})


def test_training_lifecycle_and_checkpoints(client):
    r = client.post("/api/training/start", json={"name": "pytest dqn", "algorithm": "dqn", "episodes": 3, "eval_every": 1000000})
    assert r.status_code == 200
    exp_id = r.json()["id"]
    assert client.post("/api/training/start", json={"name": "second", "episodes": 3}).status_code == 400
    t = wait_for(lambda: (lambda x: x if x["status"] in ("completed", "failed") else None)(client.get("/api/training/state").json()), 120)
    assert t["status"] == "completed" and t["episode"] == 3
    exp = client.get(f"/api/experiments/{exp_id}").json()
    names = {c["name"] for c in exp["checkpoints"]}
    assert {"last.pt", "best.pt"} <= names
    assert len(client.get(f"/api/experiments/{exp_id}/metrics").json()) == 3
    assert client.post("/api/checkpoints/load", json={"experiment_id": exp_id}).status_code == 200
    csv = client.get(f"/api/experiments/{exp_id}/export?format=csv")
    assert csv.status_code == 200 and csv.text.startswith("episode,")
    js = client.get(f"/api/experiments/{exp_id}/export?format=json").json()
    assert js["experiment"]["id"] == exp_id and len(js["metrics"]) == 3
    assert client.delete(f"/api/experiments/{exp_id}").status_code == 200


def test_training_pause_resume_stop_keeps_checkpoint(client):
    r = client.post("/api/training/start", json={"name": "pytest q", "algorithm": "qlearning", "episodes": 100000})
    exp_id = r.json()["id"]
    wait_for(lambda: client.get("/api/training/state").json()["episode"] >= 3, 60)
    assert client.post("/api/training/pause").json()["status"] == "paused"
    time.sleep(0.5)
    e1 = client.get("/api/training/state").json()["episode"]
    time.sleep(0.8)
    assert client.get("/api/training/state").json()["episode"] == e1      # really paused
    assert client.post("/api/training/resume").json()["status"] == "running"
    client.post("/api/training/stop")
    wait_for(lambda: client.get("/api/training/state").json()["status"] == "stopped", 60)
    names = {c["name"] for c in client.get(f"/api/experiments/{exp_id}").json()["checkpoints"]}
    assert "last.pt" in names
    assert client.post("/api/training/stop").status_code == 400


def test_invalid_training_config_rejected(client):
    assert client.post("/api/training/start", json={"name": "x", "lr": 5.0}).status_code == 400
    assert client.post("/api/training/start", json={"name": "x", "eps_start": 0.1, "eps_end": 0.5}).status_code == 400
    assert client.post("/api/training/start", json={"name": "  "}).status_code == 400


def test_reference_experiments_are_read_only(client):
    ids = [e["id"] for e in client.get("/api/experiments").json() if e["imported"]]
    for i in ids:
        assert client.delete(f"/api/experiments/{i}").status_code == 409


def test_planner_compare_produces_valid_paths(client):
    r = client.post("/api/planner/compare", json={"algorithms": ["astar", "dijkstra"], "source": "random", "seed": 1000005, "density": 0.15, "trials": 3})
    assert r.status_code == 200
    d = r.json()
    for res in d["results"]:
        assert res["success"] and res["collisions"] == 0
        assert res["path_length"] >= d["results"][0]["reference_length"] * 0.95
        assert res["planned_path"][0] and res["nodes_expanded"] > 0
    assert d["trials"]["astar"]["success_rate"] >= 0.66
    assert client.post("/api/planner/compare", json={"algorithms": []}).status_code == 400


def test_hardware_mode_is_safe_without_robot(client):
    hw = client.get("/api/hardware/state").json()
    assert hw["status"] == "disconnected" and not hw["armed"]
    assert client.post("/api/hardware/arm", json={"confirmation": "ARM"}).status_code == 400       # no robot, sim mode
    if not hw["ros2_available"]:
        r = client.post("/api/hardware/connect", json={"backend": "ros2"})
        assert r.status_code == 400 and "ROS 2" in r.json()["detail"]
        assert client.get("/api/hardware/state").json()["status"] != "connected"


def test_hardware_loopback_arming_and_estop(client):
    assert client.post("/api/hardware/connect", json={"backend": "loopback"}).json()["simulated"] is True
    assert client.post("/api/hardware/arm", json={"confirmation": "ARM"}).status_code == 400       # still simulation mode
    client.post("/api/mode", json={"mode": "hardware"})
    assert client.post("/api/hardware/manual", json={"v": 0.2, "w": 0}).status_code == 400          # not armed
    assert client.post("/api/hardware/arm", json={"confirmation": "yes"}).status_code == 400        # wrong phrase
    assert client.post("/api/hardware/arm", json={"confirmation": "ARM"}).json()["armed"] is True
    assert client.post("/api/hardware/deploy", json={}).json()["mode"] == "autonomous"
    time.sleep(1.0)
    st = client.post("/api/hardware/estop", json={"engaged": True}).json()
    assert st["estop"] and not st["armed"] and st["mode"] == "idle"
    assert client.post("/api/hardware/arm", json={"confirmation": "ARM"}).status_code == 400       # e-stop latched
    client.post("/api/hardware/estop", json={"engaged": False})
    client.post("/api/hardware/arm", json={"confirmation": "ARM"})
    client.post("/api/mode", json={"mode": "simulation"})                                          # leaving hardware mode disarms
    assert client.get("/api/hardware/state").json()["armed"] is False
    client.post("/api/hardware/disconnect")


def test_websocket_streams_backend_state(client):
    with client.websocket_connect("/ws") as ws:
        hello = json.loads(ws.receive_text())
        assert hello["type"] == "hello"
        tick = json.loads(ws.receive_text())
        assert tick["type"] == "tick" and "sim" in tick and "training" in tick and "hardware" in tick
