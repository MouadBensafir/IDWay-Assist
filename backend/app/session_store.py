from __future__ import annotations

from dataclasses import dataclass, field
from threading import Lock
from typing import Any
from uuid import uuid4


@dataclass
class SessionState:
    session_id: str
    messages: list[dict[str, Any]] = field(default_factory=list)
    submissions: list[dict[str, Any]] = field(default_factory=list)
    summary: str = ""


_SESSIONS: dict[str, SessionState] = {}
_LOCK = Lock()


def get_or_create_session(session_id: str | None, system_prompt: str, reset: bool = False) -> SessionState:
    with _LOCK:
        if session_id and not reset and session_id in _SESSIONS:
            return _SESSIONS[session_id]

        next_session_id = session_id or uuid4().hex
        state = SessionState(
            session_id=next_session_id,
            messages=[{"role": "system", "content": system_prompt}],
        )
        _SESSIONS[next_session_id] = state
        return state


def record_submission(session: SessionState, submission: dict[str, Any]) -> None:
    with _LOCK:
        session.submissions.append(submission)


def get_session_count() -> int:
    with _LOCK:
        return len(_SESSIONS)


def delete_session(session_id: str) -> bool:
    with _LOCK:
        return _SESSIONS.pop(session_id, None) is not None


def update_session_summary(session: SessionState, summary: str, messages: list[dict[str, Any]]) -> None:
    with _LOCK:
        session.summary = summary
        session.messages = messages
