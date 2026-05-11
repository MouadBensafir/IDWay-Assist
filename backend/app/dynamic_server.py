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

from fastapi import APIRouter, HTTPException, Request
from starlette.datastructures import UploadFile as StarletteUploadFile

from .blueprint import (
    Blueprint,
    DynamicChatRequest,
    DynamicChatResponse,
    RegisterBlueprintRequest,
    RegisterBlueprintResponse,
)
from .config import OLLAMA_MODEL, RECENT_MESSAGE_COUNT
from .document_utils import build_document_payload
from .form_engine import _submission_path, apply_tool_call, prepare_turn
from .ollama_client import extract_token_usage, ollama_chat_completion
from .repositories import blueprint_repository, submission_repository
from .session_store import (
    SessionState,
    cache_documents,
    delete_session,
    get_token_usage,
    get_or_create_session,
    record_token_usage,
    update_session_state,
)

dynamic_router = APIRouter(prefix="/dynamic", tags=["Dynamic Schema-Driven"])

def _get_blueprint(blueprint_id: str) -> Blueprint:
    bp = blueprint_repository.get(blueprint_id)
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
    blueprint_repository.save(bp)
    return RegisterBlueprintResponse(
        blueprint_id=bp.blueprint_id,
        field_count=len(bp.fields),
    )


@dynamic_router.get("/blueprints", response_model=list[str])
async def list_blueprints() -> list[str]:
    """List all registered blueprint IDs."""
    return blueprint_repository.list_ids()


@dynamic_router.get("/blueprints/{blueprint_id}", response_model=Blueprint)
async def get_blueprint(blueprint_id: str) -> Blueprint:
    """Return the full Blueprint document for the given ID."""
    return _get_blueprint(blueprint_id)


@dynamic_router.delete("/blueprints/{blueprint_id}")
async def delete_blueprint(blueprint_id: str) -> dict[str, Any]:
    """Unregister a Blueprint."""
    if not blueprint_repository.delete(blueprint_id):
        raise HTTPException(status_code=404, detail=f"Blueprint '{blueprint_id}' not found.")
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
    path = _submission_path(session_id, bp.blueprint_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="No submission found for this session.")
    return submission_repository.load_path(path)


@dynamic_router.delete("/sessions/{session_id}")
async def remove_dynamic_session(session_id: str) -> dict[str, Any]:
    """Delete the in-memory conversation history for a session."""
    deleted = delete_session(session_id)
    return {"session_id": session_id, "deleted": deleted}


# ---------------------------------------------------------------------------
# Main chat endpoint
# ---------------------------------------------------------------------------


@dynamic_router.post("/chat", response_model=DynamicChatResponse)
async def dynamic_chat(request: Request) -> DynamicChatResponse:
    session_id, blueprint, prompt, reset, files = await _parse_dynamic_chat_request(request)
    session = get_or_create_session(session_id, reset=reset)
    return await run_dynamic_blueprint_turn(
        session=session,
        blueprint=blueprint,
        prompt=prompt,
        reset=reset,
        files=files,
    )


async def run_dynamic_blueprint_turn(
    *,
    session: SessionState,
    blueprint: Blueprint,
    prompt: str,
    reset: bool = False,
    files: list[StarletteUploadFile] | None = None,
) -> DynamicChatResponse:
    document_payload = await build_document_payload(files or [])
    cache_documents(session, document_payload.vision_parts, document_payload.text_blocks)

    ctx = prepare_turn(session.session_id, blueprint, reset=reset)
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

    if document_payload.vision_parts or document_payload.text_blocks:
        await _extract_dynamic_document_fields(session, blueprint, document_payload)
        ctx = prepare_turn(session.session_id, blueprint)
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

    user_text = prompt.strip() or "Hello."
    user_content = _build_user_content(user_text, document_payload, session)
    update_session_state(
        session,
        message={"role": "user", "content": _build_session_user_summary(user_text, document_payload.filenames)},
    )

    response_text, data_was_saved = await _run_dynamic_turn(
        session=session,
        blueprint=blueprint,
        user_content=user_content,
        ctx=ctx,
    )

    ctx = prepare_turn(session.session_id, blueprint)
    if ctx.missing_fields and not data_was_saved and user_text.strip():
        await _extract_dynamic_from_conversation(session, blueprint, user_text, response_text)
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
    user_content: list[dict[str, Any]],
    ctx: "Any",  # FormEngineContext — avoid circular import annotation
) -> tuple[str, bool]:
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
    messages = _build_messages(session, ctx, user_content)

    # Keep track of the current tool definition (may change each round
    # as fields get filled and the available set shrinks)
    current_ctx = ctx
    data_was_saved = False

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
            return final_text, data_was_saved

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
            data_was_saved = data_was_saved or bool(result.get("updated_fields"))

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
    user_content: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build the full message list for an Ollama call."""
    history = _build_history(session)
    return [
        {"role": "system", "content": ctx.system_prompt},
        *history,
        {"role": "user", "content": user_content},
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


async def _parse_dynamic_chat_request(
    request: Request,
) -> tuple[str | None, Blueprint, str, bool, list[StarletteUploadFile]]:
    content_type = request.headers.get("content-type", "").lower()

    if "multipart/form-data" in content_type:
        form = await request.form()
        session_id = _normalize_optional_string(form.get("session_id"))
        prompt = _normalize_optional_string(form.get("prompt")) or ""
        reset = _coerce_bool(form.get("reset"))
        files = [
            value
            for _, value in form.multi_items()
            if isinstance(value, StarletteUploadFile)
        ]

        blueprint_json = _normalize_optional_string(form.get("blueprint"))
        if blueprint_json:
            try:
                blueprint = Blueprint.model_validate(json.loads(blueprint_json))
            except Exception as exc:
                raise HTTPException(status_code=400, detail="Invalid blueprint payload.") from exc
            blueprint_repository.save(blueprint)
            return session_id, blueprint, prompt, reset, files

        blueprint_id = _normalize_optional_string(form.get("blueprint_id"))
        if not blueprint_id:
            raise HTTPException(status_code=400, detail="blueprint_id is required for multipart chat.")
        return session_id, _get_blueprint(blueprint_id), prompt, reset, files

    try:
        payload = DynamicChatRequest.model_validate(await request.json())
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid dynamic chat payload.") from exc

    if payload.blueprint is not None:
        blueprint_repository.save(payload.blueprint)
        return payload.session_id, payload.blueprint, payload.prompt.strip(), payload.reset, []

    assert payload.blueprint_id is not None
    return payload.session_id, _get_blueprint(payload.blueprint_id), payload.prompt.strip(), payload.reset, []


def _build_user_content(prompt: str, document_payload: Any, session: SessionState) -> list[dict[str, Any]]:
    content_parts: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": prompt or "No text message was provided. Use any uploaded documents if relevant.",
        }
    ]

    for text_block in document_payload.text_blocks:
        content_parts.append({"type": "text", "text": f"Extracted PDF text:\n{text_block}"})
    content_parts.extend(document_payload.vision_parts)

    if not (document_payload.vision_parts or document_payload.text_blocks) and session.has_received_document:
        content_parts.append(
            {
                "type": "text",
                "text": (
                    "[SESSION DOCUMENT CACHE] Previously uploaded documents are included again "
                    "for re-examination. Do not ask the user to resend them."
                ),
            }
        )
        for text_block in session.cached_text_blocks:
            content_parts.append({"type": "text", "text": f"Cached document text:\n{text_block}"})
        content_parts.extend(session.cached_vision_parts)

    return content_parts


def _build_session_user_summary(prompt: str, filenames: list[str]) -> str:
    if not filenames:
        return prompt
    return f"{prompt}\nUploaded files: {', '.join(filenames)}"


async def _extract_dynamic_document_fields(session: SessionState, blueprint: Blueprint, document_payload: Any) -> None:
    ctx = prepare_turn(session.session_id, blueprint)
    if not ctx.missing_fields:
        return

    fields_str = ", ".join(ctx.missing_fields)
    content_parts: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": (
                f"Extract the following fields from the attached document image or text: {fields_str}\n\n"
                "Return ONLY a valid JSON object with the field keys as keys and extracted values as strings. "
                "If a field is not visible, omit it."
            ),
        }
    ]
    for text_block in document_payload.text_blocks:
        content_parts.append({"type": "text", "text": f"Document text:\n{text_block}"})
    content_parts.extend(document_payload.vision_parts)

    completion = await ollama_chat_completion(
        [
            {
                "role": "system",
                "content": (
                    "You extract structured form values from documents. "
                    "Return only a JSON object with field keys and string values."
                ),
            },
            {"role": "user", "content": content_parts},
        ],
        temperature=0.0,
    )
    usage = extract_token_usage(completion)
    record_token_usage(
        session,
        prompt_tokens=usage["prompt_tokens"],
        completion_tokens=usage["completion_tokens"],
    )
    extracted = _parse_json_object(_extract_text(completion.get("message") or {}))
    if extracted:
        apply_tool_call(session.session_id, blueprint, extracted)


async def _extract_dynamic_from_conversation(
    session: SessionState,
    blueprint: Blueprint,
    user_text: str,
    assistant_text: str,
) -> None:
    ctx = prepare_turn(session.session_id, blueprint)
    if not ctx.missing_fields:
        return

    fields_str = ", ".join(ctx.missing_fields)
    prompt = (
        f'The user said: "{user_text}"\n'
        f'The assistant replied: "{assistant_text}"\n\n'
        f"Extract values for these fields if they are clearly present: {fields_str}\n\n"
        "Return ONLY a valid JSON object keyed by field key. If nothing is extractable, return {}."
    )
    completion = await ollama_chat_completion(
        [
            {
                "role": "system",
                "content": (
                    "You extract structured form values from conversation text. "
                    "Return only a JSON object."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        temperature=0.0,
        max_tokens=256,
    )
    usage = extract_token_usage(completion)
    record_token_usage(
        session,
        prompt_tokens=usage["prompt_tokens"],
        completion_tokens=usage["completion_tokens"],
    )
    extracted = _parse_json_object(_extract_text(completion.get("message") or {}))
    if extracted:
        apply_tool_call(session.session_id, blueprint, extracted)


def _parse_json_object(raw_text: str) -> dict[str, Any]:
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.removeprefix("```json").removeprefix("```").strip()
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3].strip()
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _normalize_optional_string(value: Any) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "on"}
