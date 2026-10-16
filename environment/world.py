"""2D world: arena, static rectangular obstacles, optional moving obstacles,
random map generation with a guaranteed collision-free route."""
import math
from collections import deque

import numpy as np

from environment.geometry import circle_hits_circles, circle_hits_rects, circle_outside_bounds


class World:
    def __init__(self, width, height, rects, start, goal, movers=None, mover_radius=0.2, timed=None):
        self.width, self.height = width, height
        # timed rows: [xmin, ymin, xmax, ymax, t_on, t_off] - obstacles that exist only for
        # t_on <= t < t_off (temporary blockages). `rects` = static + currently active timed.
        self.timed = np.zeros((0, 6)) if timed is None else np.asarray(timed, dtype=np.float64).reshape(-1, 6)
        self.time = 0.0
        self.rects = rects
        self.start = start                    # (x, y, theta)
        self.goal = goal                      # (x, y)
        # movers rows: [x, y, vx, vy]
        self.movers = np.zeros((0, 4)) if movers is None else np.asarray(movers, dtype=np.float64)
        self.mover_radius = mover_radius

    @property
    def rects(self):
        return self._active

    @rects.setter
    def rects(self, value):
        """Setting rects replaces the STATIC obstacles; active timed obstacles are re-added."""
        self.static_rects = np.asarray(value, dtype=np.float64).reshape(-1, 4)
        self._refresh_active()

    def _refresh_active(self):
        if len(self.timed) == 0:
            self._active = self.static_rects
            self._active_mask = None
            return
        mask = (self.timed[:, 4] <= self.time) & (self.time < self.timed[:, 5])
        self._active_mask = mask
        self._active = np.vstack([self.static_rects, self.timed[mask, :4]]) if mask.any() else self.static_rects

    def advance_time(self, dt):
        self.time += dt
        if len(self.timed):
            mask = (self.timed[:, 4] <= self.time) & (self.time < self.timed[:, 5])
            if self._active_mask is None or (mask != self._active_mask).any():
                self._refresh_active()

    @property
    def mover_circles(self):
        if len(self.movers) == 0:
            return np.zeros((0, 3))
        return np.column_stack([self.movers[:, :2], np.full(len(self.movers), self.mover_radius)])

    def collides(self, x, y, r, include_movers=True):
        if circle_outside_bounds(x, y, r, self.width, self.height):
            return True
        if circle_hits_rects(x, y, r, self.rects):
            return True
        return include_movers and circle_hits_circles(x, y, r, self.mover_circles)

    def step_movers(self, dt):
        """Advance world time (timed obstacles) and move dynamic obstacles; movers
        bounce off walls and obstacles."""
        self.advance_time(dt)
        r = self.mover_radius
        for m in self.movers:
            for axis in (0, 1):
                old = m[axis]
                m[axis] += m[2 + axis] * dt
                if circle_outside_bounds(m[0], m[1], r, self.width, self.height) or \
                        circle_hits_rects(m[0], m[1], r, self.rects):
                    m[axis] = old
                    m[2 + axis] *= -1

    def occupancy_grid(self, resolution, inflation=0.0):
        """Boolean grid (rows = y, cols = x); True = blocked for a robot centre.
        Static obstacles only: this is the 'known map' given to classical planners."""
        nx = int(math.ceil(self.width / resolution))
        ny = int(math.ceil(self.height / resolution))
        xs = (np.arange(nx) + 0.5) * resolution
        ys = (np.arange(ny) + 0.5) * resolution
        X, Y = np.meshgrid(xs, ys)
        occ = (X < inflation) | (Y < inflation) | (X > self.width - inflation) | (Y > self.height - inflation)
        for xmin, ymin, xmax, ymax in self.rects:
            cx = np.clip(X, xmin, xmax)
            cy = np.clip(Y, ymin, ymax)
            occ |= (cx - X) ** 2 + (cy - Y) ** 2 <= inflation ** 2
        return occ


def _cell(p, resolution, shape):
    return (min(int(p[1] / resolution), shape[0] - 1), min(int(p[0] / resolution), shape[1] - 1))


def grid_reachable(occ, a, b):
    if occ[a] or occ[b]:
        return False
    seen = np.zeros_like(occ, dtype=bool)
    seen[a] = True
    q = deque([a])
    while q:
        r, c = q.popleft()
        if (r, c) == b:
            return True
        for nr, nc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
            if 0 <= nr < occ.shape[0] and 0 <= nc < occ.shape[1] and not occ[nr, nc] and not seen[nr, nc]:
                seen[nr, nc] = True
                q.append((nr, nc))
    return False


def generate_world(wcfg, robot_radius, rng, density=None, num_movers=None, num_obstacles=None):
    """Random map. Obstacles are placed until the covered area reaches the target
    density; start/goal are sampled in free space and must be connected."""
    density = wcfg.obstacle_density if density is None else density
    # num_obstacles (optional): place exactly this many rectangles instead of filling to a density
    num_movers = wcfg.num_moving_obstacles if num_movers is None else num_movers
    W, H = wcfg.width, wcfg.height
    smin, smax = wcfg.obstacle_size
    check_res = 0.1

    for _ in range(200):
        rects = []
        covered = np.zeros((int(H / check_res), int(W / check_res)), dtype=bool)
        while (len(rects) < num_obstacles) if num_obstacles is not None else (covered.mean() < density):
            w, h = rng.uniform(smin, smax, size=2)
            x, y = rng.uniform(0, W - w), rng.uniform(0, H - h)
            rects.append([x, y, x + w, y + h])
            covered[int(y / check_res):int(math.ceil((y + h) / check_res)),
                    int(x / check_res):int(math.ceil((x + w) / check_res))] = True
        world = World(W, H, rects, None, None, mover_radius=wcfg.moving_obstacle_radius)

        clearance = max(wcfg.start_goal_clearance, robot_radius)
        free = _sample_free_points(world, clearance, rng, 200)
        if len(free) < 2:
            continue
        occ = world.occupancy_grid(check_res, inflation=robot_radius + 0.02)
        for _ in range(50):
            i, j = rng.choice(len(free), size=2, replace=False)
            s, g = free[i], free[j]
            if math.dist(s, g) < wcfg.min_start_goal_dist:
                continue
            if grid_reachable(occ, _cell(s, check_res, occ.shape), _cell(g, check_res, occ.shape)):
                world.start = (s[0], s[1], rng.uniform(-math.pi, math.pi))
                world.goal = (g[0], g[1])
                world.movers = _spawn_movers(world, num_movers, wcfg.moving_obstacle_speed, rng)
                return world
    raise RuntimeError("Could not generate a solvable map; lower the obstacle density.")


def _sample_free_points(world, clearance, rng, n):
    pts = rng.uniform([clearance, clearance], [world.width - clearance, world.height - clearance], size=(n, 2))
    return [tuple(p) for p in pts if not world.collides(p[0], p[1], clearance, include_movers=False)]


def _spawn_movers(world, n, speed, rng):
    movers = []
    r = world.mover_radius
    for _ in range(n * 50):
        if len(movers) == n:
            break
        x, y = rng.uniform(r, world.width - r), rng.uniform(r, world.height - r)
        if world.collides(x, y, r, include_movers=False):
            continue
        if math.dist((x, y), world.start[:2]) < 1.0 or math.dist((x, y), world.goal) < 0.8:
            continue
        a = rng.uniform(-math.pi, math.pi)
        movers.append([x, y, speed * math.cos(a), speed * math.sin(a)])
    return np.array(movers).reshape(-1, 4)
