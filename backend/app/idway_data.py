from __future__ import annotations

import json
import re
from copy import deepcopy
from datetime import date, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any


DATA_DIR = Path(__file__).resolve().parent / "data" / "idway"
DEFAULT_SERVICE_CODE = "ai-id-renewal"


@lru_cache(maxsize=None)
def load_json_file(filename: str) -> Any:
    with (DATA_DIR / filename).open("r", encoding="utf-8") as data_file:
        return json.load(data_file)


@lru_cache(maxsize=1)
def get_translation_map() -> dict[str, str]:
    raw_translations = load_json_file("translation.json")
    translations: dict[str, str] = {}

    if isinstance(raw_translations, list):
        for group in raw_translations:
            if not isinstance(group, dict):
                continue
            entries = group.get("EN")
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                key = str(entry.get("key") or "").strip()
                content = str(entry.get("content") or "").strip()
                if key and content:
                    translations[key] = content

    return translations


def translate_text(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    return get_translation_map().get(value, value)


@lru_cache(maxsize=1)
def get_services_overview() -> list[dict[str, Any]]:
    details_by_code = get_service_details_map()
    services: list[dict[str, Any]] = []

    for service in load_json_file("overview.json"):
        if not isinstance(service, dict):
            continue
        code = str(service.get("code") or "").strip()
        if not code:
            continue
        detail = details_by_code.get(code, {})
        services.append(
            {
                "id": service.get("id"),
                "code": code,
                "label": translate_text(service.get("name") or code),
                "description": translate_text(detail.get("description") or ""),
                "enabled": bool(service.get("enabled", code == DEFAULT_SERVICE_CODE)),
            }
        )

    return services


@lru_cache(maxsize=1)
def get_service_details_map() -> dict[str, dict[str, Any]]:
    services: dict[str, dict[str, Any]] = {}

    for service in load_json_file("service-details.json"):
        if not isinstance(service, dict):
            continue
        code = str(service.get("code") or "").strip()
        if not code:
            continue

        normalized = deepcopy(service)
        normalized["label"] = translate_text(service.get("name") or code)
        normalized["description"] = translate_text(service.get("description") or "")
        normalized["stepDetailDtos"] = sorted(
            deepcopy(service.get("stepDetailDtos") or []),
            key=lambda step: step.get("order", 0),
        )
        services[code] = normalized

    return services


@lru_cache(maxsize=1)
def get_form_fields_map() -> dict[str, list[dict[str, Any]]]:
    fields: list[dict[str, Any]] = []

    for field in load_json_file("field-validation.json"):
        if not isinstance(field, dict):
            continue
        normalized = deepcopy(field)
        normalized["name"] = translate_text(field.get("name") or field.get("code") or "")
        normalized["description"] = translate_text(field.get("description") or "")
        fields.append(normalized)

    return {DEFAULT_SERVICE_CODE: sorted(fields, key=lambda field: field.get("fieldOrder", 0))}


@lru_cache(maxsize=1)
def get_countries_data() -> list[dict[str, Any]]:
    return [deepcopy(item) for item in load_json_file("countries.json") if isinstance(item, dict)]


@lru_cache(maxsize=1)
def get_regions_data() -> list[dict[str, Any]]:
    return [deepcopy(item) for item in load_json_file("regions.json") if isinstance(item, dict)]


@lru_cache(maxsize=1)
def get_towns_data() -> list[dict[str, Any]]:
    return [deepcopy(item) for item in load_json_file("towns.json") if isinstance(item, dict)]


@lru_cache(maxsize=1)
def get_enrollment_centers_data() -> list[dict[str, Any]]:
    return [deepcopy(item) for item in load_json_file("enrollment-centers.json") if isinstance(item, dict)]


@lru_cache(maxsize=1)
def get_date_availability_data() -> dict[str, Any]:
    raw_data = load_json_file("enrollmemt-centers-dates.json")
    if isinstance(raw_data, list) and raw_data:
        return deepcopy(raw_data[0])
    raise ValueError("No enrollment center date availability data found.")


@lru_cache(maxsize=1)
def get_time_slots_data() -> list[dict[str, Any]]:
    return [deepcopy(item) for item in load_json_file("enrollment-centers-date-times.json") if isinstance(item, dict)]


def list_services(include_disabled: bool = False) -> list[dict[str, Any]]:
    services = [service for service in get_services_overview() if include_disabled or service.get("enabled")]
    return deepcopy(services)


def get_service_details(service_code: str) -> dict[str, Any]:
    service = get_service_details_map().get(service_code)
    if service is None:
        raise ValueError(f"Unknown service code '{service_code}'.")
    return deepcopy(service)


def get_form_fields(service_code: str) -> list[dict[str, Any]]:
    fields = get_form_fields_map().get(service_code)
    if fields is None:
        raise ValueError(f"No form definition found for service '{service_code}'.")
    return deepcopy(fields)


def validate_form_field(service_code: str, field_code: str, value: str) -> dict[str, Any]:
    fields = get_form_fields(service_code)
    field = next((item for item in fields if item["code"] == field_code), None)
    if field is None:
        raise ValueError(f"Unknown field '{field_code}' for service '{service_code}'.")

    normalized = value.strip()
    errors: list[str] = []

    if len(normalized) < int(field.get("minSize", 0)):
        errors.append(f"Value must be at least {field['minSize']} characters long.")
    if len(normalized) > int(field.get("maxSize", len(normalized))):
        errors.append(f"Value must be at most {field['maxSize']} characters long.")

    if field.get("fieldType") == "BIRTHDATE":
        try:
            date.fromisoformat(normalized)
        except ValueError:
            errors.append("Value must use YYYY-MM-DD format.")
    elif field.get("regex") and not re.fullmatch(str(field["regex"]), normalized):
        errors.append("Value does not match the allowed format.")

    return {"ok": not errors, "field": field["code"], "value": normalized, "errors": errors}


def get_countries() -> list[dict[str, Any]]:
    return deepcopy(get_countries_data())


def get_regions(country_code: str) -> list[dict[str, Any]]:
    regions = [region for region in get_regions_data() if region.get("codeParent") == country_code]
    if not regions:
        raise ValueError(f"No regions found for country '{country_code}'.")
    return deepcopy(regions)


def get_towns(region_code: str) -> list[dict[str, Any]]:
    towns = [town for town in get_towns_data() if town.get("codeParent") == region_code]
    if not towns:
        raise ValueError(f"No towns found for region '{region_code}'.")
    return deepcopy(towns)


def get_enrollment_centers(town_code: str) -> list[dict[str, Any]]:
    if not any(town.get("code") == town_code for town in get_towns_data()):
        raise ValueError(f"Unknown town '{town_code}'.")

    # The JSON dataset does not currently map centers to towns, so return enabled centers.
    centers = [center for center in get_enrollment_centers_data() if center.get("enabled", True)]
    if not centers:
        raise ValueError(f"No enrollment centers found for town '{town_code}'.")
    return deepcopy(centers)


def get_enrollment_center_dates(service_code: str, enrollment_center_code: str) -> dict[str, Any]:
    get_service_details(service_code)
    if not any(center.get("code") == enrollment_center_code for center in get_enrollment_centers_data()):
        raise ValueError(f"Unknown enrollment center '{enrollment_center_code}'.")

    availability = get_date_availability_data()
    availability["nearestAvailableDate"] = find_nearest_available_date(availability)
    availability["enrollmentCenterCode"] = enrollment_center_code
    return deepcopy(availability)


def get_enrollment_center_times(service_code: str, enrollment_center_code: str, selected_date: str) -> dict[str, Any]:
    get_enrollment_center_dates(service_code, enrollment_center_code)
    try:
        date.fromisoformat(selected_date)
    except ValueError as exc:
        raise ValueError("Date must use YYYY-MM-DD format.") from exc

    time_slots = get_time_slots_data()
    available_slots = [
        str(slot.get("name"))
        for slot in time_slots
        if slot.get("status") and int(slot.get("capacity", 0)) > 0
    ]
    return {
        "enrollmentCenterCode": enrollment_center_code,
        "date": selected_date,
        "timeSlots": deepcopy(time_slots),
        "nearestAvailableTime": available_slots[0] if available_slots else None,
    }


def requires_appointment(service_code: str) -> bool:
    service = get_service_details(service_code)
    return any(step.get("name") == "Appointment" for step in service.get("stepDetailDtos", []))


def build_submission(service_code: str, payload: dict[str, Any]) -> dict[str, Any]:
    fields = get_form_fields(service_code)
    errors: list[str] = []

    for field in fields:
        field_value = str(payload.get(field["code"], "")).strip()
        validation = validate_form_field(service_code, field["code"], field_value)
        if not validation["ok"]:
            errors.extend(f"{field['code']}: {error}" for error in validation["errors"])

    if requires_appointment(service_code):
        for required_key in ("enrollmentCenterCode", "date", "time"):
            if not str(payload.get(required_key, "")).strip():
                errors.append(f"{required_key}: value is required for appointment services.")

    if errors:
        raise ValueError("; ".join(errors))

    timestamp = datetime.utcnow()
    return {
        "success": True,
        "referenceNumber": f"REQ-{timestamp:%Y%m%d-%H%M%S}",
        "message": "Your request has been successfully submitted.",
        "serviceCode": service_code,
        "submittedPayload": deepcopy(payload),
    }


def find_nearest_available_date(availability: dict[str, Any]) -> str | None:
    start_date = date.fromisoformat(str(availability["minDate"]))
    end_date = date.fromisoformat(str(availability["maxDate"]))
    off_dates = {str(item) for item in availability.get("offDates", [])}
    weekly_off_days = {int(item) for item in availability.get("weeklyOffDaysIndexes", [])}

    current = start_date
    while current <= end_date:
        weekday_index = (current.weekday() + 1) % 7
        if current.isoformat() not in off_dates and weekday_index not in weekly_off_days:
            return current.isoformat()
        current += timedelta(days=1)

    return None
