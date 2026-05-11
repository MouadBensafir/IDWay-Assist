"""
workflow_session_store.py
=========================
Persistence layer for workflow sessions.

Workflow sessions are stored as JSON files under
    backend/submissions/wf_{workflow_session_id}.json

This gives the same "survives process restarts" guarantee as the
Blueprint submission files, and keeps the architecture consistent.

Thread-safety is handled via a simple module-level Lock (matching
the pattern used in session_store.py).
"""

from __future__ import annotations

import json
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from .config import SUBMISSIONS_DIR
from .workflow import StepStatus, Workflow, WorkflowSessionState, WorkflowStep


_LOCK = Lock()


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------


def _session_path(workflow_session_id: str) -> Path:
    return SUBMISSIONS_DIR / f"wf_{workflow_session_id}.json"


# ---------------------------------------------------------------------------
# Load / save
# ---------------------------------------------------------------------------


def _load(path: Path) -> WorkflowSessionState | None:
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as fh:
        raw = json.load(fh)
    return WorkflowSessionState.model_validate(raw)


def _save(state: WorkflowSessionState) -> None:
    path = _session_path(state.workflow_session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(state.model_dump(mode="json"), fh, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_or_create_workflow_session(
    workflow: Workflow,
    workflow_session_id: str | None = None,
) -> WorkflowSessionState:
    """
    Load an existing workflow session or create a fresh one.

    If ``workflow_session_id`` is given and a file exists, the saved state
    is returned as-is (resume).  If the ID is given but no file exists, a
    fresh session is created with that ID (allows the mobile app to supply
    a stable ID).

    On creation, every step's initial status is computed from the dependency
    graph: steps with no dependencies start as AVAILABLE; all others as LOCKED.
    """
    with _LOCK:
        session_id = workflow_session_id or uuid4().hex

        if workflow_session_id:
            path = _session_path(workflow_session_id)
            existing = _load(path)
            if existing is not None:
                return existing

        # Compute initial statuses
        step_statuses: dict[str, StepStatus] = {}
        for step in workflow.steps:
            if not step.depends_on:
                step_statuses[step.step_id] = StepStatus.AVAILABLE
            else:
                step_statuses[step.step_id] = StepStatus.LOCKED

        state = WorkflowSessionState(
            workflow_session_id=session_id,
            workflow_id=workflow.workflow_id,
            step_statuses=step_statuses,
        )
        _save(state)
        return state


def load_workflow_session(workflow_session_id: str) -> WorkflowSessionState | None:
    """Return a session by ID, or None if it doesn't exist."""
    with _LOCK:
        return _load(_session_path(workflow_session_id))


def save_workflow_session(state: WorkflowSessionState) -> None:
    """Persist the session state to disk."""
    with _LOCK:
        _save(state)


def delete_workflow_session(workflow_session_id: str) -> bool:
    """Remove the session file. Returns True if deleted, False if not found."""
    with _LOCK:
        path = _session_path(workflow_session_id)
        if not path.exists():
            return False
        path.unlink(missing_ok=True)
        return True


# ---------------------------------------------------------------------------
# Graph helpers
# ---------------------------------------------------------------------------


def recompute_statuses(state: WorkflowSessionState, workflow: Workflow) -> bool:
    """
    Walk the dependency graph and unlock steps whose dependencies are all
    COMPLETED (or SKIPPED).

    Returns True if any status changed (so callers can decide whether to
    re-save).
    """
    changed = False
    done = {
        sid
        for sid, status in state.step_statuses.items()
        if status in (StepStatus.COMPLETED, StepStatus.SKIPPED)
    }

    for step in workflow.steps:
        current = state.step_statuses.get(step.step_id, StepStatus.LOCKED)
        if current in (StepStatus.COMPLETED, StepStatus.SKIPPED, StepStatus.IN_PROGRESS):
            continue
        if all(dep in done for dep in step.depends_on):
            if current == StepStatus.LOCKED:
                state.step_statuses[step.step_id] = StepStatus.AVAILABLE
                changed = True

    return changed


def apply_output_mappings(
    state: WorkflowSessionState,
    step: WorkflowStep,
    filled_fields: dict[str, Any],
) -> None:
    """
    Apply a completed step's output_mappings into state.pre_filled so that
    downstream steps receive the values automatically when their chat session
    is started.
    """
    for mapping in step.output_mappings:
        value = filled_fields.get(mapping.from_field)
        if value is None:
            continue
        if mapping.to_step_id not in state.pre_filled:
            state.pre_filled[mapping.to_step_id] = {}
        state.pre_filled[mapping.to_step_id][mapping.to_field] = value


def is_workflow_complete(state: WorkflowSessionState, workflow: Workflow) -> bool:
    """
    The workflow is complete when every non-optional step is either
    COMPLETED or SKIPPED.
    """
    for step in workflow.steps:
        status = state.step_statuses.get(step.step_id, StepStatus.LOCKED)
        if step.optional:
            continue
        if status not in (StepStatus.COMPLETED, StepStatus.SKIPPED):
            return False
    return True
