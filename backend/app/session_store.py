from __future__ import annotations

from dataclasses import dataclass, field
from threading import Lock
from typing import Any
from uuid import uuid4

from .repositories import session_repository


@dataclass
class TokenUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


@dataclass
class SessionState:
    session_id: str
    messages: list[dict[str, Any]] = field(default_factory=list)
    service_name: str | None = None
    submission_path: str | None = None
    completed: bool = False
    token_usage: TokenUsage = field(default_factory=TokenUsage)

    # ── Document cache ───────────────────────────────────────────────────────
    # Vision parts (base64 data-URL dicts) and extracted text blocks from ALL
    # documents uploaded during this session.  Persisted in-memory so the
    # agent can reference them on every subsequent turn without the user
    # needing to re-send the photo.  Cleared only when the session is deleted.
    cached_vision_parts: list[dict[str, Any]] = field(default_factory=list)
    cached_text_blocks: list[str] = field(default_factory=list)

    # ── Document-offer tracking ───────────────────────────────────────────────
    # Set to True the first time a document arrives this session, so the
    # state summary can tell the LLM whether documents are available.
    has_received_document: bool = False


_LOCK = Lock()


def get_or_create_session(session_id: str | None, reset: bool = False) -> SessionState:
    with _LOCK:
        existing = session_repository.get(session_id) if session_id and not reset else None
        if existing is not None:
            return existing

        next_session_id = session_id or uuid4().hex
        state = SessionState(session_id=next_session_id)
        session_repository.put(state)
        return state


def update_session_state(
    session: SessionState,
    *,
    service_name: str | None = None,
    submission_path: str | None = None,
    completed: bool | None = None,
    message: dict[str, Any] | None = None,
) -> None:
    with _LOCK:
        if service_name is not None:
            session.service_name = service_name
        if submission_path is not None:
            session.submission_path = submission_path
        if completed is not None:
            session.completed = completed
        if message is not None:
            session.messages.append(message)


def cache_documents(
    session: SessionState,
    vision_parts: list[dict[str, Any]],
    text_blocks: list[str],
) -> None:
    """
    Merge newly-uploaded document parts into the session-level document cache.

    This is called once per request right after the files are parsed, so the
    agent can reference every previously uploaded document on future turns
    without the user needing to re-send the file.
    """
    with _LOCK:
        session.cached_vision_parts.extend(vision_parts)
        session.cached_text_blocks.extend(text_blocks)
        if vision_parts or text_blocks:
            session.has_received_document = True


def get_session_count() -> int:
    return session_repository.count()


def delete_session(session_id: str) -> bool:
    session = session_repository.delete(session_id)
    if session is None:
        return False
    session.cached_vision_parts.clear()
    session.cached_text_blocks.clear()
    return True


def record_token_usage(
    session: SessionState,
    *,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
) -> None:
    with _LOCK:
        session.token_usage.prompt_tokens += max(0, int(prompt_tokens))
        session.token_usage.completion_tokens += max(0, int(completion_tokens))
        session.token_usage.total_tokens = (
            session.token_usage.prompt_tokens + session.token_usage.completion_tokens
        )


def get_token_usage(session: SessionState) -> dict[str, int]:
    with _LOCK:
        return {
            "prompt_tokens": session.token_usage.prompt_tokens,
            "completion_tokens": session.token_usage.completion_tokens,
            "total_tokens": session.token_usage.total_tokens,
        }
