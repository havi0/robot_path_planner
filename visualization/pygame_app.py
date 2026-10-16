"""Interactive 2D simulator (Pygame).

EVALUATE mode: watch a trained policy (DQN / Q-learning) or a planner (A* / Dijkstra)
               drive on unseen maps. Click anywhere to move the goal.
TRAIN mode:    train a fresh DQN live and watch it learn.

Keys: SPACE start/pause  R reset map  N next map  M mode  P policy  S safety shield
      X emergency stop   UP/DOWN density  O moving obstacles  G obstacle shapes
      L lidar beams  +/- speed  K save live model  ESC quit
"""
import copy
import os
import time
from collections import deque

import numpy as np
import pygame

from environment.nav_env import NavigationEnv
from evaluation.evaluate import (dqn_method, load_dqn, load_qlearning, plan_with_fallback, planner_methods,
                                 qlearning_method, with_recovery)
from safety.safety_layer import SafetyLayer
from visualization.renderer import (BLUE, BORDER, CRITICAL, GOOD, MUTED, ORANGE, PAGE, SURFACE, TEXT, TEXT_2,
                                    VIOLET, WARNING, Button, WorldView, aa_circle, draw_chart, draw_text,
                                    load_fonts, pill, progress_bar, stat_tile)

SPEEDS = [4, 15, 60, 240, 1000, 4000]          # simulation steps per second (4 = real time)
SHAPES = [("normal", [0.3, 1.0]), ("clutter", [0.15, 0.35]), ("walls", [1.0, 2.5])]


class SimulatorApp:
    W, H = 1440, 860
    VIEW = 820
    PANEL_X, PANEL_W = 860, 560

    def __init__(self, cfg, dqn_path=None, q_path=None):
        pygame.init()
        pygame.display.set_caption("RL Robot Navigator")
        self.screen = pygame.display.set_mode((self.W, self.H))
        self.fonts = load_fonts()
        self.mouse = (0, 0)
        self.clock = pygame.time.Clock()
        self.cfg = copy.deepcopy(cfg)
        self.view = WorldView((20, 20, self.VIEW, self.VIEW), cfg.world.width, cfg.world.height)

        self.methods = {}
        if dqn_path and os.path.exists(dqn_path):
            agent, tcfg = load_dqn(dqn_path)
            self.methods["DQN + recovery"] = with_recovery(dqn_method(agent), tcfg)
            self.methods["DQN"] = dqn_method(agent)
        if q_path and os.path.exists(q_path):
            self.methods["Q-learning"] = qlearning_method(load_qlearning(q_path)[0])
        for m in planner_methods(cfg):
            self.methods[m.name] = m
        self.policy_names = list(self.methods)

        self.mode = "eval"
        self.paused = False
        self.speed_idx = 1
        self.step_budget = 0.0
        self.policy_idx = 0
        self.density = cfg.world.obstacle_density
        self.train_density_override = False
        self.movers = 0
        self.shape_idx = 0
        self.show_beams = True
        self.shield = False
        self.estop = False
        self.map_seed = cfg.evaluation.heldout_seed_offset
        self.trainer = None
        self.session = {"eval": [], "train": []}       # (return, outcome)
        self.message = ""
        self._build_buttons()
        self.new_episode()

    # ------------------------------------------------------------------ UI
    def _build_buttons(self):
        x0, y0 = self.PANEL_X, 668
        specs = [("Pause", self.toggle_pause, "SPACE"), ("Reset", lambda: self.new_episode(same_map=True), "R"),
                 ("Next map", self.next_map, "N"), ("Train", self.toggle_mode, "M"),
                 ("Policy", self.cycle_policy, "P"), ("Shield", self.toggle_shield, "S"),
                 ("Density -", lambda: self.change_density(-0.05), "DN"),
                 ("Density +", lambda: self.change_density(0.05), "UP"),
                 ("Movers", self.toggle_movers, "O"), ("Shapes", self.cycle_shapes, "G"),
                 ("Slower", lambda: self.change_speed(-1), "-"), ("Faster", lambda: self.change_speed(1), "+")]
        bw = (self.PANEL_W - 3 * 8) // 4
        self.buttons = []
        for i, (label, fn, key) in enumerate(specs):
            r, c = divmod(i, 4)
            self.buttons.append(Button((x0 + c * (bw + 8), y0 + r * 42, bw, 34), label, fn, key))

    def toggle_pause(self):
        self.paused = not self.paused

    def change_speed(self, d):
        self.speed_idx = int(np.clip(self.speed_idx + d, 0, len(SPEEDS) - 1))

    def next_map(self):
        self.map_seed += 1
        self.new_episode()

    def toggle_mode(self):
        self.mode = "train" if self.mode == "eval" else "eval"
        if self.mode == "train" and self.trainer is None:
            self._start_trainer()
        self.new_episode()

    def cycle_policy(self):
        self.policy_idx = (self.policy_idx + 1) % len(self.policy_names)
        self.new_episode(same_map=True)

    def toggle_shield(self):
        self.shield = not self.shield
        self._apply_safety()

    def change_density(self, d):
        self.density = float(np.clip(round(self.density + d, 2), 0.0, 0.35))
        self.train_density_override = True
        self.new_episode(same_map=True)

    def toggle_movers(self):
        self.movers = 0 if self.movers else 3
        self.new_episode(same_map=True)

    def cycle_shapes(self):
        self.shape_idx = (self.shape_idx + 1) % len(SHAPES)
        self.new_episode(same_map=True)

    def toggle_estop(self):
        self.estop = not self.estop
        env = self.env
        if self.estop:
            env.safety.estop.trigger("operator")
        else:
            env.safety.estop.reset()
        self._apply_safety()

    def _apply_safety(self):
        env = self.env
        env.core.safety = env.safety if (self.shield or self.estop) else None

    # ------------------------------------------------------------- episodes
    def _start_trainer(self):
        from training.train_dqn import DQNTrainer
        tcfg = copy.deepcopy(self.cfg)
        tcfg.training.eval_every = 10 ** 12          # no blocking evaluations in the live view
        run_dir = os.path.join("runs", f"live_{time.strftime('%Y%m%d_%H%M%S')}")
        self.trainer = DQNTrainer(tcfg, run_dir=run_dir, quiet=True)
        self.message = f"live training -> {run_dir}"

    def new_episode(self, same_map=False):
        self.cfg.world.obstacle_size = SHAPES[self.shape_idx][1]
        self.trail, self.plan, self.ep_return, self.ep_steps = [], [], 0.0, 0
        self.outcome, self.banner_until = None, 0.0
        if self.mode == "train":
            self.trainer.env.cfg.world.obstacle_size = SHAPES[self.shape_idx][1]
            opts = {"num_movers": self.movers}
            if self.train_density_override:
                opts["density"] = self.density
            self.trainer.reset_options = opts
            self.trainer.obs, _ = self.trainer.env.reset(options=opts)
            self.trainer.ep_return, self.trainer.ep_len = 0.0, 0
            self.env = self.trainer.env
        else:
            if not hasattr(self, "eval_env"):
                self.eval_env = NavigationEnv(self.cfg, mode="eval", use_safety=True)
            self.env = self.eval_env
            self.obs, _ = self.env.reset(options={"map_seed": self.map_seed, "density": self.density,
                                                  "num_movers": self.movers})
            self._prepare_policy()
        if self.env.safety is None:
            self.env.safety = SafetyLayer(self.cfg.safety, self.cfg.robot.radius)
        if self.estop:
            self.env.safety.estop.trigger("operator")
        self._apply_safety()
        p = self.env.core.last_pose
        self.trail = [(p.x, p.y)]

    def _prepare_policy(self):
        method = self.methods[self.policy_names[self.policy_idx]]
        if method.planner is not None:
            plan = plan_with_fallback(self.cfg, method.planner, self.env.backend.world, self.env.core.goal)
            self.plan = plan.path
            method.policy.reset(path=plan.path)
            self.message = f"{method.name}: planned {plan.length:.2f} m in {plan.plan_time_ms:.1f} ms " \
                           f"({plan.expanded} nodes)"
        else:
            method.policy.reset()
            self.message = f"{method.name}: acting on local sensor readings only"

    def set_goal(self, sx, sy):
        if self.mode != "eval":
            return
        x, y = self.view.to_world(sx, sy)
        world = self.env.backend.world
        if not (0 < x < world.width and 0 < y < world.height) or world.collides(x, y, self.cfg.robot.radius + 0.05):
            self.message = "goal must be in free space"
            return
        world.goal = (x, y)
        self.env.core.goal = (x, y)
        self.env.prev_dist = self.env.core.distance_to_goal(self.env.core.last_pose)
        self.env.steps = 0
        self.outcome = None
        self.obs = self.env.core._observe(self.env.core.last_reading, self.env.core.last_pose)
        self._prepare_policy()

    # ---------------------------------------------------------------- steps
    def _finish(self, info, ret):
        outcome = "success" if info["is_success"] else "collision" if info["collision"] else "timeout"
        self.session[self.mode].append((ret, outcome))
        return outcome

    def eval_step(self):
        if self.outcome:
            if time.time() > self.banner_until:
                self.next_map()
            return
        method = self.methods[self.policy_names[self.policy_idx]]
        action = method.policy.act(self.obs, self.env.core.last_pose, self.env.core.goal)
        self.obs, r, term, trunc, info = self.env.step(action)
        self.last_info, self.last_action = info, action
        self.ep_return += r
        self.ep_steps += 1
        p = self.env.core.last_pose
        self.trail.append((p.x, p.y))
        if term or trunc:
            self.outcome = self._finish(info, self.ep_return)
            self.banner_until = time.time() + 1.2

    def train_step(self):
        t = self.trainer
        prev_ep = t.episode
        ret_before = t.ep_return
        summary = t.step()
        self.last_info = t.last_info
        if summary:
            self.session["train"].append((summary["return"], summary["outcome"]))
            self.outcome = summary["outcome"]
            self.ep_return = summary["return"]
            p = self.env.core.last_pose
            self.trail = [(p.x, p.y)]
        else:
            self.ep_return = ret_before if t.episode != prev_ep else t.ep_return
            p = self.env.core.last_pose
            self.trail.append((p.x, p.y))
        self.ep_steps = t.ep_len

    # ---------------------------------------------------------------- draw
    def draw(self):
        s = self.screen
        s.fill(PAGE)
        env, v = self.env, self.view
        self.mouse = pygame.mouse.get_pos()
        v.draw_world(s, env.backend.world, self.cfg.world.goal_radius, time.time())
        if self.plan:
            v.draw_path(s, self.plan, VIOLET, 2, dashed=True)
        pose, reading = env.core.last_pose, env.core.last_reading
        if self.show_beams and reading is not None:
            v.draw_beams(s, pose, reading, self.cfg.reward.proximity_threshold)
        v.draw_trail(s, self.trail[-1500:])
        v.draw_robot(s, pose, self.cfg.robot.radius, CRITICAL if env.backend.collided else BLUE)
        if self.message:
            self._caption(self.message)
        if self.estop:
            pygame.draw.rect(s, CRITICAL, v.rect, 4, border_radius=10)
            self._toast("Emergency stop engaged  -  press X to release", CRITICAL)
        elif self.outcome and self.mode == "eval":
            text, col = {"success": ("Goal reached", GOOD), "collision": ("Collision", CRITICAL)}.get(
                self.outcome, ("Timed out", WARNING))
            self._toast(text, col)
        self._draw_panel()
        pygame.display.flip()

    def _toast(self, text, color):
        F, s = self.fonts, self.screen
        img = F["toast"].render(text, True, TEXT)
        w, h = img.get_width() + 60, img.get_height() + 20
        rect = pygame.Rect(0, 0, w, h)
        rect.midtop = (self.view.rect.centerx, self.view.rect.y + 18)
        layer = pygame.Surface((w, h), pygame.SRCALPHA)
        pygame.draw.rect(layer, (*SURFACE, 235), layer.get_rect(), border_radius=h // 2)
        s.blit(layer, rect)
        pygame.draw.rect(s, color, rect, 2, border_radius=h // 2)
        aa_circle(s, color, (rect.x + 26, rect.centery), 6)
        s.blit(img, (rect.x + 42, rect.y + 10))

    def _caption(self, text):
        F, s = self.fonts, self.screen
        img = F["small"].render(text, True, TEXT_2)
        rect = pygame.Rect(self.view.rect.x + 14, self.view.rect.bottom - 40, img.get_width() + 24, 26)
        layer = pygame.Surface(rect.size, pygame.SRCALPHA)
        pygame.draw.rect(layer, (*SURFACE, 220), layer.get_rect(), border_radius=13)
        s.blit(layer, rect)
        pygame.draw.rect(s, BORDER, rect, 1, border_radius=13)
        s.blit(img, (rect.x + 12, rect.y + 5))

    def _pills(self, items, x, y, max_x):
        F = self.fonts
        cx = x
        for text, dot in items:
            w = F["small"].size(text)[0] + 20 + (14 if dot else 0)
            if cx + w > max_x:
                cx, y = x, y + 30
            cx += pill(self.screen, F["small"], text, (cx, y), TEXT_2, dot=dot) + 8
        return y + 30

    def _draw_panel(self):
        s, F = self.screen, self.fonts
        x, w = self.PANEL_X, self.PANEL_W
        t = self.trainer

        # header
        draw_text(s, F["title"], "RL Robot Navigator", (x, 20))
        draw_text(s, F["small"], "Deep Q-Network  -  differential-drive robot  -  24-beam LiDAR", (x, 50), MUTED)
        state, scol = ("Paused", MUTED) if self.paused else ("Running", GOOD)
        mode = "Training" if self.mode == "train" else "Evaluating"
        sw = F["small"].size(state)[0] + 34
        mw = F["small"].size(mode)[0] + 34
        pill(s, F["small"], state, (x + w - sw, 24), TEXT, dot=scol)
        pill(s, F["small"], mode, (x + w - sw - mw - 8, 24), TEXT, dot=VIOLET if self.mode == "train" else BLUE)

        # status chips
        dens = f"{self.density:.2f}" if (self.mode == "eval" or self.train_density_override) else "random"
        chips = [(f"Policy: {self.policy_names[self.policy_idx]}" if self.mode == "eval" else "Policy: DQN (learning)",
                  BLUE),
                 ("Shield on" if self.shield else "Shield off", GOOD if self.shield else MUTED),
                 (f"Density {dens}", None), (f"Shapes: {SHAPES[self.shape_idx][0]}", None),
                 (f"{SPEEDS[self.speed_idx] * self.cfg.robot.control_dt:g}x speed", None)]
        if self.movers:
            chips.append((f"{self.movers} moving obstacles", ORANGE))
        if self.estop:
            chips.insert(0, ("E-STOP", CRITICAL))
        info = getattr(self, "last_info", None)
        if info and info["safety_reasons"]:
            chips.append(("Safety: " + info["safety_reasons"][0].replace("_", " "), WARNING))
        y = self._pills(chips, x, 82, x + w)

        # stat tiles
        y += 8
        tw = (w - 3 * 10) // 4
        dist = f"{info['distance_to_goal']:.2f}" if info else "-"
        path = f"driven {info['path_length']:.1f} m" if info else ""
        if self.mode == "eval":
            tiles = [("Episode", str(len(self.session["eval"]) + 1), f"map #{self.map_seed % 1000}", BLUE),
                     ("Step", str(self.ep_steps), f"of {self.cfg.training.max_episode_steps}", None),
                     ("Reward", f"{self.ep_return:.1f}", "cumulative", None),
                     ("To goal (m)", dist, path, GOOD)]
        else:
            tiles = [("Episode", str(t.episode + 1), f"step {self.ep_steps}", VIOLET),
                     ("Total steps", f"{t.total_steps:,}", f"epsilon {t.epsilon:.2f}", None),
                     ("Reward", f"{self.ep_return:.1f}", "this episode", None),
                     ("Replay buffer", f"{len(t.agent.buffer):,}", f"loss {t.last_loss:.3f}", None)]
        for i, (label, val, sub, acc) in enumerate(tiles):
            stat_tile(s, F, (x + i * (tw + 10), y, tw, 84), label, val, sub, acc)
        y += 96

        # session summary (status colours always paired with a text label)
        hist = self.session[self.mode]
        n = len(hist)
        rect = pygame.Rect(x, y, w, 106)
        pygame.draw.rect(s, SURFACE, rect, border_radius=12)
        pygame.draw.rect(s, BORDER, rect, 1, border_radius=12)
        draw_text(s, F["h"], "This session", (x + 14, y + 10))
        draw_text(s, F["small"], f"{n} episode{'' if n == 1 else 's'}", (x + w - 14, y + 13), MUTED, "topright")
        for i, (key, label, col) in enumerate((("success", "Success", GOOD), ("collision", "Collision", CRITICAL),
                                               ("timeout", "Timeout", WARNING))):
            k = sum(o == key for _, o in hist)
            frac = k / n if n else 0.0
            ry = y + 40 + i * 21
            draw_text(s, F["small"], label, (x + 14, ry), TEXT_2)
            progress_bar(s, (x + 96, ry + 6, w - 196, 8), frac, col)
            draw_text(s, F["small"], f"{frac:.0%}  ({k})", (x + w - 14, ry), TEXT, "topright")
        y += 116

        # charts
        win = 50 if self.mode == "train" else 10
        rets = [r for r, _ in hist][-300:]
        roll = lambda xs: [float(np.mean(xs[max(0, i - win + 1):i + 1])) for i in range(len(xs))]
        succ = roll([o == "success" for _, o in hist][-300:])
        coll = roll([o == "collision" for _, o in hist][-300:])
        draw_chart(s, F, (x, y, w, 146), [(roll(rets), BLUE, "Reward", False)],
                   f"Episode reward  (rolling {win})", fill=True)
        draw_chart(s, F, (x, y + 156, w, 146), [(succ, BLUE, "Success", False), (coll, ORANGE, "Collision", True)],
                   f"Outcome rate  (rolling {win})", y_range=(0, 1), fmt="{:.0%}")

        # controls
        for b in self.buttons:
            if b.key_hint == "SPACE":
                b.label = "Start" if self.paused else "Pause"
            elif b.key_hint == "M":
                b.label = "Evaluate" if self.mode == "train" else "Train"
            active = (b.key_hint == "S" and self.shield) or (b.key_hint == "M" and self.mode == "train") or \
                     (b.key_hint == "O" and self.movers > 0)
            b.draw(s, F, active, b.rect.collidepoint(self.mouse))
        draw_text(s, F["small"], "Click the map to move the goal    X  emergency stop    L  LiDAR    "
                  "K  save model    ESC  quit", (x, self.H - 44), MUTED)

    # ----------------------------------------------------------------- loop
    def handle_key(self, k):
        keymap = {
            pygame.K_SPACE: self.toggle_pause, pygame.K_r: lambda: self.new_episode(same_map=True),
            pygame.K_n: self.next_map, pygame.K_m: self.toggle_mode, pygame.K_p: self.cycle_policy,
            pygame.K_s: self.toggle_shield, pygame.K_x: self.toggle_estop,
            pygame.K_UP: lambda: self.change_density(0.05), pygame.K_DOWN: lambda: self.change_density(-0.05),
            pygame.K_o: self.toggle_movers, pygame.K_g: self.cycle_shapes,
            pygame.K_l: lambda: setattr(self, "show_beams", not self.show_beams),
            pygame.K_PLUS: lambda: self.change_speed(1), pygame.K_EQUALS: lambda: self.change_speed(1),
            pygame.K_KP_PLUS: lambda: self.change_speed(1), pygame.K_MINUS: lambda: self.change_speed(-1),
            pygame.K_KP_MINUS: lambda: self.change_speed(-1), pygame.K_k: self.save_live_model,
        }
        if k in keymap:
            keymap[k]()

    def save_live_model(self):
        if self.trainer:
            self.trainer.save("live.pt")
            self.message = f"saved {os.path.join(self.trainer.run_dir, 'live.pt')}"

    def run(self, max_frames=None):
        fps, frame, running = 30, 0, True
        while running:
            for e in pygame.event.get():
                if e.type == pygame.QUIT or (e.type == pygame.KEYDOWN and e.key == pygame.K_ESCAPE):
                    running = False
                elif e.type == pygame.KEYDOWN:
                    self.handle_key(e.key)
                elif e.type == pygame.MOUSEBUTTONDOWN and e.button == 1:
                    if not any(b.handle(e.pos) for b in self.buttons) and self.view.rect.collidepoint(e.pos):
                        self.set_goal(*e.pos)
            if not self.paused:
                self.step_budget += SPEEDS[self.speed_idx] / fps
                t_end = time.perf_counter() + 0.8 / fps          # keep the UI responsive
                while self.step_budget >= 1 and time.perf_counter() < t_end:
                    self.step_budget -= 1
                    self.eval_step() if self.mode == "eval" else self.train_step()
                self.step_budget = min(self.step_budget, 5)
            self.draw()
            self.clock.tick(fps)
            frame += 1
            if max_frames and frame >= max_frames:
                break
        if self.trainer:
            self.trainer.save("live.pt")
        pygame.quit()
