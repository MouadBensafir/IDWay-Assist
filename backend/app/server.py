from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.datastructures import UploadFile as StarletteUploadFile

from .config import (
    ASSISTANT_STYLE_PROMPT,
    MAX_TOOL_ROUNDS,
    OLLAMA_MODEL,
    RECENT_MESSAGE_COUNT,
    SYSTEM_PROMPT,
)
from .blueprint import Blueprint, BlueprintField, FieldType
from .document_utils import build_document_payload
from .form_engine import fetch_field_options
from .models import DeleteSessionResponse, PromptRequest, PromptResponse
from .ollama_client import extract_token_usage, ollama_chat_completion
from .repositories import blueprint_repository, submission_repository
from .session_store import (
    SessionState,
    cache_documents,
    delete_session,
    get_token_usage,
    get_or_create_session,
    get_session_count,
    record_token_usage,
    update_session_state,
)


app = FastAPI(title="IDWay Assist Agent", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Schema-Driven State Machine router ───────────────────────────────────────
from .dynamic_server import dynamic_router  # noqa: E402
app.include_router(dynamic_router)
# ── Service Workflow orchestration router ────────────────────────────────────
from .workflow_server import workflow_router  # noqa: E402
app.include_router(workflow_router)
# ────────────────────────────────────────────────────────────────────────────


SERVICE_CATALOG = {
    "ID Renewal": {
        "template": "id_renewal.json",
        "description": "Renew an existing ID card by confirming personal details and current document information.",
        "process": [
            "Select the renewal service.",
            "Provide or extract identity details from the current document.",
            "Confirm personal details and current address.",
            "Review the collected data and complete the request.",
        ],
        "questions": {
            "Full Name": "What is your full name as it should appear on the renewal request?",
            "Date of Birth": "What is your date of birth?",
            "Current ID Number": "What is your current ID number?",
            "Expiry Date": "What is the expiry date on your current ID?",
            "Address": "What is your current address?",
            "Blood Type": "What is your blood type?",
        },
    },
    "VISA Appointment": {
        "template": "visa_appointment.json",
        "description": "Book a visa appointment by collecting passport details, travel purpose, and a preferred appointment date.",
        "process": [
            "Choose the visa appointment service.",
            "Provide passport and nationality information.",
            "Specify destination country and travel purpose.",
            "Pick the desired appointment date and review the request.",
        ],
        "questions": {
            "Full Name": "What is your full name as it appears on your passport?",
            "Passport Number": "What is your passport number?",
            "Nationality": "What is your nationality?",
            "Destination Country": "Which country are you traveling to?",
            "Purpose of Travel": "What is the purpose of your travel?",
            "Desired Appointment Date": "What appointment date would you prefer?",
        },
    },
    "Driving License Renewal": {
        "template": "driving_license_renewal.json",
        "description": "Renew a driving license by confirming license details, vehicle class, and vision status.",
        "process": [
            "Select the driving license renewal service.",
            "Provide license details or upload the current license.",
            "Confirm vehicle class and issue date.",
            "Confirm vision test status and review the request.",
        ],
        "questions": {
            "Full Name": "What is your full name as it appears on your license?",
            "License Number": "What is your license number?",
            "Vehicle Class": "What vehicle class is on your license?",
            "Issue Date": "What is the issue date on your current license?",
            "Vision Test Status": "What is your current vision test status?",
        },
    },
}

SERVICE_ALIASES = {
    "id renewal": "ID Renewal",
    "id card renewal": "ID Renewal",
    "renew id": "ID Renewal",
    "visa appointment": "VISA Appointment",
    "visa": "VISA Appointment",
    "driving license renewal": "Driving License Renewal",
    "driver license renewal": "Driving License Renewal",
    "license renewal": "Driving License Renewal",
}

ASSISTANT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_services",
            "description": "List all available company services with short descriptions.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_service_details",
            "description": "Get the description, process, required fields, and current questions for a service.",
            "parameters": {
                "type": "object",
                "properties": {
                    "service_name": {
                        "type": "string",
                        "description": "Canonical service name.",
                    }
                },
                "required": ["service_name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "select_service",
            "description": "Select a service for the current session and create its submission record if needed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "service_name": {
                        "type": "string",
                        "description": "Canonical service name or close alias.",
                    }
                },
                "required": ["service_name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_submission_state",
            "description": "Read the current submission database record for this session, including filled and missing fields.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_submission_fields",
            "description": "Update one or more form fields in the current submission database using grounded user or document data.",
            "parameters": {
                "type": "object",
                "properties": {
                    "fields": {
                        "type": "object",
                        "description": "Map of field name to extracted value.",
                        "additionalProperties": {"type": "string"},
                    }
                },
                "required": ["fields"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "complete_service_request",
            "description": "Mark the current service request complete if no required fields are missing.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
    },
]


@app.on_event("startup")
async def startup_event() -> None:
    submission_repository.ensure_directories()


@app.get("/health")
async def healthcheck() -> dict[str, Any]:
    return {
        "status": "ok",
        "model": OLLAMA_MODEL,
        "sessions": get_session_count(),
        "services": list(SERVICE_CATALOG.keys()),
    }


@app.post("/chat", response_model=PromptResponse)
async def chat(request: Request) -> PromptResponse:
    session_id, prompt, reset, files = await parse_chat_request(request)
    session = get_or_create_session(session_id, reset=reset)

    if session.completed:
        return PromptResponse(
            session_id=session.session_id,
            response="This session is already complete. Start a new session if you need another service.",
            model=OLLAMA_MODEL,
            service_name=session.service_name,
            submission_path=session.submission_path,
            completed=True,
            missing_fields=[],
            token_usage=get_token_usage(session),
        )

    document_payload = await build_document_payload(files)

    # ── Merge any new uploads into the session-level document cache ──────────
    cache_documents(session, document_payload.vision_parts, document_payload.text_blocks)

    # ── SAFETY NET 1: Server-side document extraction ────────────────────────
    # When a document is uploaded, run a separate vision-only LLM call to
    # extract field values BEFORE the conversational turn.  This guarantees
    # data gets saved even if the model fails to call the tool itself.
    has_new_docs = bool(document_payload.vision_parts or document_payload.text_blocks)
    if has_new_docs:
        await _extract_document_fields(session, document_payload)
    # ─────────────────────────────────────────────────────────────────────────

    user_content = build_user_content(prompt, document_payload, session)
    session_user_summary = build_session_user_summary(prompt, document_payload.filenames)
    update_session_state(
        session,
        message={"role": "user", "content": session_user_summary},
    )

    response_text, data_was_saved = await run_assistant_turn(
        session=session,
        user_content=user_content,
    )

    # ── SAFETY NET 2: Post-turn conversation extraction ──────────────────────
    # If the LLM responded with text but never called a SAVE tool, and there are
    # still missing fields, run a quick text-only extraction call.
    form_data = load_current_form(session)
    missing_fields = get_missing_fields(form_data or {}, session.service_name)
    if missing_fields and not data_was_saved and prompt.strip():
        print(f"[Safety Net] No data saved by LLM. Attempting fallback extraction for: {missing_fields}")
        await _extract_from_conversation(session, prompt, response_text)
        form_data = load_current_form(session)
        missing_fields = get_missing_fields(form_data or {}, session.service_name)
    # ─────────────────────────────────────────────────────────────────────────

    return PromptResponse(
        session_id=session.session_id,
        response=response_text,
        model=OLLAMA_MODEL,
        service_name=session.service_name,
        submission_path=session.submission_path,
        completed=session.completed,
        missing_fields=missing_fields,
        token_usage=get_token_usage(session),
    )


@app.delete("/sessions/{session_id}", response_model=DeleteSessionResponse)
async def remove_session(session_id: str) -> DeleteSessionResponse:
    return DeleteSessionResponse(session_id=session_id, deleted=delete_session(session_id))


async def parse_chat_request(request: Request) -> tuple[str | None, str, bool, list[StarletteUploadFile]]:
    content_type = request.headers.get("content-type", "").lower()

    if "multipart/form-data" in content_type:
        form = await request.form()
        session_id = normalize_optional_string(form.get("session_id"))
        prompt = normalize_optional_string(form.get("prompt")) or ""
        reset = coerce_bool(form.get("reset"))
        files = [
            value
            for _, value in form.multi_items()
            if isinstance(value, StarletteUploadFile)
        ]
        return session_id, prompt, reset, files

    try:
        payload = PromptRequest.model_validate(await request.json())
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid chat payload.") from exc

    return payload.session_id, payload.prompt.strip(), payload.reset, []


async def run_assistant_turn(
    *,
    session: SessionState,
    user_content: list[dict[str, Any]],
) -> tuple[str, bool]:
    """
    Run the tool-calling loop.

    Returns (response_text, data_was_saved).
    """
    messages = build_llm_messages(session=session, user_content=user_content)
    data_was_saved = False

    for _ in range(MAX_TOOL_ROUNDS):
        completion = await ollama_chat_completion(
            messages,
            tools=ASSISTANT_TOOLS,
            temperature=0.1,
        )
        usage = extract_token_usage(completion)
        record_token_usage(
            session,
            prompt_tokens=usage["prompt_tokens"],
            completion_tokens=usage["completion_tokens"],
        )
        message = completion.get("message") or {}
        assistant_content = extract_message_content(message)
        assistant_tool_calls = list(message.get("tool_calls") or [])

        assistant_message_payload: dict[str, Any] = {
            "role": "assistant",
        }
        if assistant_content:
            assistant_message_payload["content"] = assistant_content
        if assistant_tool_calls:
            assistant_message_payload["tool_calls"] = assistant_tool_calls

        messages.append(assistant_message_payload)

        if not assistant_tool_calls:
            final_text = assistant_content.strip()
            if not final_text:
                raise HTTPException(status_code=502, detail="Ollama returned an empty response.")
            update_session_state(session, message={"role": "assistant", "content": final_text})
            return final_text, data_was_saved

        for tool_call in assistant_tool_calls:
            tool_name = get_tool_call_name(tool_call)
            if tool_name == "update_submission_fields":
                data_was_saved = True
            
            tool_result = execute_tool_call(session=session, tool_call=tool_call)
            messages.append(
                {
                    "role": "tool",
                    "tool_name": tool_name,
                    "content": json.dumps(tool_result, ensure_ascii=False),
                }
            )
            update_session_state(
                session,
                message={
                    "role": "tool",
                    "content": summarize_tool_result(tool_result),
                },
            )

        # ── Re-inject updated state summary ──────────────────────────────────
        new_summary = build_state_summary(session)
        if len(messages) > 1 and messages[1].get("role") == "system":
            messages[1]["content"] = new_summary
        # ─────────────────────────────────────────────────────────────────────

    raise HTTPException(status_code=502, detail="Ollama exceeded the maximum tool rounds.")


def build_llm_messages(session: SessionState, user_content: list[dict[str, Any]]) -> list[dict[str, Any]]:
    state_summary = build_state_summary(session)
    history_messages = build_history_messages(session)

    return [
        {
            "role": "system",
            "content": (
                f"{SYSTEM_PROMPT}\n\n"
                f"{ASSISTANT_STYLE_PROMPT}\n\n"
                "MANDATORY RULES (follow every single one):\n\n"
                "1. SELECT SERVICE FIRST: Use `select_service` before any field updates.\n\n"
                "2. DOCUMENT-FIRST: After selecting a service, if no documents are cached, "
                "your FIRST message MUST ask the user to send a photo of their document "
                "(ID card, passport, license). Only go field-by-field if they decline.\n\n"
                "3. ALWAYS SAVE IMMEDIATELY: Every time you learn a field value — whether "
                "from the user's speech, a document photo, or any other source — you MUST "
                "call `update_submission_fields` in that SAME turn. Never respond with text "
                "only when you have data to save. This is the most important rule.\n\n"
                "4. RE-EXAMINE CACHED DOCS: If session state shows cached documents and "
                "fields are still empty, look at the cached document again for those fields "
                "before asking the user manually.\n\n"
                "5. EXTRACT EVERYTHING AT ONCE: When a document image is present, extract "
                "ALL readable fields in one `update_submission_fields` call.\n\n"
                "6. Do NOT mention tool names or field keys to the user.\n"
            ),
        },
        {
            "role": "system",
            "content": state_summary,
        },
        *history_messages,
        {
            "role": "user",
            "content": user_content,
        },
    ]


def build_state_summary(session: SessionState) -> str:
    form_data = load_current_form(session)
    blueprint = get_service_blueprint(session.service_name)
    field_map = blueprint.field_map() if blueprint is not None else {}
    missing_fields = get_missing_fields(form_data or {}, session.service_name)
    filled_fields = get_filled_fields(form_data or {}, session.service_name)
    service_name = session.service_name or "None"

    doc_count = len(session.cached_vision_parts) + len(session.cached_text_blocks)
    doc_status = (
        f"{doc_count} document(s) cached — they are re-injected into every turn automatically"
        if session.has_received_document
        else "No documents uploaded yet this session"
    )

    parts = [
        "=== CURRENT SESSION STATE ===",
        f"Service: {service_name}",
        f"Documents: {doc_status}",
    ]

    if filled_fields:
        parts.append("\nAlready saved in submission:")
        for key, val in filled_fields.items():
            parts.append(f"  ✓ {key}: {val}")

    if missing_fields:
        parts.append("\nSTILL EMPTY (must be filled):")
        for field_name in missing_fields:
            parts.append(f"  ✗ {field_name}")
        parts.append(
            "\n>>> ACTION: If the user provides ANY of the above fields in this message, "
            "you MUST call `update_submission_fields` to save them NOW. <<<"
        )
    else:
        parts.append("\nAll fields are filled! Call `complete_service_request` to finish.")

    return "\n".join(parts)


def build_history_messages(session: SessionState) -> list[dict[str, Any]]:
    raw_messages = session.messages
    if raw_messages and str(raw_messages[-1].get("role") or "").strip().lower() == "user":
        raw_messages = raw_messages[:-1]
    raw_messages = raw_messages[-RECENT_MESSAGE_COUNT:]
    formatted_messages: list[dict[str, Any]] = []

    for message in raw_messages:
        role = str(message.get("role") or "").strip().lower()
        content = normalize_optional_string(message.get("content")) or ""
        if not role or not content:
            continue

        if role == "tool":
            # Include tool results as assistant actions so the LLM sees
            # the pattern: "user gives info → I call the tool → data saved".
            # This reinforces tool-calling behaviour across turns.
            formatted_messages.append({
                "role": "assistant",
                "content": f"[I called a tool: {content}]",
            })
            continue

        if role not in {"user", "assistant"}:
            continue
        formatted_messages.append({"role": role, "content": content})

    return formatted_messages


def build_user_content(prompt: str, document_payload: Any, session: SessionState) -> list[dict[str, Any]]:
    content_parts: list[dict[str, Any]] = []
    content_parts.append(
        {
            "type": "text",
            "text": prompt or "No text message was provided. Use the uploaded documents if relevant.",
        }
    )

    # Current-turn documents (fresh upload from this request)
    for text_block in document_payload.text_blocks:
        content_parts.append(
            {
                "type": "text",
                "text": f"Extracted PDF text:\n{text_block}",
            }
        )
    content_parts.extend(document_payload.vision_parts)

    # ── Inject cached documents when no new file was sent this turn ──────────
    # This lets the agent re-examine previously uploaded photos without the
    # user needing to re-send them.
    new_docs_this_turn = bool(document_payload.vision_parts or document_payload.text_blocks)
    if not new_docs_this_turn and session.has_received_document:
        content_parts.append(
            {
                "type": "text",
                "text": (
                    "[SESSION DOCUMENT CACHE] The following document(s) were uploaded "
                    "earlier in this conversation. They are provided here again so you "
                    "can re-examine them for any fields you may not have extracted yet. "
                    "Do NOT ask the user to resend them."
                ),
            }
        )
        for text_block in session.cached_text_blocks:
            content_parts.append({"type": "text", "text": f"Cached document text:\n{text_block}"})
        content_parts.extend(session.cached_vision_parts)
    # ─────────────────────────────────────────────────────────────────────────

    return content_parts


def build_session_user_summary(prompt: str, filenames: list[str]) -> str:
    prompt_text = prompt or "No text message."
    if not filenames:
        return prompt_text
    return f"{prompt_text}\nUploaded files: {', '.join(filenames)}"


def execute_tool_call(session: SessionState, tool_call: Any) -> dict[str, Any]:
    function_payload = tool_call.get("function") if isinstance(tool_call, dict) else None
    if not isinstance(function_payload, dict):
        return {"ok": False, "error": "Malformed tool call payload."}

    function_name = str(function_payload.get("name") or "").strip()
    arguments = parse_tool_arguments(function_payload.get("arguments"))

    if function_name == "list_services":
        services = [
            {
                "name": service_name,
                "description": service_config["description"],
            }
            for service_name, service_config in SERVICE_CATALOG.items()
        ]
        return {"ok": True, "services": services}

    if function_name == "get_service_details":
        service_name = normalize_service_name(arguments.get("service_name"))
        if not service_name:
            return {"ok": False, "error": "Unknown service name."}
        return {
            "ok": True,
            "service": build_service_details(service_name),
        }

    if function_name == "select_service":
        service_name = normalize_service_name(arguments.get("service_name"))
        if not service_name:
            return {"ok": False, "error": "Unknown service name."}

        if session.service_name != service_name or not session.submission_path:
            submission_path = create_submission_from_template(session.session_id, service_name)
            update_session_state(
                session,
                service_name=service_name,
                submission_path=str(submission_path),
            )

        form_data = load_current_form(session) or {}
        return {
            "ok": True,
            "service_name": service_name,
            "submission_path": session.submission_path,
            "state": describe_submission_state(service_name, form_data),
        }

    if function_name == "get_submission_state":
        form_data = load_current_form(session)
        return {
            "ok": True,
            "service_name": session.service_name,
            "submission_path": session.submission_path,
            "state": describe_submission_state(session.service_name, form_data or {}),
        }

    if function_name == "update_submission_fields":
        if not session.service_name:
            return {"ok": False, "error": "No service selected yet."}

        form_data = load_current_form(session)
        if form_data is None:
            return {"ok": False, "error": "No submission database exists for this session."}

        fields = arguments.get("fields")
        if not isinstance(fields, dict):
            return {"ok": False, "error": "The fields argument must be an object."}

        applied_updates = apply_field_updates(form_data, fields)
        save_current_form(session, form_data)

        return {
            "ok": True,
            "service_name": session.service_name,
            "updated_fields": applied_updates,
            "state": describe_submission_state(session.service_name, form_data),
        }

    if function_name == "complete_service_request":
        form_data = load_current_form(session)
        missing_fields = get_missing_fields(form_data or {}, session.service_name)
        if missing_fields:
            return {
                "ok": False,
                "error": "The service is not complete yet.",
                "missing_fields": missing_fields,
            }

        update_session_state(session, completed=True)
        return {
            "ok": True,
            "service_name": session.service_name,
            "submission_path": session.submission_path,
            "state": describe_submission_state(session.service_name, form_data or {}),
            "completed": True,
        }

    return {"ok": False, "error": f"Unknown tool: {function_name}"}


def save_current_form(session: SessionState, form_data: dict[str, Any]) -> None:
    if not session.submission_path:
        raise HTTPException(status_code=500, detail="Submission path is missing for this session.")

    submission_path = Path(session.submission_path)
    submission_repository.save_path(submission_path, form_data)


def apply_field_updates(form_data: dict[str, Any], field_updates: dict[str, Any]) -> list[str]:
    normalized_field_map = {normalize_key(key): key for key in form_data}
    applied_updates: list[str] = []

    for incoming_key, incoming_value in field_updates.items():
        canonical_key = normalized_field_map.get(normalize_key(str(incoming_key)))
        if not canonical_key:
            continue

        cleaned_value = normalize_optional_string(incoming_value)
        if cleaned_value is None:
            continue

        if form_data.get(canonical_key) == cleaned_value:
            continue

        form_data[canonical_key] = cleaned_value
        applied_updates.append(canonical_key)

    return applied_updates


def extract_message_content(message: Any) -> str:
    if isinstance(message, dict):
        content = message.get("content")
    else:
        content = getattr(message, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text") or ""))
            else:
                text_value = getattr(item, "text", None)
                if isinstance(text_value, str):
                    parts.append(text_value)
        return "\n".join(part for part in parts if part).strip()
    return str(content or "").strip()


def get_tool_call_name(tool_call: dict[str, Any]) -> str:
    function_payload = tool_call.get("function")
    if not isinstance(function_payload, dict):
        return ""
    return str(function_payload.get("name") or "").strip()


def summarize_tool_result(tool_result: dict[str, Any]) -> str:
    if tool_result.get("ok") is False:
        return f"Tool error: {tool_result.get('error')}"

    service_name = normalize_optional_string(tool_result.get("service_name"))
    state = tool_result.get("state")
    if isinstance(state, dict):
        missing_fields = state.get("missing_fields")
        updated_fields = tool_result.get("updated_fields")
        summary_parts = []
        if service_name:
            summary_parts.append(f"Service: {service_name}.")
        if isinstance(updated_fields, list) and updated_fields:
            summary_parts.append(f"Updated fields: {', '.join(str(item) for item in updated_fields)}.")
        if isinstance(missing_fields, list):
            summary_parts.append(
                "Missing fields: "
                + (", ".join(str(item) for item in missing_fields) if missing_fields else "none")
                + "."
            )
        return " ".join(summary_parts).strip() or json.dumps(tool_result, ensure_ascii=False)

    return json.dumps(tool_result, ensure_ascii=False)


def parse_json_object(raw_text: str) -> dict[str, Any]:
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if not match:
            return {}
        try:
            parsed = json.loads(match.group(0))
        except json.JSONDecodeError:
            return {}

    if not isinstance(parsed, dict):
        return {}
    return parsed


def parse_tool_arguments(raw_arguments: Any) -> dict[str, Any]:
    if isinstance(raw_arguments, dict):
        return raw_arguments
    return parse_json_object(str(raw_arguments or "{}"))


def normalize_service_name(value: Any) -> str | None:
    normalized = normalize_optional_string(value)
    if normalized is None:
        return None

    if normalized in SERVICE_CATALOG:
        return normalized

    return SERVICE_ALIASES.get(normalized.lower())


def normalize_optional_string(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        cleaned = value.strip()
        return cleaned or None
    cleaned = str(value).strip()
    return cleaned or None


def normalize_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def get_service_blueprint(service_name: str | None) -> Blueprint | None:
    if not service_name:
        return None

    service_config = SERVICE_CATALOG.get(service_name)
    if not service_config:
        return None

    template_name = normalize_optional_string(service_config.get("template"))
    if not template_name:
        return None
    blueprint_id = Path(template_name).stem
    return blueprint_repository.get(blueprint_id)


def is_filled_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return bool(value)
    return True


def _dependencies_met(field: BlueprintField, form_data: dict[str, Any]) -> bool:
    return all(is_filled_value(form_data.get(dep)) for dep in field.depends_on)


def sync_form_data_with_blueprint(service_name: str | None, form_data: dict[str, Any]) -> bool:
    blueprint = get_service_blueprint(service_name)
    if blueprint is None:
        return False

    changed = False
    normalized_keys = {normalize_key(key): key for key in list(form_data.keys())}

    for field in blueprint.fields:
        if field.key in form_data:
            continue

        legacy_key = normalized_keys.get(normalize_key(field.label))
        legacy_value = form_data.get(legacy_key) if legacy_key else None
        form_data[field.key] = legacy_value if is_filled_value(legacy_value) else None
        changed = True

    return changed


def get_missing_fields(form_data: dict[str, Any], service_name: str | None = None) -> list[str]:
    blueprint = get_service_blueprint(service_name)
    if blueprint is not None:
        return [
            field.key
            for field in blueprint.fields
            if field.required and not is_filled_value(form_data.get(field.key))
        ]

    missing_fields: list[str] = []
    for key, value in form_data.items():
        if not is_filled_value(value):
            missing_fields.append(key)
    return missing_fields


def get_filled_fields(form_data: dict[str, Any], service_name: str | None = None) -> dict[str, Any]:
    blueprint = get_service_blueprint(service_name)
    if blueprint is not None:
        return {
            field.key: form_data[field.key]
            for field in blueprint.fields
            if field.key in form_data and is_filled_value(form_data.get(field.key))
        }

    return {
        key: value
        for key, value in form_data.items()
        if is_filled_value(value)
    }


def build_service_details(service_name: str) -> dict[str, Any]:
    service_config = SERVICE_CATALOG[service_name]
    blueprint = get_service_blueprint(service_name)
    required_fields = (
        [field.label for field in blueprint.fields if field.required]
        if blueprint is not None
        else list(service_config["questions"].keys())
    )
    return {
        "name": service_name,
        "description": service_config["description"],
        "process": service_config["process"],
        "required_fields": required_fields,
        "next_questions": service_config["questions"],
    }


def get_next_question(service_name: str | None, missing_fields: list[str]) -> str | None:
    if not service_name or not missing_fields:
        return None

    blueprint = get_service_blueprint(service_name)
    if blueprint is not None:
        field = blueprint.field_map().get(missing_fields[0])
        if field is None:
            return None
        return field.hint or f"Please provide your {field.label.lower()}."

    return SERVICE_CATALOG[service_name]["questions"].get(missing_fields[0])


def describe_submission_state(service_name: str | None, form_data: dict[str, Any]) -> dict[str, Any]:
    missing_fields = get_missing_fields(form_data, service_name)
    filled_fields = get_filled_fields(form_data, service_name)

    return {
        "service_name": service_name,
        "filled_fields": filled_fields,
        "missing_fields": missing_fields,
        "next_question": get_next_question(service_name, missing_fields),
        "is_complete": not missing_fields,
    }


def load_current_form(session: SessionState) -> dict[str, Any] | None:
    if not session.submission_path:
        return None

    submission_path = Path(session.submission_path)
    if not submission_path.exists():
        return None

    data = submission_repository.load_path(submission_path)
    if not isinstance(data, dict):
        raise HTTPException(status_code=500, detail="Stored submission file is invalid.")

    if sync_form_data_with_blueprint(session.service_name, data):
        save_current_form(session, data)

    return data


def create_submission_from_template(session_id: str, service_name: str) -> Path:
    blueprint = get_service_blueprint(service_name)
    if blueprint is not None:
        return submission_repository.create_from_blueprint(
            session_id,
            blueprint,
            legacy_service_name=service_name,
        )

    service_config = SERVICE_CATALOG[service_name]
    template_name = str(service_config["template"])
    try:
        return submission_repository.create_from_template(session_id, service_name, template_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=f"Template not found for {service_name}.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def build_state_summary(session: SessionState) -> str:
    form_data = load_current_form(session)
    blueprint = get_service_blueprint(session.service_name)
    field_map = blueprint.field_map() if blueprint is not None else {}
    missing_fields = get_missing_fields(form_data or {}, session.service_name)
    filled_fields = get_filled_fields(form_data or {}, session.service_name)
    service_name = session.service_name or "None"

    doc_count = len(session.cached_vision_parts) + len(session.cached_text_blocks)
    doc_status = (
        f"{doc_count} document(s) cached - they are re-injected into every turn automatically"
        if session.has_received_document
        else "No documents uploaded yet this session"
    )

    parts = [
        "=== CURRENT SESSION STATE ===",
        f"Service: {service_name}",
        f"Documents: {doc_status}",
    ]

    if filled_fields:
        parts.append("\nAlready saved in submission:")
        for key, value in filled_fields.items():
            label = field_map.get(key).label if key in field_map else key
            parts.append(f"  - {label}: {value}")

    if missing_fields:
        parts.append("\nSTILL EMPTY (must be filled):")
        for field_name in missing_fields:
            field = field_map.get(field_name)
            if field is None:
                parts.append(f"  - {field_name}")
                continue

            if not _dependencies_met(field, form_data or {}):
                dependency_labels = [
                    field_map[dep].label
                    for dep in field.depends_on
                    if dep in field_map
                ]
                deps_text = ", ".join(dependency_labels) if dependency_labels else "required earlier fields"
                parts.append(f"  - {field.label} (wait until {deps_text} is filled)")
                continue

            line = f"  - {field.label}"
            if field.hint:
                line += f": {field.hint}"
            parts.append(line)

            if field.field_type == FieldType.DYNAMIC_ENUM:
                options = fetch_field_options(field, form_data or {}) or []
                if options:
                    options_text = ", ".join(
                        f"{item['label']} ({item['value']})"
                        if item["label"] != item["value"]
                        else item["label"]
                        for item in options
                    )
                    parts.append(f"    Available options: {options_text}")

        parts.append(
            "\n>>> ACTION: If the user provides ANY of the above fields in this message, "
            "you MUST call `update_submission_fields` to save them NOW. <<<"
        )
    else:
        parts.append("\nAll fields are filled! Call `complete_service_request` to finish.")

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Extraction safety nets
# ---------------------------------------------------------------------------


async def _extract_document_fields(session: SessionState, document_payload: Any) -> None:
    """
    Safety net: extract field values from an uploaded document via a separate
    vision-only LLM call (no tools).  Runs BEFORE the main conversational turn
    so data is saved regardless of whether the model calls
    ``update_submission_fields``.
    """
    if not session.service_name or not session.submission_path:
        return

    form_data = load_current_form(session)
    if form_data is None:
        return

    missing = get_missing_fields(form_data, session.service_name)
    if not missing:
        return

    fields_str = ", ".join(missing)
    extraction_prompt = (
        f"Extract the following fields from the attached document image: {fields_str}\n\n"
        "Return ONLY a valid JSON object with the field names as keys and "
        "extracted values as strings.  If a field is not visible in the "
        'document, omit it.  Example: {"Full Name": "John Doe", '
        '"Passport Number": "AB1234567"}'
    )

    content_parts: list[dict[str, Any]] = [
        {"type": "text", "text": extraction_prompt},
    ]
    for text_block in document_payload.text_blocks:
        content_parts.append({"type": "text", "text": f"Document text:\n{text_block}"})
    content_parts.extend(document_payload.vision_parts)

    messages = [
        {
            "role": "system",
            "content": (
                "You are a document data extractor. Read the document and return "
                "a JSON object mapping field names to extracted values. "
                "Return ONLY the JSON object — no explanation, no markdown."
            ),
        },
        {"role": "user", "content": content_parts},
    ]

    try:
        completion = await ollama_chat_completion(messages, temperature=0.0)
        usage = extract_token_usage(completion)
        record_token_usage(
            session,
            prompt_tokens=usage["prompt_tokens"],
            completion_tokens=usage["completion_tokens"],
        )
        response_text = extract_message_content(completion.get("message") or {})
        extracted = parse_json_object(response_text)
        if extracted:
            applied = apply_field_updates(form_data, extracted)
            if applied:
                print(f"[Safety Net] Extracted {len(applied)} fields from document: {applied}")
                save_current_form(session, form_data)
    except Exception as e:
        print(f"[Safety Net] Document extraction failed: {e}")
        pass


async def _extract_from_conversation(
    session: SessionState, user_text: str, assistant_text: str
) -> None:
    """
    Safety net: when the LLM responded with text but did NOT call a tool,
    run a quick text-only extraction call to save any field values the user
    provided in their message.
    """
    if not session.service_name or not session.submission_path:
        return

    form_data = load_current_form(session)
    if form_data is None:
        return

    missing = get_missing_fields(form_data, session.service_name)
    if not missing:
        return

    fields_str = ", ".join(missing)
    prompt = (
        f"The user said: \"{user_text}\"\n"
        f"The assistant replied: \"{assistant_text}\"\n\n"
        f"From this exchange, extract values for these fields: {fields_str}\n\n"
        "Return ONLY a valid JSON object with field names as keys. "
        "If no values can be extracted, return {}"
    )

    messages = [
        {
            "role": "system",
            "content": (
                "You extract field values from conversation text. "
                "Return ONLY a valid JSON object — no explanation."
            ),
        },
        {"role": "user", "content": prompt},
    ]

    try:
        completion = await ollama_chat_completion(
            messages, temperature=0.0, max_tokens=256,
        )
        usage = extract_token_usage(completion)
        record_token_usage(
            session,
            prompt_tokens=usage["prompt_tokens"],
            completion_tokens=usage["completion_tokens"],
        )
        response_text = extract_message_content(completion.get("message") or {})
        extracted = parse_json_object(response_text)
        if extracted:
            applied = apply_field_updates(form_data, extracted)
            if applied:
                print(f"[Safety Net] Captured {len(applied)} fields from chat fallback: {applied}")
                save_current_form(session, form_data)
    except Exception as e:
        print(f"[Safety Net] Conversation fallback failed: {e}")
        pass
