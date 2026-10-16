"""NEXUS studio backend (FastAPI).

REST for commands, one WebSocket (/ws) streaming live state. Long-running work
(simulation loop, training, evaluation, hardware control) runs in background
threads, never on the asyncio event loop.
"""
import asyncio
import contextlib
import io
import json
import logging
import os
import platform
import sys
import time
from typing import List, Optional

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import torch  # noqa: E402
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, Response  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from config import load_config, load_robot_profile  # noqa: E402
from server.events import EventLog  # noqa: E402
from server.experiments import ExperimentStore  # noqa: E402
from server.hardware_service import HardwareBridge, HardwareError  # noqa: E402
from server.models import ModelRegistry  # noqa: E402
from server.planner_service import PlannerError, compare  # noqa: E402
from server.sim_session import RobotFitError, SimSession, ValidationError  # noqa: E402
from navigation import robots as robot_catalog  # noqa: E402
from server.training_manager import TrainingError, TrainingManager  # noqa: E402
from server import routes_research  # noqa: E402
from server.catalog import ModelCatalog, compatibility_issues  # noqa: E402
from server.copilot import Copilot  # noqa: E402
from server.jobs import JobManager  # noqa: E402
from server.research import ResearchError, ResearchService  # noqa: E402
from server.stores import EpisodeStore, JsonCollection  # noqa: E402

VERSION = "2.0.0"
log = logging.getLogger("nexus")


def clean(obj):
    """JSON-safe copy: NaN/inf -> None (undefined metrics), numpy scalars/arrays -> Python."""
    import math
    import numpy as np
    if isinstance(obj, dict):
        return {str(k): clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return clean(obj.tolist())
    if isinstance(obj, np.generic):
        obj = obj.item()
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    return obj


class SafeJSONResponse(JSONResponse):
    def render(self, content):
        return json.dumps(clean(content), ensure_ascii=False, separators=(",", ":")).encode("utf-8")


# ---------------------------------------------------------------- request models
class ControlReq(BaseModel):
    action: str


class SpeedReq(BaseModel):
    steps_per_second: float


class PolicyReq(BaseModel):
    policy: str


class ShieldReq(BaseModel):
    enabled: bool


class SimConfigReq(BaseModel):
    width: Optional[float] = None
    height: Optional[float] = None
    density: Optional[float] = None
    num_obstacles: Optional[int] = None
    dynamic_obstacles: Optional[int] = None
    seed: Optional[int] = None
    max_linear: Optional[float] = None
    max_angular: Optional[float] = None


class PointReq(BaseModel):
    x: float
    y: float
    theta: Optional[float] = None


class ObstacleReq(BaseModel):
    action: str                                  # add | remove | clear
    rect: Optional[List[float]] = None
    x: Optional[float] = None
    y: Optional[float] = None


class TrainReq(BaseModel):
    name: str
    algorithm: str = "dqn"
    episodes: int = 1000
    lr: Optional[float] = None
    gamma: Optional[float] = None
    eps_start: Optional[float] = None
    eps_end: Optional[float] = None
    eps_decay: Optional[int] = None
    buffer_size: Optional[int] = None
    batch_size: Optional[int] = None
    target_update: Optional[int] = None
    alpha: Optional[float] = None
    seed: Optional[int] = None
    density_min: Optional[float] = None
    density_max: Optional[float] = None
    randomization: Optional[bool] = None
    eval_every: Optional[int] = None
    curriculum: Optional[dict] = None
    robot: Optional[dict] = None          # {"id": ..., "custom": {...}}; omitted = reference robot


class RobotSelectReq(BaseModel):
    id: str
    custom: Optional[dict] = None
    regenerate: bool = False


class EvalReq(BaseModel):
    experiment_id: str
    checkpoint: Optional[str] = None
    episodes: int = 50


class LoadReq(BaseModel):
    experiment_id: str
    checkpoint: Optional[str] = None


class RenameReq(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class CompareReq(BaseModel):
    algorithms: List[str]
    source: str = "current"
    seed: Optional[int] = None
    density: Optional[float] = None
    trials: int = 0


class ModeReq(BaseModel):
    mode: str


class ConnectReq(BaseModel):
    backend: str


class ArmReq(BaseModel):
    confirmation: str


class EstopReq(BaseModel):
    engaged: bool


class ManualReq(BaseModel):
    v: float
    w: float


class DeployReq(BaseModel):
    goal: Optional[List[float]] = None


# ---------------------------------------------------------------- app factory
def create_app(data_dir=None, dqn_path=None, q_path=None, broadcast_hz=15.0):
    data_dir = data_dir or os.path.join(ROOT, "data")
    os.makedirs(os.path.join(data_dir, "logs"), exist_ok=True)
    if not log.handlers:
        log.setLevel(logging.INFO)
        fh = logging.FileHandler(os.path.join(data_dir, "logs", "server.log"), encoding="utf-8")
        fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        log.addHandler(fh)
        sh = logging.StreamHandler()
        sh.setFormatter(logging.Formatter("%(levelname)s  %(message)s"))
        log.addHandler(sh)

    cfg = load_config()
    state = {"operating_mode": "simulation", "clients": set()}

    @contextlib.asynccontextmanager
    async def lifespan(app):
        os.chdir(ROOT)
        events = EventLog()
        models = ModelRegistry(dqn_path or os.path.join(ROOT, "models", "dqn.pt"),
                               q_path or os.path.join(ROOT, "models", "qlearning.pt"))
        store = ExperimentStore(os.path.join(data_dir, "experiments"))
        store.import_reference_runs(ROOT)
        sim = SimSession(cfg, models, events)
        training = TrainingManager(cfg, store, models, events)
        hardware = HardwareBridge(cfg, load_robot_profile(), models, events, state)

        # ---- NEXUS 2.0 research services
        catalog = ModelCatalog(os.path.join(data_dir, "models", "catalog.json"))
        catalog.sync_from_experiments(store)
        episodes = EpisodeStore(os.path.join(data_dir, "episodes"))
        scenarios = JsonCollection(os.path.join(data_dir, "scenarios"), "sc")
        sets = JsonCollection(os.path.join(data_dir, "scenario_sets"), "set")
        runs = JsonCollection(os.path.join(data_dir, "runs"), "run")
        designs = JsonCollection(os.path.join(data_dir, "designs"), "design")
        jobs = JobManager(os.path.join(data_dir, "jobs.json"), events)
        research = ResearchService(cfg, episodes, scenarios, sets, runs, designs, catalog, store, models, jobs, events)
        copilot = Copilot(research, store, episodes, catalog, runs, designs)

        def model_meta(policy_key):
            entry = models.get("dqn" if policy_key in ("dqn", "dqn_recovery") else "qlearning")                 if policy_key in ("dqn", "dqn_recovery", "qlearning") else None
            if not entry:
                return None
            mid = catalog.id_for_path(entry[2]["path"]) or catalog.register(entry[2]["path"])["model_id"]
            return catalog.provenance(mid)

        sim.on_episode = episodes.save
        sim.model_meta = model_meta
        robot_file = os.path.join(data_dir, "robot_selection.json")

        def save_robot(sel):
            tmp = robot_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(sel, f)
            os.replace(tmp, robot_file)

        if os.path.exists(robot_file):                  # restore the user's last robot choice
            try:
                with open(robot_file, encoding="utf-8") as f:
                    sel = json.load(f)
                if sel.get("id") and sel["id"] != robot_catalog.REFERENCE:
                    sim.select_robot(sel["id"], sel.get("custom"), regenerate=True)
            except Exception as e:
                events.emit("warning", "robot", f"Saved robot selection ignored: {e}")
        sim.on_robot_change = save_robot
        training.on_finished = lambda exp_id: [catalog.register(c["path"], store.get(exp_id))
                                               for c in store.get(exp_id)["checkpoints"]]
        app.state.svc = dict(events=events, models=models, store=store, sim=sim, training=training,
                             hardware=hardware, state=state, cfg=cfg, catalog=catalog, episodes=episodes,
                             scenarios=scenarios, sets=sets, runs=runs, designs=designs, jobs=jobs,
                             research=research, copilot=copilot)
        sim.start_thread()
        hardware.start_thread()
        jobs.start()
        events.emit("success", "system", f"Backend online - NEXUS {VERSION}")
        task = asyncio.create_task(_broadcaster(app, broadcast_hz))
        try:
            yield
        finally:
            task.cancel()
            jobs.shutdown()
            training.shutdown()
            hardware.shutdown()
            sim.shutdown()

    app = FastAPI(title="NEXUS Robotics Studio API", version=VERSION, lifespan=lifespan,
                  default_response_class=SafeJSONResponse)

    def svc(request_or_app, name):
        return request_or_app.app.state.svc[name] if hasattr(request_or_app, "app") else request_or_app.state.svc[name]

    @app.exception_handler(ValidationError)
    @app.exception_handler(TrainingError)
    @app.exception_handler(PlannerError)
    @app.exception_handler(HardwareError)
    @app.exception_handler(ResearchError)
    async def _bad_request(request, exc):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(KeyError)
    async def _not_found(request, exc):
        return JSONResponse(status_code=404, content={"detail": f"not found: {exc}"})

    # ------------------------------------------------------------ system
    @app.get("/api/health")
    def health(request: Request):
        return {"status": "ok", "version": VERSION, "time": time.time(), "python": platform.python_version(),
                "torch": torch.__version__, "ros2_available": svc(request, "hardware").snapshot()["ros2_available"],
                "models": svc(request, "models").describe()}

    @app.get("/api/state")
    def full_state(request: Request):
        s = request.app.state.svc
        return {"sim": s["sim"].snapshot(), "training": s["training"].summary(), "hardware": s["hardware"].snapshot(),
                "events": s["events"].recent(100), "operating_mode": s["state"]["operating_mode"],
                "models": s["models"].describe(), "version": VERSION}

    @app.get("/api/events")
    def events(request: Request, limit: int = 100):
        return svc(request, "events").recent(min(max(limit, 1), 500))

    @app.post("/api/mode")
    def set_mode(req: ModeReq, request: Request):
        if req.mode not in ("simulation", "hardware"):
            raise HTTPException(400, "mode must be 'simulation' or 'hardware'")
        hw = svc(request, "hardware")
        if req.mode == "simulation" and (hw.armed or hw.mode != "idle"):
            hw.disarm("switched to simulation mode")
        svc(request, "state")["operating_mode"] = req.mode
        svc(request, "events").emit("info", "system", f"Operating mode: {req.mode}")
        return {"operating_mode": req.mode}

    # ------------------------------------------------------------ simulation
    @app.get("/api/sim/state")
    def sim_state(request: Request):
        return svc(request, "sim").snapshot()

    @app.post("/api/sim/control")
    def sim_control(req: ControlReq, request: Request):
        svc(request, "sim").control(req.action)
        return svc(request, "sim").snapshot()

    @app.post("/api/sim/speed")
    def sim_speed(req: SpeedReq, request: Request):
        svc(request, "sim").set_speed(req.steps_per_second)
        return {"speed": req.steps_per_second}

    @app.post("/api/sim/policy")
    def sim_policy(req: PolicyReq, request: Request):
        svc(request, "sim").set_policy(req.policy)
        return {"policy": req.policy}

    @app.get("/api/robots")
    def robots_list(request: Request):
        return {"robots": robot_catalog.catalog(), **svc(request, "sim").robot_state()}

    @app.post("/api/robots/select")
    def robots_select(req: RobotSelectReq, request: Request):
        sim = svc(request, "sim")
        try:
            notes = sim.select_robot(req.id, req.custom, req.regenerate)
        except RobotFitError as e:
            raise HTTPException(409, str(e)) from None
        return {"notes": notes, **sim.robot_state()}

    @app.post("/api/sim/shield")
    def sim_shield(req: ShieldReq, request: Request):
        svc(request, "sim").set_shield(req.enabled)
        return {"shield": req.enabled}

    @app.post("/api/sim/config")
    def sim_config(req: SimConfigReq, request: Request):
        svc(request, "sim").apply_config(req.model_dump(exclude_unset=True))
        return svc(request, "sim").snapshot()

    @app.post("/api/sim/goal")
    def sim_goal(req: PointReq, request: Request):
        svc(request, "sim").set_goal(req.x, req.y)
        return {"ok": True}

    @app.post("/api/sim/start")
    def sim_start(req: PointReq, request: Request):
        svc(request, "sim").set_start(req.x, req.y, req.theta)
        return {"ok": True}

    @app.post("/api/sim/obstacles")
    def sim_obstacles(req: ObstacleReq, request: Request):
        sim = svc(request, "sim")
        if req.action == "add":
            if not req.rect or len(req.rect) != 4:
                raise HTTPException(400, "rect must be [x0, y0, x1, y1]")
            sim.add_obstacle(req.rect)
        elif req.action == "remove":
            if req.x is None or req.y is None:
                raise HTTPException(400, "x and y are required")
            sim.remove_obstacle(req.x, req.y)
        elif req.action == "clear":
            sim.clear_obstacles()
        else:
            raise HTTPException(400, "action must be add, remove or clear")
        return {"ok": True}

    # ------------------------------------------------------------ training
    @app.get("/api/training/state")
    def training_state(request: Request):
        return svc(request, "training").summary()

    @app.get("/api/training/episodes")
    def training_episodes(request: Request, since: int = 0):
        return svc(request, "training").episodes_since(max(0, since))

    @app.post("/api/training/start")
    def training_start(req: TrainReq, request: Request):
        return svc(request, "training").start(req.model_dump(exclude_none=True))

    @app.post("/api/training/{action}")
    def training_action(action: str, request: Request):
        t = svc(request, "training")
        fn = {"pause": t.pause, "resume": t.resume, "stop": t.stop, "checkpoint": t.request_checkpoint}.get(action)
        if fn is None:
            raise HTTPException(404, "unknown action")
        fn()
        return t.summary()

    @app.post("/api/evaluate")
    def evaluate(req: EvalReq, request: Request):
        return svc(request, "training").evaluate(req.experiment_id, req.checkpoint, req.episodes)

    @app.post("/api/checkpoints/load")
    def load_checkpoint(req: LoadReq, request: Request):
        store, models = svc(request, "store"), svc(request, "models")
        meta = store.get(req.experiment_id)
        if not meta["checkpoints"]:
            raise HTTPException(400, "experiment has no checkpoints")
        names = [c["name"] for c in meta["checkpoints"]]
        name = req.checkpoint or ("best.pt" if "best.pt" in names else names[-1])
        entry = svc(request, "catalog").register(store.checkpoint_path(req.experiment_id, name), meta)
        issues = compatibility_issues(entry["interface"], svc(request, "cfg"))
        if issues:
            raise HTTPException(409, "Refusing to load an incompatible model: " + "; ".join(issues))
        info = models.load(meta["algorithm"], store.checkpoint_path(req.experiment_id, name),
                           {"experiment_id": meta["id"], "label": f"{meta['name']} / {name}"})
        sim = svc(request, "sim")
        with sim.lock:
            sim._use_model_observation()
            sim._reset_episode()
        svc(request, "events").emit("success", "checkpoint", f"Loaded {meta['name']} / {name} into the simulator")
        return {**info, "model_id": entry["model_id"]}

    # ------------------------------------------------------------ experiments
    @app.get("/api/experiments")
    def experiments(request: Request):
        return svc(request, "store").list()

    @app.get("/api/experiments/{exp_id}")
    def experiment(exp_id: str, request: Request):
        return svc(request, "store").get(exp_id)

    @app.get("/api/experiments/{exp_id}/metrics")
    def experiment_metrics(exp_id: str, request: Request):
        t = svc(request, "training")
        if exp_id == t.experiment_id and t.status in ("running", "paused", "stopping"):
            return t.episodes_since(0)
        return svc(request, "store").metrics(exp_id)

    @app.patch("/api/experiments/{exp_id}")
    def rename_experiment(exp_id: str, req: RenameReq, request: Request):
        return svc(request, "store").update(exp_id, name=req.name.strip())

    @app.delete("/api/experiments/{exp_id}")
    def delete_experiment(exp_id: str, request: Request):
        t = svc(request, "training")
        if exp_id == t.experiment_id and t.status in ("running", "paused", "stopping"):
            raise HTTPException(409, "Stop the training run before deleting its experiment")
        meta = svc(request, "store").get(exp_id)
        if meta.get("imported"):
            raise HTTPException(409, "Reference experiments are read-only")
        svc(request, "store").delete(exp_id)
        svc(request, "events").emit("warning", "experiment", f"Experiment deleted: {meta['name']}")
        return {"ok": True}

    @app.get("/api/experiments/{exp_id}/export")
    def export_experiment(exp_id: str, request: Request, format: str = "json"):
        store = svc(request, "store")
        meta = store.get(exp_id)
        if format == "csv":
            path = store.metrics_csv_path(exp_id)
            body = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
            return Response(body, media_type="text/csv",
                            headers={"Content-Disposition": f'attachment; filename="{exp_id}-metrics.csv"'})
        if format != "json":
            raise HTTPException(400, "format must be csv or json")
        payload = clean({"experiment": meta, "metrics": store.metrics(exp_id)})
        return Response(json.dumps(payload, indent=2), media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="{exp_id}.json"'})

    # ------------------------------------------------------------ planner
    @app.post("/api/planner/compare")
    async def planner_compare(req: CompareReq, request: Request):
        s = request.app.state.svc
        return await asyncio.to_thread(compare, s["sim"], s["models"], req.algorithms, req.source, req.seed,
                                       req.density, req.trials)

    # ------------------------------------------------------------ hardware
    @app.get("/api/hardware/state")
    def hw_state(request: Request):
        return svc(request, "hardware").snapshot()

    @app.get("/api/hardware/profile")
    def hw_profile(request: Request):
        from training.logger import plain
        return plain(load_robot_profile())

    @app.post("/api/hardware/connect")
    async def hw_connect(req: ConnectReq, request: Request):
        await asyncio.to_thread(svc(request, "hardware").connect, req.backend)
        return svc(request, "hardware").snapshot()

    @app.post("/api/hardware/disconnect")
    def hw_disconnect(request: Request):
        svc(request, "hardware").disconnect()
        return svc(request, "hardware").snapshot()

    @app.post("/api/hardware/arm")
    def hw_arm(req: ArmReq, request: Request):
        svc(request, "hardware").arm(req.confirmation)
        return svc(request, "hardware").snapshot()

    @app.post("/api/hardware/disarm")
    def hw_disarm(request: Request):
        svc(request, "hardware").disarm()
        return svc(request, "hardware").snapshot()

    @app.post("/api/hardware/estop")
    def hw_estop(req: EstopReq, request: Request):
        svc(request, "hardware").set_estop(req.engaged)
        return svc(request, "hardware").snapshot()

    @app.post("/api/hardware/manual")
    def hw_manual(req: ManualReq, request: Request):
        svc(request, "hardware").manual(req.v, req.w)
        return {"ok": True}

    @app.post("/api/hardware/deploy")
    def hw_deploy(req: DeployReq, request: Request):
        if req.goal is not None and len(req.goal) != 2:
            raise HTTPException(400, "goal must be [x, y]")
        svc(request, "hardware").deploy(req.goal)
        return svc(request, "hardware").snapshot()

    @app.post("/api/hardware/stop")
    def hw_stop(request: Request):
        svc(request, "hardware").stop_motion()
        return svc(request, "hardware").snapshot()

    # ------------------------------------------------------------ websocket
    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket):
        await ws.accept()
        state["clients"].add(ws)
        s = ws.app.state.svc
        await ws.send_text(json.dumps(clean({"type": "hello", "version": VERSION,
                                             "operating_mode": state["operating_mode"],
                                             "events": s["events"].recent(100), "models": s["models"].describe(),
                                             "training_episodes": s["training"].episodes_since(0)[-3000:]})))
        try:
            while True:
                await ws.receive_text()           # keep-alive pings from the client
        except WebSocketDisconnect:
            pass
        finally:
            state["clients"].discard(ws)

    routes_research.register(app)

    # ------------------------------------------------------------ static frontend
    dist = os.path.join(ROOT, "studio", "dist")
    if os.path.isdir(dist):
        app.mount("/assets", StaticFiles(directory=os.path.join(dist, "assets")), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            f = os.path.join(dist, path)
            if path and os.path.isfile(f) and os.path.commonpath([os.path.abspath(f), dist]) == os.path.abspath(dist):
                return FileResponse(f)
            return FileResponse(os.path.join(dist, "index.html"))

    return app


async def _broadcaster(app, hz):
    """Pushes live state to every connected client. Snapshots are built in a worker
    thread so a busy simulation/training thread never stalls the event loop."""
    s = app.state.svc
    last_event = s["events"].seq
    sent_episodes = len(s["training"].episodes)
    last_exp = s["training"].experiment_id
    while True:
        await asyncio.sleep(1.0 / hz)
        clients = list(s["state"]["clients"])
        tr = s["training"]
        if tr.experiment_id != last_exp:
            last_exp, sent_episodes = tr.experiment_id, 0
        new_events = s["events"].since(last_event)
        if new_events:
            last_event = new_events[-1]["seq"]
        episodes = tr.episodes_since(sent_episodes)
        sent_episodes += len(episodes)
        if not clients:
            continue
        try:
            snap = await asyncio.to_thread(lambda: {
                "type": "tick", "time": time.time(), "operating_mode": s["state"]["operating_mode"],
                "sim": s["sim"].snapshot(), "training": tr.summary(), "hardware": s["hardware"].snapshot(),
                "events": new_events, "episodes": episodes, "models": s["models"].describe(),
                "jobs": s["jobs"].active()})
            text = json.dumps(clean(snap))
        except Exception:
            log.exception("snapshot failed")
            continue
        for ws in clients:
            try:
                await ws.send_text(text)
            except Exception:
                s["state"]["clients"].discard(ws)


app = None  # created by `python main.py studio` / uvicorn --factory server.app:create_app
