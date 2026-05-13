from __future__ import annotations

import json
import re
from typing import Any, AsyncGenerator

from fastapi import HTTPException
from starlette.datastructures import UploadFile as StarletteUploadFile

from .blueprint import Blueprint, DynamicChatResponse
from .config import OLLAMA_MODEL, RECENT_MESSAGE_COUNT
from .document_utils import build_document_payload
from .form_engine import _submission_path, apply_tool_call, prepare_turn
from .ollama_client import extract_token_usage, ollama_chat_completion, ollama_chat_completion_stream
from .repositories import blueprint_repository, submission_repository
from .session_store import (
    SessionState,
    cache_documents,
    get_token_usage,
    get_or_create_session,
    record_token_usage,
    update_session_state,
)


_MAX_TOOL_ROUNDS = 8


async def run_dynamic_blueprint_turn_stream(
    *,
    session: SessionState,
    blueprint: Blueprint,
    prompt: str,
    reset: bool = False,
    files: list[StarletteUploadFile] | None = None,
) -> AsyncGenerator[dict[str, Any], None]:
    document_payload = await build_document_payload(files or [])
    cache_documents(session, document_payload.vision_parts, document_payload.text_blocks)

    ctx = prepare_turn(session.session_id, blueprint, reset=reset)
    if ctx.is_complete:
        yield {"event": "done", "data": {
            "response": _build_user_visible_response(blueprint, ctx, blueprint.completion_message),
            "completed": True,
            "session_id": session.session_id,
            "workflow_session_id": session.session_id,
            "blueprint_id": blueprint.blueprint_id,
            "missing_fields": [],
            "filled_fields": ctx.filled_fields,
            "submission_path": str(ctx.submission_path),
            "token_usage": get_token_usage(session),
        }}
        return

    if document_payload.vision_parts or document_payload.text_blocks:
        await _extract_dynamic_document_fields(session, blueprint, document_payload)
        ctx = prepare_turn(session.session_id, blueprint)
        if ctx.is_complete:
            yield {"event": "done", "data": {
                "response": _build_user_visible_response(blueprint, ctx, blueprint.completion_message),
                "completed": True,
                "session_id": session.session_id,
                "workflow_session_id": session.session_id,
                "blueprint_id": blueprint.blueprint_id,
                "missing_fields": [],
                "filled_fields": ctx.filled_fields,
                "submission_path": str(ctx.submission_path),
                "token_usage": get_token_usage(session),
            }}
            return

    user_text = prompt.strip() or "Hello."
    user_content = _build_user_content(user_text, document_payload, session)
    update_session_state(
        session,
        message={"role": "user", "content": _build_session_user_summary(user_text, document_payload.filenames)},
    )

    stream = _run_dynamic_turn_stream(
        session=session,
        blueprint=blueprint,
        user_content=user_content,
        ctx=ctx,
    )

    response_text = ""
    data_was_saved = False

    async for event in stream:
        if event["event"] == "metadata":
            response_text = event["data"].get("response_text", "")
            data_was_saved = event["data"].get("data_was_saved", False)
            continue
        yield event

    ctx = prepare_turn(session.session_id, blueprint)
    if ctx.missing_fields and not data_was_saved and user_text.strip():
        await _extract_dynamic_from_conversation(session, blueprint, user_text, response_text)
        ctx = prepare_turn(session.session_id, blueprint)

    final_response = _build_user_visible_response(blueprint, ctx, response_text)
    yield {"event": "done", "data": {
        "response": final_response,
        "completed": ctx.is_complete,
        "session_id": session.session_id,
        "workflow_session_id": session.session_id,
        "blueprint_id": blueprint.blueprint_id,
        "missing_fields": ctx.missing_fields,
        "filled_fields": ctx.filled_fields,
        "submission_path": str(ctx.submission_path),
        "token_usage": get_token_usage(session),
    }}


async def _run_dynamic_turn_stream(
    session: SessionState,
    blueprint: Blueprint,
    user_content: list[dict[str, Any]],
    ctx: Any,
) -> AsyncGenerator[dict[str, Any], None]:
    messages = _build_messages(session, ctx, user_content)
    current_ctx = ctx
    data_was_saved = False
    response_text = ""

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

        assistant_payload: dict[str, Any] = {"role": "assistant"}
        if assistant_content:
            assistant_payload["content"] = assistant_content
        if tool_calls:
            assistant_payload["tool_calls"] = tool_calls
        messages.append(assistant_payload)

        if not tool_calls:
            final_text = assistant_content.strip()
            if not final_text:
                raise HTTPException(status_code=502, detail="Ollama returned an empty response.")
            update_session_state(session, message={"role": "assistant", "content": final_text})
            response_text = final_text
            yield {"event": "token", "data": {"token": final_text}}
            yield {"event": "metadata", "data": {
                "response_text": response_text,
                "data_was_saved": data_was_saved,
            }}
            return

        for tc in tool_calls:
            tool_name = _get_tool_name(tc)
            if tool_name != "update_form_state":
                messages.append({
                    "role": "tool",
                    "tool_name": tool_name,
                    "content": json.dumps({"ok": False, "error": f"Unknown tool: {tool_name}"}),
                })
                continue

            extracted = _parse_tool_args(tc)
            result = apply_tool_call(session.session_id, blueprint, extracted)
            if result.get("updated_fields"):
                data_was_saved = True

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

        current_ctx = prepare_turn(session.session_id, blueprint)

        if messages and messages[0]["role"] == "system":
            messages[0]["content"] = current_ctx.system_prompt

    raise HTTPException(
        status_code=502,
        detail="The assistant exceeded the maximum number of tool-call rounds.",
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


async def _run_dynamic_turn(
    session: SessionState,
    blueprint: Blueprint,
    user_content: list[dict[str, Any]],
    ctx: Any,
) -> tuple[str, bool]:
    messages = _build_messages(session, ctx, user_content)
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

        assistant_payload: dict[str, Any] = {"role": "assistant"}
        if assistant_content:
            assistant_payload["content"] = assistant_content
        if tool_calls:
            assistant_payload["tool_calls"] = tool_calls
        messages.append(assistant_payload)

        if not tool_calls:
            final_text = assistant_content.strip()
            if not final_text:
                raise HTTPException(status_code=502, detail="Ollama returned an empty response.")
            update_session_state(session, message={"role": "assistant", "content": final_text})
            return final_text, data_was_saved

        for tc in tool_calls:
            tool_name = _get_tool_name(tc)
            if tool_name != "update_form_state":
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

        current_ctx = prepare_turn(session.session_id, blueprint)

        if messages and messages[0]["role"] == "system":
            messages[0]["content"] = current_ctx.system_prompt

    raise HTTPException(
        status_code=502,
        detail="The assistant exceeded the maximum number of tool-call rounds.",
    )


def _build_messages(
    session: SessionState,
    ctx: Any,
    user_content: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    history = _build_history(session)
    return [
        {"role": "system", "content": ctx.system_prompt},
        *history,
        {"role": "user", "content": user_content},
    ]


def _build_history(session: SessionState) -> list[dict[str, Any]]:
    raw = session.messages
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
    ctx: Any,
    assistant_text: str,
) -> str:
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
