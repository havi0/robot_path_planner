"""Matplotlib figures for training runs and experiments."""
import csv
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

METHOD_COLORS = {"DQN": "#d62728", "DQN + recovery": "#e377c2", "DQN + recovery + shield": "#8c564b", "Q-learning": "#1f77b4",
                 "A*": "#2ca02c", "Dijkstra": "#9467bd"}


def read_csv(path):
    with open(path) as f:
        return list(csv.DictReader(f))


def _smooth(x, w):
    x = np.asarray(x, dtype=float)
    w = max(1, min(w, len(x)))
    return np.convolve(x, np.ones(w) / w, mode="valid")


def plot_training_run(run_dir, title, window=100):
    eps = read_csv(os.path.join(run_dir, "episodes.csv"))
    evals_path = os.path.join(run_dir, "evals.csv")
    evals = read_csv(evals_path) if os.path.exists(evals_path) else []
    x = np.array([int(e["total_steps"]) for e in eps])
    ret = [float(e["return"]) for e in eps]
    succ = [e["outcome"] == "success" for e in eps]
    coll = [e["outcome"] == "collision" for e in eps]

    fig, axes = plt.subplots(1, 3, figsize=(16, 4.3))
    xs = x[len(x) - len(_smooth(ret, window)):]
    axes[0].plot(x, ret, color="#cccccc", lw=0.5)
    axes[0].plot(xs, _smooth(ret, window), color="#d62728")
    axes[0].set(title=f"{title}: episode return", xlabel="environment steps", ylabel="return")
    axes[1].plot(xs, _smooth(succ, window), label="success", color="#2ca02c")
    axes[1].plot(xs, _smooth(coll, window), label="collision", color="#d62728")
    axes[1].set(title=f"Training episodes (moving avg {window})", xlabel="environment steps", ylim=(0, 1))
    axes[1].legend()
    if evals:
        ex = [int(e["total_steps"]) for e in evals]
        for key, lab, col in (("success_rate", "success", "#2ca02c"), ("collision_rate", "collision", "#d62728"),
                              ("timeout_rate", "timeout", "#ff7f0e")):
            axes[2].plot(ex, [float(e[key]) for e in evals], "-o", ms=3, label=lab, color=col)
        axes[2].set(title="Greedy policy on validation maps", xlabel="environment steps", ylim=(0, 1))
        axes[2].legend()
    for ax in axes:
        ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(os.path.join(run_dir, "training_curves.png"), dpi=120)
    plt.close(fig)


def plot_sweep(rows, x_key, x_label, title, path, metrics=("success_rate", "collision_rate")):
    """rows: list of dicts with 'method', x_key and metric columns."""
    methods = list(dict.fromkeys(r["method"] for r in rows))
    fig, axes = plt.subplots(1, len(metrics), figsize=(6 * len(metrics), 4.3))
    axes = np.atleast_1d(axes)
    for ax, metric in zip(axes, metrics):
        for m in methods:
            pts = sorted((float(r[x_key]), float(r[metric])) for r in rows if r["method"] == m)
            ax.plot(*zip(*pts), "-o", label=m, color=METHOD_COLORS.get(m))
            if metric == "success_rate":
                lo = sorted((float(r[x_key]), float(r["success_ci_low"])) for r in rows if r["method"] == m)
                hi = sorted((float(r[x_key]), float(r["success_ci_high"])) for r in rows if r["method"] == m)
                ax.fill_between([p[0] for p in lo], [p[1] for p in lo], [p[1] for p in hi],
                                color=METHOD_COLORS.get(m), alpha=0.12)
        ax.set(title=metric.replace("_", " "), xlabel=x_label)
        if metric.endswith("rate"):
            ax.set_ylim(-0.02, 1.02)
        ax.grid(alpha=0.3)
        ax.legend()
    fig.suptitle(title)
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def plot_comparison_bars(stats_by_method, path, title):
    methods = list(stats_by_method)
    metrics = [("success_rate", "Success rate"), ("collision_rate", "Collision rate"),
               ("mean_path_ratio_success", "Path length / shortest"),
               ("mean_steps_success", "Steps to goal"),
               ("mean_inference_ms", "Decision time / step (ms)"),
               ("mean_planning_ms", "Up-front planning time (ms)")]
    fig, axes = plt.subplots(2, 3, figsize=(15, 7.5))
    for ax, (key, label) in zip(axes.flat, metrics):
        vals = [stats_by_method[m][key] for m in methods]
        bars = ax.bar(methods, vals, color=[METHOD_COLORS.get(m, "#888") for m in methods])
        ax.bar_label(bars, fmt="%.2f", fontsize=8)
        ax.set_title(label)
        ax.tick_params(axis="x", rotation=20)
        ax.grid(alpha=0.3, axis="y")
    fig.suptitle(title)
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def plot_trajectories(world, trajectories, path, title, plans=None, cfg=None):
    """trajectories: {method_name: [(x, y), ...]}"""
    from matplotlib.patches import Circle, Rectangle
    fig, ax = plt.subplots(figsize=(6.5, 6.5))
    for xmin, ymin, xmax, ymax in world.rects:
        ax.add_patch(Rectangle((xmin, ymin), xmax - xmin, ymax - ymin, color="#555555"))
    for name, plan in (plans or {}).items():
        if plan:
            ax.plot(*zip(*plan), ":", color=METHOD_COLORS.get(name), lw=1.2, label=f"{name} plan")
    styles = ["-", "--", ":", "-."]
    for i, (name, traj) in enumerate(trajectories.items()):
        if traj:
            col = METHOD_COLORS.get(name.split(" (")[0])     # labels may carry "(outcome)"
            ax.plot(*zip(*traj), styles[i % len(styles)], lw=2.2, color=col, label=name)
            ax.plot(*traj[-1], "o", color=col)
    ax.plot(*world.start[:2], "s", color="#2ca02c", ms=10, label="start")
    gr = cfg.world.goal_radius if cfg else 0.3
    ax.add_patch(Circle(world.goal, gr, color="#ff7f0e", alpha=0.35))
    ax.plot(*world.goal, "*", color="#ff7f0e", ms=16, label="goal")
    ax.set(xlim=(0, world.width), ylim=(0, world.height), aspect="equal", title=title)
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.06), ncol=3, fontsize=8)
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)
