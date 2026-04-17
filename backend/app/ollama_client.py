from __future__ import annotations

import json
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request

from fastapi import HTTPException

from .config import OLLAMA_MODEL, OLLAMA_NUM_CTX, OLLAMA_URL, REQUEST_TIMEOUT_SECONDS
from .tools import OLLAMA_TOOLS


def ollama_chat(messages: list[dict[str, Any]], *, include_tools: bool = True) -> dict[str, Any]:
    payload = {
        "model": OLLAMA_MODEL,
        "messages": messages,
        "think": False,
        "stream": False,
        "options": {
            "num_ctx": OLLAMA_NUM_CTX,
        },
    }
    if include_tools:
        payload["tools"] = OLLAMA_TOOLS

    body = json.dumps(payload).encode("utf-8")
    request = urllib_request.Request(
        f"{OLLAMA_URL.rstrip('/')}/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib_request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib_error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace").strip()
        raise HTTPException(
            status_code=502,
            detail=detail or "Ollama returned an unexpected error.",
        ) from exc
    except urllib_error.URLError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Unable to reach Ollama. Make sure Ollama is running locally and the "
                f"model '{OLLAMA_MODEL}' is available."
            ),
        ) from exc
