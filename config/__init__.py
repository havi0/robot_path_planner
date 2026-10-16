"""Configuration loading: YAML files -> attribute-accessible nested dicts."""
import copy
import os

import yaml

CONFIG_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(CONFIG_DIR, "default.yaml")
ROBOT_PROFILE = os.path.join(CONFIG_DIR, "robot_profile.yaml")


class Config(dict):
    """dict with attribute access: cfg.world.width == cfg["world"]["width"]."""

    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError as e:
            raise AttributeError(key) from e

    def __setattr__(self, key, value):
        self[key] = value

    def __deepcopy__(self, memo):
        return Config.wrap(copy.deepcopy(dict(self), memo))

    @staticmethod
    def wrap(obj):
        if isinstance(obj, dict):
            return Config({k: Config.wrap(v) for k, v in obj.items()})
        if isinstance(obj, list):
            return [Config.wrap(v) for v in obj]
        return obj


def _parse_value(text):
    return yaml.safe_load(text)


def load_config(path=None, overrides=None):
    """Load YAML config. `overrides` is a list like ["training.total_steps=1000"]."""
    with open(path or DEFAULT_CONFIG) as f:
        cfg = Config.wrap(yaml.safe_load(f))
    for item in overrides or []:
        key, _, value = item.partition("=")
        node = cfg
        *parents, leaf = key.strip().split(".")
        for p in parents:
            node = node[p]
        if leaf not in node:
            raise KeyError(f"Unknown config key: {key}")
        node[leaf] = Config.wrap(_parse_value(value))
    return cfg


def load_robot_profile(path=None):
    with open(path or ROBOT_PROFILE) as f:
        return Config.wrap(yaml.safe_load(f))


def save_config(cfg, path):
    def plain(o):
        if isinstance(o, dict):
            return {k: plain(v) for k, v in o.items()}
        if isinstance(o, list):
            return [plain(v) for v in o]
        return o

    with open(path, "w") as f:
        yaml.safe_dump(plain(cfg), f, sort_keys=False)
