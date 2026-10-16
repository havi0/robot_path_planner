"""Robot monitoring / teleoperation window. Works with ANY backend: the
simulation (no hardware needed) or the ROS 2 HardwareBackend.

Shows connection, pose, sensor health, requested vs executed commands and the
safety-layer state. It is separate from the training simulator on purpose: it
only talks to the robot through the RobotBackend interface.

Keys: SPACE emergency stop / release   arrows manual drive (override)
      D autonomous drive on/off (needs --drive and a model)   ESC quit
"""
import math
from collections import deque

import numpy as np
import pygame

from evaluation.evaluate import load_dqn
from navigation.actions import STOP, DiscreteActionSpace, VelocityCommand
from navigation.core import NavigationCore
from navigation.policies import DQNPolicy
from safety.safety_layer import SafetyLayer
from sensors.observation import observation_builder_from_config
from visualization.renderer import BAD, BG, BORDER, MUTED, OK, ROBOT, SERIOUS, SURFACE, TEXT, WARN, draw_text


class HardwareMonitor:
    W, H = 1000, 640

    def __init__(self, backend, cfg, model_path=None):
        pygame.init()
        pygame.display.set_caption(f"Robot monitor - {backend.name}")
        self.screen = pygame.display.set_mode((self.W, self.H))
        self.font = pygame.font.SysFont("consolas,monospace", 15)
        self.big = pygame.font.SysFont("segoeui,arial", 20, bold=True)
        self.backend, self.cfg = backend, cfg
        self.safety = SafetyLayer(cfg.safety, cfg.robot.radius)
        self.actions = DiscreteActionSpace.from_config(cfg)
        self.policy = None
        if model_path:
            agent, train_cfg = load_dqn(model_path)
            self.policy = DQNPolicy(agent)
            self.cfg = train_cfg
        self.core = NavigationCore(backend, observation_builder_from_config(self.cfg), self.actions,
                                   self.cfg.robot.control_dt, self.cfg.world.goal_radius, self.safety)
        world = getattr(backend, "world", None)
        pose = backend.get_pose()
        self.goal = world.goal if world is not None else \
            ((pose.x + 2 * math.cos(pose.theta), pose.y + 2 * math.sin(pose.theta)) if pose else (2.0, 0.0))
        self.autonomous = False
        self.trail = deque(maxlen=3000)
        self.last_decision = None
        self.requested = STOP

    def _manual_command(self):
        keys = pygame.key.get_pressed()
        v = self.cfg.safety.max_linear_speed * (keys[pygame.K_UP] - (keys[pygame.K_DOWN] if self.cfg.safety.allow_reverse else 0))
        w = 1.0 * (keys[pygame.K_LEFT] - keys[pygame.K_RIGHT])
        return VelocityCommand(float(v), float(w)), bool(v or w)

    def tick(self):
        dt = self.cfg.robot.control_dt
        manual, pressed = self._manual_command()
        if pressed:
            self.safety.override.engage(manual)
        else:
            self.safety.override.release()
        if self.autonomous and self.policy and not pressed:
            if self.core.goal is None:
                self.core.begin(self.goal)
            obs = self.core._observe(self.core.last_reading, self.core.last_pose)
            action = self.policy.act(obs, self.core.last_pose, self.goal) if obs is not None else \
                self.actions.index_of("stop")
            res = self.core.step(action)
            self.requested, self.last_decision = res.requested, res.safety
            if res.reached:
                self.autonomous = False
        else:
            self.core.goal = None
            reading = self.backend.read_sensors()
            self.requested = manual if pressed else STOP
            d = self.safety.filter(self.requested, reading, self.backend.now(), self.backend.is_connected(), dt)
            self.backend.send_command(d.command)
            self.backend.wait(dt)
            self.last_decision = d
        p = self.backend.get_pose()
        if p:
            self.trail.append((p.x, p.y))

    def draw(self):
        s, f = self.screen, self.font
        s.fill(BG)
        b = self.backend
        connected = b.is_connected()
        pose, reading, now = b.get_pose(), b.read_sensors(), b.now()
        x, y = 20, 16
        y += draw_text(s, self.big, f"Backend: {b.name}", (x, y)) + 8
        rows = [
            (f"Connection   : {'OK' if connected else 'LOST'}", OK if connected else BAD),
            (f"E-stop       : {'ENGAGED (' + str(self.safety.estop.reason) + ')' if self.safety.estop.engaged else 'released'}",
             BAD if self.safety.estop.engaged else OK),
            (f"Mode         : {'AUTONOMOUS (DQN)' if self.autonomous else 'manual / idle'}", WARN if self.autonomous else TEXT),
        ]
        if pose:
            rows.append((f"Pose         : x={pose.x:6.2f}  y={pose.y:6.2f}  th={math.degrees(pose.theta):7.1f} deg"
                         f"  age={now - pose.timestamp:.2f}s", TEXT))
        else:
            rows.append(("Pose         : NO DATA", BAD))
        if reading is not None:
            age = now - reading.timestamp
            stale = age > self.cfg.safety.sensor_timeout
            rows.append((f"Range sensor : {reading.valid_fraction:.0%} beams valid  min "
                         f"{np.nanmin(reading.ranges) if reading.valid_mask.any() else float('nan'):.2f} m  age {age:.2f}s",
                         BAD if stale or reading.valid_fraction < self.cfg.safety.min_valid_beam_fraction else TEXT))
        else:
            rows.append(("Range sensor : NO DATA", BAD))
        d = self.last_decision
        rows.append((f"Requested    : v={self.requested.v:5.2f} m/s  w={self.requested.w:5.2f} rad/s", TEXT))
        if d:
            rows.append((f"Executed     : v={d.command.v:5.2f} m/s  w={d.command.w:5.2f} rad/s", TEXT))
            rows.append((f"Safety       : {', '.join(d.reasons) if d.reasons else 'nominal'}", WARN if d.reasons else OK))
        rows.append((f"Goal         : ({self.goal[0]:.2f}, {self.goal[1]:.2f})", MUTED))
        for text, col in rows:
            y += draw_text(s, f, text, (x, y), col) + 4
        draw_text(s, f, "SPACE e-stop   arrows manual drive   D autonomous   ESC quit", (x, self.H - 30), MUTED)

        # polar scan (robot frame, forward = up)
        cx, cy, R = 760, 200, 170
        pygame.draw.circle(s, SURFACE, (cx, cy), R)
        pygame.draw.circle(s, BORDER, (cx, cy), R, 1)
        if reading is not None:
            scale = R / reading.max_range
            for r, a in zip(reading.ranges, reading.angles):
                ok = np.isfinite(r)
                rr = r if ok else reading.max_range
                end = (cx - rr * scale * math.sin(a), cy - rr * scale * math.cos(a))
                pygame.draw.line(s, SERIOUS if ok and rr < 0.5 else (60, 80, 110) if ok else BAD, (cx, cy), end, 1)
        pygame.draw.circle(s, ROBOT, (cx, cy), int(self.cfg.robot.radius * R / self.cfg.sensor.max_range) + 2)
        draw_text(s, f, "range scan (forward = up)", (cx - 90, cy + R + 6), MUTED)

        # odometry trail
        box = pygame.Rect(560, 400, 420, 200)
        pygame.draw.rect(s, SURFACE, box)
        pygame.draw.rect(s, BORDER, box, 1)
        pts = list(self.trail) + [self.goal]
        if len(pts) >= 2:
            xs, ys = zip(*pts)
            span = max(max(xs) - min(xs), max(ys) - min(ys), 1.0)
            sc = min(box.w, box.h) * 0.9 / span
            mx, my = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
            tp = lambda p: (box.centerx + (p[0] - mx) * sc, box.centery - (p[1] - my) * sc)
            if len(self.trail) >= 2:
                pygame.draw.lines(s, ROBOT, False, [tp(p) for p in self.trail], 2)
            pygame.draw.circle(s, OK, tp(self.goal), 6)
        draw_text(s, f, "odometry trail", (box.x + 6, box.y + 4), MUTED)
        pygame.display.flip()

    def run(self, max_frames=None):
        clock, frame, running = pygame.time.Clock(), 0, True
        while running:
            for e in pygame.event.get():
                if e.type == pygame.QUIT or (e.type == pygame.KEYDOWN and e.key == pygame.K_ESCAPE):
                    running = False
                elif e.type == pygame.KEYDOWN and e.key == pygame.K_SPACE:
                    if self.safety.estop.engaged:
                        self.safety.estop.reset()
                    else:
                        self.safety.estop.trigger("operator")
                        self.autonomous = False
                        self.backend.stop()
                elif e.type == pygame.KEYDOWN and e.key == pygame.K_d and self.policy:
                    self.autonomous = not self.autonomous
            self.tick()
            self.draw()
            if not hasattr(self.backend, "new_episode"):
                clock.tick(60)        # hardware: backend.wait() already paces the loop
            else:
                clock.tick(1 / self.cfg.robot.control_dt)
            frame += 1
            if max_frames and frame >= max_frames:
                break
        self.backend.stop()
        pygame.quit()
