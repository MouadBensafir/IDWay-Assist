from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


BACKEND_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BACKEND_DIR / "config.json"
DEFAULT_CONFIG = {
    "server": {
        "host": "0.0.0.0",
        "port": 8001,
    },
    "chat": {
        "maxToolRounds": 5,
        "systemPrompt": (
            "You are IDWay Assist, a guided e-service agent. "
            "Help the user complete one service request at a time by calling the available tools. "
            "Do not invent services, form fields, appointment options, or submission results. "
            "Use `list_services` before suggesting services, `get_service_details` to determine step order, "
            "`get_form_fields` and `validate_form_field` for form collection, and the appointment tools for location, date, and time selection. "
            "Ask one focused question at a time, keep the flow concise, summarize before submission, and only call "
            "`submit_service_request` after the user explicitly confirms they want to submit. "
            "When `submit_service_request` succeeds, give one brief final confirmation that includes the reference number and saved summary file path, "
            "then end the flow by asking if the user wants to do something else. Do not continue collecting data after a successful submission."
        ),
        "memorySummaryPrompt": (
            "Summarize the useful durable context from this conversation for a follow-up assistant turn. "
            "Keep only information that should persist: the user's goal, collected facts, confirmed choices, "
            "validated form data, pending questions, constraints, corrections, and any tool results that still matter. "
            "Omit chit-chat, repeated wording, and transient steps that no longer matter. "
            "Write concise bullet-style plain text without markdown."
        ),
    },
    "ollama": {
        "url": "http://127.0.0.1:11434",
        "model": "qwen3.5",
        "numCtx": 4096,
        "requestTimeoutSeconds": 120,
        "maxContextChars": 16000,
        "recentMessageCount": 8,
        "compactTriggerChars": 12000,
        "toolResultMaxChars": 2500,
        "toolResultMaxItems": 8,
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

MAX_TOOL_ROUNDS = int(
    os.getenv(
        "CHAT_MAX_TOOL_ROUNDS",
        str(
            CHAT_CONFIG.get(
                "maxToolRounds",
                DEFAULT_CONFIG["chat"]["maxToolRounds"],
            )
        ),
    )
)
SYSTEM_PROMPT = str(
    CHAT_CONFIG.get(
        "systemPrompt",
        DEFAULT_CONFIG["chat"]["systemPrompt"],
    )
)
MEMORY_SUMMARY_PROMPT = str(
    CHAT_CONFIG.get(
        "memorySummaryPrompt",
        DEFAULT_CONFIG["chat"]["memorySummaryPrompt"],
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
MAX_CONTEXT_CHARS = int(
    os.getenv(
        "OLLAMA_MAX_CONTEXT_CHARS",
        str(
            OLLAMA_CONFIG.get(
                "maxContextChars",
                DEFAULT_CONFIG["ollama"]["maxContextChars"],
            )
        ),
    )
)
COMPACT_TRIGGER_CHARS = int(
    os.getenv(
        "OLLAMA_COMPACT_TRIGGER_CHARS",
        str(
            OLLAMA_CONFIG.get(
                "compactTriggerChars",
                DEFAULT_CONFIG["ollama"]["compactTriggerChars"],
            )
        ),
    )
)
RECENT_MESSAGE_COUNT = int(
    os.getenv(
        "OLLAMA_RECENT_MESSAGE_COUNT",
        str(
            OLLAMA_CONFIG.get(
                "recentMessageCount",
                DEFAULT_CONFIG["ollama"]["recentMessageCount"],
            )
        ),
    )
)
TOOL_RESULT_MAX_CHARS = int(
    os.getenv(
        "OLLAMA_TOOL_RESULT_MAX_CHARS",
        str(
            OLLAMA_CONFIG.get(
                "toolResultMaxChars",
                DEFAULT_CONFIG["ollama"]["toolResultMaxChars"],
            )
        ),
    )
)
TOOL_RESULT_MAX_ITEMS = int(
    os.getenv(
        "OLLAMA_TOOL_RESULT_MAX_ITEMS",
        str(
            OLLAMA_CONFIG.get(
                "toolResultMaxItems",
                DEFAULT_CONFIG["ollama"]["toolResultMaxItems"],
            )
        ),
    )
)
