"""
blueprint.py
============
Pydantic models that define the "Blueprint" contract.

A Blueprint is a JSON document that a mobile developer POSTs to the backend
once (or on every session start).  It tells the AI:
  - what fields exist in the form
  - which fields are required / optional
  - what type each field holds (text, date, enum, …)
  - whether a field's valid options come from a local data/ file
  - whether a field depends on another field being filled first (dependency)
  - a human-readable label and hint for the AI to use when asking

Everything is fully generic — the backend never needs to know the domain.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, field_validator, model_validator


# ---------------------------------------------------------------------------
# Enumerations
# ---------------------------------------------------------------------------


class FieldType(str, Enum):
    """Primitive type hint for the field value."""

    TEXT = "text"
    DATE = "date"
    NUMBER = "number"
    ENUM = "enum"          # static list of allowed values
    DYNAMIC_ENUM = "dynamic_enum"   # list fetched from a data/ file
    BOOLEAN = "boolean"


class DataSourceFilter(BaseModel):
    """
    An optional filter that restricts which rows to load from the data file.

    Example: only load centers whose cityCode matches the value already
    collected in the "city_code" field of the current submission.

        DataSourceFilter(field="cityCode", from_field="city_code")

    The engine will look up `submission["city_code"]` and compare it to
    each row's `row[field]`.
    """

    field: str = Field(
        description="The key inside each row of the data file to filter on."
    )
    from_field: str = Field(
        description=(
            "The submission field whose current value is used as the filter value. "
            "If that field is not yet filled, the data source is considered unavailable."
        )
    )


class DataSourceConfig(BaseModel):
    """
    Describes how to load valid options from a local JSON file in data/.

    The file is expected to be either:
      - a JSON array of objects  →  the engine extracts `label_key` from each
      - a JSON object with a single array at `array_key` (if provided)
      - a plain JSON array of strings

    Attributes
    ----------
    path:
        Relative path from the backend/ root, e.g. ``"data/cities.json"``.
    label_key:
        Key inside each row object whose value becomes the option label shown
        to the AI/user (e.g. ``"name"``).  If omitted the whole row is used.
    value_key:
        Key inside each row object whose value is stored in the submission
        (e.g. ``"code"``).  Defaults to ``label_key`` when not set.
    array_key:
        If the JSON file is an object rather than a top-level array, this key
        addresses the array inside it (e.g. ``"items"``).
    filter:
        Optional filter so only a subset of rows is offered (see DataSourceFilter).
    enabled_key:
        If set, only rows where ``row[enabled_key] == True`` are kept.
    """

    path: str = Field(description="Relative path from backend/ to the data file.")
    label_key: str | None = Field(
        default=None,
        description="Row attribute to use as the human-readable option label.",
    )
    value_key: str | None = Field(
        default=None,
        description="Row attribute to store as the field value. Defaults to label_key.",
    )
    array_key: str | None = Field(
        default=None,
        description="If the JSON root is an object, the key holding the array.",
    )
    items_key: str | None = Field(
        default=None,
        description=(
            "If set, each top-level row is treated as a container and the engine "
            "explodes the sub-array at row[items_key] into individual option entries. "
            "Useful for nested structures like timeslots where each row has an "
            "'availableSlots' array. The filter is applied to the parent row first "
            "(to pick the right container), then label_key/value_key are read from "
            "the child items. An optional child_filter_key can further restrict items "
            "(e.g. only available==true items)."
        ),
    )
    child_filter_key: str | None = Field(
        default=None,
        description=(
            "When items_key is set, only child items where row[child_filter_key] is "
            "truthy are included (e.g. 'available' to skip full slots)."
        ),
    )
    filter: DataSourceFilter | None = Field(
        default=None,
        description="Optional dependency-based row filter.",
    )
    enabled_key: str | None = Field(
        default=None,
        description="If set, only rows where this key is True are included.",
    )

    @model_validator(mode="after")
    def _default_value_key(self) -> "DataSourceConfig":
        if self.value_key is None:
            self.value_key = self.label_key
        return self


class BlueprintField(BaseModel):
    """
    Definition of a single field in the form.

    Attributes
    ----------
    key:
        Machine-readable field identifier used as the JSON key in the
        submission file (e.g. ``"full_name"``).
    label:
        Human-readable label the AI uses when addressing the field
        (e.g. ``"Full Name"``).
    field_type:
        One of the FieldType enum values.
    required:
        Whether the form cannot be completed without this field.
    hint:
        Optional extra instruction for the AI, e.g.
        ``"Extract this from the uploaded ID document if available."``.
    enum_values:
        Static list of allowed values when field_type == ENUM.
    data_source:
        Configuration for loading valid options from a data/ file.
        Required when field_type == DYNAMIC_ENUM.
    depends_on:
        List of field keys that must be filled before this field can be
        asked about.  Used by the state machine to determine ordering.
    extractable_from_document:
        Hint to the AI that this field can be read from uploaded documents.
    """

    key: str = Field(description="Machine-readable field key (snake_case recommended).")
    label: str = Field(description="Human-readable label shown in AI conversation.")
    field_type: FieldType = Field(default=FieldType.TEXT)
    required: bool = Field(default=True)
    hint: str | None = Field(
        default=None,
        description="Extra AI guidance for collecting this field.",
    )
    enum_values: list[str] | None = Field(
        default=None,
        description="Static allowed values for ENUM fields.",
    )
    data_source: DataSourceConfig | None = Field(
        default=None,
        description="Dynamic data source config for DYNAMIC_ENUM fields.",
    )
    depends_on: list[str] = Field(
        default_factory=list,
        description="Field keys that must be filled before this one is asked.",
    )
    extractable_from_document: bool = Field(
        default=False,
        description="Tell the AI it may extract this from an uploaded document.",
    )

    @field_validator("data_source", mode="before")
    @classmethod
    def _check_data_source(cls, v: Any, info: Any) -> Any:
        # Allow None for non-dynamic fields; validation is enforced in model_validator
        return v

    @model_validator(mode="after")
    def _validate_type_consistency(self) -> "BlueprintField":
        if self.field_type == FieldType.ENUM and not self.enum_values:
            raise ValueError(
                f"Field '{self.key}': enum_values must be provided for ENUM fields."
            )
        if self.field_type == FieldType.DYNAMIC_ENUM and not self.data_source:
            raise ValueError(
                f"Field '{self.key}': data_source is required for DYNAMIC_ENUM fields."
            )
        return self


class Blueprint(BaseModel):
    """
    The top-level Blueprint document submitted by a mobile developer.

    Attributes
    ----------
    blueprint_id:
        Unique identifier for this blueprint (e.g. ``"id_renewal_v2"``).
        Used to namespace submission files.
    title:
        Short title for the service/form, used in AI system prompt.
    description:
        Longer description of the form's purpose.
    assistant_persona:
        Optional persona override for the AI (overrides config.json systemPrompt).
    fields:
        Ordered list of field definitions.  The engine respects dependency
        ordering; the list order is only a presentation hint.
    completion_message:
        Message the AI delivers when the form is fully complete.
    """

    blueprint_id: str = Field(
        description="Unique identifier for this blueprint (used as file-system key)."
    )
    title: str = Field(description="Human-readable form/service title.")
    description: str = Field(description="What this form is for.")
    assistant_persona: str | None = Field(
        default=None,
        description="Optional system-prompt persona override for this blueprint.",
    )
    fields: list[BlueprintField] = Field(
        min_length=1,
        description="All field definitions for this form.",
    )
    completion_message: str = Field(
        default=(
            "All required information has been collected. "
            "Please review the summary and confirm to submit."
        ),
        description="Message delivered when the form is complete.",
    )
    required_documents: list[str] = Field(
        default_factory=list,
        description="Optional list of documents expected from the user for this step.",
    )

    @model_validator(mode="after")
    def _validate_depends_on(self) -> "Blueprint":
        known_keys = {f.key for f in self.fields}
        for f in self.fields:
            for dep in f.depends_on:
                if dep not in known_keys:
                    raise ValueError(
                        f"Field '{f.key}' depends_on unknown key '{dep}'."
                    )
        return self

    def field_map(self) -> dict[str, BlueprintField]:
        """Return a dict keyed by field.key for O(1) lookup."""
        return {f.key: f for f in self.fields}


# ---------------------------------------------------------------------------
# Request / Response models used by dynamic_server.py
# ---------------------------------------------------------------------------


class RegisterBlueprintRequest(BaseModel):
    """Body for POST /dynamic/blueprints — registers a blueprint server-side."""

    blueprint: Blueprint


class RegisterBlueprintResponse(BaseModel):
    blueprint_id: str
    field_count: int
    registered: bool = True


class DynamicChatRequest(BaseModel):
    """
    Chat turn request for the schema-driven endpoint.

    Either send ``blueprint_id`` (if already registered) or embed the full
    ``blueprint`` object to register-and-chat in a single call.
    """

    session_id: str | None = Field(
        default=None,
        description="Existing session to continue. Omit to start a new session.",
    )
    blueprint_id: str | None = Field(
        default=None,
        description="ID of an already-registered blueprint.",
    )
    blueprint: Blueprint | None = Field(
        default=None,
        description="Inline blueprint (registers it if not already known).",
    )
    prompt: str = Field(default="", description="User utterance / transcribed speech.")
    reset: bool = Field(
        default=False,
        description="Wipe the current session state and start fresh.",
    )

    @model_validator(mode="after")
    def _require_blueprint_ref(self) -> "DynamicChatRequest":
        if self.blueprint_id is None and self.blueprint is None:
            raise ValueError("Either blueprint_id or blueprint must be provided.")
        return self


class DynamicChatResponse(BaseModel):
    session_id: str
    blueprint_id: str
    response: str
    model: str
    completed: bool = False
    missing_fields: list[str] = Field(default_factory=list)
    filled_fields: dict[str, Any] = Field(default_factory=dict)
    submission_path: str | None = None
    token_usage: dict[str, int] = Field(default_factory=dict)
