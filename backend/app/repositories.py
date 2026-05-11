from __future__ import annotations

import json
import re
from pathlib import Path
from threading import Lock
from typing import Any

from .blueprint import Blueprint
from .config import BACKEND_DIR, SUBMISSIONS_DIR, TEMPLATES_DIR


def _safe_json_load(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as file_handle:
        data = json.load(file_handle)
    return data if isinstance(data, dict) else {}


def _safe_json_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file_handle:
        json.dump(payload, file_handle, ensure_ascii=False, indent=2)


class JsonBlueprintRepository:
    def __init__(self, blueprints_dir: Path | None = None) -> None:
        self.blueprints_dir = blueprints_dir or (BACKEND_DIR / "data" / "blueprints")

    def list_ids(self) -> list[str]:
        if not self.blueprints_dir.exists():
            return []
        return sorted(path.stem for path in self.blueprints_dir.glob("*.json"))

    def get(self, blueprint_id: str) -> Blueprint | None:
        path = self._path_for_id(blueprint_id)
        if not path.exists():
            return None
        return self._load_path(path)

    def save(self, blueprint: Blueprint) -> Path:
        self.blueprints_dir.mkdir(parents=True, exist_ok=True)
        path = self._path_for_id(blueprint.blueprint_id)
        _safe_json_write(path, blueprint.model_dump(mode="json"))
        return path

    def delete(self, blueprint_id: str) -> bool:
        path = self._path_for_id(blueprint_id)
        if not path.exists():
            return False
        path.unlink(missing_ok=True)
        return True

    def _path_for_id(self, blueprint_id: str) -> Path:
        return self.blueprints_dir / f"{blueprint_id}.json"

    def _load_path(self, path: Path) -> Blueprint:
        with path.open("r", encoding="utf-8") as file_handle:
            raw = json.load(file_handle)
        return Blueprint.model_validate(raw)


class JsonSubmissionRepository:
    def __init__(self, submissions_dir: Path | None = None, templates_dir: Path | None = None) -> None:
        self.submissions_dir = submissions_dir or SUBMISSIONS_DIR
        self.templates_dir = templates_dir or TEMPLATES_DIR

    def ensure_directories(self) -> None:
        self.submissions_dir.mkdir(parents=True, exist_ok=True)
        self.templates_dir.mkdir(parents=True, exist_ok=True)

    def legacy_path(self, session_id: str, service_name: str) -> Path:
        safe_service_name = re.sub(r"[^a-z0-9]+", "_", service_name.lower()).strip("_")
        return self.submissions_dir / f"{session_id}_{safe_service_name}.json"

    def blueprint_path(self, session_id: str, blueprint_id: str) -> Path:
        safe_bid = re.sub(r"[^a-z0-9_-]", "_", blueprint_id.lower())
        return self.submissions_dir / f"{session_id}__{safe_bid}.json"

    def load_path(self, path: Path) -> dict[str, Any]:
        return _safe_json_load(path)

    def save_path(self, path: Path, data: dict[str, Any]) -> None:
        _safe_json_write(path, data)

    def create_from_blueprint(self, session_id: str, blueprint: Blueprint, legacy_service_name: str | None = None) -> Path:
        form_data = {field.key: None for field in blueprint.fields}
        path = (
            self.legacy_path(session_id, legacy_service_name)
            if legacy_service_name
            else self.blueprint_path(session_id, blueprint.blueprint_id)
        )
        self.save_path(path, form_data)
        return path


class JsonReferenceDataRepository:
    def __init__(self, backend_dir: Path | None = None) -> None:
        self.backend_dir = backend_dir or BACKEND_DIR

    def load_rows(self, path_str: str) -> list[Any]:
        rel = Path(path_str)
        if rel.is_absolute():
            raise ValueError(f"data_source path must be relative, got: {path_str}")

        candidate = self.backend_dir / rel
        if not candidate.exists():
            raise FileNotFoundError(f"Data file not found: {candidate}")

        with candidate.open("r", encoding="utf-8") as file_handle:
            raw = json.load(file_handle)

        if isinstance(raw, list):
            return raw
        if isinstance(raw, dict):
            for key in ("items", "data", "results", "values"):
                if isinstance(raw.get(key), list):
                    return raw[key]
            raise ValueError(
                f"Data file {path_str} is a JSON object but no array key was found. "
                "Set data_source.array_key explicitly."
            )
        return []

class InMemorySessionRepository:
    def __init__(self) -> None:
        self._sessions: dict[str, Any] = {}
        self._lock = Lock()

    def get(self, session_id: str) -> Any | None:
        with self._lock:
            return self._sessions.get(session_id)

    def put(self, session: Any) -> None:
        with self._lock:
            self._sessions[session.session_id] = session

    def delete(self, session_id: str) -> Any | None:
        with self._lock:
            return self._sessions.pop(session_id, None)

    def count(self) -> int:
        with self._lock:
            return len(self._sessions)


blueprint_repository = JsonBlueprintRepository()
submission_repository = JsonSubmissionRepository()
reference_data_repository = JsonReferenceDataRepository()
session_repository = InMemorySessionRepository()
