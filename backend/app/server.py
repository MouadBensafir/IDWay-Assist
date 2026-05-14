from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .config import OLLAMA_MODEL
from .repositories import submission_repository
from .session_store import delete_session, get_session_count


app = FastAPI(title="IDWay Assist Agent", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Service Workflow orchestration router ────────────────────────────────────
from .workflow_server import workflow_chat_auto_stream, workflow_router  # noqa: E402
app.include_router(workflow_router)
# ────────────────────────────────────────────────────────────────────────────


@app.on_event("startup")
async def startup_event() -> None:
    submission_repository.ensure_directories()


@app.get("/health")
async def healthcheck() -> dict[str, Any]:
    return {
        "status": "ok",
        "model": OLLAMA_MODEL,
        "sessions": get_session_count(),
    }


@app.delete("/sessions/{session_id}")
async def remove_session(session_id: str) -> dict[str, Any]:
    return {"session_id": session_id, "deleted": delete_session(session_id)}


@app.post("/chat/stream")
async def chat_stream_alias(request: Request) -> StreamingResponse:
    return await workflow_chat_auto_stream(request)
