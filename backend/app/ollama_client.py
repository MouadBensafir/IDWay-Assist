from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from ollama import AsyncClient, ResponseError

from .config import (
    MAX_COMPLETION_TOKENS,
    OLLAMA_MODEL,
    OLLAMA_NUM_CTX,
    OLLAMA_TEMPERATURE,
    OLLAMA_URL,
    REQUEST_TIMEOUT_SECONDS,
)


client = AsyncClient(
    host=OLLAMA_URL,
    timeout=REQUEST_TIMEOUT_SECONDS,
)


async def ollama_chat_completion(
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None = None,
    model: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": OLLAMA_MODEL,
        "messages": [_to_ollama_message(message) for message in messages],
        "think": False,
        "stream": False,
        "options": {
            "num_ctx": OLLAMA_NUM_CTX,
            "num_predict": max_tokens or MAX_COMPLETION_TOKENS,
            "temperature": OLLAMA_TEMPERATURE if temperature is None else temperature,
        },
    }
    if model:
        payload["model"] = model
    if tools:
        payload["tools"] = tools

    try:
        response = await client.chat(**payload)
        return _model_dump(response)
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


def _to_ollama_message(message: dict[str, Any]) -> dict[str, Any]:
    role = str(message.get("role") or "").strip().lower()
    normalized: dict[str, Any] = {"role": role}

    if role == "tool":
        normalized["tool_name"] = str(message.get("tool_name") or "")
        normalized["content"] = _stringify_content(message.get("content"))
        return normalized

    content = message.get("content")
    if isinstance(content, list):
        text_parts: list[str] = []
        images: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            item_type = str(item.get("type") or "").strip().lower()
            if item_type == "text":
                text_value = str(item.get("text") or "").strip()
                if text_value:
                    text_parts.append(text_value)
                continue
            if item_type == "image_url":
                image_url = item.get("image_url")
                if isinstance(image_url, dict):
                    url = str(image_url.get("url") or "").strip()
                    if url.startswith("data:") and "," in url:
                        images.append(url.split(",", 1)[1])
        normalized["content"] = "\n\n".join(part for part in text_parts if part).strip()
        if images:
            normalized["images"] = images
        return normalized

    normalized["content"] = _stringify_content(content)
    tool_calls = message.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls:
        normalized["tool_calls"] = tool_calls
    return normalized


def _stringify_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    return str(content)


def _model_dump(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if isinstance(value, dict):
        return value
    return dict(value)


def extract_token_usage(response: dict[str, Any]) -> dict[str, int]:
    prompt_tokens = _coerce_int(
        response.get("prompt_eval_count", response.get("prompt_tokens", 0))
    )
    completion_tokens = _coerce_int(
        response.get("eval_count", response.get("completion_tokens", 0))
    )
    total_tokens = _coerce_int(
        response.get("total_tokens", prompt_tokens + completion_tokens)
    )
    if total_tokens <= 0:
        total_tokens = prompt_tokens + completion_tokens
    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
    }


def _coerce_int(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0
