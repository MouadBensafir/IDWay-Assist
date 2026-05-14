"""
workflow_server.py
==================
FastAPI router that exposes the Service Workflow API.

All routes are under the ``/workflows`` prefix and are additive — the
existing /dynamic/* and /chat/* routes remain completely unchanged.

Routes
------
POST   /workflows
    Register (or overwrite) a Workflow definition.

GET    /workflows
    List all registered workflow IDs.

GET    /workflows/{workflow_id}
    Retrieve the full Workflow document.

DELETE /workflows/{workflow_id}
    Unregister a Workflow.

POST   /workflows/{workflow_id}/sessions
    Start (or resume) a user workflow session.

GET    /workflows/{workflow_id}/sessions/{session_id}
    Get full session detail including per-step statuses, chat session IDs,
    and pre-filled values ready to inject.

POST   /workflows/{workflow_id}/sessions/{session_id}/advance
    Mark a step COMPLETED, apply output_mappings, unlock next steps.

POST   /workflows/{workflow_id}/sessions/{session_id}/skip
    Mark an optional step SKIPPED and unlock downstream steps.

DELETE /workflows/{workflow_id}/sessions/{session_id}
    Delete a workflow session file.

GET    /workflows/{workflow_id}/sessions/{session_id}/step/{step_id}/chat_context
    Convenience endpoint: returns the blueprint_id, chat session_id, and
    pre_filled payload ready to pass directly to POST /dynamic/chat.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

from typing import AsyncGenerator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.datastructures import UploadFile as StarletteUploadFile

from .service import (
    _coerce_bool,
    _normalize_optional_string,
    run_dynamic_blueprint_turn,
    run_dynamic_blueprint_turn_stream,
)
from .form_engine import init_state, _submission_path
from .repositories import blueprint_repository, submission_repository
from .session_store import get_or_create_session
from .workflow import (
    AdvanceWorkflowRequest,
    AdvanceWorkflowResponse,
    RegisterWorkflowRequest,
    RegisterWorkflowResponse,
    SkipStepRequest,
    StartWorkflowSessionRequest,
    StartWorkflowSessionResponse,
    StepStatus,
    Workflow,
    WorkflowChatResponse,
    WorkflowSelectionResponse,
    WorkflowSessionDetailResponse,
    WorkflowSessionState,
    WorkflowSummary,
    WorkflowStepDetail,
)
from .repositories import workflow_repository
from .workflow_session_store import (
    apply_output_mappings,
    delete_workflow_session,
    get_or_create_workflow_session,
    is_workflow_complete,
    load_workflow_session,
    recompute_statuses,
    save_workflow_session,
)

workflow_router = APIRouter(prefix="/workflows", tags=["Service Workflows"])

_WORKFLOW_HINTS: dict[str, tuple[str, ...]] = {
    "us_nonimmigrant_visa": (
        "visa",
        "interview",
        "ds-160",
        "ds160",
        "biometrics",
        "consular",
        "mrv",
        "embassy",
        "consulate",
        "appointment profile",
    ),
    "us_state_id_renewal": (
        "id renewal",
        "renew my id",
        "state id",
        "real id",
        "dmv",
        "identification card",
        "id card renewal",
        "renewal fee",
        "temporary paper id",
    ),
}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _get_workflow(workflow_id: str) -> Workflow:
    wf = workflow_repository.get(workflow_id)
    if wf is None:
        raise HTTPException(
            status_code=404,
            detail=f"Workflow '{workflow_id}' not found. POST it to /workflows first.",
        )
    return wf


def _get_session(session_id: str, workflow_id: str) -> WorkflowSessionState:
    state = load_workflow_session(session_id)
    if state is None:
        raise HTTPException(
            status_code=404,
            detail=f"Workflow session '{session_id}' not found.",
        )
    if state.workflow_id != workflow_id:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Session '{session_id}' belongs to workflow '{state.workflow_id}', "
                f"not '{workflow_id}'."
            ),
        )
    return state


def _workflow_catalog() -> list[WorkflowSummary]:
    catalog: list[WorkflowSummary] = []
    for workflow_id in workflow_repository.list_ids():
        workflow = workflow_repository.get(workflow_id)
        if workflow is None:
            continue
        catalog.append(
            WorkflowSummary(
                workflow_id=workflow.workflow_id,
                title=workflow.title,
                description=workflow.description,
                step_count=len(workflow.steps),
            )
        )
    return catalog


def _infer_workflow_id(prompt: str) -> str | None:
    text = (prompt or "").strip().lower()
    if not text:
        return None

    scores: dict[str, int] = {}
    for workflow_id, hints in _WORKFLOW_HINTS.items():
        score = 0
        for hint in hints:
            if hint in text:
                score += 1
        if score:
            scores[workflow_id] = score

    if not scores:
        return None

    ordered = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    if len(ordered) > 1 and ordered[0][1] == ordered[1][1]:
        return None
    return ordered[0][0]


def _selection_prompt_response() -> WorkflowSelectionResponse:
    catalog = _workflow_catalog()
    titles = ", ".join(item.title for item in catalog)
    return WorkflowSelectionResponse(
        response=(
            "What service would you like to do? "
            f"Available services: {titles}."
        ),
        available_workflows=catalog,
    )


def _step_detail(
    step_id: str,
    workflow: Workflow,
    state: WorkflowSessionState,
) -> WorkflowStepDetail:
    step_map = workflow.step_map()
    step = step_map[step_id]
    return WorkflowStepDetail(
        step_id=step.step_id,
        title=step.title,
        description=step.description,
        blueprint_id=step.blueprint_id,
        status=state.step_statuses.get(step.step_id, StepStatus.LOCKED),
        chat_session_id=state.step_chat_session_ids.get(step.step_id),
        pre_filled=state.pre_filled.get(step.step_id, {}),
    )


def _available_step_summaries(
    state: WorkflowSessionState,
    workflow: Workflow,
) -> list[dict[str, Any]]:
    step_map = workflow.step_map()
    return [
        {
            "step_id": sid,
            "title": step_map[sid].title,
            "blueprint_id": step_map[sid].blueprint_id,
            "chat_session_id": state.step_chat_session_ids.get(sid),
            "pre_filled": state.pre_filled.get(sid, {}),
        }
        for sid, status in state.step_statuses.items()
        if status == StepStatus.AVAILABLE
    ]


def _select_actionable_step(
    workflow: Workflow,
    state: WorkflowSessionState,
    requested_step_id: str | None = None,
):
    step_map = workflow.step_map()

    if requested_step_id:
        if requested_step_id not in step_map:
            raise HTTPException(status_code=404, detail=f"Step '{requested_step_id}' not found.")
        status = state.step_statuses.get(requested_step_id, StepStatus.LOCKED)
        if status not in (StepStatus.AVAILABLE, StepStatus.IN_PROGRESS):
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Step '{requested_step_id}' is '{status}' and cannot be chatted with. "
                    "It must be AVAILABLE or IN_PROGRESS."
                ),
            )
        return step_map[requested_step_id]

    for desired_status in (StepStatus.IN_PROGRESS, StepStatus.AVAILABLE):
        for step in workflow.steps:
            if state.step_statuses.get(step.step_id) == desired_status:
                return step

    return None


def _seed_step_submission(
    state: WorkflowSessionState,
    step,
    chat_session_id: str,
) -> None:
    bp = blueprint_repository.get(step.blueprint_id)
    if bp is None:
        raise HTTPException(
            status_code=500,
            detail=f"Blueprint '{step.blueprint_id}' was not found for step '{step.step_id}'.",
        )

    sub_path = _submission_path(chat_session_id, bp.blueprint_id)
    current_state = submission_repository.load_path(sub_path) if sub_path.exists() else {}

    if not current_state:
        current_state = {field.key: None for field in bp.fields}

    pre_filled = state.pre_filled.get(step.step_id, {})
    for key, value in pre_filled.items():
        if key not in current_state or current_state[key] is None:
            current_state[key] = value

    submission_repository.save_path(sub_path, current_state)


def _ensure_step_chat_session(
    workflow: Workflow,
    state: WorkflowSessionState,
    step,
) -> str:
    chat_session_id = state.step_chat_session_ids.get(step.step_id)
    if not chat_session_id:
        chat_session_id = uuid4().hex
        state.step_chat_session_ids[step.step_id] = chat_session_id

    if state.step_statuses.get(step.step_id) == StepStatus.AVAILABLE:
        state.step_statuses[step.step_id] = StepStatus.IN_PROGRESS

    _seed_step_submission(state, step, chat_session_id)
    save_workflow_session(state)
    return chat_session_id


def _load_step_filled_fields(
    workflow: Workflow,
    state: WorkflowSessionState,
    step,
    fallback_filled_fields: dict[str, Any] | None = None,
) -> dict[str, Any]:
    chat_session_id = state.step_chat_session_ids.get(step.step_id)
    bp = blueprint_repository.get(step.blueprint_id)
    if chat_session_id and bp is not None:
        sub_path = _submission_path(chat_session_id, bp.blueprint_id)
        if sub_path.exists():
            raw = submission_repository.load_path(sub_path)
            missing = [
                field.key
                for field in bp.fields
                if field.required and (raw.get(field.key) is None or raw.get(field.key) == "")
            ]
            if missing:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "error": "Step Blueprint still has unfilled required fields.",
                        "missing_fields": missing,
                    },
                )
            return {key: value for key, value in raw.items() if value is not None and value != ""}

    return dict(fallback_filled_fields or {})


def _complete_step(
    workflow: Workflow,
    state: WorkflowSessionState,
    step,
    filled_fields: dict[str, Any],
) -> list[dict[str, Any]]:
    apply_output_mappings(state, step, filled_fields)
    state.step_submissions[step.step_id] = filled_fields
    state.step_statuses[step.step_id] = StepStatus.COMPLETED
    recompute_statuses(state, workflow)
    state.workflow_complete = is_workflow_complete(state, workflow)
    save_workflow_session(state)
    return _available_step_summaries(state, workflow)


# ---------------------------------------------------------------------------
# Workflow CRUD
# ---------------------------------------------------------------------------


@workflow_router.post("", response_model=RegisterWorkflowResponse, status_code=201)
async def register_workflow(body: RegisterWorkflowRequest) -> RegisterWorkflowResponse:
    """Register or overwrite a Workflow definition. Idempotent."""
    wf = body.workflow
    workflow_repository.save(wf)
    return RegisterWorkflowResponse(workflow_id=wf.workflow_id, step_count=len(wf.steps))


@workflow_router.get("", response_model=list[str])
async def list_workflows() -> list[str]:
    """List all registered workflow IDs."""
    return workflow_repository.list_ids()


@workflow_router.get("/catalog", response_model=list[WorkflowSummary])
async def get_workflow_catalog() -> list[WorkflowSummary]:
    """Return lightweight workflow metadata for service selection UIs."""
    return _workflow_catalog()


@workflow_router.get("/{workflow_id}", response_model=Workflow)
async def get_workflow(workflow_id: str) -> Workflow:
    """Retrieve the full Workflow document."""
    return _get_workflow(workflow_id)


@workflow_router.delete("/{workflow_id}")
async def delete_workflow(workflow_id: str) -> dict[str, Any]:
    """Unregister a Workflow."""
    if not workflow_repository.delete(workflow_id):
        raise HTTPException(status_code=404, detail=f"Workflow '{workflow_id}' not found.")
    return {"workflow_id": workflow_id, "deleted": True}


# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------


@workflow_router.post("/{workflow_id}/sessions", response_model=StartWorkflowSessionResponse)
async def start_session(
    workflow_id: str,
    body: StartWorkflowSessionRequest,
) -> StartWorkflowSessionResponse:
    """
    Start a new workflow session or resume an existing one.

    If ``workflow_session_id`` is provided in the body and a matching session
    exists on disk, it is resumed (no data is reset).  Otherwise a fresh
    session is created.
    """
    wf = _get_workflow(workflow_id)
    state = get_or_create_workflow_session(wf, body.workflow_session_id)

    return StartWorkflowSessionResponse(
        workflow_session_id=state.workflow_session_id,
        workflow_id=wf.workflow_id,
        workflow_title=wf.title,
        available_steps=_available_step_summaries(state, wf),
        step_statuses=state.step_statuses,
        workflow_complete=state.workflow_complete,
    )


@workflow_router.get(
    "/{workflow_id}/sessions/{session_id}",
    response_model=WorkflowSessionDetailResponse,
)
async def get_session(workflow_id: str, session_id: str) -> WorkflowSessionDetailResponse:
    """Return the full session detail with per-step statuses, chat IDs, and pre-fills."""
    wf = _get_workflow(workflow_id)
    state = _get_session(session_id, workflow_id)

    steps = [_step_detail(step.step_id, wf, state) for step in wf.steps]

    return WorkflowSessionDetailResponse(
        workflow_session_id=state.workflow_session_id,
        workflow_id=wf.workflow_id,
        workflow_title=wf.title,
        workflow_complete=state.workflow_complete,
        steps=steps,
    )


@workflow_router.delete("/{workflow_id}/sessions/{session_id}")
async def remove_session(workflow_id: str, session_id: str) -> dict[str, Any]:
    """Delete a workflow session file."""
    deleted = delete_workflow_session(session_id)
    return {"session_id": session_id, "deleted": deleted}


@workflow_router.delete("/sessions/{session_id}")
async def remove_session_by_id(session_id: str) -> dict[str, Any]:
    """Delete a workflow session file without requiring the caller to know the workflow_id."""
    deleted = delete_workflow_session(session_id)
    return {"session_id": session_id, "deleted": deleted}


@workflow_router.post("/chat", response_model=WorkflowSelectionResponse)
async def workflow_chat_auto(request: Request) -> WorkflowSelectionResponse:
    workflow_session_id, prompt, reset, requested_step_id, files = await _parse_workflow_chat_request(request)

    if workflow_session_id:
        state = load_workflow_session(workflow_session_id)
        if state is None:
            if reset:
                return _selection_prompt_response()
            raise HTTPException(
                status_code=404,
                detail=f"Workflow session '{workflow_session_id}' not found.",
            )
        return await _run_workflow_chat(
            workflow_id=state.workflow_id,
            workflow_session_id=workflow_session_id,
            prompt=prompt,
            reset=reset,
            requested_step_id=requested_step_id,
            files=files,
        )

    inferred_workflow_id = _infer_workflow_id(prompt)
    if inferred_workflow_id is None:
        return _selection_prompt_response()

    return await _run_workflow_chat(
        workflow_id=inferred_workflow_id,
        workflow_session_id=None,
        prompt=prompt,
        reset=reset,
        requested_step_id=requested_step_id,
        files=files,
    )


@workflow_router.post("/{workflow_id}/chat", response_model=WorkflowChatResponse)
async def workflow_chat(workflow_id: str, request: Request) -> WorkflowChatResponse:
    workflow_session_id, prompt, reset, requested_step_id, files = await _parse_workflow_chat_request(request)
    return await _run_workflow_chat(
        workflow_id=workflow_id,
        workflow_session_id=workflow_session_id,
        prompt=prompt,
        reset=reset,
        requested_step_id=requested_step_id,
        files=files,
    )


async def _run_workflow_chat(
    *,
    workflow_id: str,
    workflow_session_id: str | None,
    prompt: str,
    reset: bool,
    requested_step_id: str | None,
    files: list[StarletteUploadFile],
) -> WorkflowChatResponse:
    wf = _get_workflow(workflow_id)
    if workflow_session_id and reset:
        delete_workflow_session(workflow_session_id)

    state = get_or_create_workflow_session(wf, workflow_session_id)
    if state.workflow_complete:
        return WorkflowChatResponse(
            workflow_session_id=state.workflow_session_id,
            workflow_id=wf.workflow_id,
            workflow_title=wf.title,
            response="This workflow is already complete.",
            model="workflow-router",
            workflow_complete=True,
            available_steps=[],
            step_statuses=state.step_statuses,
        )

    step = _select_actionable_step(wf, state, requested_step_id)
    if step is None:
        raise HTTPException(
            status_code=409,
            detail="No actionable workflow step is available yet. Remaining steps are still locked.",
        )

    chat_session_id = _ensure_step_chat_session(wf, state, step)
    chat_session = get_or_create_session(chat_session_id, reset=False)
    blueprint = blueprint_repository.get(step.blueprint_id)
    if blueprint is None:
        raise HTTPException(
            status_code=500,
            detail=f"Blueprint '{step.blueprint_id}' was not found for step '{step.step_id}'.",
        )

    dynamic_response = await run_dynamic_blueprint_turn(
        session=chat_session,
        blueprint=blueprint,
        prompt=prompt,
        files=files,
    )

    refreshed_state = _get_session(state.workflow_session_id, workflow_id)
    step_completed = False
    next_step = step
    available_steps = _available_step_summaries(refreshed_state, wf)

    if dynamic_response.completed and refreshed_state.step_statuses.get(step.step_id) != StepStatus.COMPLETED:
        filled_fields = _load_step_filled_fields(wf, refreshed_state, step, dynamic_response.filled_fields)
        available_steps = _complete_step(wf, refreshed_state, step, filled_fields)
        refreshed_state = _get_session(state.workflow_session_id, workflow_id)
        step_completed = True
        next_step = _select_actionable_step(wf, refreshed_state)
    elif dynamic_response.completed:
        refreshed_state = _get_session(state.workflow_session_id, workflow_id)
        next_step = _select_actionable_step(wf, refreshed_state)

    response_text = dynamic_response.response
    if step_completed:
        if refreshed_state.workflow_complete:
            response_text = f"{response_text}\n\nWorkflow complete."
        elif next_step is not None:
            response_text = (
                f"{response_text}\n\nNext step: {next_step.title}. "
                f"Continue the conversation to proceed."
            )

    return WorkflowChatResponse(
        workflow_session_id=refreshed_state.workflow_session_id,
        workflow_id=wf.workflow_id,
        workflow_title=wf.title,
        response=response_text,
        model=dynamic_response.model,
        workflow_complete=refreshed_state.workflow_complete,
        current_step_id=step.step_id,
        current_step_title=step.title,
        current_step_status=refreshed_state.step_statuses.get(step.step_id),
        current_chat_session_id=chat_session_id,
        step_completed=step_completed,
        next_step_id=next_step.step_id if step_completed and next_step is not None else None,
        next_step_title=next_step.title if step_completed and next_step is not None else None,
        available_steps=available_steps,
        step_statuses=refreshed_state.step_statuses,
        missing_fields=dynamic_response.missing_fields,
        filled_fields=dynamic_response.filled_fields,
        submission_path=dynamic_response.submission_path,
        token_usage=dynamic_response.token_usage,
    )


# ---------------------------------------------------------------------------
# Advance (mark step complete)
# ---------------------------------------------------------------------------


@workflow_router.post(
    "/{workflow_id}/sessions/{session_id}/advance",
    response_model=AdvanceWorkflowResponse,
)
async def advance_step(
    workflow_id: str,
    session_id: str,
    body: AdvanceWorkflowRequest,
) -> AdvanceWorkflowResponse:
    """
    Mark a step as COMPLETED, apply its output_mappings, and unlock
    downstream steps whose dependencies are now fully satisfied.

    Flow
    ----
    1. Validate the step exists and is in AVAILABLE or IN_PROGRESS state.
    2. Load the step's Blueprint submission from disk and verify no required
       fields are missing (uses the same submission files as /dynamic/chat).
    3. Apply output_mappings: propagate values into ``state.pre_filled``.
    4. Mark the step COMPLETED.
    5. Recompute all step statuses.
    6. Check whether the entire workflow is now complete.
    7. Persist and return.
    """
    wf = _get_workflow(workflow_id)
    state = _get_session(session_id, workflow_id)
    step_map = wf.step_map()

    if body.step_id not in step_map:
        raise HTTPException(
            status_code=404,
            detail=f"Step '{body.step_id}' does not exist in workflow '{workflow_id}'.",
        )

    current_status = state.step_statuses.get(body.step_id, StepStatus.LOCKED)
    if current_status not in (StepStatus.AVAILABLE, StepStatus.IN_PROGRESS):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Step '{body.step_id}' cannot be advanced from status '{current_status}'. "
                "It must be AVAILABLE or IN_PROGRESS."
            ),
        )

    step = step_map[body.step_id]
    filled_fields = _load_step_filled_fields(wf, state, step, body.filled_fields)
    newly_available = _complete_step(wf, state, step, filled_fields)

    return AdvanceWorkflowResponse(
        workflow_session_id=session_id,
        completed_step_id=body.step_id,
        newly_available_steps=newly_available,
        step_statuses=state.step_statuses,
        workflow_complete=state.workflow_complete,
    )


# ---------------------------------------------------------------------------
# Skip (optional steps)
# ---------------------------------------------------------------------------


@workflow_router.post(
    "/{workflow_id}/sessions/{session_id}/skip",
)
async def skip_step(
    workflow_id: str,
    session_id: str,
    body: SkipStepRequest,
) -> dict[str, Any]:
    """
    Mark an optional step as SKIPPED and unlock its downstream dependencies.

    Only steps marked ``optional: true`` in the Workflow definition may be
    skipped. Trying to skip a required step returns a 422.
    """
    wf = _get_workflow(workflow_id)
    state = _get_session(session_id, workflow_id)
    step_map = wf.step_map()

    if body.step_id not in step_map:
        raise HTTPException(status_code=404, detail=f"Step '{body.step_id}' not found.")

    step = step_map[body.step_id]
    if not step.optional:
        raise HTTPException(
            status_code=422,
            detail=f"Step '{body.step_id}' is required and cannot be skipped.",
        )

    state.step_statuses[body.step_id] = StepStatus.SKIPPED
    recompute_statuses(state, wf)
    state.workflow_complete = is_workflow_complete(state, wf)
    save_workflow_session(state)

    return {
        "workflow_session_id": session_id,
        "skipped_step_id": body.step_id,
        "newly_available_steps": _available_step_summaries(state, wf),
        "step_statuses": state.step_statuses,
        "workflow_complete": state.workflow_complete,
    }


# ---------------------------------------------------------------------------
# Chat context helper (convenience endpoint for the mobile app / agent)
# ---------------------------------------------------------------------------


@workflow_router.get(
    "/{workflow_id}/sessions/{session_id}/step/{step_id}/chat_context",
)
async def get_step_chat_context(
    workflow_id: str,
    session_id: str,
    step_id: str,
) -> dict[str, Any]:
    """
    Return everything needed to start or resume a /dynamic/chat call for
    a specific step.

    Response
    --------
    ```json
    {
      "blueprint_id": "ds160_form",
      "chat_session_id": "abc123",          // null on first visit
      "pre_filled": { "visa_type": "B2" },  // from output_mappings
      "status": "available"
    }
    ```

    The mobile app (or agent) should:
    1. Use ``blueprint_id`` as the ``blueprint_id`` field in POST /dynamic/chat.
    2. Pass ``chat_session_id`` as ``session_id`` (or omit if null to start fresh).
    3. Inject ``pre_filled`` values at the start of the conversation so the
       agent can pre-populate those fields via ``update_form_state``.

    When a new chat session is started for this step, call
    POST /workflows/{workflow_id}/sessions/{session_id}/step/{step_id}/bind_chat
    to record the new chat_session_id.
    """
    wf = _get_workflow(workflow_id)
    state = _get_session(session_id, workflow_id)
    step_map = wf.step_map()

    if step_id not in step_map:
        raise HTTPException(status_code=404, detail=f"Step '{step_id}' not found.")

    step = step_map[step_id]
    status = state.step_statuses.get(step_id, StepStatus.LOCKED)

    return {
        "blueprint_id": step.blueprint_id,
        "chat_session_id": state.step_chat_session_ids.get(step_id),
        "pre_filled": state.pre_filled.get(step_id, {}),
        "status": status,
    }


# ---------------------------------------------------------------------------
# Bind chat session (called by agent after starting a new /dynamic/chat session)
# ---------------------------------------------------------------------------


@workflow_router.post(
    "/{workflow_id}/sessions/{session_id}/step/{step_id}/bind_chat",
)
async def bind_chat_session(
    workflow_id: str,
    session_id: str,
    step_id: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    """
    Associate a /dynamic/chat ``session_id`` with a workflow step.

    Body: ``{ "chat_session_id": "abc123" }``

    Also marks the step as IN_PROGRESS if it was AVAILABLE, and pre-fills
    any output-mapped values into the step's Blueprint submission so the
    agent immediately sees them in its context.
    """
    wf = _get_workflow(workflow_id)
    state = _get_session(session_id, workflow_id)
    step_map = wf.step_map()

    if step_id not in step_map:
        raise HTTPException(status_code=404, detail=f"Step '{step_id}' not found.")

    chat_session_id = str(body.get("chat_session_id") or "").strip()
    if not chat_session_id:
        raise HTTPException(status_code=422, detail="chat_session_id is required.")

    step = step_map[step_id]
    state.step_chat_session_ids[step_id] = chat_session_id

    # Advance status from AVAILABLE → IN_PROGRESS
    if state.step_statuses.get(step_id) == StepStatus.AVAILABLE:
        state.step_statuses[step_id] = StepStatus.IN_PROGRESS

    # Pre-fill output-mapped values into the Blueprint submission so the
    # agent's first context already contains them.
    pre_filled = state.pre_filled.get(step_id, {})
    _seed_step_submission(state, step, chat_session_id)

    save_workflow_session(state)

    return {
        "workflow_session_id": session_id,
        "step_id": step_id,
        "chat_session_id": chat_session_id,
        "status": state.step_statuses.get(step_id),
        "pre_filled_count": len(pre_filled),
    }


async def _parse_workflow_chat_request(
    request: Request,
) -> tuple[str | None, str, bool, str | None, list[StarletteUploadFile]]:
    content_type = request.headers.get("content-type", "").lower()

    if "multipart/form-data" in content_type:
        form = await request.form()
        workflow_session_id = _normalize_optional_string(form.get("workflow_session_id"))
        prompt = _normalize_optional_string(form.get("prompt")) or ""
        reset = _coerce_bool(form.get("reset"))
        step_id = _normalize_optional_string(form.get("step_id"))
        files = [
            value
            for _, value in form.multi_items()
            if isinstance(value, StarletteUploadFile)
        ]
        return workflow_session_id, prompt, reset, step_id, files

    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid workflow chat payload.") from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Workflow chat payload must be an object.")

    workflow_session_id = _normalize_optional_string(payload.get("workflow_session_id"))
    prompt = _normalize_optional_string(payload.get("prompt")) or ""
    reset = _coerce_bool(payload.get("reset"))
    step_id = _normalize_optional_string(payload.get("step_id"))
    return workflow_session_id, prompt, reset, step_id, []


# ---------------------------------------------------------------------------
# Streaming helpers
# ---------------------------------------------------------------------------


async def _sse_stream(
    workflow_id: str,
    workflow_session_id: str | None,
    prompt: str,
    reset: bool,
    requested_step_id: str | None,
    files: list[StarletteUploadFile],
) -> AsyncGenerator[bytes, None]:
    wf = _get_workflow(workflow_id)
    if workflow_session_id and reset:
        delete_workflow_session(workflow_session_id)

    state = get_or_create_workflow_session(wf, workflow_session_id)
    if state.workflow_complete:
        yield _sse_event("done", {
            "response": "This workflow is already complete.",
            "workflow_session_id": state.workflow_session_id,
            "workflow_id": wf.workflow_id,
            "workflow_title": wf.title,
            "workflow_complete": True,
            "model": "workflow-router",
        })
        return

    step = _select_actionable_step(wf, state, requested_step_id)
    if step is None:
        yield _sse_event("error", {"detail": "No actionable workflow step is available."})
        return

    chat_session_id = _ensure_step_chat_session(wf, state, step)
    chat_session = get_or_create_session(chat_session_id, reset=False)
    blueprint = blueprint_repository.get(step.blueprint_id)
    if blueprint is None:
        yield _sse_event("error", {"detail": f"Blueprint '{step.blueprint_id}' not found."})
        return

    response_text = ""
    step_completed = False
    next_step = step

    async for event in run_dynamic_blueprint_turn_stream(
        session=chat_session,
        blueprint=blueprint,
        prompt=prompt,
        files=files,
    ):
        if event["event"] == "token":
            response_text += event["data"].get("token", "")
            yield _sse_event("token", {"token": event["data"].get("token", "")})
        elif event["event"] == "done":
            refreshed_state = _get_session(state.workflow_session_id, workflow_id)
            if event["data"].get("completed") and refreshed_state.step_statuses.get(step.step_id) != StepStatus.COMPLETED:
                filled_fields = _load_step_filled_fields(wf, refreshed_state, step, event["data"].get("filled_fields", {}))
                available_steps = _complete_step(wf, refreshed_state, step, filled_fields)
                refreshed_state = _get_session(state.workflow_session_id, workflow_id)
                step_completed = True
                next_step = _select_actionable_step(wf, refreshed_state)
            elif event["data"].get("completed"):
                refreshed_state = _get_session(state.workflow_session_id, workflow_id)
                next_step = _select_actionable_step(wf, refreshed_state)

            response_text = event["data"].get("response", response_text)
            if step_completed:
                if refreshed_state.workflow_complete:
                    response_text = f"{response_text}\n\nWorkflow complete."
                elif next_step is not None:
                    response_text = f"{response_text}\n\nNext step: {next_step.title}. Continue the conversation to proceed."

            yield _sse_event("done", {
                "response": response_text,
                "workflow_session_id": refreshed_state.workflow_session_id,
                "workflow_id": wf.workflow_id,
                "workflow_title": wf.title,
                "model": "qwen3.5",
                "workflow_complete": refreshed_state.workflow_complete,
                "current_step_id": step.step_id,
                "current_step_title": step.title,
                "current_step_status": refreshed_state.step_statuses.get(step.step_id),
                "current_chat_session_id": chat_session_id,
                "step_completed": step_completed,
                "next_step_id": next_step.step_id if step_completed and next_step is not None else None,
                "next_step_title": next_step.title if step_completed and next_step is not None else None,
                "missing_fields": event["data"].get("missing_fields", []),
                "filled_fields": event["data"].get("filled_fields", {}),
                "submission_path": event["data"].get("submission_path"),
                "token_usage": event["data"].get("token_usage", {}),
                "required_documents": [
                    str(item).strip()
                    for item in (getattr(blueprint, "required_documents", None) or [])
                    if str(item).strip()
                ],
            })
            return


def _sse_event(event_type: str, data: dict[str, Any]) -> bytes:
    body = json.dumps(data, ensure_ascii=False)
    return f"event: {event_type}\ndata: {body}\n\n".encode("utf-8")


@workflow_router.post("/chat/stream")
async def workflow_chat_auto_stream(request: Request) -> StreamingResponse:
    workflow_session_id, prompt, reset, requested_step_id, files = await _parse_workflow_chat_request(request)

    if workflow_session_id:
        state = load_workflow_session(workflow_session_id)
        if state is None:
            if reset:
                async def _empty_stream() -> AsyncGenerator[bytes, None]:
                    yield _sse_event("done", {"response": "Session reset."})
                return StreamingResponse(_empty_stream(), media_type="text/event-stream")
            raise HTTPException(
                status_code=404,
                detail=f"Workflow session '{workflow_session_id}' not found.",
            )
        return StreamingResponse(
            _sse_stream(
                workflow_id=state.workflow_id,
                workflow_session_id=workflow_session_id,
                prompt=prompt,
                reset=reset,
                requested_step_id=requested_step_id,
                files=files,
            ),
            media_type="text/event-stream",
        )

    inferred_workflow_id = _infer_workflow_id(prompt)
    if inferred_workflow_id is None:
        catalog = _workflow_catalog()
        titles = ", ".join(item.title for item in catalog)
        async def _selection_stream() -> AsyncGenerator[bytes, None]:
            yield _sse_event("done", {
                "response": f"What service would you like to do? Available services: {titles}.",
                "available_workflows": [item.model_dump() for item in catalog],
            })
        return StreamingResponse(_selection_stream(), media_type="text/event-stream")

    return StreamingResponse(
        _sse_stream(
            workflow_id=inferred_workflow_id,
            workflow_session_id=None,
            prompt=prompt,
            reset=reset,
            requested_step_id=requested_step_id,
            files=files,
        ),
        media_type="text/event-stream",
    )


@workflow_router.post("/{workflow_id}/chat/stream")
async def workflow_chat_stream(workflow_id: str, request: Request) -> StreamingResponse:
    workflow_session_id, prompt, reset, requested_step_id, files = await _parse_workflow_chat_request(request)
    return StreamingResponse(
        _sse_stream(
            workflow_id=workflow_id,
            workflow_session_id=workflow_session_id,
            prompt=prompt,
            reset=reset,
            requested_step_id=requested_step_id,
            files=files,
        ),
        media_type="text/event-stream",
    )


