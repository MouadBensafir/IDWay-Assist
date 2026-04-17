from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import TOOL_RESULT_MAX_CHARS, TOOL_RESULT_MAX_ITEMS
from .idway_data import (
    build_submission,
    get_countries,
    get_enrollment_center_dates,
    get_enrollment_center_times,
    get_enrollment_centers,
    get_form_fields,
    get_regions,
    get_service_details,
    get_towns,
    list_services,
    validate_form_field,
)
from .session_store import SessionState, record_submission

SUBMISSIONS_DIR = Path(__file__).resolve().parent / "data" / "idway" / "submissions"


def tool_list_services(include_disabled: bool = False) -> dict[str, Any]:
    return {"ok": True, "services": list_services(include_disabled=include_disabled)}


def tool_get_service_details(code: str) -> dict[str, Any]:
    return {"ok": True, "service": get_service_details(code)}


def tool_get_form_fields(code: str) -> dict[str, Any]:
    return {"ok": True, "fields": get_form_fields(code)}


def tool_validate_form_field(code: str, field_code: str, value: str) -> dict[str, Any]:
    return validate_form_field(code, field_code, value)


def tool_get_countries() -> dict[str, Any]:
    return {"ok": True, "countries": get_countries()}


def tool_get_regions(country_code: str) -> dict[str, Any]:
    return {"ok": True, "regions": get_regions(country_code)}


def tool_get_towns(region_code: str) -> dict[str, Any]:
    return {"ok": True, "towns": get_towns(region_code)}


def tool_get_enrollment_centers(town_code: str) -> dict[str, Any]:
    return {"ok": True, "centers": get_enrollment_centers(town_code)}


def tool_get_available_dates(code: str, enrollment_center_code: str) -> dict[str, Any]:
    return {"ok": True, "availability": get_enrollment_center_dates(code, enrollment_center_code)}


def tool_get_available_time_slots(code: str, enrollment_center_code: str, date: str) -> dict[str, Any]:
    return {"ok": True, "availability": get_enrollment_center_times(code, enrollment_center_code, date)}


def _find_by_code(items: list[dict[str, Any]], code: str) -> dict[str, Any] | None:
    return next((item for item in items if str(item.get("code")) == code), None)


def _build_submission_snapshot(code: str, payload: dict[str, Any], submission: dict[str, Any]) -> dict[str, Any]:
    form_fields = get_form_fields(code)
    countries = get_countries()

    country = _find_by_code(countries, str(payload.get("countryCode") or ""))
    regions = []
    if country is not None:
        try:
            regions = get_regions(str(country.get("code")))
        except Exception:
            regions = []

    region = _find_by_code(regions, str(payload.get("regionCode") or ""))
    towns = []
    if region is not None:
        try:
            towns = get_towns(str(region.get("code")))
        except Exception:
            towns = []

    town = _find_by_code(towns, str(payload.get("townCode") or ""))
    center = None
    town_code = str(payload.get("townCode") or "")
    if town_code:
        try:
            centers = get_enrollment_centers(town_code)
            center = _find_by_code(centers, str(payload.get("enrollmentCenterCode") or ""))
        except Exception:
            center = None

    form_values: dict[str, Any] = {}
    for field in form_fields:
        field_code = str(field.get("code") or "")
        if field_code and field_code in payload:
            form_values[field_code] = payload[field_code]

    appointment = {
        "countryCode": payload.get("countryCode"),
        "countryName": country.get("name") if country else None,
        "regionCode": payload.get("regionCode"),
        "regionName": region.get("name") if region else None,
        "townCode": payload.get("townCode"),
        "townName": town.get("name") if town else None,
        "enrollmentCenterCode": payload.get("enrollmentCenterCode"),
        "enrollmentCenterName": center.get("name") if center else None,
        "date": payload.get("date"),
        "time": payload.get("time"),
    }

    extracted_user = {
        "uin": payload.get("uin"),
        "firstName": payload.get("firstName"),
        "lastName": payload.get("lastName"),
        "birthDate": payload.get("birthDate"),
    }

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "referenceNumber": submission.get("referenceNumber"),
        "serviceCode": code,
        "message": submission.get("message"),
        "user": extracted_user,
        "formData": form_values,
        "appointment": appointment,
        "submittedPayload": deepcopy(payload),
    }


def _write_submission_snapshot(session_id: str | None, submission: dict[str, Any], snapshot: dict[str, Any]) -> str:
    SUBMISSIONS_DIR.mkdir(parents=True, exist_ok=True)
    safe_session_id = session_id or "anonymous"
    safe_reference = str(submission.get("referenceNumber") or "submission")
    filename = f"{safe_session_id}-{safe_reference}.json".replace("/", "-").replace("\\", "-")
    output_path = SUBMISSIONS_DIR / filename
    output_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(output_path)


def tool_submit_service_request(code: str, payload: dict[str, Any], session: SessionState | None = None) -> dict[str, Any]:
    submission = build_submission(code, payload)
    snapshot = _build_submission_snapshot(code, payload, submission)
    output_path = _write_submission_snapshot(session.session_id if session is not None else None, submission, snapshot)
    submission["summaryFile"] = output_path
    submission["conversationClosed"] = True
    submission["nextPrompt"] = "Ask the user if they want to do something else."
    if session is not None:
        record_submission(session, submission)
    return submission


AVAILABLE_TOOLS: dict[str, Any] = {
    "list_services": tool_list_services,
    "get_service_details": tool_get_service_details,
    "get_form_fields": tool_get_form_fields,
    "validate_form_field": tool_validate_form_field,
    "get_countries": tool_get_countries,
    "get_regions": tool_get_regions,
    "get_towns": tool_get_towns,
    "get_enrollment_centers": tool_get_enrollment_centers,
    "get_available_dates": tool_get_available_dates,
    "get_available_time_slots": tool_get_available_time_slots,
    "submit_service_request": tool_submit_service_request,
}

OLLAMA_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_services",
            "description": "List available e-services that the assistant can help the user complete.",
            "parameters": {
                "type": "object",
                "properties": {
                    "include_disabled": {
                        "type": "boolean",
                        "description": "Whether disabled services should be included.",
                        "default": False,
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_service_details",
            "description": "Get the full detail and ordered steps for a specific service code.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "The service code.",
                    },
                },
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_form_fields",
            "description": "Get the ordered form fields for a service code.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "The service code.",
                    },
                },
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "validate_form_field",
            "description": "Validate one field value for a service before moving to the next question.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "The service code.",
                    },
                    "field_code": {
                        "type": "string",
                        "description": "The field code to validate.",
                    },
                    "value": {
                        "type": "string",
                        "description": "The user-provided value.",
                    },
                },
                "required": ["code", "field_code", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_countries",
            "description": "List available countries for appointment booking.",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_regions",
            "description": "List regions for a selected country.",
            "parameters": {
                "type": "object",
                "properties": {
                    "country_code": {
                        "type": "string",
                        "description": "The selected country code.",
                    },
                },
                "required": ["country_code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_towns",
            "description": "List towns for a selected region.",
            "parameters": {
                "type": "object",
                "properties": {
                    "region_code": {
                        "type": "string",
                        "description": "The selected region code.",
                    },
                },
                "required": ["region_code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_enrollment_centers",
            "description": "List available enrollment centers for a town.",
            "parameters": {
                "type": "object",
                "properties": {
                    "town_code": {
                        "type": "string",
                        "description": "The selected town code.",
                    },
                },
                "required": ["town_code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_available_dates",
            "description": "Get the bookable date range and nearest available date for an enrollment center.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "The service code.",
                    },
                    "enrollment_center_code": {
                        "type": "string",
                        "description": "The selected enrollment center code.",
                    },
                },
                "required": ["code", "enrollment_center_code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_available_time_slots",
            "description": "Get available time slots for a selected date and enrollment center.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "The service code.",
                    },
                    "enrollment_center_code": {
                        "type": "string",
                        "description": "The selected enrollment center code.",
                    },
                    "date": {
                        "type": "string",
                        "description": "The selected date in YYYY-MM-DD format.",
                    },
                },
                "required": ["code", "enrollment_center_code", "date"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "submit_service_request",
            "description": "Submit the final service request after the user confirms the summary.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "The service code.",
                    },
                    "payload": {
                        "type": "object",
                        "description": "The final request payload including form fields and appointment data when required.",
                        "additionalProperties": True,
                    },
                },
                "required": ["code", "payload"],
            },
        },
    },
]


def normalize_tool_call(tool_call: Any) -> tuple[str, dict[str, Any]]:
    function_data = getattr(tool_call, "function", None) or tool_call.get("function", {})
    name = getattr(function_data, "name", None) or function_data.get("name")
    arguments_raw = getattr(function_data, "arguments", None) or function_data.get("arguments") or "{}"

    if not name or name not in AVAILABLE_TOOLS:
        raise ValueError("Model requested an unsupported tool.")

    if isinstance(arguments_raw, dict):
        arguments = arguments_raw
    else:
        arguments = json.loads(arguments_raw)

    if not isinstance(arguments, dict):
        raise ValueError("Tool arguments must be a JSON object.")

    return name, arguments


def execute_tool_call(tool_call: Any, session: SessionState | None = None) -> dict[str, Any]:
    name, arguments = normalize_tool_call(tool_call)
    tool_fn = AVAILABLE_TOOLS[name]

    try:
        if name == "submit_service_request":
            result = tool_fn(session=session, **arguments)
        else:
            result = tool_fn(**arguments)
    except Exception as exc:
        result = {"ok": False, "error": str(exc)}

    return {"tool": name, "result": result}


def build_tool_result_message(tool_result: dict[str, Any]) -> str:
    compact_result = compact_tool_payload(tool_result)
    content = json.dumps(compact_result, ensure_ascii=False)
    if len(content) <= TOOL_RESULT_MAX_CHARS:
        return content

    overflow = len(content) - TOOL_RESULT_MAX_CHARS
    fallback = {
        "tool": compact_result.get("tool"),
        "result": {
            "ok": bool(compact_result.get("result", {}).get("ok")),
            "summary": f"Tool result truncated to fit context budget. Omitted approximately {overflow} characters.",
        },
    }
    return json.dumps(fallback, ensure_ascii=False)


def compact_tool_payload(value: Any) -> Any:
    if isinstance(value, dict):
        items = list(value.items())
        compacted: dict[str, Any] = {}
        for index, (key, item) in enumerate(items):
            if index >= TOOL_RESULT_MAX_ITEMS:
                compacted["_truncatedKeys"] = len(items) - TOOL_RESULT_MAX_ITEMS
                break
            compacted[key] = compact_tool_payload(item)
        return compacted

    if isinstance(value, list):
        compacted_list = [compact_tool_payload(item) for item in value[:TOOL_RESULT_MAX_ITEMS]]
        if len(value) > TOOL_RESULT_MAX_ITEMS:
            compacted_list.append({"_truncatedItems": len(value) - TOOL_RESULT_MAX_ITEMS})
        return compacted_list

    if isinstance(value, str):
        if len(value) <= 240:
            return value
        return f"{value[:237]}..."

    return value


def serialize_tool_call(tool_call: Any) -> dict[str, Any]:
    if isinstance(tool_call, dict):
        return tool_call

    function_data = getattr(tool_call, "function", None)
    return {
        "function": {
            "name": getattr(function_data, "name", None),
            "arguments": getattr(function_data, "arguments", None),
        }
    }
