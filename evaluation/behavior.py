"""Navigation behaviour profiler: explicit, testable rules over recorded telemetry.

Every rule has a DETECT threshold and an UNCERTAIN band just below it. A label is
reported as "detected" only when the measured value clears the threshold; values
in the band are reported as "uncertain"; the measured value and the threshold
are always returned so each classification can be verified by hand.
"""
import math

import numpy as np

TURN_DEG_PER_ACTION = 17.2   # 1.2 rad/s * 0.25 s (informational; rules use counts)

RULES = {
    "repeated_turning": {"desc": "Longest run of consecutive same-direction turns (actions)",
                         "detect": 21, "uncertain": 16},          # 21 x ~17 deg = a full spin in place
    "oscillation": {"desc": "Max left<->right reversals within any 20-action window",
                    "detect": 6, "uncertain": 4, "window": 20},
    "stagnation": {"desc": "Min displacement over any 12-step (3 s) window (m) - lower is worse",
                   "detect": 0.05, "uncertain": 0.08, "window": 12},
    "excessive_detour": {"desc": "Driven length / shortest feasible path (successful episodes)",
                         "detect": 1.5, "uncertain": 1.35},
    "approach_retreat": {"desc": "Times the robot got closer then moved >= rise metres away again",
                         "detect": 2, "uncertain": 1, "rise": 0.5},
    "idle_stop": {"desc": "Longest run of consecutive 'stop' actions",
                  "detect": 10, "uncertain": 6},
    "near_miss": {"desc": "Minimum clearance between robot surface and obstacles (m) - lower is worse",
                  "detect": 0.03, "uncertain": 0.06},
}

OUTCOME_LABELS = {"success": "Successful navigation", "collision": "Collision", "timeout": "Timeout"}
LABEL_NAMES = {
    "repeated_turning": "Repeated turning", "oscillation": "Oscillation between actions",
    "stagnation": "Stagnation", "excessive_detour": "Excessive detour",
    "approach_retreat": "Approach-and-retreat", "idle_stop": "Idle stopping", "near_miss": "Near miss",
}


def _status(value, rule, higher_is_worse=True):
    d, u = rule["detect"], rule["uncertain"]
    if value is None:
        return None
    if higher_is_worse:
        return "detected" if value >= d else "uncertain" if value >= u else None
    return "detected" if value <= d else "uncertain" if value <= u else None


def _runs(seq, pred):
    """[(start, end_exclusive)] of maximal runs where pred(item) is true."""
    out, start = [], None
    for i, v in enumerate(seq):
        if pred(v):
            start = i if start is None else start
        elif start is not None:
            out.append((start, i)); start = None
    if start is not None:
        out.append((start, len(seq)))
    return out


def profile_episode(steps, outcome, reference_length=None, robot_radius=0.15):
    """steps: dict of equal-length lists; index k = state BEFORE action k is applied for
    x/y/theta/dist (length n+1), and the action/reward taken at step k (length n)."""
    actions = steps.get("action", [])
    xs, ys = np.asarray(steps["x"]), np.asarray(steps["y"])
    dist = np.asarray(steps.get("dist", []), dtype=float)
    n = len(actions)
    labels = []

    def add(key, value, status, segments, evidence):
        if status:
            labels.append({"label": key, "name": LABEL_NAMES[key], "status": status, "value": value,
                           "threshold": RULES[key]["detect"], "uncertain_from": RULES[key]["uncertain"],
                           "rule": RULES[key]["desc"], "segments": segments, "evidence": evidence})

    # repeated turning
    best, seg = 0, None
    for name in ("turn_left", "turn_right"):
        for a, b in _runs(actions, lambda v, nm=name: v == nm):
            if b - a > best:
                best, seg = b - a, (a, b)
    add("repeated_turning", best, _status(best, RULES["repeated_turning"]), [list(seg)] if seg else [],
        {"longest_turn_run": best, "approx_rotation_deg": round(best * TURN_DEG_PER_ACTION)})

    # oscillation: reversals turn_left<->turn_right
    rev = [i for i in range(1, n) if {actions[i], actions[i - 1]} == {"turn_left", "turn_right"}]
    w = RULES["oscillation"]["window"]
    best, seg = 0, None
    for i in rev:
        c = sum(1 for j in rev if i <= j < i + w)
        if c > best:
            best, seg = c, (i, min(n, i + w))
    add("oscillation", best, _status(best, RULES["oscillation"]), [list(seg)] if seg else [],
        {"total_reversals": len(rev), "max_reversals_in_window": best})

    # stagnation
    w = RULES["stagnation"]["window"]
    min_disp, seg, stuck_segments = None, None, []
    if len(xs) > w:
        disp = np.hypot(xs[w:] - xs[:-w], ys[w:] - ys[:-w])
        i = int(disp.argmin())
        min_disp, seg = float(disp[i]), (i, i + w)
        for a, b in _runs(list(disp < RULES["stagnation"]["detect"]), bool):
            stuck_segments.append([a, min(n, b + w)])
    st = _status(min_disp, RULES["stagnation"], higher_is_worse=False)
    add("stagnation", None if min_disp is None else round(min_disp, 4), st,
        stuck_segments if st == "detected" else ([list(seg)] if seg else []),
        {"min_displacement_m": None if min_disp is None else round(min_disp, 4), "window_steps": w})

    # excessive detour (only meaningful for successful episodes)
    path_len = float(np.hypot(np.diff(xs), np.diff(ys)).sum()) if len(xs) > 1 else 0.0
    ratio = path_len / reference_length if (outcome == "success" and reference_length) else None
    add("excessive_detour", None if ratio is None else round(ratio, 3), _status(ratio, RULES["excessive_detour"]), [],
        {"path_length_m": round(path_len, 3), "reference_m": reference_length})

    # approach-and-retreat on distance to goal
    rise = RULES["approach_retreat"]["rise"]
    count, segs, low, low_i = 0, [], None, 0
    for i, d in enumerate(dist):
        if low is None or d < low:
            low, low_i = d, i
        elif d - low >= rise:
            count += 1
            segs.append([low_i, i])
            low, low_i = d, i                     # restart after a retreat
    add("approach_retreat", count, _status(count, RULES["approach_retreat"]), segs,
        {"retreats": count, "rise_threshold_m": rise})

    # idle stopping
    runs = _runs(actions, lambda v: v == "stop")
    longest = max((b - a for a, b in runs), default=0)
    seg = max(runs, key=lambda r: r[1] - r[0]) if runs else None
    add("idle_stop", longest, _status(longest, RULES["idle_stop"]), [list(seg)] if seg else [], {"longest_stop_run": longest})

    # near miss (not a collision)
    mr = [v for v in steps.get("min_range", []) if v is not None]
    clearance = (min(mr) - robot_radius) if mr else None
    if outcome != "collision":
        i = int(np.argmin(mr)) if mr else 0
        add("near_miss", None if clearance is None else round(clearance, 4),
            _status(clearance, RULES["near_miss"], higher_is_worse=False), [[max(0, i - 1), i + 1]] if mr else [],
            {"min_clearance_m": None if clearance is None else round(clearance, 4)})

    detected = [l["label"] for l in labels if l["status"] == "detected"]
    uncertain = [l["label"] for l in labels if l["status"] == "uncertain"]
    return {"outcome": outcome, "outcome_name": OUTCOME_LABELS.get(outcome, outcome), "labels": labels,
            "detected": detected, "uncertain": uncertain, "rules_version": 1,
            "metrics": {"path_length": round(path_len, 3), "min_clearance": None if clearance is None else round(clearance, 4),
                        "steps": n}}
