"""
Тонкая обёртка над Groq API (OpenAI-совместимый эндпоинт) с общим
rate-limiter'ом и backoff на 429/5xx — см. app/ratelimit.py.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
from pathlib import Path

import httpx

from . import config
from .ratelimit import limiter, DailyLimitExceeded

log = logging.getLogger("groq_client")

BASE_URL = "https://api.groq.com/openai/v1"


class GroqError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


async def _request(client: httpx.AsyncClient, method: str, url: str, **kwargs) -> httpx.Response:
    if not config.GROQ_API_KEY:
        raise GroqError("GROQ_API_KEY не задан в server/.env")
    headers = kwargs.pop("headers", {})
    headers["Authorization"] = f"Bearer {config.GROQ_API_KEY}"
    last_exc: Exception | None = None
    for attempt in range(1, config.GROQ_MAX_RETRIES + 1):
        try:
            await limiter.acquire()
        except DailyLimitExceeded as e:
            raise GroqError(str(e)) from e
        resp = await client.request(method, url, headers=headers, **kwargs)
        if resp.status_code == 429:
            retry_after = float(resp.headers.get("retry-after", 2 ** attempt))
            log.warning("Groq 429, попытка %s/%s, жду %.1fs", attempt, config.GROQ_MAX_RETRIES, retry_after)
            last_exc = GroqError(f"Groq 429 Too Many Requests: {resp.text[:300]}", 429)
            await asyncio.sleep(retry_after)
            continue
        if resp.status_code >= 500:
            wait = 2 ** attempt
            log.warning("Groq %s, попытка %s/%s, жду %.1fs", resp.status_code, attempt, config.GROQ_MAX_RETRIES, wait)
            last_exc = GroqError(f"Groq {resp.status_code}: {resp.text[:300]}", resp.status_code)
            await asyncio.sleep(wait)
            continue
        if resp.status_code >= 400:
            raise GroqError(f"Groq {resp.status_code}: {resp.text[:500]}", resp.status_code)
        return resp
    raise last_exc or GroqError("Groq: превышено число попыток")


async def transcribe(audio_path: Path, language: str | None = None) -> dict:
    """Whisper-транскрипция аудио. Возвращает {"text", "segments":[{"text","avg_logprob"}]}."""
    async with httpx.AsyncClient(timeout=120) as client:
        with open(audio_path, "rb") as f:
            files = {"file": (audio_path.name, f, "audio/wav")}
            data = {
                "model": config.GROQ_MODEL_TRANSCRIBE,
                "response_format": "verbose_json",
                "temperature": "0",
            }
            if language:
                data["language"] = language
            resp = await _request(client, "POST", f"{BASE_URL}/audio/transcriptions", files=files, data=data)
    return resp.json()


async def vision_extract_text(image_paths: list[Path], context_hint: str = "") -> str:
    """Отдаёт пачку кадров vision-модели, просит вернуть весь текст рецепта, видимый на экране."""
    content = [{
        "type": "text",
        "text": (
            "Это кадры короткого кулинарного видео (YouTube Shorts). "
            "Если на кадрах есть текст рецепта (название блюда, ингредиенты, граммовки, шаги приготовления) — "
            "выпиши его точно как написано, построчно, без комментариев и без markdown. "
            "Игнорируй водяные знаки, никнеймы, хэштеги и субтитры соцсети (не относящиеся к рецепту). "
            "Если текста рецепта нет ни на одном кадре — ответь одним словом: NONE.\n"
            f"Контекст (название видео): {context_hint}"
        ),
    }]
    for p in image_paths:
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})

    payload = {
        "model": config.GROQ_MODEL_VISION,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0,
        "max_tokens": 1500,
    }
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await _request(client, "POST", f"{BASE_URL}/chat/completions", json=payload)
    text = resp.json()["choices"][0]["message"]["content"].strip()
    return "" if text.upper() == "NONE" else text


RECIPE_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "meal": {"type": "string", "enum": ["breakfast", "lunch", "dinner", "snack"]},
        "time": {"type": "integer", "description": "время приготовления в минутах"},
        "servings": {"type": "integer"},
        "tags": {"type": "array", "items": {"type": "string"}},
        "steps": {"type": "array", "items": {"type": "string"}},
        "ingredients": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "match_id": {
                        "type": ["string", "null"],
                        "description": "id из каталога ингредиентов, если продукт уверенно совпадает; иначе null",
                    },
                    "name": {"type": "string"},
                    "amount_g": {"type": "number", "description": "масса в граммах (перевести из штук/стаканов и т.п.)"},
                    "new_ingredient": {
                        "type": ["object", "null"],
                        "description": "заполнить, только если match_id = null — оценка КБЖУ на 100 г",
                        "properties": {
                            "cat": {"type": "string", "enum": ["protein", "dairy", "veg", "fruit", "grain", "legume", "fat", "other"]},
                            "kcal": {"type": "number"},
                            "p": {"type": "number"},
                            "f": {"type": "number"},
                            "c": {"type": "number"},
                        },
                        "required": ["cat", "kcal", "p", "f", "c"],
                    },
                },
                "required": ["match_id", "name", "amount_g", "new_ingredient"],
            },
        },
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "notes": {"type": "string", "description": "что показалось неоднозначным/сомнительным, если есть"},
    },
    "required": ["title", "meal", "time", "servings", "tags", "steps", "ingredients", "confidence", "notes"],
}


async def structure_recipe(raw_text: str, video_title: str, ingredient_catalog_text: str) -> dict:
    system = (
        "Ты извлекаешь рецепт правильного питания (ПП) из текста видео (субтитры/транскрипт/текст на экране) "
        "и приводишь его к строгой JSON-схеме. Правила:\n"
        "- Если данных для поля нет — верни null/пустой массив, НЕ выдумывай граммовки и калорийность.\n"
        "- Для каждого ингредиента сначала попробуй найти совпадение в каталоге ниже (match_id); "
        "совпадение по смыслу/синониму допустимо (например «курица» → chicken_breast), но только если уверен. "
        "Если совпадения нет — match_id = null и обязательно укажи new_ingredient с реалистичной оценкой КБЖУ на 100 г.\n"
        "- amount_g — всегда переводи в граммы (стакан ~200г, ст.л. ~15г, ч.л. ~5г, шт. яйца ~55г и т.п. — используй кулинарные оценки). "
        "Если точная граммовка НЕ прозвучала в тексте (например «фарш», «лук» без числа) — "
        "НЕ ставь 0 или 1: дай реалистичную типичную оценку для такого блюда (например «фарш» в начинку — обычно 150–300 г, «лук» — 50–80 г), "
        "и обязательно перечисли такие ингредиенты в notes с пометкой «граммовка оценочная».\n"
        "- meal определи по контексту (завтрак/обед/ужин/перекус).\n"
        "- confidence = low, если ingredients или steps получились пустыми, текст на входе скудный/бессвязный, "
        "или граммовка хотя бы одного ингредиента — оценочная (не прозвучала явно в тексте).\n\n"
        f"Каталог ингредиентов (id — название):\n{ingredient_catalog_text}"
    )
    user = f"Название видео: {video_title}\n\nСобранный текст (субтитры/транскрипт/текст на экране):\n{raw_text}"
    payload = {
        "model": config.GROQ_MODEL_STRUCTURE,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "recipe", "schema": RECIPE_JSON_SCHEMA, "strict": True},
        },
    }
    async with httpx.AsyncClient(timeout=120) as client:
        try:
            resp = await _request(client, "POST", f"{BASE_URL}/chat/completions", json=payload)
        except GroqError as e:
            if e.status_code == 400:
                # некоторые модели/деплои Groq не поддерживают json_schema — fallback на json_object
                payload["response_format"] = {"type": "json_object"}
                payload["messages"][0]["content"] += "\n\nОтветь ЧИСТЫМ JSON-объектом по описанной структуре, без пояснений."
                resp = await _request(client, "POST", f"{BASE_URL}/chat/completions", json=payload)
            else:
                raise
    content = resp.json()["choices"][0]["message"]["content"]
    return json.loads(content)
