# API Usage

This backend exposes two chat flows:

- `POST /chat`: the main assistant flow used by the current app
- `POST /dynamic/chat`: the schema-driven blueprint flow

Default local base URL:

```text
http://127.0.0.1:8001
```

## 1. Health Check

```bash
curl.exe http://127.0.0.1:8001/health
```

Returns basic server status, model name, active session count, and available services.

## 2. Main Chat API

Endpoint:

```text
POST /chat
```

Purpose:

- starts or continues a service conversation
- selects a service automatically from the user prompt
- saves collected form data into `backend/submissions/`
- supports plain text or multipart file upload

### JSON request

```json
{
  "session_id": "optional-existing-session-id",
  "prompt": "I need a visa appointment",
  "reset": false
}
```

### JSON example

```bash
curl.exe -X POST http://127.0.0.1:8001/chat ^
  -H "Content-Type: application/json" ^
  -d "{\"prompt\":\"I need a visa appointment\"}"
```

### Multipart example

```bash
curl.exe -X POST http://127.0.0.1:8001/chat ^
  -F "prompt=I need a visa appointment" ^
  -F "file=@C:\\path\\to\\passport.jpg"
```

### Response shape

```json
{
  "session_id": "7df954188b704f0a9988c5cf2e9b3c64",
  "response": "Assistant reply text",
  "model": "qwen3.5",
  "service_name": "VISA Appointment",
  "submission_path": "C:\\...\\backend\\submissions\\7df954188b704f0a9988c5cf2e9b3c64_visa_appointment.json",
  "completed": false,
  "missing_fields": [
    "appointment_city",
    "appointment_center"
  ],
  "token_usage": {
    "prompt_tokens": 100,
    "completion_tokens": 40,
    "total_tokens": 140
  }
}
```

### Notes

- Reuse `session_id` to continue a conversation.
- Set `reset: true` to restart an existing session.
- Uploaded documents are cached in memory for the current session.
- Completed submissions are stored as JSON files in `backend/submissions/`.

## 3. Delete a Main Chat Session

Endpoint:

```text
DELETE /sessions/{session_id}
```

Example:

```bash
curl.exe -X DELETE http://127.0.0.1:8001/sessions/7df954188b704f0a9988c5cf2e9b3c64
```

Response:

```json
{
  "session_id": "7df954188b704f0a9988c5cf2e9b3c64",
  "deleted": true
}
```

## 4. Dynamic Blueprint API

These endpoints support the schema-driven form engine.

## 4.1 Register a Blueprint

Endpoint:

```text
POST /dynamic/blueprints
```

Example:

```bash
curl.exe -X POST http://127.0.0.1:8001/dynamic/blueprints ^
  -H "Content-Type: application/json" ^
  --data-binary "@backend/data/blueprints/visa_appointment.json"
```

The actual request body must be wrapped like this:

```json
{
  "blueprint": {
    "blueprint_id": "visa_appointment",
    "title": "VISA Appointment",
    "fields": []
  }
}
```

Response:

```json
{
  "blueprint_id": "visa_appointment",
  "field_count": 9,
  "registered": true
}
```

## 4.2 List Registered Blueprints

```bash
curl.exe http://127.0.0.1:8001/dynamic/blueprints
```

## 4.3 Get a Blueprint

```bash
curl.exe http://127.0.0.1:8001/dynamic/blueprints/visa_appointment
```

## 4.4 Delete a Blueprint

```bash
curl.exe -X DELETE http://127.0.0.1:8001/dynamic/blueprints/visa_appointment
```

## 4.5 Dynamic Chat

Endpoint:

```text
POST /dynamic/chat
```

You must provide either:

- `blueprint_id`
- or a full inline `blueprint`

### Request using `blueprint_id`

```json
{
  "session_id": "optional-session-id",
  "blueprint_id": "visa_appointment",
  "prompt": "I need a visa appointment",
  "reset": false
}
```

### Example

```bash
curl.exe -X POST http://127.0.0.1:8001/dynamic/chat ^
  -H "Content-Type: application/json" ^
  -d "{\"blueprint_id\":\"visa_appointment\",\"prompt\":\"I need a visa appointment\"}"
```

### Response shape

```json
{
  "session_id": "abc123",
  "blueprint_id": "visa_appointment",
  "response": "Assistant reply text",
  "model": "qwen3.5",
  "completed": false,
  "missing_fields": [
    "appointment_city",
    "appointment_center"
  ],
  "filled_fields": {
    "full_name": "MOUAD BENSAFIR"
  },
  "submission_path": "C:\\...\\backend\\submissions\\abc123__visa_appointment.json",
  "token_usage": {
    "prompt_tokens": 100,
    "completion_tokens": 40,
    "total_tokens": 140
  }
}
```

## 4.6 Get Dynamic Session State

Endpoint:

```text
GET /dynamic/sessions/{session_id}/state?blueprint_id={blueprint_id}
```

Example:

```bash
curl.exe "http://127.0.0.1:8001/dynamic/sessions/abc123/state?blueprint_id=visa_appointment"
```

Returns the raw saved submission JSON for that dynamic session.

## 4.7 Delete a Dynamic Session

```bash
curl.exe -X DELETE http://127.0.0.1:8001/dynamic/sessions/abc123
```

## 5. Data Files Used by the Dynamic Flow

The current blueprint-based visa flow reads options from:

- [data/cities.json](/c:/Users/Mouad/Desktop/Expo_Test/backend/data/cities.json)
- [data/centers.json](/c:/Users/Mouad/Desktop/Expo_Test/backend/data/centers.json)
- [data/timeslots.json](/c:/Users/Mouad/Desktop/Expo_Test/backend/data/timeslots.json)

The current visa blueprint is:

- [data/blueprints/visa_appointment.json](/c:/Users/Mouad/Desktop/Expo_Test/backend/data/blueprints/visa_appointment.json)

## 6. Current Storage Behavior

At the moment, persistence is file-based, but the backend now treats JSON as a storage adapter behind repository-style components.

Current repository-backed simulation:

- `app/repositories.py`
  - `JsonBlueprintRepository`
  - `JsonSubmissionRepository`
  - `JsonReferenceDataRepository`
  - `InMemorySessionRepository`

- service blueprints live under `backend/data/blueprints/`
- service templates live under `backend/templates/`
- submission outputs live under `backend/submissions/`
- conversation sessions are kept in memory until deleted or process restart

If the process restarts:

- submission JSON files remain on disk
- in-memory session history is lost

This means you can keep the current JSON files for development and UI work, then later replace the repository implementations with a database-backed version without changing the public API.
