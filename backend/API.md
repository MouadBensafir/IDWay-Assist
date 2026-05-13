# API Usage

This backend exposes a single workflow-driven chat API.

Base URL:
```text
http://127.0.0.1:8001
```

## 1. Health Check

```bash
curl.exe http://127.0.0.1:8001/health
```

Returns server status, model name, and active session count.

## 2. Workflow Chat

### Auto-detect workflow

```text
POST /workflows/chat
```

The backend infers the workflow from keyword matching in the prompt. If ambiguous or no match, it returns a list of available services.

```bash
curl.exe -X POST http://127.0.0.1:8001/workflows/chat ^
  -H "Content-Type: application/json" ^
  -d "{\"prompt\":\"I need a visa appointment\"}"
```

### Explicit workflow

```text
POST /workflows/{workflow_id}/chat
```

```bash
curl.exe -X POST http://127.0.0.1:8001/workflows/us_nonimmigrant_visa/chat ^
  -H "Content-Type: application/json" ^
  -d "{\"prompt\":\"I need a visa appointment\"}"
```

### Multipart with file upload

```bash
curl.exe -X POST http://127.0.0.1:8001/workflows/us_nonimmigrant_visa/chat ^
  -F "prompt=Here is my passport" ^
  -F "file=@C:\path\to\passport.jpg"
```

### Response shape

```json
{
  "workflow_session_id": "abc123",
  "workflow_id": "us_nonimmigrant_visa",
  "workflow_title": "US Non-Immigrant Visa Appointment",
  "response": "Assistant reply text",
  "model": "qwen3.5",
  "workflow_complete": false,
  "current_step_id": "determine_visa_category",
  "current_step_title": "1. Determine Visa Category",
  "current_step_status": "in_progress",
  "missing_fields": ["full_name", "visa_type"],
  "filled_fields": {},
  "submission_path": "C:\\...\\submissions\\abc123__visa_category_selector.json",
  "token_usage": { "prompt_tokens": 100, "completion_tokens": 40, "total_tokens": 140 }
}
```

### Notes

- Reuse `workflow_session_id` to continue a conversation.
- Set `reset: true` to restart an existing session.
- Uploaded documents are cached in memory for the current session.
- Completed submissions stored as JSON files in `backend/submissions/`.

## 3. Delete a Session

```text
DELETE /sessions/{session_id}
```

```bash
curl.exe -X DELETE http://127.0.0.1:8001/sessions/abc123
```

## 4. Workflow Management

### Register a Workflow

```text
POST /workflows
```

```bash
curl.exe -X POST http://127.0.0.1:8001/workflows ^
  -H "Content-Type: application/json" ^
  --data-binary "@backend/data/workflows/us_nonimmigrant_visa.json"
```

Response:
```json
{ "workflow_id": "us_nonimmigrant_visa", "step_count": 5, "registered": true }
```

### List Workflows

```bash
curl.exe http://127.0.0.1:8001/workflows
```

### Workflow Catalog

```bash
curl.exe http://127.0.0.1:8001/workflows/catalog
```

### Get a Workflow

```bash
curl.exe http://127.0.0.1:8001/workflows/us_nonimmigrant_visa
```

### Delete a Workflow

```bash
curl.exe -X DELETE http://127.0.0.1:8001/workflows/us_nonimmigrant_visa
```

## 5. Workflow Sessions

### Start or Resume a Session

```text
POST /workflows/{workflow_id}/sessions
```

```json
{ "workflow_session_id": "optional-existing-session-id" }
```

### Get Session Detail

```text
GET /workflows/{workflow_id}/sessions/{session_id}
```

### Delete a Workflow Session

```text
DELETE /workflows/{workflow_id}/sessions/{session_id}
```

### Delete by Session ID (without workflow_id)

```text
DELETE /workflows/sessions/{session_id}
```

### Advance a Step

```text
POST /workflows/{workflow_id}/sessions/{session_id}/advance
```

```json
{ "step_id": "determine_visa_category", "filled_fields": { ... } }
```

### Skip an Optional Step

```text
POST /workflows/{workflow_id}/sessions/{session_id}/skip
```

```json
{ "step_id": "some_optional_step" }
```

### Get Step Chat Context

```text
GET /workflows/{workflow_id}/sessions/{session_id}/step/{step_id}/chat_context
```

### Bind Chat Session to a Step

```text
POST /workflows/{workflow_id}/sessions/{session_id}/step/{step_id}/bind_chat
```

```json
{ "chat_session_id": "abc123" }
```

## 6. Data Files

Workflow definitions live in `backend/data/workflows/`.

Blueprint definitions live in `backend/data/blueprints/`.

Submission outputs are stored in `backend/submissions/`.

## 7. Storage

- Session state is file-backed (`backend/submissions/`) and survives restarts.
- Conversation history is in-memory and lost on restart.
- Repository pattern (`app/repositories.py`) allows swapping to a database later.
