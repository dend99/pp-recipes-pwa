from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import datetime, timezone

from . import config

_SCHEMA = """
CREATE TABLE IF NOT EXISTS imports (
    video_id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    extraction_method TEXT,
    confidence TEXT,
    recipe_json TEXT NOT NULL,
    custom_ingredients_json TEXT NOT NULL,
    meta_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


def _conn():
    conn = sqlite3.connect(config.DB_PATH)
    conn.execute(_SCHEMA)
    return conn


def _init_sync():
    conn = _conn()
    conn.commit()
    conn.close()


async def init_db():
    await asyncio.to_thread(_init_sync)


def _get_sync(video_id: str) -> dict | None:
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT url, extraction_method, confidence, recipe_json, custom_ingredients_json, meta_json, created_at "
            "FROM imports WHERE video_id = ?",
            (video_id,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    url, method, confidence, recipe_json, custom_json, meta_json, created_at = row
    return {
        "extraction_method": method,
        "confidence": confidence,
        "recipe": json.loads(recipe_json),
        "customIngredients": json.loads(custom_json),
        "meta": json.loads(meta_json),
        "cached": True,
        "cached_at": created_at,
    }


async def get_cached(video_id: str) -> dict | None:
    return await asyncio.to_thread(_get_sync, video_id)


def _save_sync(video_id: str, url: str, result: dict):
    conn = _conn()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO imports "
            "(video_id, url, extraction_method, confidence, recipe_json, custom_ingredients_json, meta_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                video_id,
                url,
                result.get("extraction_method"),
                result.get("confidence"),
                json.dumps(result["recipe"], ensure_ascii=False),
                json.dumps(result.get("customIngredients", {}), ensure_ascii=False),
                json.dumps(result.get("meta", {}), ensure_ascii=False),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
    finally:
        conn.close()


async def save_cache(video_id: str, url: str, result: dict):
    await asyncio.to_thread(_save_sync, video_id, url, result)
