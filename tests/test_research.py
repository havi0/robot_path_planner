"""Tests for NEXUS 2.0: analyzer, scenarios, behaviour rules, exact counterfactuals,
curriculum, model registry, statistics and the research API."""
import copy
import json
import os
import shutil
import sys
import time
import warnings

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
warnings.filterwarnings("ignore")

from config import load_config  # noqa: E402
from environment.world import World  # noqa: E402
from evaluation.behavior import RULES, profile_episode  # noqa: E402
from evaluation.evaluate import load_dqn  # noqa: E402
from evaluation.recorder import record_episode, resimulate_to, run_counterfactual  # noqa: E402
from scenarios.analyzer import analyze_world  # noqa: E402
from scenarios.curriculum import Curriculum  # noqa: E402
from scenarios.generator import EVAL_SEED_OFFSET, SCENARIO_TYPES, generate_scenario  # noqa: E402
from scenarios.io import world_from_dict, world_to_dict  # noqa: E402
from server.catalog import ModelCatalog, compatibility_issues, interface_spec  # noqa: E402
from server.research import mean_ci, two_proportion_test, ResearchService  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DQN = os.path.join(ROOT, "models", "dqn.pt")


@pytest.fixture(scope="module")
def cfg():
    return load_config()


@pytest.fixture(scope="module")
def dqn():
    return load_dqn(DQN)


# ---------------------------------------------------------------- analyzer
def test_analyzer_detects_narrow_gap_and_not_open_space(cfg):
    gap = World(6, 6, [[2.95, 0, 3.05, 2.75], [2.95, 3.25, 3.05, 6]], (1, 3, 0), (5, 3))      # 0.5 m gap
    a = analyze_world(gap, cfg.robot.radius)
    assert a["route_exists"] and a["narrow_on_route"] == 1
    open_map = World(6, 6, [[2.5, 0.5, 3.0, 1.0]], (1, 3, 0), (5, 3))
    assert analyze_world(open_map, cfg.robot.radius)["narrow_on_route"] == 0


def test_analyzer_local_minimum_trap_and_unsolvable(cfg):
    u = World(6, 6, [[3.5, 2.0, 3.65, 4.0], [2.5, 2.0, 3.65, 2.15], [2.5, 3.85, 3.65, 4.0]], (0.8, 3, 0), (5.2, 3))
    a = analyze_world(u, cfg.robot.radius)
    assert a["local_minimum_trap"] and a["route_exists"]
    wall = World(6, 6, [[2.9, 0, 3.1, 6]], (1, 3, 0), (5, 3))
    b = analyze_world(wall, cfg.robot.radius)
    assert not b["route_exists"] and b["free_regions"] == 2 and b["difficulty"]["band"] == "unsolvable"


def test_difficulty_components_are_inspectable(cfg):
    w, a, _ = generate_scenario("narrow_passage", EVAL_SEED_OFFSET + 1)
    d = a["difficulty"]
    assert set(d["components"]) == set(d["weights"]) and 0 <= d["score"] <= 100
    assert abs(sum(d["weights"].values()) - 1.0) < 1e-9


@pytest.mark.parametrize("kind", list(SCENARIO_TYPES))
def test_every_scenario_type_is_solvable(kind, cfg):
    w, a, _ = generate_scenario(kind, EVAL_SEED_OFFSET + 42)
    assert a["route_exists"]
    assert not w.collides(*w.start[:2], cfg.robot.radius)
    w2 = world_from_dict(world_to_dict(w))                      # serialisation round-trip
    assert np.array_equal(w2.static_rects, w.static_rects) and np.array_equal(w2.timed, w.timed)  # lossless


def test_scenarios_are_reproducible_from_seed():
    a = world_to_dict(generate_scenario("u_trap", 123)[0])
    b = world_to_dict(generate_scenario("u_trap", 123)[0])
    assert a == b


def test_timed_blockage_disappears():
    w = World(6, 6, [], (1, 3, 0), (5, 3), timed=[[2.9, 2.5, 3.1, 3.5, 0.0, 2.0]])
    assert w.collides(3.0, 3.0, 0.1)
    for _ in range(9):
        w.step_movers(0.25)
    assert not w.collides(3.0, 3.0, 0.1)


# ---------------------------------------------------------------- behaviour rules
def _steps(actions, xs=None, ys=None, dist=None):
    n = len(actions)
    xs = xs or [0.0] * (n + 1)
    ys = ys or [0.0] * (n + 1)
    return {"action": actions, "x": xs, "y": ys, "dist": dist or [2.0] * (n + 1), "min_range": [1.0] * (n + 1)}


def _label(res, key):
    return next((l for l in res["labels"] if l["label"] == key), None)


def test_oscillation_detected_and_uncertain_band():
    r = profile_episode(_steps(["turn_left", "turn_right"] * 6), "timeout")
    assert _label(r, "oscillation")["status"] == "detected"
    r = profile_episode(_steps(["turn_left", "turn_right", "turn_left", "turn_right", "turn_left"] + ["forward"] * 20,
                               xs=[0.1 * i for i in range(26)]), "success")
    lab = _label(r, "oscillation")
    assert lab["status"] == "uncertain" and lab["value"] == RULES["oscillation"]["uncertain"]


def test_repeated_turning_stagnation_and_idle_stop():
    r = profile_episode(_steps(["turn_left"] * 25 + ["stop"] * 12), "timeout")
    assert _label(r, "repeated_turning")["status"] == "detected"
    assert _label(r, "stagnation")["status"] == "detected"
    assert _label(r, "idle_stop")["status"] == "detected"


def test_progressing_episode_has_no_loop_labels():
    n = 40
    xs = [0.075 * i for i in range(n + 1)]
    r = profile_episode(_steps(["forward"] * n, xs=xs, dist=[3 - x for x in xs]), "success", reference_length=3.0)
    assert r["detected"] == [] and r["outcome"] == "success"


def test_approach_and_retreat_counts():
    d = [3.0, 2.0, 1.0, 1.6, 0.8, 1.5, 0.5]
    r = profile_episode(_steps(["forward"] * 6, xs=[i * 0.5 for i in range(7)], dist=d), "timeout")
    assert _label(r, "approach_retreat")["value"] == 2


# ---------------------------------------------------------------- exact counterfactuals
def test_resimulation_is_exact_with_noise_and_moving_obstacles(cfg, dqn):
    w, _, _ = generate_scenario("moving", EVAL_SEED_OFFSET + 7)
    ep = record_episode(cfg, world_to_dict(w), "dqn_recovery", {"sensor_noise": 0.03, "motion_noise": 0.1}, 99,
                        dqn[0], dqn[1], source="test")
    k = len(ep["steps"]["action"]) // 2
    _, rest = resimulate_to(cfg, ep, k, dqn[0], dqn[1])
    assert rest["exact"] and rest["max_prefix_deviation_m"] == 0.0
    runner, rest2 = run_counterfactual(cfg, ep, k, {"type": "sensor_noise", "std": 0.03}, dqn[0], dqn[1])  # no-op change
    assert runner.steps["x"] == ep["steps"]["x"] and runner.outcome == ep["outcome"]


def test_counterfactual_detects_non_reproducible_recording(cfg, dqn):
    w, _, _ = generate_scenario("open", EVAL_SEED_OFFSET + 3)
    ep = record_episode(cfg, world_to_dict(w), "dqn", {}, 5, dqn[0], dqn[1], source="test")
    tampered = copy.deepcopy(ep)
    tampered["seed"] = 6                                   # recording no longer matches the inputs
    tampered["conditions"]["motion_noise"] = 0.2
    _, rest = resimulate_to(cfg, tampered, min(10, len(ep["steps"]["action"]) - 1), dqn[0], dqn[1])
    assert not rest["exact"] and "APPROXIMATE" in rest["note"]


def test_counterfactual_rejects_obstacle_on_robot(cfg, dqn):
    w, _, _ = generate_scenario("open", EVAL_SEED_OFFSET + 4)
    ep = record_episode(cfg, world_to_dict(w), "dqn", {}, 1, dqn[0], dqn[1], source="test")
    x, y = ep["steps"]["x"][3], ep["steps"]["y"][3]
    with pytest.raises(ValueError):
        run_counterfactual(cfg, ep, 3, {"type": "add_obstacle", "rect": [x - 0.1, y - 0.1, x + 0.1, y + 0.1]}, dqn[0], dqn[1])


# ---------------------------------------------------------------- curriculum
def test_curriculum_promotes_only_when_criterion_met():
    cur = Curriculum(["open"], threshold=0.8, window=10, min_episodes=10)
    for i in range(10):
        cur.record("success" if i % 2 else "collision", i)   # 50% < 80%
    assert cur.level == 0
    promoted_at = None
    for i in range(10):
        if cur.record("success", 10 + i):
            promoted_at = 10 + i
    # rolling window first reaches 8/10 = 80% at episode 14 (5 alternating + 5 successes)
    assert promoted_at == 14 and cur.level == 1 and cur.history[0]["success"] >= 0.8
    assert len(cur.outcomes) == 5                                   # counting restarts at the new level


def test_curriculum_rejects_invalid_criteria():
    with pytest.raises(ValueError):
        Curriculum(["open"], threshold=1.5)
    with pytest.raises(ValueError):
        Curriculum(["nonexistent"])


# ---------------------------------------------------------------- registry & stats
def test_model_id_is_content_hash_and_compatibility(tmp_path, cfg):
    cat = ModelCatalog(str(tmp_path / "catalog.json"))
    a = cat.register(DQN)
    copy_path = tmp_path / "copy.pt"
    shutil.copy(DQN, copy_path)
    b = cat.register(str(copy_path))
    assert a["model_id"] == b["model_id"]                          # same weights -> same id
    assert compatibility_issues(a["interface"], cfg) == []
    spec = json.loads(json.dumps(a["interface"]))
    spec["sensor"]["num_beams"] = 36
    spec["actions"] = {"forward": [0.3, 0], "turn_left": [0, 1]}
    issues = compatibility_issues(spec, cfg)
    assert any("num_beams" in i for i in issues) and any("action set" in i for i in issues)
    assert interface_spec(dict(cfg))["sensor"]["num_beams"] == cfg.sensor.num_beams


def test_statistics_refuse_to_crown_a_winner_on_overlap():
    plan = {"metric": "success_rate", "cells": [{"cell_id": "c0", "purpose": "base", "params": {}, "baseline": True},
                                                {"cell_id": "c1", "purpose": "x", "params": {}}]}
    res = [{"cell_id": "c0", "metrics": {"success_rate": v}} for v in (0.6, 0.7)] + \
          [{"cell_id": "c1", "metrics": {"success_rate": v}} for v in (0.65, 0.72)]
    s = ResearchService.summarize_design(None, plan, res)
    assert s["winner"] is None and "No configuration is clearly best" in s["conclusion"]
    assert "no significant difference" in s["comparisons"][0]["verdict"]
    m = mean_ci([0.5, 0.6, 0.7])
    assert m["ci_low"] < 0.6 < m["ci_high"]
    assert two_proportion_test(50, 100, 52, 100) > 0.5 and two_proportion_test(90, 100, 40, 100) < 0.001
