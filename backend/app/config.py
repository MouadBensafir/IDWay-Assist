from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


BACKEND_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BACKEND_DIR / "config.json"
TEMPLATES_DIR = BACKEND_DIR / "templates"
SUBMISSIONS_DIR = BACKEND_DIR / "submissions"

DEFAULT_CONFIG = {
    "server": {
        "host": "0.0.0.0",
        "port": 8001,
    },
    "chat": {
        "recentMessageCount": 10,
    },
    "ollama": {
        "url": "http://localhost:11434",
        "model": "qwen3.5",
        "requestTimeoutSeconds": 120,
        "maxCompletionTokens": 2048,
        "temperature": 0.2,
        "numCtx": 8192,
        "pdfVisionMaxPages": 3,
        "pdfTextMinChars": 80,
    },
}


def load_config() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        return DEFAULT_CONFIG

    with CONFIG_PATH.open("r", encoding="utf-8") as config_file:
        data = json.load(config_file)

    if not isinstance(data, dict):
        return DEFAULT_CONFIG

    return data


CONFIG = load_config()
CHAT_CONFIG = CONFIG.get("chat", {})
OLLAMA_CONFIG = CONFIG.get("ollama", {})

RECENT_MESSAGE_COUNT = int(
    os.getenv(
        "CHAT_RECENT_MESSAGE_COUNT",
        str(
            CHAT_CONFIG.get(
                "recentMessageCount",
                DEFAULT_CONFIG["chat"]["recentMessageCount"],
            )
        ),
    )
)

OLLAMA_URL = os.getenv(
    "OLLAMA_URL",
    str(OLLAMA_CONFIG.get("url", DEFAULT_CONFIG["ollama"]["url"])),
)
OLLAMA_MODEL = os.getenv(
    "OLLAMA_MODEL",
    str(OLLAMA_CONFIG.get("model", DEFAULT_CONFIG["ollama"]["model"])),
)
REQUEST_TIMEOUT_SECONDS = float(
    os.getenv(
        "OLLAMA_TIMEOUT_SECONDS",
        str(
            OLLAMA_CONFIG.get(
                "requestTimeoutSeconds",
                DEFAULT_CONFIG["ollama"]["requestTimeoutSeconds"],
            )
        ),
    )
)
MAX_COMPLETION_TOKENS = int(
    os.getenv(
        "OLLAMA_MAX_COMPLETION_TOKENS",
        str(
            OLLAMA_CONFIG.get(
                "maxCompletionTokens",
                DEFAULT_CONFIG["ollama"]["maxCompletionTokens"],
            )
        ),
    )
)
OLLAMA_TEMPERATURE = float(
    os.getenv(
        "OLLAMA_TEMPERATURE",
        str(
            OLLAMA_CONFIG.get(
                "temperature",
                DEFAULT_CONFIG["ollama"]["temperature"],
            )
        ),
    )
)
OLLAMA_NUM_CTX = int(
    os.getenv(
        "OLLAMA_NUM_CTX",
        str(
            OLLAMA_CONFIG.get(
                "numCtx",
                DEFAULT_CONFIG["ollama"]["numCtx"],
            )
        ),
    )
)
PDF_VISION_MAX_PAGES = int(
    os.getenv(
        "PDF_VISION_MAX_PAGES",
        str(
            OLLAMA_CONFIG.get(
                "pdfVisionMaxPages",
                DEFAULT_CONFIG["ollama"]["pdfVisionMaxPages"],
            )
        ),
    )
)
PDF_TEXT_MIN_CHARS = int(
    os.getenv(
        "PDF_TEXT_MIN_CHARS",
        str(
            OLLAMA_CONFIG.get(
                "pdfTextMinChars",
                DEFAULT_CONFIG["ollama"]["pdfTextMinChars"],
            )
        ),
    )
)
