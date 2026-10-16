"""Map difficulty & coverage analysis (purely geometric, computed before training).

All metrics are measurable properties of the map under an explicit assumption:
a circular robot of radius r moving on a grid of `resolution` metres. The
"geometric difficulty" score is a transparent weighted sum of these metrics; it
is NOT a measure of how hard the map is for a learned policy (that has to be
measured by running the policy - see the benchmark / risk explorer).
"""
import math

import numpy as np
from scipy import ndimage

from baselines.grid_planners import grid_search, smooth_path

GEOMETRIC_WEIGHTS = {
    "tortuosity": 0.20,        # shortest path / straight-line distance
    "local_minimum": 0.20,     # greedy goal-seeking gets trapped (U-traps, dead ends)
    "density": 0.10,           # obstacle area fraction
    "narrow_on_route": 0.15,   # narrow corridors the shortest route must traverse
    "route_clearance": 0.10,   # how close the shortest route passes to obstacles
    "heading": 0.05,           # initial heading vs. direction of the route
    "single_route": 0.05,      # 1 if no alternative route was found
    "dynamic": 0.10,           # moving obstacles + temporary blockages
    "goal_clearance": 0.05,    # goal tucked close to obstacles
}


def _cell(p, res, shape):
    return (min(max(int(p[1] / res), 0), shape[0] - 1), min(max(int(p[0] / res), 0), shape[1] - 1))


def _cells_to_xy(cells, res):
    return [((c + 0.5) * res, (r + 0.5) * res) for r, c in cells]


def _length(pts):
    return float(sum(math.dist(a, b) for a, b in zip(pts, pts[1:])))


def clearance_map(world, res):
    """Distance (m) from each cell centre to the nearest obstacle surface or wall."""
    nx, ny = int(math.ceil(world.width / res)), int(math.ceil(world.height / res))
    xs, ys = (np.arange(nx) + 0.5) * res, (np.arange(ny) + 0.5) * res
    X, Y = np.meshgrid(xs, ys)
    d = np.minimum.reduce([X, Y, world.width - X, world.height - Y])
    for xmin, ymin, xmax, ymax in world.rects:
        cx, cy = np.clip(X, xmin, xmax), np.clip(Y, ymin, ymax)
        d = np.minimum(d, np.hypot(cx - X, cy - Y))
    return d


def analyze_world(world, robot_radius, resolution=0.05, narrow_margin=0.15, alt_ratio=1.5):
    res, r = resolution, robot_radius
    clear = clearance_map(world, res)
    free = clear > r + 0.02                     # robot centre can stand here (2 cm margin)
    total = free.size
    obstacle_density = float(_covered_fraction(world, res))

    labels, n_regions = ndimage.label(free)
    s_cell, g_cell = _cell(world.start, res, free.shape), _cell(world.goal, res, free.shape)
    start_region = labels[s_cell]
    reachable = (labels == start_region) if start_region > 0 else np.zeros_like(free)
    route_exists = bool(start_region > 0 and labels[g_cell] == start_region)

    out = {
        "assumptions": {"robot_radius": r, "resolution": res, "safety_margin": 0.02, "narrow_margin": narrow_margin},
        "width": world.width, "height": world.height,
        "obstacle_density": obstacle_density,
        "static_obstacles": int(len(world.static_rects)),
        "moving_obstacles": int(len(world.movers)),
        "temporary_blockages": int(len(world.timed)),
        "free_space_ratio": float(free.sum() / total),
        "reachable_free_ratio": float(reachable.sum() / max(free.sum(), 1)),
        "free_regions": int(n_regions),
        "route_exists": route_exists,
        "start_goal_distance": float(math.dist(world.start[:2], world.goal)),
        "start_clearance": float(clear[s_cell] - r),
        "goal_clearance": float(clear[g_cell] - r),
    }

    # narrow passages: free cells whose corridor WIDTH (obstacle-to-obstacle distance through
    # the cell, horizontally or vertically) is below 2*(r + narrow_margin). Passing close to a
    # single obstacle in open space does not count, a gap or corridor does.
    width = _corridor_width(clear < res / 2, res)
    narrow = free & (width < 2 * (r + narrow_margin))
    nlab, n_narrow = ndimage.label(narrow, structure=np.ones((3, 3)))
    sizes = ndimage.sum(narrow, nlab, range(1, n_narrow + 1)) if n_narrow else []
    big = {i + 1 for i, sz in enumerate(sizes) if sz >= 3}
    out["narrow_regions"] = len(big)

    out["local_minimum_trap"], out["greedy_stuck_distance"] = _greedy_trap(free, s_cell, g_cell, res)

    if not route_exists:
        out.update({"shortest_path": None, "path": [], "tortuosity": None, "route_min_clearance": None,
                    "narrow_on_route": None, "route_alternatives": 0, "start_heading_error_deg": None})
        out["difficulty"] = geometric_difficulty(out)
        return out

    occ = ~free
    cells, _, _ = grid_search(occ, s_cell, g_cell, 1.0)
    smooth = smooth_path(occ, cells)
    pts = [tuple(world.start[:2])] + _cells_to_xy(smooth[1:-1], res) + [tuple(world.goal)]
    length = _length(pts)
    on_route = {nlab[c] for c in cells if nlab[c] in big}
    route_clear = float(min(clear[c] for c in cells) - r)
    first = pts[1] if len(pts) > 1 else world.goal
    head = math.degrees(abs((math.atan2(first[1] - world.start[1], first[0] - world.start[0]) - world.start[2] + math.pi)
                            % (2 * math.pi) - math.pi))

    # alternative routes: repeatedly block a corridor around the found route and replan;
    # count routes no longer than alt_ratio x shortest (an estimate, not an exact homotopy count)
    alts, blocked = 1, occ.copy()
    rad = max(2, int(0.35 / res))
    cur = cells
    for _ in range(4):
        mask = np.zeros_like(blocked)
        for (rr, cc) in cur[len(cur) // 6: len(cur) - len(cur) // 6]:
            mask[max(0, rr - rad): rr + rad + 1, max(0, cc - rad): cc + rad + 1] = True
        blocked |= mask
        blocked[s_cell] = blocked[g_cell] = False
        nxt, _, _ = grid_search(blocked, s_cell, g_cell, 1.0)
        if nxt is None:
            break
        alt_len = _length([tuple(world.start[:2])] + _cells_to_xy(smooth_path(blocked, nxt)[1:-1], res) + [tuple(world.goal)])
        if alt_len > alt_ratio * length:
            break
        alts += 1
        cur = nxt

    out.update({"shortest_path": length, "path": [[round(x, 3), round(y, 3)] for x, y in pts],
                "tortuosity": length / max(out["start_goal_distance"], 1e-6),
                "route_min_clearance": route_clear, "narrow_on_route": len(on_route),
                "route_alternatives": alts, "start_heading_error_deg": head})
    out["difficulty"] = geometric_difficulty(out)
    return out


def _corridor_width(obstacle, res):
    """Per cell: min(horizontal, vertical) free span between obstacles / arena walls (m)."""
    def span(axis):
        o = obstacle if axis == 1 else obstacle.T
        n = o.shape[1]
        idx = np.broadcast_to(np.arange(n), o.shape)
        left = np.maximum.accumulate(np.where(o, idx, -1), axis=1)
        right = np.flip(np.minimum.accumulate(np.flip(np.where(o, idx, n), axis=1), axis=1), axis=1)
        w = (right - left - 1) * res
        return w if axis == 1 else w.T
    return np.minimum(span(1), span(0))


def _greedy_trap(free, s, g, res):
    """Follow strictly decreasing straight-line distance to the goal over free cells
    (what a purely greedy reactive controller would do). Returns (trapped, remaining m)."""
    cur = s
    dist = lambda c: math.hypot(c[0] - g[0], c[1] - g[1])
    for _ in range(free.size):
        if cur == g or dist(cur) <= 1.5:
            return False, 0.0
        best, bd = None, dist(cur)
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                n = (cur[0] + dr, cur[1] + dc)
                if (dr or dc) and 0 <= n[0] < free.shape[0] and 0 <= n[1] < free.shape[1] and free[n] and dist(n) < bd:
                    best, bd = n, dist(n)
        if best is None:
            return True, round(dist(cur) * res, 3)
        cur = best
    return True, round(dist(cur) * res, 3)


def _covered_fraction(world, res):
    nx, ny = int(math.ceil(world.width / res)), int(math.ceil(world.height / res))
    xs, ys = (np.arange(nx) + 0.5) * res, (np.arange(ny) + 0.5) * res
    X, Y = np.meshgrid(xs, ys)
    occ = np.zeros(X.shape, dtype=bool)
    for xmin, ymin, xmax, ymax in world.rects:
        occ |= (X >= xmin) & (X <= xmax) & (Y >= ymin) & (Y <= ymax)
    return occ.mean()


def geometric_difficulty(a):
    """0-100 weighted sum of normalised geometric metrics. Components are returned so the
    score is fully inspectable."""
    def n(v, lo, hi):
        return 0.0 if v is None else float(np.clip((v - lo) / (hi - lo), 0, 1))
    if not a.get("route_exists"):
        return {"score": None, "band": "unsolvable", "components": {}, "weights": GEOMETRIC_WEIGHTS}
    comp = {
        "tortuosity": n(a["tortuosity"], 1.0, 2.0),
        "local_minimum": n(a["greedy_stuck_distance"], 0.0, 1.5) if a["local_minimum_trap"] else 0.0,
        "density": n(a["obstacle_density"], 0.0, 0.35),
        "narrow_on_route": n(a["narrow_on_route"], 0, 3),
        "route_clearance": 1.0 - n(a["route_min_clearance"], 0.0, 0.4),
        "heading": n(a["start_heading_error_deg"], 0, 180),
        "single_route": 1.0 if a["route_alternatives"] <= 1 else 0.0,
        "dynamic": n(a["moving_obstacles"] + 2 * a["temporary_blockages"], 0, 5),
        "goal_clearance": 1.0 - n(a["goal_clearance"], 0.0, 0.5),
    }
    score = 100 * sum(GEOMETRIC_WEIGHTS[k] * v for k, v in comp.items())
    band = "easy" if score < 30 else "moderate" if score < 50 else "hard" if score < 70 else "extreme"
    return {"score": round(score, 1), "band": band, "components": {k: round(v, 3) for k, v in comp.items()},
            "weights": GEOMETRIC_WEIGHTS, "note": "Geometric difficulty only - not validated as RL difficulty."}
