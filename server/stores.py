"""Persistent stores for recorded episodes, scenarios, scenario sets, benchmark runs
and experiment designs. JSON on disk; episodes are gzip-compressed with a
line-delimited index for fast filtering."""
import gzip
import json
import os
import re
import threading
import time
import uuid

_ID = re.compile(r"^[A-Za-z0-9_\-.]+$")


def _safe(i):
    if not i or not _ID.match(i):
        raise KeyError(i)
    return i


def _write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


class EpisodeStore:
    INDEX_FIELDS = ("id", "created", "source", "label", "policy", "policy_name", "run_id", "seed", "outcome", "world_hash")

    def __init__(self, root):
        self.root = root
        os.makedirs(root, exist_ok=True)
        self.index_path = os.path.join(root, "index.jsonl")
        self._lock = threading.Lock()
        self._index = []
        if os.path.exists(self.index_path):
            with open(self.index_path, encoding="utf-8") as f:
                for line in f:
                    try:
                        self._index.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue

    @staticmethod
    def summary(ep):
        s = {k: ep.get(k) for k in EpisodeStore.INDEX_FIELDS}
        m = ep["metrics"]
        s.update({"steps": m["steps_taken"], "reward": m["reward"], "path_length": m["path_length"],
                  "path_ratio": m["path_ratio"], "min_clearance": m.get("min_clearance"),
                  "model_id": (ep.get("model") or {}).get("model_id"), "model_label": (ep.get("model") or {}).get("label"),
                  "scenario_id": (ep.get("scenario") or {}).get("id"), "scenario_type": (ep.get("scenario") or {}).get("type"),
                  "scenario_name": (ep.get("scenario") or {}).get("name"),
                  "behaviors": ep["behavior"]["detected"], "uncertain": ep["behavior"]["uncertain"],
                  "parent_id": (ep.get("parent") or {}).get("episode_id"),
                  "exact": (ep.get("restoration") or {}).get("exact"),
                  "safety_interventions": m.get("safety_interventions"),
                  "collision_cause": (m.get("collision") or {}).get("cause"),
                  "collision_kind": (m.get("collision") or {}).get("kind"),
                  "shield": bool((ep.get("conditions") or {}).get("shield"))})
        return s

    def save(self, ep):
        with self._lock:
            with gzip.open(os.path.join(self.root, f"{_safe(ep['id'])}.json.gz"), "wt", encoding="utf-8") as f:
                json.dump(ep, f)
            s = self.summary(ep)
            self._index.append(s)
            with open(self.index_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(s) + "\n")
        return s

    def get(self, ep_id):
        path = os.path.join(self.root, f"{_safe(ep_id)}.json.gz")
        if not os.path.exists(path):
            raise KeyError(ep_id)
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)

    def query(self, **flt):
        q = (flt.pop("q", None) or "").lower()
        behavior = flt.pop("behavior", None)
        limit = int(flt.pop("limit", 500) or 500)
        out = []
        with self._lock:
            items = list(reversed(self._index))
        for s in items:
            if any(v not in (None, "") and str(s.get(k)) != str(v) for k, v in flt.items()):
                continue
            if behavior and behavior not in (s.get("behaviors") or []) and behavior != s.get("outcome") \
                    and behavior not in (s.get("uncertain") or []):
                continue
            if q and q not in json.dumps(s).lower():
                continue
            out.append(s)
            if len(out) >= limit:
                break
        return out

    def all_summaries(self):
        with self._lock:
            return list(self._index)

    def delete_run(self, run_id):
        with self._lock:
            keep = [s for s in self._index if s.get("run_id") != run_id]
            for s in self._index:
                if s.get("run_id") == run_id:
                    try:
                        os.remove(os.path.join(self.root, f"{s['id']}.json.gz"))
                    except OSError:
                        pass
            self._index = keep
            with open(self.index_path, "w", encoding="utf-8") as f:
                for s in keep:
                    f.write(json.dumps(s) + "\n")


class JsonCollection:
    """Directory of <id>.json documents."""

    def __init__(self, root, prefix):
        self.root, self.prefix = root, prefix
        os.makedirs(root, exist_ok=True)
        self._lock = threading.Lock()

    def new_id(self, hint=""):
        slug = re.sub(r"[^a-z0-9]+", "-", hint.lower()).strip("-")[:24]
        return f"{self.prefix}-{time.strftime('%Y%m%d%H%M%S')}-{slug + '-' if slug else ''}{uuid.uuid4().hex[:4]}"

    def save(self, doc):
        with self._lock:
            _write_json(os.path.join(self.root, f"{_safe(doc['id'])}.json"), doc)
        return doc

    def get(self, doc_id):
        path = os.path.join(self.root, f"{_safe(doc_id)}.json")
        if not os.path.exists(path):
            raise KeyError(doc_id)
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def exists(self, doc_id):
        return os.path.exists(os.path.join(self.root, f"{_safe(doc_id)}.json"))

    def list(self):
        out = []
        for name in sorted(os.listdir(self.root), reverse=True):
            if name.endswith(".json"):
                try:
                    with open(os.path.join(self.root, name), encoding="utf-8") as f:
                        out.append(json.load(f))
                except (OSError, json.JSONDecodeError):
                    continue
        return out

    def delete(self, doc_id):
        os.remove(os.path.join(self.root, f"{_safe(doc_id)}.json"))

    def update(self, doc_id, **fields):
        with self._lock:
            doc = self.get(doc_id)
            doc.update(fields)
            _write_json(os.path.join(self.root, f"{_safe(doc_id)}.json"), doc)
            return doc
