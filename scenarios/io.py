"""World <-> JSON serialisation (scenarios, recorded episodes)."""
import numpy as np

from environment.world import World


def world_to_dict(w):
    """Lossless (full float precision) so a saved world re-simulates bit-for-bit."""
    return {
        "width": float(w.width), "height": float(w.height),
        "rects": np.asarray(w.static_rects, dtype=float).tolist(),
        "timed": np.asarray(w.timed, dtype=float).tolist(),
        "movers": np.asarray(w.movers, dtype=float).tolist(),
        "mover_radius": float(w.mover_radius),
        "start": [float(v) for v in w.start],
        "goal": [float(v) for v in w.goal],
    }


def world_from_dict(d):
    return World(d["width"], d["height"], d.get("rects", []), tuple(d["start"]), tuple(d["goal"]),
                 movers=np.asarray(d.get("movers", []), dtype=np.float64).reshape(-1, 4),
                 mover_radius=d.get("mover_radius", 0.2), timed=d.get("timed") or None)
