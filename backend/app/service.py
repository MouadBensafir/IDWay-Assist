from __future__ import annotations

from typing import Any, AsyncIterator

from fastapi import HTTPException
from ollama import ResponseError

from .config import (
    MAX_COMPLETION_TOKENS,
    OLLAMA_MODEL,
    OLLAMA_NUM_CTX,
    OLLAMA_TEMPERATURE,
)
from .ollama_client import client, _model_dump, _to_ollama_message


async def ollama_chat_completion_stream(
    messages: list[dict[str, Any]],
    *,
    model: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> AsyncIterator[dict[str, Any]]:
    payload: dict[str, Any] = {
        "model": model or OLLAMA_MODEL,
        "messages": [_to_ollama_message(message) for message in messages],
        "think": False,
        "stream": True,
        "options": {
            "num_ctx": OLLAMA_NUM_CTX,
            "num_predict": max_tokens or MAX_COMPLETION_TOKENS,
            "temperature": OLLAMA_TEMPERATURE if temperature is None else temperature,
        },
    }

    try:
        stream = await client.chat(**payload)
        async for chunk in stream:
            yield _model_dump(chunk)
    except ResponseError as exc:
        raise HTTPException(
            status_code=502,
            detail=str(exc) or "Ollama returned an unexpected error.",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Unable to reach Ollama. Make sure Ollama is running locally and the "
                f"model '{OLLAMA_MODEL}' is available."
            ),
        ) from exc
