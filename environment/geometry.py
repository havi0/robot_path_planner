"""Vectorised 2D geometry: collision tests and ray casting.

Static obstacles are axis-aligned rectangles stored as rows [xmin, ymin, xmax, ymax].
Moving obstacles are circles stored as rows [x, y, radius].
"""
import numpy as np

EPS = 1e-9


def circle_hits_rects(x, y, r, rects):
    if len(rects) == 0:
        return False
    cx = np.clip(x, rects[:, 0], rects[:, 2])
    cy = np.clip(y, rects[:, 1], rects[:, 3])
    return bool(np.any((cx - x) ** 2 + (cy - y) ** 2 < r * r))


def circle_hits_circles(x, y, r, circles):
    if len(circles) == 0:
        return False
    d2 = (circles[:, 0] - x) ** 2 + (circles[:, 1] - y) ** 2
    return bool(np.any(d2 < (circles[:, 2] + r) ** 2))


def circle_outside_bounds(x, y, r, width, height):
    return x - r < 0 or y - r < 0 or x + r > width or y + r > height


def raycast(ox, oy, angles, rects, circles, width, height, max_range):
    """Distance from (ox, oy) along each world-frame angle to the nearest surface."""
    dx, dy = np.cos(angles), np.sin(angles)
    dx = np.where(np.abs(dx) < EPS, EPS, dx)
    dy = np.where(np.abs(dy) < EPS, EPS, dy)

    # arena boundary (robot is inside the box)
    tx = np.where(dx > 0, (width - ox) / dx, -ox / dx)
    ty = np.where(dy > 0, (height - oy) / dy, -oy / dy)
    t = np.minimum(np.minimum(tx, ty), max_range)

    if len(rects):
        inv_dx, inv_dy = (1.0 / dx)[:, None], (1.0 / dy)[:, None]
        t1, t2 = (rects[:, 0] - ox) * inv_dx, (rects[:, 2] - ox) * inv_dx
        t3, t4 = (rects[:, 1] - oy) * inv_dy, (rects[:, 3] - oy) * inv_dy
        t_near = np.maximum(np.minimum(t1, t2), np.minimum(t3, t4))
        t_far = np.minimum(np.maximum(t1, t2), np.maximum(t3, t4))
        hit = t_far >= np.maximum(t_near, 0.0)
        t_hit = np.where(hit, np.maximum(t_near, 0.0), np.inf)
        t = np.minimum(t, t_hit.min(axis=1))

    if len(circles):
        fx = ox - circles[:, 0]
        fy = oy - circles[:, 1]
        b = dx[:, None] * fx + dy[:, None] * fy
        c = fx * fx + fy * fy - circles[:, 2] ** 2
        disc = b * b - c
        root = np.sqrt(np.maximum(disc, 0.0))
        t_c = -b - root
        t_c = np.where(c < 0, 0.0, t_c)               # origin inside a circle
        t_c = np.where((disc >= 0) & (t_c >= 0), t_c, np.inf)
        t = np.minimum(t, t_c.min(axis=1))

    return np.maximum(t, 0.0)
