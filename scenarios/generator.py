"""Procedural scenario generator.

Each generator builds a structured layout in a canonical orientation (start on
the left, goal on the right), then applies a random rotation/mirror so the
policy cannot exploit a fixed direction. Every scenario is validated with the
map analyzer: a collision-free route must exist (for temporary blockages it
must exist while the blockage is active).

Seeds: training/curriculum scenarios use seeds < 1,000,000 (same range as the
training maps); evaluation scenario sets use seeds >= 3,000,000, so evaluation
scenarios are never seen in training.
"""
import math

import numpy as np

from environment.world import World
from scenarios.analyzer import analyze_world

SCENARIO_TYPES = {
    "open": "Few scattered obstacles (baseline)",
    "dense_field": "Dense field of small obstacles",
    "narrow_passage": "Wall across the arena with one narrow gap",
    "dead_end": "Closed corridor pointing at the goal",
    "u_trap": "U-shaped trap opening toward the start",
    "multi_route": "Central block with two routes of different length",
    "moving": "Moderate clutter with moving obstacles",
    "temporary_blockage": "Shortest gap blocked for the first seconds",
    "difficult_start_goal": "Start facing away in a tight spot, goal near obstacles",
}

EVAL_SEED_OFFSET = 3_000_000
TRAIN_SEED_LIMIT = 1_000_000


def _wall(x0, y0, x1, y1, t=0.15):
    """Axis-aligned wall between two points (thickness t)."""
    if abs(x1 - x0) >= abs(y1 - y0):
        return [min(x0, x1), y0 - t / 2, max(x0, x1), y0 + t / 2]
    return [x0 - t / 2, min(y0, y1), x0 + t / 2, max(y0, y1)]


def _scatter(rng, W, H, n, smin, smax, keep_out):
    rects = []
    for _ in range(n * 20):
        if len(rects) >= n:
            break
        w, h = rng.uniform(smin, smax, 2)
        x, y = rng.uniform(0, W - w), rng.uniform(0, H - h)
        r = [x, y, x + w, y + h]
        if any(_overlaps(r, k, 0.45) for k in keep_out):
            continue
        rects.append(r)
    return rects


def _overlaps(r, p, margin):
    return r[0] - margin < p[0] < r[2] + margin and r[1] - margin < p[1] < r[3] + margin


def _layout(kind, rng, W, H):
    """Canonical layout: returns rects, timed, movers, start(x,y,theta), goal(x,y)."""
    cy = H / 2
    timed, movers = [], []
    start = [0.7, cy + rng.uniform(-1.0, 1.0), rng.uniform(-0.6, 0.6)]
    goal = [W - 0.7, cy + rng.uniform(-1.0, 1.0)]
    keep = [start[:2], goal]

    if kind == "open":
        rects = _scatter(rng, W, H, int(rng.integers(3, 6)), 0.3, 0.8, keep)
    elif kind == "dense_field":
        rects = _scatter(rng, W, H, int(rng.integers(22, 32)), 0.2, 0.45, keep)
    elif kind == "narrow_passage":
        gx, gap = W / 2 + rng.uniform(-0.5, 0.5), rng.uniform(0.45, 0.6)
        gy = rng.uniform(1.0, H - 1.0)
        rects = [_wall(gx, 0, gx, gy - gap / 2), _wall(gx, gy + gap / 2, gx, H)]
        rects += _scatter(rng, W, H, 3, 0.25, 0.5, keep + [(gx, gy)])
    elif kind == "dead_end":
        y, half, x0, x1 = cy, rng.uniform(0.45, 0.7), rng.uniform(1.6, 2.0), rng.uniform(3.9, 4.4)
        start[1], goal[1] = y, y + rng.uniform(-0.3, 0.3)
        rects = [_wall(x0, y - half, x1, y - half), _wall(x0, y + half, x1, y + half), _wall(x1, y - half, x1, y + half)]
        rects += _scatter(rng, W, H, 2, 0.25, 0.5, keep + [(x0 + 1, y)])
    elif kind == "u_trap":
        y, half, depth = cy, rng.uniform(0.7, 1.0), rng.uniform(0.8, 1.2)
        xb = rng.uniform(3.4, 3.9)
        start[1], goal[1] = y + rng.uniform(-0.2, 0.2), y + rng.uniform(-0.3, 0.3)
        rects = [_wall(xb, y - half, xb, y + half), _wall(xb - depth, y - half, xb, y - half), _wall(xb - depth, y + half, xb, y + half)]
    elif kind == "multi_route":
        bw, bh = rng.uniform(1.4, 2.0), rng.uniform(H * 0.45, H * 0.6)
        bx, by = W / 2 - bw / 2, cy - bh / 2 + rng.uniform(-0.6, 0.6)
        start[1], goal[1] = cy, cy
        rects = [[bx, by, bx + bw, by + bh]]
        rects += _scatter(rng, W, H, 3, 0.25, 0.45, keep + [(bx + bw / 2, cy)])
    elif kind == "moving":
        rects = _scatter(rng, W, H, int(rng.integers(5, 9)), 0.3, 0.7, keep)
        for _ in range(int(rng.integers(2, 5))):
            a = rng.uniform(-math.pi, math.pi)
            movers.append([rng.uniform(1.8, W - 1.8), rng.uniform(1.0, H - 1.0), 0.2 * math.cos(a), 0.2 * math.sin(a)])
    elif kind == "temporary_blockage":
        gx = W / 2
        g1, g2 = rng.uniform(1.2, 2.2), rng.uniform(H - 2.2, H - 1.2)
        gap = 0.6
        if rng.random() < 0.5:
            g1, g2 = g2, g1
        start[1] = goal[1] = g1 + rng.uniform(-0.3, 0.3)        # short route uses gap g1
        lo, hi = sorted([g1, g2])
        rects = [_wall(gx, 0, gx, lo - gap / 2), _wall(gx, lo + gap / 2, gx, hi - gap / 2), _wall(gx, hi + gap / 2, gx, H)]
        t_off = rng.uniform(6.0, 14.0)
        timed = [[gx - 0.15, g1 - gap / 2 - 0.05, gx + 0.15, g1 + gap / 2 + 0.05, 0.0, t_off]]
    elif kind == "difficult_start_goal":
        rects = _scatter(rng, W, H, int(rng.integers(6, 10)), 0.3, 0.8, [])
        start = [rng.uniform(0.6, 1.4), rng.uniform(0.6, H - 0.6), 0.0]
        goal = [rng.uniform(W - 1.4, W - 0.6), rng.uniform(0.6, H - 0.6)]
        start[2] = math.atan2(goal[1] - start[1], goal[0] - start[0]) + math.pi + rng.uniform(-0.4, 0.4)  # facing away
        # tuck the goal next to an obstacle
        side = rng.choice([-1, 1])
        rects.append([goal[0] - 0.4, goal[1] + side * 0.42 - 0.12, goal[0] + 0.4, goal[1] + side * 0.42 + 0.12])
    else:
        raise ValueError(f"unknown scenario type {kind}")
    return rects, timed, movers, start, goal


def _transform(rects, timed, movers, start, goal, W, H, k, mirror):
    """Rotate by k*90 deg about the centre (square arenas) and optionally mirror vertically."""
    def pt(x, y):
        if mirror:
            y = H - y
        for _ in range(k):
            x, y = W - y, x          # +90 deg for a square arena
        return x, y

    def rect(r):
        (ax, ay), (bx, by) = pt(r[0], r[1]), pt(r[2], r[3])
        return [min(ax, bx), min(ay, by), max(ax, bx), max(ay, by)]

    th = start[2]
    if mirror:
        th = -th
    th += k * math.pi / 2
    mv = []
    for x, y, vx, vy in movers:
        nx, ny = pt(x, y)
        tvx, tvy = vx, (-vy if mirror else vy)
        for _ in range(k):
            tvx, tvy = -tvy, tvx
        mv.append([nx, ny, tvx, tvy])
    return ([rect(r) for r in rects], [rect(t[:4]) + list(t[4:]) for t in timed], mv,
            [*pt(start[0], start[1]), (th + math.pi) % (2 * math.pi) - math.pi], list(pt(*goal)))


def generate_scenario(kind, seed, robot_radius=0.15, size=6.0, max_tries=40):
    rng = np.random.default_rng(seed)
    W = H = float(size)
    for attempt in range(max_tries):
        rects, timed, movers, start, goal = _layout(kind, rng, W, H)
        rects, timed, movers, start, goal = _transform(rects, timed, movers, start, goal, W, H,
                                                       int(rng.integers(0, 4)), bool(rng.integers(0, 2)))
        rects = [[max(0, a), max(0, b), min(W, c), min(H, d)] for a, b, c, d in rects if c - a > 0.05 and d - b > 0.05]
        world = World(W, H, rects, tuple(start), tuple(goal), movers=np.array(movers).reshape(-1, 4), timed=timed or None)
        if world.collides(start[0], start[1], robot_radius + 0.05, include_movers=True) or \
                world.collides(goal[0], goal[1], robot_radius + 0.05, include_movers=False):
            continue
        analysis = analyze_world(world, robot_radius)     # timed blockage active at t=0
        if not analysis["route_exists"]:
            continue
        return world, analysis, {"attempts": attempt + 1}
    raise RuntimeError(f"could not generate a valid '{kind}' scenario for seed {seed}")
