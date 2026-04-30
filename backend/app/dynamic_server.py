"""
dynamic_server.py
=================
FastAPI router that mounts the Schema-Driven State Machine onto the existing
application.

Routes
------
POST /dynamic/blueprints
    Register (or update) a Blueprint server-side.  Returns blueprint_id.

GET  /dynamic/blueprints
    List all registered blueprint IDs.

GET  /dynamic/blueprints/{blueprint_id}
    Retrieve a registered Blueprint by ID.

DELETE /dynamic/blueprints/{blueprint_id}
    Remove a registered Blueprint.

POST /dynamic/chat
    Main conversational endpoint.  Accepts a blueprint reference and a user
    utterance.  Returns the assistant reply and updated form state.

GET  /dynamic/sessions/{session_id}/state
    Inspect the raw submission JSON for a session.

DELETE /dynamic/sessions/{session_id}
    Delete a session's in-memory conversation history.

The router is imported and mounted in server.py via:
    app.include_router(dynamic_router)
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException

from .blueprint import (
    Blueprint,
    DynamicChatRequest,
    DynamicChatResponse,
    RegisterBlueprintRequest,
    RegisterBlueprintResponse,
)
from .config import OLLAMA_MODEL, RECENT_MESSAGE_COUNT, SUBMISSIONS_DIR
from .document_utils import build_document_payload
from .form_engine import apply_tool_call, prepare_turn
from .ollama_client import extract_token_usage, ollama_chat_completion
from .session_store import (
    SessionState,
    delete_session,
    get_token_usage,
    get_or_create_session,
    record_token_usage,
    update_session_state,
)

dynamic_router = APIRouter(prefix="/dynamic", tags=["Dynamic Schema-Driven"])

# ---------------------------------------------------------------------------
# In-process Blueprint registry
# ---------------------------------------------------------------------------

_BLUEPRINT_REGISTRY: dict[str, Blueprint] = {}


def _get_blueprint(blueprint_id: str) -> Blueprint:
    bp = _BLUEPRINT_REGISTRY.get(blueprint_id)
    if bp is None:
        raise HTTPException(
            status_code=404,
            detail=f"Blueprint '{blueprint_id}' is not registered. POST it to /dynamic/blueprints first.",
        )
    return bp


# ---------------------------------------------------------------------------
# Blueprint management routes
# ---------------------------------------------------------------------------


@dynamic_router.post("/blueprints", response_model=RegisterBlueprintResponse, status_code=201)
async def register_blueprint(body: RegisterBlueprintRequest) -> RegisterBlueprintResponse:
    """Register or overwrite a Blueprint. Idempotent."""
    bp = body.blueprint
    _BLUEPRINT_REGISTRY[bp.blueprint_id] = bp
    return RegisterBlueprintResponse(
        blueprint_id=bp.blueprint_id,
        field_count=len(bp.fields),
    )


@dynamic_router.get("/blueprints", response_model=list[str])
async def list_blueprints() -> list[str]:
    """List all registered blueprint IDs."""
    return list(_BLUEPRINT_REGISTRY.keys())


@dynamic_router.get("/blueprints/{blueprint_id}", response_model=Blueprint)
async def get_blueprint(blueprint_id: str) -> Blueprint:
    """Return the full Blueprint document for the given ID."""
    return _get_blueprint(blueprint_id)


@dynamic_router.delete("/blueprints/{blueprint_id}")
async def delete_blueprint(blueprint_id: str) -> dict[str, Any]:
    """Unregister a Blueprint."""
    if blueprint_id not in _BLUEPRINT_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Blueprint '{blueprint_id}' not found.")
    del _BLUEPRINT_REGISTRY[blueprint_id]
    return {"blueprint_id": blueprint_id, "deleted": True}


# ---------------------------------------------------------------------------
# Session state inspection
# ---------------------------------------------------------------------------


@dynamic_router.get("/sessions/{session_id}/state")
async def get_session_state(session_id: str, blueprint_id: str) -> dict[str, Any]:
    """
    Return the raw submission JSON for a session.

    Query parameter ``blueprint_id`` is required because the submission
    filename includes the blueprint ID.
    """
    bp = _get_blueprint(blueprint_id)
    from .form_engine import _submission_path, _load_raw  # noqa: PLC0415

    path = _submission_path(session_id, bp.blueprint_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="No submission found for this session.")
    return _load_raw(path)


@dynamic_router.delete("/sessions/{session_id}")
async def remove_dynamic_session(session_id: str) -> dict[str, Any]:
    """Delete the in-memory conversation history for a session."""
    deleted = delete_session(session_id)
    return {"session_id": session_id, "deleted": deleted}


# ---------------------------------------------------------------------------
# Main chat endpoint
# ---------------------------------------------------------------------------


@dynamic_router.post("/chat", response_model=DynamicChatResponse)
async def dynamic_chat(request: DynamicChatRequest) -> DynamicChatResponse:
    """
    Schema-driven conversational turn.

    Flow
    ----
    1. Resolve the Blueprint (inline or from registry).
    2. Get/create the in-memory session (for conversation history).
    3. Call ``prepare_turn`` to load state, compute missing fields, fetch
       dynamic data, build the system prompt and the single tool definition.
    4. If the form is already complete, return early.
    5. Build the message list: [system, ...history, user].
    6. Run the agentic tool loop (same pattern as server.py).
    7. Return the assistant response and updated form summary.
    """
    # ---- 1. Resolve Blueprint ------------------------------------------------
    blueprint: Blueprint
    if request.blueprint is not None:
        blueprint = request.blueprint
        _BLUEPRINT_REGISTRY[blueprint.blueprint_id] = blueprint
    else:
        assert request.blueprint_id is not None  # validated by model
        blueprint = _get_blueprint(request.blueprint_id)

    # ---- 2. Session ----------------------------------------------------------
    session = get_or_create_session(request.session_id, reset=request.reset)

    # ---- 3. Prepare turn context --------------------------------------------
    ctx = prepare_turn(session.session_id, blueprint, reset=request.reset)

    # ---- 4. Early-exit if already complete ----------------------------------
    if ctx.is_complete:
        return DynamicChatResponse(
            session_id=session.session_id,
            blueprint_id=blueprint.blueprint_id,
            response=_build_user_visible_response(blueprint, ctx, blueprint.completion_message),
            model=OLLAMA_MODEL,
            completed=True,
            missing_fields=[],
            filled_fields=ctx.filled_fields,
            submission_path=str(ctx.submission_path),
            token_usage=get_token_usage(session),
        )

    # ---- 5. Record user message in session history --------------------------
    user_text = request.prompt.strip() or "Hello."
    update_session_state(session, message={"role": "user", "content": user_text})

    # ---- 6. Run agentic loop ------------------------------------------------
    response_text = await _run_dynamic_turn(
        session=session,
        blueprint=blueprint,
        user_text=user_text,
        ctx=ctx,
    )

    # Reload context after tool calls may have updated the state
    ctx = prepare_turn(session.session_id, blueprint)
    response_text = _build_user_visible_response(blueprint, ctx, response_text)

    return DynamicChatResponse(
        session_id=session.session_id,
        blueprint_id=blueprint.blueprint_id,
        response=response_text,
        model=OLLAMA_MODEL,
        completed=ctx.is_complete,
        missing_fields=ctx.missing_fields,
        filled_fields=ctx.filled_fields,
        submission_path=str(ctx.submission_path),
        token_usage=get_token_usage(session),
    )


# ---------------------------------------------------------------------------
# Agentic tool-call loop
# ---------------------------------------------------------------------------

_MAX_TOOL_ROUNDS = 8  # guard against infinite loops


async def _run_dynamic_turn(
    session: SessionState,
    blueprint: Blueprint,
    user_text: str,
    ctx: "Any",  # FormEngineContext — avoid circular import annotation
) -> str:
    """
    Run the LLM in a loop, executing ``update_form_state`` tool calls until
    the model produces a final text response.

    Each iteration:
      - Calls Ollama with the current message list and the dynamic tool.
      - If the model issues a tool call, executes it, re-evaluates state,
        rebuilds the prompt/tool, and continues.
      - If the model returns plain text, ends the loop.
    """
    # Build initial message list
    messages = _build_messages(session, ctx, user_text)

    # Keep track of the current tool definition (may change each round
    # as fields get filled and the available set shrinks)
    current_ctx = ctx

    for _round in range(_MAX_TOOL_ROUNDS):
        completion = await ollama_chat_completion(
            messages,
            tools=[current_ctx.tool_definition],
            temperature=0.1,
        )
        usage = extract_token_usage(completion)
        record_token_usage(
            session,
            prompt_tokens=usage["prompt_tokens"],
            completion_tokens=usage["completion_tokens"],
        )
        message = completion.get("message") or {}
        assistant_content = _extract_text(message)
        tool_calls = list(message.get("tool_calls") or [])

        # Build assistant payload for message history
        assistant_payload: dict[str, Any] = {"role": "assistant"}
        if assistant_content:
            assistant_payload["content"] = assistant_content
        if tool_calls:
            assistant_payload["tool_calls"] = tool_calls
        messages.append(assistant_payload)

        # No tool call → final answer
        if not tool_calls:
            final_text = assistant_content.strip()
            if not final_text:
                raise HTTPException(status_code=502, detail="Ollama returned an empty response.")
            update_session_state(session, message={"role": "assistant", "content": final_text})
            return final_text

        # Execute each tool call
        for tc in tool_calls:
            tool_name = _get_tool_name(tc)
            if tool_name != "update_form_state":
                # Safety: ignore unknown tools
                messages.append({
                    "role": "tool",
                    "tool_name": tool_name,
                    "content": json.dumps({"ok": False, "error": f"Unknown tool: {tool_name}"}),
                })
                continue

            extracted = _parse_tool_args(tc)
            result = apply_tool_call(session.session_id, blueprint, extracted)

            messages.append({
                "role": "tool",
                "tool_name": "update_form_state",
                "content": json.dumps(result, ensure_ascii=False),
            })
            update_session_state(
                session,
                message={
                    "role": "tool",
                    "content": _summarize_tool_result(result),
                },
            )

        # Rebuild context after each round so the next tool definition
        # reflects newly filled fields
        current_ctx = prepare_turn(session.session_id, blueprint)

        # Re-inject updated system prompt (rules + state summary) so the model 
        # sees the latest filled/missing fields immediately.
        if messages and messages[0]["role"] == "system":
            messages[0]["content"] = current_ctx.system_prompt

    raise HTTPException(
        status_code=502,
        detail="The assistant exceeded the maximum number of tool-call rounds.",
    )


def _build_messages(
    session: SessionState,
    ctx: "Any",  # FormEngineContext
    user_text: str,
) -> list[dict[str, Any]]:
    """Build the full message list for an Ollama call."""
    history = _build_history(session)
    return [
        {"role": "system", "content": ctx.system_prompt},
        *history,
        {"role": "user", "content": user_text},
    ]


def _build_history(session: SessionState) -> list[dict[str, Any]]:
    """Return the last N user/assistant/tool messages from session history."""
    raw = session.messages
    # Drop the trailing user message (it will be added separately)
    if raw and str(raw[-1].get("role") or "").lower() == "user":
        raw = raw[:-1]
    raw = raw[-RECENT_MESSAGE_COUNT:]
    result: list[dict[str, Any]] = []
    for msg in raw:
        role = str(msg.get("role") or "").lower()
        content = str(msg.get("content") or "").strip()
        if not content:
            continue
        if role == "tool":
            # Include tool results so the LLM sees its own save-pattern
            result.append({"role": "assistant", "content": f"[I called a tool: {content}]"})
        elif role in {"user", "assistant"}:
            result.append({"role": role, "content": content})
    return result


def _extract_text(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text") or ""))
            elif hasattr(item, "text"):
                parts.append(str(item.text))
        return "\n".join(p for p in parts if p).strip()
    return str(content or "").strip()


def _get_tool_name(tool_call: Any) -> str:
    if isinstance(tool_call, dict):
        fn = tool_call.get("function") or {}
        return str(fn.get("name") or "").strip()
    return ""


def _parse_tool_args(tool_call: Any) -> dict[str, Any]:
    if isinstance(tool_call, dict):
        fn = tool_call.get("function") or {}
        args = fn.get("arguments")
        if isinstance(args, dict):
            # The model may place data directly under "arguments" or nest it
            # under "extracted_data" depending on how it interprets the schema.
            if "extracted_data" in args and isinstance(args["extracted_data"], dict):
                return args["extracted_data"]
            return args
        if isinstance(args, str):
            try:
                parsed = json.loads(args)
                if isinstance(parsed, dict):
                    if "extracted_data" in parsed and isinstance(parsed["extracted_data"], dict):
                        return parsed["extracted_data"]
                    return parsed
            except json.JSONDecodeError:
                pass
    return {}


def _summarize_tool_result(result: dict[str, Any]) -> str:
    if not result.get("ok"):
        return f"Tool error: {result.get('error')}"
    updated = result.get("updated_fields") or []
    missing = result.get("missing_fields") or []
    parts = []
    if updated:
        parts.append(f"Saved: {', '.join(updated)}.")
    parts.append(
        "Still missing: " + (", ".join(missing) if missing else "none") + "."
    )
    return " ".join(parts)


def _build_user_visible_response(
    blueprint: Blueprint,
    ctx: "Any",  # FormEngineContext
    assistant_text: str,
) -> str:
    """
    Append a concise, user-visible summary of the collected form data.

    The dynamic engine already tracks `filled_fields`, but many clients only
    render the `response` string. This keeps the current state visible inside
    the conversation itself.
    """
    text = assistant_text.strip()
    summary = _format_filled_fields_summary(blueprint, ctx.filled_fields)
    if not summary:
        return text
    if not text:
        return summary
    return f"{text}\n\n{summary}"


def _format_filled_fields_summary(
    blueprint: Blueprint,
    filled_fields: dict[str, Any],
) -> str:
    if not filled_fields:
        return ""

    field_map = blueprint.field_map()
    lines = ["Collected so far:"]
    for key, value in filled_fields.items():
        label = field_map[key].label if key in field_map else key
        lines.append(f"- {label}: {value}")
    return "\n".join(lines)
