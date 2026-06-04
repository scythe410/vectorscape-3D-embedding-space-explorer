"""Pins the loudness of intentionally-degraded paths.

The audit principle: a degraded path must never be indistinguishable from the
happy path in the logs. Each test here drives a degraded code path and
asserts the operator-visible log signal exists.

If a future refactor drops one of these logs the failure should be loud, not
silent — that's the whole reason this file exists.
"""
from __future__ import annotations

import logging

import numpy as np
import pytest

from app import bridge, embeddings


def test_embed_texts_warns_when_unknown_embed_model_coerced_to_local(
    monkeypatch, caplog
) -> None:
    """`embed_model='not-a-real-model'` silently uses local MiniLM (every value
    that isn't literally `'openai'` does). Pre-audit that was invisible; now
    it logs a WARNING so an operator can see when callers pass garbage."""
    # Stub the heavy local-model call so we don't load MiniLM here.
    monkeypatch.setattr(
        embeddings,
        "_embed_local",
        lambda texts, batch_size=64: np.zeros((len(texts), 384), dtype=np.float32),
    )
    # Disable the disk cache so the call definitely goes through.
    monkeypatch.setattr(embeddings, "_load_cached", lambda digest: None)
    monkeypatch.setattr(embeddings, "_save_cached", lambda digest, vec: None)

    with caplog.at_level(logging.WARNING, logger="app.embeddings"):
        out = embeddings.embed_texts(["hello"], embed_model="not-a-real-model")
    assert out.shape == (1, 384)
    assert any(
        "unknown embed_model" in r.message for r in caplog.records
    ), caplog.text


def test_embed_texts_silent_on_explicit_default(monkeypatch, caplog) -> None:
    """The exact default string is *not* a coercion — no warning should
    fire when the caller passes the documented default."""
    monkeypatch.setattr(
        embeddings,
        "_embed_local",
        lambda texts, batch_size=64: np.zeros((len(texts), 384), dtype=np.float32),
    )
    monkeypatch.setattr(embeddings, "_load_cached", lambda digest: None)
    monkeypatch.setattr(embeddings, "_save_cached", lambda digest, vec: None)

    with caplog.at_level(logging.WARNING, logger="app.embeddings"):
        embeddings.embed_texts(["hello"], embed_model="all-MiniLM-L6-v2")
    coercion_warnings = [
        r for r in caplog.records if "unknown embed_model" in r.message
    ]
    assert coercion_warnings == []


def test_bridge_no_key_fallback_is_logged(monkeypatch, caplog) -> None:
    """With neither OPENAI_API_KEY nor GEMINI_API_KEY set, /bridge returns
    the stock 'no LLM key' message. Pre-audit that path was silent; now it
    emits an INFO log so the operator can see how often the no-prose
    fallback fires."""
    monkeypatch.setattr(bridge, "OPENAI_API_KEY", "")
    monkeypatch.setattr(bridge, "GEMINI_API_KEY", "")
    with caplog.at_level(logging.INFO, logger="app.bridge"):
        summary, model = bridge._summarize("anything")
    assert "No LLM API key" in summary
    assert model == "fallback"
    assert any(
        "no-LLM-key fallback fired" in r.message for r in caplog.records
    ), caplog.text


@pytest.mark.parametrize("env_key", ["OPENAI_API_KEY", "GEMINI_API_KEY"])
def test_bridge_no_key_log_does_not_fire_when_any_key_present(
    monkeypatch, caplog, env_key
) -> None:
    """The fallback log is specific to the no-key path. Setting either key
    should take the LLM branch — and that branch will try to import openai
    and call the API; we stub it so we don't need a real key, then confirm
    the no-key log did NOT fire."""
    if env_key == "OPENAI_API_KEY":
        monkeypatch.setattr(bridge, "OPENAI_API_KEY", "sk-test-xxxx")
        monkeypatch.setattr(bridge, "GEMINI_API_KEY", "")
    else:
        monkeypatch.setattr(bridge, "OPENAI_API_KEY", "")
        monkeypatch.setattr(bridge, "GEMINI_API_KEY", "test-gemini-xxx")

    # Stub the OpenAI client so we never hit the network. The bridge code
    # imports OpenAI inside the function; patching the module avoids that.
    class _FakeMsg:
        content = "Shared theme is foo; the contrast is bar."

    class _FakeChoice:
        message = _FakeMsg()

    class _FakeResp:
        choices = [_FakeChoice()]

    class _FakeCompletions:
        def create(self, **_kwargs):
            return _FakeResp()

    class _FakeChat:
        completions = _FakeCompletions()

    class _FakeOpenAI:
        def __init__(self, *_args, **_kwargs):
            self.chat = _FakeChat()

    import openai as _openai_mod

    monkeypatch.setattr(_openai_mod, "OpenAI", _FakeOpenAI)

    with caplog.at_level(logging.INFO, logger="app.bridge"):
        summary, model = bridge._summarize("prompt")
    assert "Shared theme" in summary
    assert model in (bridge.LLM_MODEL, bridge.GEMINI_MODEL)
    # The no-key log MUST NOT have fired.
    assert not any(
        "no-LLM-key fallback fired" in r.message for r in caplog.records
    ), caplog.text
