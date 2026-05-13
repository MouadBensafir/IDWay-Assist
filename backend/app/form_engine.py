"""
form_engine.py
==============
The Schema-Driven State Machine.

Responsibilities
----------------
1. **State initialisation** – create ``submissions/{session_id}.json`` from
   the Blueprint's field list on first contact.

2. **State loading / saving** – always read from and write to disk so state
   survives process restarts (fully offline-safe).

3. **`update_form_state`** – the single universal tool exposed to the LLM.
   Recursively merges the model's extracted data into the saved state and
   immediately flushes to disk.

4. **Missing-field analysis** – walks the dependency graph to determine which
   fields are currently collectable (dependencies satisfied) vs blocked.

5. **Dynamic data fetching** – if a missing field has a ``data_source``,
   reads the specified local JSON file, applies filters and enabled checks,
   and returns the valid option labels/values.

6. **Dynamic system prompt generation** – builds a rich, contextual prompt
   each turn that tells Qwen exactly what is still needed and what options
   are available, without any hardcoded domain knowledge.

7. **Dynamic tool definition** – constructs a single OpenAI-compatible
   function-call schema for ``update_form_state`` restricted to only the
   fields that are currently collectable, so the model's JSON output is
   always structurally valid.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .blueprint import Blueprint, BlueprintField, DataSourceConfig, FieldType
from .repositories import reference_data_repository, submission_repository


def _submission_path(session_id: str, blueprint_id: str) -> Path:
    return submission_repository.blueprint_path(session_id, blueprint_id)


def _load_raw(path: Path) -> dict[str, Any]:
    """Load a submission JSON file from disk. Returns {} if file is absent."""
    return submission_repository.load_path(path)


def _save_raw(path: Path, data: dict[str, Any]) -> None:
    """Atomically write submission state to disk."""
    submission_repository.save_path(path, data)


# ---------------------------------------------------------------------------
# State initialisation
# ---------------------------------------------------------------------------


def init_state(session_id: str, blueprint: Blueprint, reset: bool = False) -> dict[str, Any]:
    """
    Load existing submission state from disk, or create a fresh one.

    If ``reset`` is True, the file is wiped and re-initialised regardless of
    whether it already exists.

    Returns the current in-memory state dict.
    """
    path = _submission_path(session_id, blueprint.blueprint_id)

    if not reset and path.exists():
        state = _load_raw(path)
        # Ensure every Blueprint field key exists in the state (forward-compat
        # if a new field is added to the blueprint after the session started).
        changed = False
        for field in blueprint.fields:
            if field.key not in state:
                state[field.key] = None
                changed = True
        if changed:
            _save_raw(path, state)
        return state

    # Fresh initialisation: every field starts as None (unfilled)
    state: dict[str, Any] = {field.key: None for field in blueprint.fields}
    _save_raw(path, state)
    return state


# ---------------------------------------------------------------------------
# The Universal Tool — update_form_state
# ---------------------------------------------------------------------------


def update_form_state(
    session_id: str,
    blueprint: Blueprint,
    extracted_data: dict[str, Any],
) -> dict[str, Any]:
    """
    Merge ``extracted_data`` into the persisted submission state.

    * Only keys that are declared in the Blueprint are accepted (unknown keys
      are silently ignored to prevent prompt-injection via the model).
    * Values are recursively merged: a dict value is deep-merged rather than
      replaced wholesale.
    * The updated state is immediately flushed to disk.

    Returns a result dict describing what was updated and what is still missing.
    """
    path = _submission_path(session_id, blueprint.blueprint_id)
    state = _load_raw(path)
    field_map = blueprint.field_map()

    # Whitelist: only accept keys declared in the Blueprint
    allowed_keys = set(field_map.keys())
    applied: list[str] = []
    validation_errors: dict[str, str] = {}

    for raw_key, value in extracted_data.items():
        canonical = _resolve_key(raw_key, allowed_keys)
        if canonical is None:
            continue  # unknown key – skip

        cleaned = _clean_value(value)
        if cleaned is None:
            continue  # empty / None – skip

        # Regex validation — reject values that don't match
        field = field_map[canonical]
        if field.validation_regex is not None:
            string_value = str(cleaned)
            if not re.match(field.validation_regex, string_value):
                validation_errors[canonical] = (
                    f"must match pattern {field.validation_regex}"
                )
                continue

        old_value = state.get(canonical)
        merged = _deep_merge(old_value, cleaned)
        if merged != old_value:
            state[canonical] = merged
            applied.append(canonical)

    _save_raw(path, state)

    missing = _get_missing_fields(state, blueprint)
    filled = _get_filled_fields(state)

    return {
        "ok": True,
        "updated_fields": applied,
        "missing_fields": missing,
        "filled_fields": filled,
        "validation_errors": validation_errors,
        "is_complete": len(missing) == 0,
    }


def _resolve_key(raw_key: str, allowed_keys: set[str]) -> str | None:
    """
    Fuzzy-match an incoming key to a canonical Blueprint key.

    Exact match is tried first; then a normalised (lower-case, non-alphanum
    stripped) comparison so the model can use "Full Name" or "full_name"
    interchangeably.
    """
    if raw_key in allowed_keys:
        return raw_key
    norm_raw = re.sub(r"[^a-z0-9]", "", raw_key.lower())
    for k in allowed_keys:
        if re.sub(r"[^a-z0-9]", "", k.lower()) == norm_raw:
            return k
    return None


def _clean_value(value: Any) -> Any:
    """Return None for clearly empty values; otherwise return value as-is."""
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped if stripped else None
    return value


def _deep_merge(old: Any, new: Any) -> Any:
    """
    Recursively merge ``new`` into ``old``.

    - dict + dict  → merged dict (new wins on conflicts)
    - list + list  → new replaces old (no dedup logic needed for forms)
    - anything else → new replaces old
    """
    if isinstance(old, dict) and isinstance(new, dict):
        merged = dict(old)
        for k, v in new.items():
            merged[k] = _deep_merge(old.get(k), v)
        return merged
    return new


# ---------------------------------------------------------------------------
# Missing / filled field analysis
# ---------------------------------------------------------------------------


def _is_filled(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return bool(value)
    return True


def _get_missing_fields(state: dict[str, Any], blueprint: Blueprint) -> list[str]:
    """Return keys of required fields that are not yet filled."""
    return [
        f.key
        for f in blueprint.fields
        if f.required and not _is_filled(state.get(f.key))
    ]


def _get_filled_fields(state: dict[str, Any]) -> dict[str, Any]:
    """Return a dict of only the filled (non-None, non-empty) fields."""
    return {k: v for k, v in state.items() if _is_filled(v)}


def _dependencies_met(field: BlueprintField, state: dict[str, Any]) -> bool:
    """True if all fields listed in field.depends_on are already filled."""
    return all(_is_filled(state.get(dep)) for dep in field.depends_on)


# ---------------------------------------------------------------------------
# Dynamic data fetching from data/ files
# ---------------------------------------------------------------------------


def _load_data_file(path_str: str) -> list[Any]:
    """
    Load a data/ JSON file and always return a list.

    Handles:
      - path relative to backend/ (e.g. ``"data/cities.json"``)
      - path relative to project root
      - absolute paths (rejected for security)
    """
    return reference_data_repository.load_rows(path_str)


def _extract_options(
    rows: list[Any],
    cfg: DataSourceConfig,
    state: dict[str, Any],
) -> list[dict[str, str]] | None:
    """
    Filter ``rows`` and return ``[{"label": ..., "value": ...}, ...]``.

    Supports two modes:
    1. **Flat mode** (default): each row is an option.
    2. **Nested mode** (items_key set): each row is a container; the sub-array
       at ``row[items_key]`` is exploded into individual options.  The parent
       row filter selects the right container(s); child_filter_key further
       restricts the child items.

    Returns None if the dependency for a filter is not yet satisfied.
    """
    # Check filter dependency
    if cfg.filter is not None:
        dep_value = state.get(cfg.filter.from_field)
        if not _is_filled(dep_value):
            # Dependency not yet filled – data source unavailable
            return None
        filter_value = str(dep_value).strip()
    else:
        filter_value = None

    options: list[dict[str, str]] = []

    for row in rows:
        if not isinstance(row, dict):
            if cfg.items_key is None:
                options.append({"label": str(row), "value": str(row)})
            continue

        # enabled_key filter (parent row)
        if cfg.enabled_key and not row.get(cfg.enabled_key, True):
            continue

        # dependency-based field filter (parent row)
        if cfg.filter is not None and filter_value is not None:
            row_field_value = str(row.get(cfg.filter.field, "")).strip()
            if row_field_value != filter_value:
                continue

        # ── Nested mode ────────────────────────────────────────────────────
        if cfg.items_key is not None:
            child_rows = row.get(cfg.items_key)
            if not isinstance(child_rows, list):
                continue
            for child in child_rows:
                if not isinstance(child, dict):
                    options.append({"label": str(child), "value": str(child)})
                    continue
                # child_filter_key (e.g. available == true)
                if cfg.child_filter_key and not child.get(cfg.child_filter_key, True):
                    continue
                label = str(child.get(cfg.label_key, "")) if cfg.label_key else json.dumps(child)
                value = str(child.get(cfg.value_key, label)) if cfg.value_key else label
                if label:
                    options.append({"label": label, "value": value})
            continue

        # ── Flat mode ───────────────────────────────────────────────────────
        label = str(row.get(cfg.label_key, "")) if cfg.label_key else json.dumps(row)
        value = str(row.get(cfg.value_key, label)) if cfg.value_key else label
        if label:
            options.append({"label": label, "value": value})

    return options


def fetch_field_options(
    field: BlueprintField,
    state: dict[str, Any],
) -> list[dict[str, str]] | None:
    """
    Return the valid options for a DYNAMIC_ENUM field given the current state.

    Returns:
        - A list of ``{"label": ..., "value": ...}`` dicts if options are
          available.
        - ``None`` if the field's data_source filter dependency is not yet
          satisfied (i.e. the field cannot be asked yet).
    """
    if field.data_source is None:
        return None
    try:
        rows = _load_data_file(field.data_source.path)
    except (FileNotFoundError, ValueError):
        return []

    return _extract_options(rows, field.data_source, state)


# ---------------------------------------------------------------------------
# Dynamic prompt generation
# ---------------------------------------------------------------------------


def build_dynamic_system_prompt(
    blueprint: Blueprint,
    state: dict[str, Any],
    field_options: dict[str, list[dict[str, str]] | None],
) -> str:
    """
    Build a fully dynamic system prompt for the current turn.

    The prompt includes:
      - The assistant persona (from blueprint or default)
      - The form title and description
      - A summary of already-filled fields
      - For each *actionable* missing field: label, hint, and (if available)
        the valid options list
      - Fields that are blocked (dependencies not met) are mentioned
        separately so the AI knows not to ask about them yet

    Parameters
    ----------
    blueprint:
        The active Blueprint.
    state:
        Current submission state dict.
    field_options:
        Map from field.key → options list (or None if blocked).
    """
    field_map = blueprint.field_map()

    filled = _get_filled_fields(state)
    missing_required = _get_missing_fields(state, blueprint)

    # Partition missing fields: actionable vs blocked
    actionable: list[BlueprintField] = []
    blocked: list[BlueprintField] = []

    for key in missing_required:
        f = field_map[key]
        if not _dependencies_met(f, state):
            blocked.append(f)
            continue
        if f.field_type == FieldType.DYNAMIC_ENUM:
            opts = field_options.get(f.key)
            if opts is None:
                # Filter dependency not met even though formal deps are met
                blocked.append(f)
                continue
        actionable.append(f)

    # Build persona block
    persona = (
        blueprint.assistant_persona
        or (
            "You are a helpful, professional assistant guiding the user through "
            f"the '{blueprint.title}' form."
        )
    )

    parts: list[str] = [
        persona,
        "",
        "## IMPORTANT RULES",
        "- DOCUMENT-FIRST: Your VERY FIRST response when missing fields exist MUST be to ask "
        "the user to send a photo of their document (ID card, passport, driving license). "
        "Only ask questions field-by-field AFTER the user explicitly says they cannot or "
        "prefer not to send a photo.",
        "- IMMEDIATE SAVE: The moment you extract ANY field value — from a document photo OR "
        "from a user answer — call `update_form_state` immediately. Do NOT wait until all "
        "fields are collected. Save partial data right away.",
        "- DOCUMENT CACHE: If a document was previously uploaded in this session, it is "
        "automatically re-injected into every turn. Re-examine the cached document for any "
        "still-missing fields before asking the user to type them manually. Never ask the "
        "user to resend a document.",
        "- EXTRACTION: When a document image is present, extract ALL readable fields in a "
        "single `update_form_state` call. Leave genuinely unreadable fields for manual follow-up.",
        "- Ask about ONE missing field at a time unless the user volunteers multiple answers.",
        "",
        f"## Service: {blueprint.title}",
        blueprint.description,
        "",
    ]

    # Filled fields summary
    if filled:
        parts.append("### Already collected")
        for key, val in filled.items():
            label = field_map[key].label if key in field_map else key
            parts.append(f"- **{label}**: {val}")
        parts.append("")

    # Actionable missing fields
    if actionable:
        parts.append("### Still needed from the user")
        parts.append(
            "Ask about the fields below. Collect them one at a time unless "
            "the user volunteers multiple answers at once. "
            "Never invent or guess values — only save what the user confirms."
        )
        parts.append("")
        for f in actionable:
            line = f"- **{f.label}** (`{f.key}`)"
            if f.hint:
                line += f"\n  *Hint:* {f.hint}"
            if f.extractable_from_document:
                line += "\n  *May be extracted from an uploaded document.*"
            if f.field_type == FieldType.ENUM and f.enum_values:
                opts_str = ", ".join(f.enum_values)
                line += f"\n  *Allowed values:* {opts_str}"
            if f.field_type == FieldType.DYNAMIC_ENUM:
                opts = field_options.get(f.key) or []
                if opts:
                    opts_str = ", ".join(
                        f"{o['label']} ({o['value']})" if o["label"] != o["value"] else o["label"]
                        for o in opts
                    )
                    line += f"\n  *Available options:* {opts_str}"
            parts.append(line)
        parts.append("")
    else:
        if not missing_required:
            parts.append(
                f"### Form complete\n{blueprint.completion_message}"
            )

    # Blocked fields (informational)
    if blocked:
        parts.append("### Waiting on dependencies (do not ask yet)")
        for f in blocked:
            dep_labels = [
                field_map[d].label if d in field_map else d for d in f.depends_on
            ]
            reason = f"needs {', '.join(dep_labels)} first" if dep_labels else "dependencies unmet"
            parts.append(f"- **{f.label}** — {reason}")
        parts.append("")

    # Tool usage rules
    parts += [
        "### Tool rules",
        "- Call `update_form_state` **immediately** whenever you extract one or "
          "more field values from the conversation or an uploaded document.",
        "- Do NOT batch saves — call the tool the moment you have any value(s).",
        "- Only call `update_form_state` with field keys listed under 'Still needed'.",
        "- Do NOT mention internal field keys or tool names to the user.",
        "- After calling the tool, continue the conversation naturally.",
    ]

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Dynamic tool definition
# ---------------------------------------------------------------------------


def build_update_form_state_tool(
    blueprint: Blueprint,
    state: dict[str, Any],
    field_options: dict[str, list[dict[str, str]] | None],
) -> dict[str, Any]:
    """
    Build a single OpenAI-compatible function-call tool definition for
    ``update_form_state``, constrained strictly to the currently collectable
    fields.

    The JSON Schema for the ``extracted_data`` argument is dynamically
    generated from the Blueprint field definitions so Qwen always produces
    structurally valid output.
    """
    field_map = blueprint.field_map()
    missing_required = _get_missing_fields(state, blueprint)

    # Collect actionable field keys (same logic as prompt builder)
    actionable_keys: list[str] = []
    for key in missing_required:
        f = field_map[key]
        if not _dependencies_met(f, state):
            continue
        if f.field_type == FieldType.DYNAMIC_ENUM:
            opts = field_options.get(f.key)
            if opts is None:
                continue
        actionable_keys.append(key)

    # Also include optional unfilled fields that have met dependencies
    for f in blueprint.fields:
        if not f.required and not _is_filled(state.get(f.key)):
            if _dependencies_met(f, state):
                if f.key not in actionable_keys:
                    if f.field_type == FieldType.DYNAMIC_ENUM:
                        opts = field_options.get(f.key)
                        if opts is None:
                            continue
                    actionable_keys.append(f.key)

    # Build per-field JSON Schema properties
    properties: dict[str, Any] = {}
    for key in actionable_keys:
        f = field_map[key]
        prop = _field_to_json_schema_property(f, field_options)
        properties[key] = prop

    extracted_data_schema: dict[str, Any] = {
        "type": "object",
        "description": (
            "A flat map of field keys to extracted values. "
            "Only include fields you are confident about."
        ),
        "properties": properties,
        "additionalProperties": False,
    }

    return {
        "type": "function",
        "function": {
            "name": "update_form_state",
            "description": (
                "Save one or more collected field values into the submission form. "
                "Call this as soon as you have a confirmed value from the user or "
                "from an uploaded document. Never call it with invented values."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "extracted_data": extracted_data_schema,
                },
                "required": ["extracted_data"],
                "additionalProperties": False,
            },
        },
    }


def _field_to_json_schema_property(
    field: BlueprintField,
    field_options: dict[str, list[dict[str, str]] | None],
) -> dict[str, Any]:
    """Convert a BlueprintField into a JSON Schema property definition."""
    desc_parts = [field.label]
    if field.hint:
        desc_parts.append(field.hint)

    base: dict[str, Any] = {"description": " — ".join(desc_parts)}

    if field.field_type == FieldType.NUMBER:
        base["type"] = "number"

    elif field.field_type == FieldType.BOOLEAN:
        base["type"] = "boolean"

    elif field.field_type == FieldType.ENUM and field.enum_values:
        base["type"] = "string"
        base["enum"] = field.enum_values

    elif field.field_type == FieldType.DYNAMIC_ENUM:
        opts = field_options.get(field.key) or []
        valid_values = [o["value"] for o in opts]
        if valid_values:
            base["type"] = "string"
            base["enum"] = valid_values
        else:
            base["type"] = "string"

    else:
        # TEXT, DATE, or fallback
        base["type"] = "string"
        if field.field_type == FieldType.DATE:
            base["format"] = "date"
            base["description"] += " (ISO 8601 date, e.g. 2026-05-15)"

    return base


# ---------------------------------------------------------------------------
# High-level orchestration helper
# ---------------------------------------------------------------------------


class FormEngineContext:
    """
    A lightweight value-object returned by ``prepare_turn`` containing
    everything the dynamic server needs to run one LLM turn.
    """

    __slots__ = (
        "state",
        "missing_fields",
        "filled_fields",
        "is_complete",
        "field_options",
        "system_prompt",
        "tool_definition",
        "submission_path",
    )

    def __init__(
        self,
        state: dict[str, Any],
        missing_fields: list[str],
        filled_fields: dict[str, Any],
        is_complete: bool,
        field_options: dict[str, list[dict[str, str]] | None],
        system_prompt: str,
        tool_definition: dict[str, Any],
        submission_path: Path,
    ) -> None:
        self.state = state
        self.missing_fields = missing_fields
        self.filled_fields = filled_fields
        self.is_complete = is_complete
        self.field_options = field_options
        self.system_prompt = system_prompt
        self.tool_definition = tool_definition
        self.submission_path = submission_path


def prepare_turn(
    session_id: str,
    blueprint: Blueprint,
    reset: bool = False,
) -> FormEngineContext:
    """
    Load (or initialise) the session state, compute which fields are
    actionable, fetch dynamic data, and build the system prompt + tool
    definition for the upcoming LLM turn.

    This is the single entry-point called by ``dynamic_server.py`` before
    each ``ollama_chat_completion`` call.
    """
    state = init_state(session_id, blueprint, reset=reset)
    path = _submission_path(session_id, blueprint.blueprint_id)

    missing = _get_missing_fields(state, blueprint)
    filled = _get_filled_fields(state)
    is_complete = len(missing) == 0

    # Fetch options for every DYNAMIC_ENUM field
    field_options: dict[str, list[dict[str, str]] | None] = {}
    for f in blueprint.fields:
        if f.field_type == FieldType.DYNAMIC_ENUM and f.data_source:
            field_options[f.key] = fetch_field_options(f, state)

    system_prompt = build_dynamic_system_prompt(blueprint, state, field_options)
    tool_def = build_update_form_state_tool(blueprint, state, field_options)

    return FormEngineContext(
        state=state,
        missing_fields=missing,
        filled_fields=filled,
        is_complete=is_complete,
        field_options=field_options,
        system_prompt=system_prompt,
        tool_definition=tool_def,
        submission_path=path,
    )


def apply_tool_call(
    session_id: str,
    blueprint: Blueprint,
    extracted_data: dict[str, Any],
) -> dict[str, Any]:
    """
    Thin wrapper around ``update_form_state`` called when the LLM issues a
    tool call.  Returns the tool result dict that gets fed back into the
    message list.
    """
    return update_form_state(session_id, blueprint, extracted_data)
