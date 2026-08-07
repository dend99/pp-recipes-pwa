from __future__ import annotations

import json

from . import config

_catalog: list[tuple] | None = None


def load_catalog() -> list[tuple]:
    global _catalog
    if _catalog is None:
        _catalog = json.loads(config.INGREDIENTS_PATH.read_text(encoding="utf-8"))
    return _catalog


def catalog_ids() -> set[str]:
    return {row[0] for row in load_catalog()}


def catalog_prompt_text() -> str:
    return "\n".join(f"{row[0]} — {row[1]}" for row in load_catalog())
