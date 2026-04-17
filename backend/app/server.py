from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .config import (
    COMPACT_TRIGGER_CHARS,
    MAX_CONTEXT_CHARS,
    MAX_TOOL_ROUNDS,
    MEMORY_SUMMARY_PROMPT,
    OLLAMA_MODEL,
    RECENT_MESSAGE_COUNT,
    SYSTEM_PROMPT,
)
from .models import DeleteSessionResponse, PromptRequest, PromptResponse
from .ollama_client import ollama_chat
from .session_store import (
    SessionState,
    delete_session,
    get_or_create_session,
    get_session_count,
    update_session_summary,
)
from .tools import build_tool_result_message, execute_tool_call, serialize_tool_call


app = FastAPI(title="IDWay Assist Agent", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def healthcheck() -> dict[str, str]:
    return {"status": "ok", "model": OLLAMA_MODEL, "sessions": str(get_session_count())}


@app.post("/chat", response_model=PromptResponse)
async def chat(request: PromptRequest) -> PromptResponse:
    prompt = request.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt must not be empty.")

    session = get_or_create_session(request.session_id, SYSTEM_PROMPT, reset=request.reset)
    session.messages.append({"role": "user", "content": prompt})

    try:
        response = None
        forced_final_response: str | None = None
        for _ in range(MAX_TOOL_ROUNDS):
            await compact_session_if_needed(session)
            response = await asyncio.to_thread(ollama_chat, session.messages)

            assistant_message = response.get("message", {})
            assistant_content = str(assistant_message.get("content") or "").strip()
            assistant_tool_calls = list(assistant_message.get("tool_calls") or [])

            assistant_payload: dict[str, Any] = {"role": "assistant"}
            if assistant_content:
                assistant_payload["content"] = assistant_content
            if assistant_tool_calls:
                assistant_payload["tool_calls"] = [serialize_tool_call(tool_call) for tool_call in assistant_tool_calls]
            session.messages.append(assistant_payload)

            if not assistant_tool_calls:
                break

            for tool_call in assistant_tool_calls:
                tool_result = execute_tool_call(tool_call, session=session)
                session.messages.append(
                    {
                        "role": "tool",
                        "content": build_tool_result_message(tool_result),
                    }
                )
                forced_final_response = build_forced_final_response(tool_result)
                if forced_final_response:
                    session.messages.append({"role": "assistant", "content": forced_final_response})
                    response = {"message": {"content": forced_final_response}}
                    break
                await compact_session_if_needed(session)
            if forced_final_response:
                break

        if response is None:
            raise RuntimeError("No response returned from Ollama.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail="The backend could not get a valid response from Ollama.",
        ) from exc

    text = str(response.get("message", {}).get("content") or "").strip()
    if not text:
        raise HTTPException(status_code=502, detail="Ollama returned an empty response.")

    return PromptResponse(session_id=session.session_id, response=text, model=OLLAMA_MODEL)


def build_forced_final_response(tool_result: dict[str, Any]) -> str | None:
    if tool_result.get("tool") != "submit_service_request":
        return None

    result = tool_result.get("result", {})
    if not isinstance(result, dict) or not result.get("conversationClosed"):
        return None

    reference_number = str(result.get("referenceNumber") or "").strip()
    summary_file = str(result.get("summaryFile") or "").strip()
    if not reference_number:
        return None

    message = f"Your request has been submitted successfully. Reference number: {reference_number}."
    if summary_file:
        message += f" I saved a summary JSON file to {summary_file}."
    message += " Would you like to do something else?"
    return message


@app.delete("/sessions/{session_id}", response_model=DeleteSessionResponse)
async def remove_session(session_id: str) -> DeleteSessionResponse:
    return DeleteSessionResponse(session_id=session_id, deleted=delete_session(session_id))


async def compact_session_if_needed(session: SessionState) -> None:
    if estimate_messages_size(session.messages) <= min(MAX_CONTEXT_CHARS, COMPACT_TRIGGER_CHARS):
        return

    system_message = session.messages[0] if session.messages else {"role": "system", "content": SYSTEM_PROMPT}
    non_system_messages = session.messages[1:]
    recent_count = max(0, RECENT_MESSAGE_COUNT)
    recent_messages = non_system_messages[-recent_count:] if recent_count else []
    older_messages = non_system_messages[:-recent_count] if recent_count else non_system_messages

    if not older_messages:
        return

    summary_messages: list[dict[str, Any]] = [
        {"role": "system", "content": MEMORY_SUMMARY_PROMPT},
    ]
    if session.summary.strip():
        summary_messages.append(
            {
                "role": "user",
                "content": f"Existing summary to refine:\n{session.summary.strip()}",
            }
        )
    summary_messages.extend(older_messages)

    summary_response = await asyncio.to_thread(
        ollama_chat,
        summary_messages,
        include_tools=False,
    )
    summary_text = str(summary_response.get("message", {}).get("content") or "").strip()
    if not summary_text:
        raise HTTPException(status_code=502, detail="Ollama returned an empty conversation summary.")

    compacted_messages = build_compacted_messages(system_message, summary_text, recent_messages)
    update_session_summary(session, summary_text, compacted_messages)


def estimate_messages_size(messages: list[dict[str, Any]]) -> int:
    total = 0
    for message in messages:
        total += len(str(message.get("role") or ""))
        total += len(str(message.get("content") or ""))
        tool_calls = message.get("tool_calls") or []
        total += len(json.dumps(tool_calls, ensure_ascii=False))
    return total


def build_compacted_messages(
    system_message: dict[str, Any],
    summary_text: str,
    recent_messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    summary_message = {
        "role": "system",
        "content": f"Conversation memory summary:\n{summary_text}",
    }
    trimmed_recent = list(recent_messages)

    compacted_messages = [system_message, summary_message, *trimmed_recent]
    while trimmed_recent and estimate_messages_size(compacted_messages) > MAX_CONTEXT_CHARS:
        trimmed_recent.pop(0)
        compacted_messages = [system_message, summary_message, *trimmed_recent]

    return compacted_messages
