"""Small CSV logger + run directory helpers."""
import csv
import os
import time

from config import save_config


def make_run_dir(base, prefix):
    path = os.path.join(base, f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}")
    os.makedirs(path, exist_ok=True)
    return path


class CSVLogger:
    def __init__(self, path):
        self.path = path
        self._writer = None
        self._file = None

    def log(self, row):
        if self._writer is None:
            new = not os.path.exists(self.path)
            self._file = open(self.path, "a", newline="")
            self._writer = csv.DictWriter(self._file, fieldnames=list(row.keys()))
            if new:
                self._writer.writeheader()
        self._writer.writerow(row)
        self._file.flush()

    def close(self):
        if self._file:
            self._file.close()


def plain(cfg):
    if isinstance(cfg, dict):
        return {k: plain(v) for k, v in cfg.items()}
    if isinstance(cfg, list):
        return [plain(v) for v in cfg]
    return cfg


def snapshot_config(cfg, run_dir):
    save_config(cfg, os.path.join(run_dir, "config.yaml"))
