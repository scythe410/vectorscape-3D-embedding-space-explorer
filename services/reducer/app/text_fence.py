"""Shared user-text fencing for any LLM call that includes user CSV content.

The fence is the same one /bridge uses: control characters stripped, the
closing tag defanged, then wrapped in <user_text>…</user_text>. The system
prompt at the call site must tell the model to treat fenced content as data,
never instructions.
"""
from __future__ import annotations

# Strip C0 controls except \t (0x09), \n (0x0A), \r (0x0D), plus DEL (0x7F).
_CONTROL_CHARS = "".join(
    chr(c) for c in list(range(0x00, 0x09)) + [0x0B, 0x0C] + list(range(0x0E, 0x20)) + [0x7F]
)
_CONTROL_TRANSLATE = str.maketrans("", "", _CONTROL_CHARS)


def truncate(s: str | None, n: int) -> str:
    if not s:
        return ""
    s = s.strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def sanitize(s: str | None) -> str:
    """Strip control chars and defang the closing fence tag."""
    if not s:
        return ""
    s = s.translate(_CONTROL_TRANSLATE)
    return s.replace("</user_text>", "<!-- /user_text -->").replace(
        "</USER_TEXT>", "<!-- /USER_TEXT -->"
    )


def fenced(text: str | None, cap: int) -> str:
    """Wrap user text in an explicit data fence so the LLM treats it as inert."""
    return f"<user_text>\n{sanitize(truncate(text, cap))}\n</user_text>"
