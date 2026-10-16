"""Classical planners on an occupancy grid: A* and Dijkstra (8-connected).

These planners are given the FULL static map in advance (known-map assumption),
whereas the RL policies see only local range readings. Moving obstacles are not
in the map; the follower executing the plan will not react to them.
"""
import heapq
import math
import time
from dataclasses import dataclass

import numpy as np

SQRT2 = math.sqrt(2)
NEIGHBOURS = [(-1, 0, 1.0), (1, 0, 1.0), (0, -1, 1.0), (0, 1, 1.0),
              (-1, -1, SQRT2), (-1, 1, SQRT2), (1, -1, SQRT2), (1, 1, SQRT2)]


@dataclass
class PlanResult:
    path: list                 # world-frame waypoints [(x, y), ...] or [] if no path
    length: float              # metres
    expanded: int              # nodes expanded (search effort)
    plan_time_ms: float


def grid_search(occ, start, goal, heuristic_weight):
    """Generic best-first search. heuristic_weight=1 -> A*, 0 -> Dijkstra."""
    rows, cols = occ.shape
    gr, gc = goal
    h = (lambda r, c: heuristic_weight * math.hypot(r - gr, c - gc)) if heuristic_weight else (lambda r, c: 0.0)
    g = np.full(occ.shape, np.inf)
    parent = {}
    closed = np.zeros(occ.shape, dtype=bool)
    g[start] = 0.0
    heap = [(h(*start), 0.0, start)]
    expanded = 0
    while heap:
        _, cost, cur = heapq.heappop(heap)
        if closed[cur]:
            continue
        closed[cur] = True
        expanded += 1
        if cur == goal:
            path = [cur]
            while cur in parent:
                cur = parent[cur]
                path.append(cur)
            return path[::-1], cost, expanded
        r, c = cur
        for dr, dc, step in NEIGHBOURS:
            nr, nc = r + dr, c + dc
            if not (0 <= nr < rows and 0 <= nc < cols) or occ[nr, nc] or closed[nr, nc]:
                continue
            if dr and dc and (occ[r, nc] or occ[nr, c]):   # no corner cutting
                continue
            ng = cost + step
            if ng < g[nr, nc]:
                g[nr, nc] = ng
                parent[(nr, nc)] = cur
                heapq.heappush(heap, (ng + h(nr, nc), ng, (nr, nc)))
    return None, math.inf, expanded


def _to_cell(p, res, shape):
    return (min(max(int(p[1] / res), 0), shape[0] - 1), min(max(int(p[0] / res), 0), shape[1] - 1))


def _nearest_free(occ, cell):
    if not occ[cell]:
        return cell
    free = np.argwhere(~occ)
    d = np.abs(free - np.array(cell)).sum(axis=1)
    return tuple(free[d.argmin()])


def _line_free(occ, a, b):
    """True if the straight segment between cells a and b crosses no occupied cell."""
    n = int(max(abs(b[0] - a[0]), abs(b[1] - a[1])) * 2) + 1
    rs = np.rint(np.linspace(a[0], b[0], n + 1)).astype(int)
    cs = np.rint(np.linspace(a[1], b[1], n + 1)).astype(int)
    return not occ[rs, cs].any()


def smooth_path(occ, cells):
    """Line-of-sight shortcutting: removes the zig-zag of 8-connected grid paths,
    giving a path much closer to the true shortest path."""
    out, i = [cells[0]], 0
    while i < len(cells) - 1:
        j = len(cells) - 1
        while j > i + 1 and not _line_free(occ, cells[i], cells[j]):
            j -= 1
        out.append(cells[j])
        i = j
    return out


def plan(world, start_xy, goal_xy, resolution, inflation, algorithm="astar", smooth=True):
    t0 = time.perf_counter()
    occ = world.occupancy_grid(resolution, inflation)
    s = _nearest_free(occ, _to_cell(start_xy, resolution, occ.shape))
    g = _nearest_free(occ, _to_cell(goal_xy, resolution, occ.shape))
    cells, cost, expanded = grid_search(occ, s, g, 1.0 if algorithm == "astar" else 0.0)
    if cells is None:
        return PlanResult([], math.inf, expanded, (time.perf_counter() - t0) * 1000)
    if smooth:
        cells = smooth_path(occ, cells)
    path = [((c + 0.5) * resolution, (r + 0.5) * resolution) for r, c in cells]
    path[0], path[-1] = tuple(start_xy), tuple(goal_xy)
    length = sum(math.dist(p, q) for p, q in zip(path, path[1:]))
    return PlanResult(path, length, expanded, (time.perf_counter() - t0) * 1000)


def astar(world, start_xy, goal_xy, resolution=0.05, inflation=0.25):
    return plan(world, start_xy, goal_xy, resolution, inflation, "astar")


def dijkstra(world, start_xy, goal_xy, resolution=0.05, inflation=0.25):
    return plan(world, start_xy, goal_xy, resolution, inflation, "dijkstra")
