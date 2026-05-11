"""
workflow_repository.py
======================
File-backed repository for Workflow definitions, following the same pattern
as JsonBlueprintRepository in repositories.py.

Workflow JSON files are stored under:
    backend/data/workflows/{workflow_id}.json
"""

from __future__ import annotations

import json
from pathlib import Path

from .config import BACKEND_DIR
from .workflow import Workflow


_WORKFLOWS_DIR = BACKEND_DIR / "data" / "workflows"


class JsonWorkflowRepository:
    def __init__(self, workflows_dir: Path | None = None) -> None:
        self.workflows_dir = workflows_dir or _WORKFLOWS_DIR

    def list_ids(self) -> list[str]:
        if not self.workflows_dir.exists():
            return []
        return sorted(path.stem for path in self.workflows_dir.glob("*.json"))

    def get(self, workflow_id: str) -> Workflow | None:
        path = self._path_for(workflow_id)
        if not path.exists():
            return None
        with path.open("r", encoding="utf-8") as fh:
            raw = json.load(fh)
        return Workflow.model_validate(raw)

    def save(self, workflow: Workflow) -> Path:
        self.workflows_dir.mkdir(parents=True, exist_ok=True)
        path = self._path_for(workflow.workflow_id)
        with path.open("w", encoding="utf-8") as fh:
            json.dump(workflow.model_dump(mode="json"), fh, ensure_ascii=False, indent=2)
        return path

    def delete(self, workflow_id: str) -> bool:
        path = self._path_for(workflow_id)
        if not path.exists():
            return False
        path.unlink(missing_ok=True)
        return True

    def _path_for(self, workflow_id: str) -> Path:
        return self.workflows_dir / f"{workflow_id}.json"


workflow_repository = JsonWorkflowRepository()
