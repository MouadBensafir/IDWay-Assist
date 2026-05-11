"""
workflow.py
===========
Pydantic models that define the "Service Workflow" contract.

A Workflow is a JSON document that a developer POSTs once. It describes a
multi-step e-government service (e.g. a US visa appointment) as a directed
acyclic graph of steps. Each step maps 1-to-1 to a registered Blueprint and
has optional output_mappings that carry collected values forward into
downstream steps automatically.

Design principles
-----------------
- Fully generic: the backend never needs to know the domain.
- Additive: the existing /dynamic/* Blueprint + chat API is unchanged.
- Agent-controlled: the agent (not the mobile UI) drives step transitions.
- File-backed sessions: workflow sessions survive process restarts.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, model_validator


# ---------------------------------------------------------------------------
# Workflow definition models
# ---------------------------------------------------------------------------


class OutputMapping(BaseModel):
    """
    Carry a value collected in one step into a downstream step.

    Example: the DS-160 confirmation number collected in step 2 should be
    pre-filled into step 3's Blueprint session automatically, so the user
    never has to type it twice.

    Attributes
    ----------
    from_field:
        The Blueprint field key in **this** step's submission that holds
        the value to carry forward.
    to_step_id:
        The ``step_id`` of the downstream step that should receive the value.
    to_field:
        The Blueprint field key in the downstream step's submission that the
        value should be written into.
    """

    from_field: str = Field(description="Field key in this step's submission to read from.")
    to_step_id: str = Field(description="Target step_id that should receive the value.")
    to_field: str = Field(description="Field key in the target step's Blueprint to write into.")


class WorkflowStep(BaseModel):
    """
    One step within a workflow.

    Attributes
    ----------
    step_id:
        Unique identifier within this workflow (snake_case, e.g. ``"pay_mrv_fee"``).
    title:
        Human-readable name shown in the mobile app progress bar.
    description:
        Short description of what this step accomplishes.
    blueprint_id:
        ID of the Blueprint that drives the AI conversation for this step.
        Must be registered via POST /dynamic/blueprints before the workflow
        session is started (or the blueprint can be registered inline).
    depends_on:
        step_ids that must be in ``completed`` state before this step becomes
        available. Empty list means the step is available immediately.
    output_mappings:
        Values to carry forward into downstream step sessions when this step
        is marked complete.
    optional:
        If True, the step may be skipped without blocking downstream steps.
    """

    step_id: str = Field(description="Unique step identifier within this workflow.")
    title: str = Field(description="Human-readable step title.")
    description: str = Field(default="", description="What this step accomplishes.")
    blueprint_id: str = Field(description="Blueprint that drives the AI conversation.")
    depends_on: list[str] = Field(
        default_factory=list,
        description="step_ids that must be complete before this step is unlocked.",
    )
    output_mappings: list[OutputMapping] = Field(
        default_factory=list,
        description="Values to propagate into downstream steps on completion.",
    )
    optional: bool = Field(
        default=False,
        description="If True this step can be skipped without blocking downstream steps.",
    )


class Workflow(BaseModel):
    """
    Top-level Workflow document submitted by a developer.

    Attributes
    ----------
    workflow_id:
        Unique identifier (e.g. ``"us_visa_appointment"``).
    title:
        Short human-readable title shown in the mobile app.
    description:
        Longer description of the overall e-service.
    steps:
        Ordered list of workflow steps. The order is a display hint only;
        actual execution order is determined by the ``depends_on`` graph.
    """

    workflow_id: str = Field(description="Unique workflow identifier.")
    title: str = Field(description="Human-readable workflow title.")
    description: str = Field(default="", description="Overall e-service description.")
    steps: list[WorkflowStep] = Field(min_length=1, description="All steps in this workflow.")

    @model_validator(mode="after")
    def _validate_graph(self) -> "Workflow":
        known_ids = {s.step_id for s in self.steps}
        for step in self.steps:
            for dep in step.depends_on:
                if dep not in known_ids:
                    raise ValueError(
                        f"Step '{step.step_id}' depends_on unknown step_id '{dep}'."
                    )
            for mapping in step.output_mappings:
                if mapping.to_step_id not in known_ids:
                    raise ValueError(
                        f"Step '{step.step_id}' has output_mapping targeting "
                        f"unknown step_id '{mapping.to_step_id}'."
                    )
        return self

    def step_map(self) -> dict[str, WorkflowStep]:
        return {s.step_id: s for s in self.steps}

    def initial_steps(self) -> list[WorkflowStep]:
        """Steps with no dependencies — immediately unlocked at session start."""
        return [s for s in self.steps if not s.depends_on]


# ---------------------------------------------------------------------------
# Workflow session state
# ---------------------------------------------------------------------------


class StepStatus(str, Enum):
    LOCKED = "locked"        # dependencies not yet met
    AVAILABLE = "available"  # dependencies met, not yet started
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    SKIPPED = "skipped"


class WorkflowSessionState(BaseModel):
    """
    Persisted state for one user's workflow session.

    Stored as ``backend/submissions/wf_{workflow_session_id}.json``.
    """

    workflow_session_id: str
    workflow_id: str
    # Map from step_id → StepStatus
    step_statuses: dict[str, StepStatus] = Field(default_factory=dict)
    # Map from step_id → chat session_id used for the /dynamic/chat calls
    step_chat_session_ids: dict[str, str] = Field(default_factory=dict)
    # Map from step_id → filled_fields snapshot at completion time
    step_submissions: dict[str, dict[str, Any]] = Field(default_factory=dict)
    # Pre-filled values injected into each step's Blueprint session via output_mappings
    # structure: { step_id: { field_key: value } }
    pre_filled: dict[str, dict[str, Any]] = Field(default_factory=dict)
    # Whether the entire workflow is done
    workflow_complete: bool = False


# ---------------------------------------------------------------------------
# Request / Response models used by workflow_server.py
# ---------------------------------------------------------------------------


class RegisterWorkflowRequest(BaseModel):
    """Body for POST /workflows."""
    workflow: Workflow


class RegisterWorkflowResponse(BaseModel):
    workflow_id: str
    step_count: int
    registered: bool = True


class StartWorkflowSessionRequest(BaseModel):
    """Body for POST /workflows/{workflow_id}/sessions."""
    workflow_session_id: str | None = Field(
        default=None,
        description="Resume an existing session. Omit to create a new one.",
    )


class StartWorkflowSessionResponse(BaseModel):
    workflow_session_id: str
    workflow_id: str
    workflow_title: str
    available_steps: list[dict[str, Any]]
    step_statuses: dict[str, StepStatus]
    workflow_complete: bool = False


class AdvanceWorkflowRequest(BaseModel):
    """
    Body for POST /workflows/{workflow_id}/sessions/{session_id}/advance.

    The caller asserts that ``step_id`` is now complete.  The server will:
    1. Validate the step's Blueprint submission has no missing required fields.
    2. Apply output_mappings → write pre_filled into downstream steps.
    3. Mark the step as COMPLETED.
    4. Recompute which steps are now AVAILABLE.
    """
    step_id: str = Field(description="The step_id being marked complete.")
    filled_fields: dict[str, Any] = Field(
        default_factory=dict,
        description="The filled_fields payload from the last /dynamic/chat response.",
    )


class SkipStepRequest(BaseModel):
    """Body for POST /workflows/{workflow_id}/sessions/{session_id}/skip."""
    step_id: str = Field(description="The optional step_id to skip.")


class WorkflowStepDetail(BaseModel):
    step_id: str
    title: str
    description: str
    blueprint_id: str
    status: StepStatus
    chat_session_id: str | None = None
    pre_filled: dict[str, Any] = Field(default_factory=dict)


class WorkflowSessionDetailResponse(BaseModel):
    workflow_session_id: str
    workflow_id: str
    workflow_title: str
    workflow_complete: bool
    steps: list[WorkflowStepDetail]


class WorkflowSummary(BaseModel):
    workflow_id: str
    title: str
    description: str
    step_count: int


class AdvanceWorkflowResponse(BaseModel):
    workflow_session_id: str
    completed_step_id: str
    newly_available_steps: list[dict[str, Any]]
    step_statuses: dict[str, StepStatus]
    workflow_complete: bool


class WorkflowChatResponse(BaseModel):
    workflow_session_id: str
    workflow_id: str
    workflow_title: str
    response: str
    model: str
    workflow_complete: bool = False
    current_step_id: str | None = None
    current_step_title: str | None = None
    current_step_status: StepStatus | None = None
    current_chat_session_id: str | None = None
    step_completed: bool = False
    next_step_id: str | None = None
    next_step_title: str | None = None
    available_steps: list[dict[str, Any]] = Field(default_factory=list)
    step_statuses: dict[str, StepStatus] = Field(default_factory=dict)
    missing_fields: list[str] = Field(default_factory=list)
    filled_fields: dict[str, Any] = Field(default_factory=dict)
    submission_path: str | None = None
    token_usage: dict[str, int] = Field(default_factory=dict)


class WorkflowSelectionResponse(BaseModel):
    workflow_session_id: str | None = None
    workflow_id: str | None = None
    workflow_title: str | None = None
    response: str
    model: str = "workflow-router"
    workflow_complete: bool = False
    available_workflows: list[WorkflowSummary] = Field(default_factory=list)
    available_steps: list[dict[str, Any]] = Field(default_factory=list)
    step_statuses: dict[str, StepStatus] = Field(default_factory=dict)
    current_step_id: str | None = None
    current_step_title: str | None = None
    current_step_status: StepStatus | None = None
    current_chat_session_id: str | None = None
    step_completed: bool = False
    next_step_id: str | None = None
    next_step_title: str | None = None
    missing_fields: list[str] = Field(default_factory=list)
    filled_fields: dict[str, Any] = Field(default_factory=dict)
    submission_path: str | None = None
    token_usage: dict[str, int] = Field(default_factory=dict)
