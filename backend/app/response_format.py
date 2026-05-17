from __future__ import annotations

import re

COLLECTED_DATA_MARKER = "COLLECTED_DATA:"

_COLLECTED_HEADING_PATTERN = re.compile(
    r"(?im)^(collected\s+(so\s+far|data|info|information|details)|collected)\s*:\s*"
)


def enforce_collected_data_section(text: str) -> str:
    cleaned = (text or "").strip()
    if not cleaned:
        return f"{COLLECTED_DATA_MARKER} none"

    marker_index = cleaned.rfind(COLLECTED_DATA_MARKER)
    if marker_index >= 0:
        main = cleaned[:marker_index].strip()
        collected = cleaned[marker_index + len(COLLECTED_DATA_MARKER) :].strip()
        if not collected:
            collected = "none"
        if main:
            return f"{main}\n\n{COLLECTED_DATA_MARKER}\n{collected}"
        return f"{COLLECTED_DATA_MARKER}\n{collected}"

    matches = list(_COLLECTED_HEADING_PATTERN.finditer(cleaned))
    if matches:
        match = matches[-1]
        main = cleaned[: match.start()].strip()
        collected = cleaned[match.end() :].strip()
        if not collected:
            collected = "none"
        if main:
            return f"{main}\n\n{COLLECTED_DATA_MARKER}\n{collected}"
        return f"{COLLECTED_DATA_MARKER}\n{collected}"

    return f"{cleaned}\n\n{COLLECTED_DATA_MARKER} none"
