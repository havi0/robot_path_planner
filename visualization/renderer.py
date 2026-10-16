"""Pygame drawing helpers shared by the simulator app and the monitor.

Dark theme. Chart/series colours follow a validated palette (blue / orange,
CVD-safe on the dark surface); green / red / amber are reserved for status
and are always paired with a text label.
"""
import math

import numpy as np
import pygame
import pygame.gfxdraw

# ---- surfaces & ink ----
PAGE = (13, 13, 13)
SURFACE = (26, 26, 25)
SURFACE_2 = (34, 34, 32)
BORDER = (48, 48, 45)
GRID = (36, 36, 34)
TEXT = (240, 239, 236)
TEXT_2 = (195, 194, 183)
MUTED = (137, 135, 129)

# ---- series (validated categorical slots 1, 2, 7) ----
BLUE = (57, 135, 229)
ORANGE = (217, 89, 38)
VIOLET = (144, 133, 233)

# ---- status (reserved; always with a label) ----
GOOD = (12, 163, 12)
WARNING = (250, 178, 25)
SERIOUS = (236, 131, 90)
CRITICAL = (208, 59, 59)

# ---- world ----
FLOOR = (21, 22, 24)
FLOOR_GRID = (30, 31, 34)
OBSTACLE = (62, 64, 71)
OBSTACLE_EDGE = (88, 91, 101)

# backwards-compatible names used by the monitor
BG, OK, BAD, WARN, ROBOT, TRAIL, PLAN, MOVER, GOAL = PAGE, GOOD, CRITICAL, WARNING, BLUE, BLUE, VIOLET, ORANGE, GOOD


def load_fonts():
    def f(size, bold=False):
        return pygame.font.SysFont("segoeui,helveticaneue,arial", size, bold=bold)
    return {"title": f(22, True), "h": f(15, True), "body": f(14), "small": f(12),
            "num": f(24, True), "toast": f(20, True)}


# ------------------------------------------------------------------ primitives
def card(surf, rect, color=SURFACE, radius=12, border=BORDER):
    pygame.draw.rect(surf, color, rect, border_radius=radius)
    if border:
        pygame.draw.rect(surf, border, rect, 1, border_radius=radius)


def aa_circle(surf, color, center, r):
    x, y, r = int(center[0]), int(center[1]), max(1, int(r))
    pygame.gfxdraw.filled_circle(surf, x, y, r, color)
    pygame.gfxdraw.aacircle(surf, x, y, r, color)


def alpha_circle(surf, color, center, r, alpha):
    r = max(1, int(r))
    s = pygame.Surface((2 * r + 2, 2 * r + 2), pygame.SRCALPHA)
    pygame.gfxdraw.filled_circle(s, r + 1, r + 1, r, (*color, int(alpha)))
    pygame.gfxdraw.aacircle(s, r + 1, r + 1, r, (*color, int(alpha)))
    surf.blit(s, (int(center[0]) - r - 1, int(center[1]) - r - 1))


def glow(surf, color, center, r, strength=60, layers=5):
    for i in range(layers, 0, -1):
        alpha_circle(surf, color, center, r * (1 + 0.35 * i), strength / (i + 1.5))


def draw_text(surf, font, text, pos, color=TEXT, anchor="topleft"):
    img = font.render(str(text), True, color)
    rect = img.get_rect(**{anchor: pos})
    surf.blit(img, rect)
    return img.get_height()


def pill(surf, font, text, pos, fg, bg=None, dot=None):
    """Rounded label chip. Returns its width."""
    img = font.render(text, True, fg)
    pad = 10
    w = img.get_width() + 2 * pad + (14 if dot else 0)
    h = img.get_height() + 6
    rect = pygame.Rect(pos[0], pos[1], w, h)
    pygame.draw.rect(surf, bg or SURFACE_2, rect, border_radius=h // 2)
    pygame.draw.rect(surf, BORDER, rect, 1, border_radius=h // 2)
    x = rect.x + pad
    if dot:
        aa_circle(surf, dot, (x + 4, rect.centery), 4)
        x += 14
    surf.blit(img, (x, rect.y + 3))
    return w


def progress_bar(surf, rect, frac, color):
    rect = pygame.Rect(rect)
    pygame.draw.rect(surf, SURFACE_2, rect, border_radius=rect.h // 2)
    if frac > 0:
        w = max(rect.h, int(rect.w * min(frac, 1.0)))
        pygame.draw.rect(surf, color, (rect.x, rect.y, w, rect.h), border_radius=rect.h // 2)


def stat_tile(surf, fonts, rect, label, value, sub=None, accent=None):
    rect = pygame.Rect(rect)
    card(surf, rect, SURFACE, 10)
    if accent:
        pygame.draw.rect(surf, accent, (rect.x + 1, rect.y + 12, 3, rect.h - 24), border_radius=2)
    draw_text(surf, fonts["small"], label.upper(), (rect.x + 14, rect.y + 10), MUTED)
    draw_text(surf, fonts["num"], value, (rect.x + 14, rect.y + 28), TEXT)
    if sub:
        draw_text(surf, fonts["small"], sub, (rect.x + 14, rect.bottom - 20), TEXT_2)


def _dashed_polyline(surf, color, pts, width=2, dash=8, gap=6):
    carry, draw_on = 0.0, True
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        seg = math.hypot(x1 - x0, y1 - y0)
        pos = 0.0
        while pos < seg:
            step = min((dash if draw_on else gap) - carry, seg - pos)
            if draw_on:
                a, b = pos / seg, (pos + step) / seg
                pygame.draw.line(surf, color, (x0 + (x1 - x0) * a, y0 + (y1 - y0) * a),
                                 (x0 + (x1 - x0) * b, y0 + (y1 - y0) * b), width)
            pos += step
            carry += step
            if carry >= (dash if draw_on else gap) - 1e-9:
                carry, draw_on = 0.0, not draw_on


def draw_chart(surf, fonts, rect, series, title, y_range=None, fmt="{:.1f}", fill=False):
    """series: list of (values, color, label, dashed). Single series -> title names it
    (no legend box); 2+ series -> legend with current values."""
    rect = pygame.Rect(rect)
    card(surf, rect)
    draw_text(surf, fonts["h"], title, (rect.x + 14, rect.y + 10), TEXT)
    plot = pygame.Rect(rect.x + 46, rect.y + 40, rect.w - 62, rect.h - 56)
    allv = [v for s in series for v in s[0]]
    if len(allv) < 2:
        draw_text(surf, fonts["body"], "Waiting for episodes…", plot.center, MUTED, "center")
        return
    if y_range:
        lo, hi = y_range
        ticks = [lo, (lo + hi) / 2, hi]
    else:                                    # "nice" round ticks that enclose the data
        lo, hi = min(allv), max(allv)
        if hi - lo < 1e-9:
            lo, hi = lo - 1, hi + 1
        raw = (hi - lo) / 2
        mag = 10 ** math.floor(math.log10(raw))
        step = next(m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw)
        lo, hi = math.floor(lo / step) * step, math.ceil(hi / step) * step
        ticks = [lo + i * step for i in range(int(round((hi - lo) / step)) + 1)]
        fmt = "{:.0f}" if step >= 1 else fmt
    ypx = lambda v: plot.bottom - plot.h * (min(max(v, lo), hi) - lo) / (hi - lo)

    for v in ticks:                          # recessive hairline grid + ticks
        y = ypx(v)
        pygame.draw.line(surf, GRID, (plot.x, y), (plot.right, y), 1)
        draw_text(surf, fonts["small"], fmt.format(v), (plot.x - 8, y), MUTED, "midright")

    if len(series) > 1:                      # legend (identity never colour-alone)
        lx = rect.right - 14
        for vals, color, label, dashed in reversed(series):
            txt = f"{label} {fmt.format(vals[-1])}" if vals else label
            img = fonts["small"].render(txt, True, TEXT_2)
            lx -= img.get_width()
            surf.blit(img, (lx, rect.y + 13))
            lx -= 22
            if dashed:
                _dashed_polyline(surf, color, [(lx, rect.y + 21), (lx + 16, rect.y + 21)], 2, 5, 3)
            else:
                pygame.draw.line(surf, color, (lx, rect.y + 21), (lx + 16, rect.y + 21), 2)
            lx -= 14
    elif series and series[0][0]:
        draw_text(surf, fonts["h"], fmt.format(series[0][0][-1]), (rect.right - 14, rect.y + 10), TEXT, "topright")

    for vals, color, label, dashed in series:
        n = len(vals)
        if n < 2:
            continue
        pts = [(plot.x + plot.w * i / (n - 1), ypx(v)) for i, v in enumerate(vals)]
        if fill:
            area = pygame.Surface(surf.get_size(), pygame.SRCALPHA)
            pygame.draw.polygon(area, (*color, 38), pts + [(pts[-1][0], plot.bottom), (pts[0][0], plot.bottom)])
            surf.blit(area, (0, 0))
        if dashed:
            _dashed_polyline(surf, color, pts, 2)
        else:
            pygame.draw.lines(surf, color, False, pts, 2)
        aa_circle(surf, SURFACE, pts[-1], 6)     # 2px surface ring around the end marker
        aa_circle(surf, color, pts[-1], 4)


class Button:
    def __init__(self, rect, label, action, key_hint=""):
        self.rect = pygame.Rect(rect)
        self.label = label
        self.action = action
        self.key_hint = key_hint

    def draw(self, surf, fonts, active=False, hover=False):
        bg = BLUE if active else (SURFACE_2 if not hover else (48, 48, 46))
        pygame.draw.rect(surf, bg, self.rect, border_radius=8)
        if not active:
            pygame.draw.rect(surf, BORDER, self.rect, 1, border_radius=8)
        draw_text(surf, fonts["body"], self.label, (self.rect.centerx, self.rect.centery - 1),
                  TEXT if active or hover else TEXT_2, "center")
        if self.key_hint:
            draw_text(surf, fonts["small"], self.key_hint, (self.rect.right - 8, self.rect.centery),
                      (200, 220, 255) if active else MUTED, "midright")

    def handle(self, pos):
        if self.rect.collidepoint(pos):
            self.action()
            return True
        return False


# ------------------------------------------------------------------ world view
class WorldView:
    """Maps world metres to a pixel rectangle (y axis up)."""

    def __init__(self, rect, width_m, height_m):
        self.rect = pygame.Rect(rect)
        self.scale = min(self.rect.w / width_m, self.rect.h / height_m)
        self.w_m, self.h_m = width_m, height_m

    def px(self, x, y):
        return (self.rect.x + x * self.scale, self.rect.y + (self.h_m - y) * self.scale)

    def to_world(self, sx, sy):
        return ((sx - self.rect.x) / self.scale, self.h_m - (sy - self.rect.y) / self.scale)

    def draw_world(self, surf, world, goal_radius, t=0.0):
        r = self.rect
        pygame.draw.rect(surf, FLOOR, r, border_radius=10)
        for i in range(1, int(self.w_m / 0.5)):               # 0.5 m floor grid
            x = r.x + i * 0.5 * self.scale
            pygame.draw.line(surf, FLOOR_GRID, (x, r.y + 2), (x, r.bottom - 2), 1)
        for i in range(1, int(self.h_m / 0.5)):
            y = r.y + i * 0.5 * self.scale
            pygame.draw.line(surf, FLOOR_GRID, (r.x + 2, y), (r.right - 2, y), 1)

        shadow = pygame.Surface(surf.get_size(), pygame.SRCALPHA)
        for xmin, ymin, xmax, ymax in world.rects:
            x0, y0 = self.px(xmin, ymax)
            rr = pygame.Rect(x0, y0, (xmax - xmin) * self.scale + 1, (ymax - ymin) * self.scale + 1)
            pygame.draw.rect(shadow, (0, 0, 0, 90), rr.move(4, 5), border_radius=5)
        surf.blit(shadow, (0, 0))
        for xmin, ymin, xmax, ymax in world.rects:
            x0, y0 = self.px(xmin, ymax)
            rr = pygame.Rect(x0, y0, (xmax - xmin) * self.scale + 1, (ymax - ymin) * self.scale + 1)
            pygame.draw.rect(surf, OBSTACLE, rr, border_radius=4)
            pygame.draw.rect(surf, OBSTACLE_EDGE, rr, 1, border_radius=4)
        pygame.draw.rect(surf, BORDER, r, 2, border_radius=10)

        for m in world.movers:
            c = self.px(m[0], m[1])
            rad = world.mover_radius * self.scale
            glow(surf, ORANGE, c, rad, 50, 3)
            aa_circle(surf, ORANGE, c, rad)
            aa_circle(surf, (240, 140, 100), c, rad * 0.45)

        if world.start is not None:
            s = self.px(*world.start[:2])
            pygame.draw.rect(surf, MUTED, (s[0] - 7, s[1] - 7, 14, 14), 2, border_radius=3)

        if world.goal is not None:
            g = self.px(*world.goal)
            gr = goal_radius * self.scale
            alpha_circle(surf, GOOD, g, gr, 45)
            pygame.gfxdraw.aacircle(surf, int(g[0]), int(g[1]), int(gr), GOOD)
            phase = (t * 0.8) % 1.0                              # expanding pulse ring
            ring = pygame.Surface(surf.get_size(), pygame.SRCALPHA)
            pygame.draw.circle(ring, (*GOOD, int(140 * (1 - phase))), (int(g[0]), int(g[1])),
                               int(gr * (1 + 0.6 * phase)), 2)
            surf.blit(ring, (0, 0))
            aa_circle(surf, GOOD, g, 6)
            aa_circle(surf, (200, 255, 200), g, 2)

    def draw_path(self, surf, pts, color, width=2, dashed=False):
        if len(pts) < 2:
            return
        p = [self.px(*q) for q in pts]
        if dashed:
            _dashed_polyline(surf, color, p, width, 7, 6)
        else:
            pygame.draw.lines(surf, color, False, p, width)

    def draw_trail(self, surf, pts, color=BLUE):
        """Trajectory that fades from transparent (old) to opaque (recent)."""
        if len(pts) < 2:
            return
        layer = pygame.Surface(surf.get_size(), pygame.SRCALPHA)
        p = [self.px(*q) for q in pts]
        n = len(p)
        for i in range(1, n):
            a = int(40 + 200 * (i / n) ** 1.5)
            pygame.draw.line(layer, (*color, a), p[i - 1], p[i], 3)
        surf.blit(layer, (0, 0))

    def draw_beams(self, surf, pose, reading, warn_dist):
        c = self.px(pose.x, pose.y)
        pts, hits = [], []
        for r, a in zip(reading.ranges, reading.angles):
            rr = r if np.isfinite(r) else reading.max_range
            ang = pose.theta + a
            end = self.px(pose.x + rr * math.cos(ang), pose.y + rr * math.sin(ang))
            pts.append(end)
            if np.isfinite(r) and r < reading.max_range - 1e-6:
                hits.append((end, r < warn_dist))
        layer = pygame.Surface(surf.get_size(), pygame.SRCALPHA)
        order = np.argsort(reading.angles)
        poly = [pts[i] for i in order]
        pygame.draw.polygon(layer, (*BLUE, 26), poly)
        for p in poly:
            pygame.draw.line(layer, (*BLUE, 40), c, p, 1)
        pygame.draw.lines(layer, (*BLUE, 70), True, poly, 1)
        surf.blit(layer, (0, 0))
        for end, near in hits:
            if near:
                alpha_circle(surf, CRITICAL, end, 7, 70)
            aa_circle(surf, CRITICAL if near else SERIOUS, end, 3)

    def draw_robot(self, surf, pose, radius, color=BLUE):
        c = self.px(pose.x, pose.y)
        rpx = radius * self.scale
        alpha_circle(surf, (0, 0, 0), (c[0] + 3, c[1] + 4), rpx, 110)        # shadow
        glow(surf, color, c, rpx, 45, 4)
        ca, sa = math.cos(-pose.theta), math.sin(-pose.theta)
        rot = lambda dx, dy: (c[0] + dx * ca - dy * sa, c[1] + dx * sa + dy * ca)
        for side in (-1, 1):                                                   # wheels
            wy = side * rpx * 0.95
            pygame.gfxdraw.aapolygon(surf, [rot(-rpx * .45, wy - 4), rot(rpx * .45, wy - 4),
                                            rot(rpx * .45, wy + 4), rot(-rpx * .45, wy + 4)], (15, 15, 15))
            pygame.gfxdraw.filled_polygon(surf, [rot(-rpx * .45, wy - 4), rot(rpx * .45, wy - 4),
                                                 rot(rpx * .45, wy + 4), rot(-rpx * .45, wy + 4)], (15, 15, 15))
        aa_circle(surf, color, c, rpx)
        aa_circle(surf, tuple(int(v * 0.72) for v in color), c, rpx * 0.72)
        nose = [rot(rpx * 0.85, 0), rot(rpx * 0.15, -rpx * 0.42), rot(rpx * 0.3, 0), rot(rpx * 0.15, rpx * 0.42)]
        pygame.gfxdraw.filled_polygon(surf, nose, (245, 248, 255))
        pygame.gfxdraw.aapolygon(surf, nose, (245, 248, 255))
