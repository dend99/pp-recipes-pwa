from __future__ import annotations

import hashlib
import logging
import re
import shutil
import uuid

from . import config, groq_client, ingredients, ytdlp_tools

log = logging.getLogger("pipeline")

MUSIC_TAG_RE = re.compile(r"\[[^\]]{0,20}\]")

TRANSLIT = str.maketrans({
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "i", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c",
    "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
    "я": "ya", " ": "_", "-": "_",
})


class PipelineError(RuntimeError):
    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason
        self.message = message


def _is_sufficient_text(text: str | None) -> bool:
    if not text:
        return False
    stripped = MUSIC_TAG_RE.sub(" ", text)
    words = [w for w in re.split(r"\s+", stripped.strip()) if w]
    return len(words) >= config.MIN_TEXT_WORDS


def _slugify(name: str) -> str:
    base = name.strip().lower().translate(TRANSLIT)
    base = re.sub(r"[^a-z0-9_]+", "", base)
    base = re.sub(r"_+", "_", base).strip("_")
    if not base:
        base = hashlib.md5(name.encode("utf-8")).hexdigest()[:8]
    return f"custom_{base}"[:48]


async def run_pipeline(job_id: str, url: str, video_id: str, report_step) -> dict:
    work_dir = config.WORK_DIR / job_id
    work_dir.mkdir(parents=True, exist_ok=True)
    try:
        await report_step("Получаю метаданные видео")
        meta = await ytdlp_tools.fetch_metadata(url)

        raw_text = None
        extraction_method = None

        await report_step("Ищу субтитры")
        subs = await ytdlp_tools.fetch_subtitles(url, work_dir)
        if _is_sufficient_text(subs):
            raw_text, extraction_method = subs, "subtitles"

        if raw_text is None:
            await report_step("Субтитров недостаточно — распознаю аудио (Whisper)")
            audio_path = await ytdlp_tools.download_audio(url, work_dir)
            if audio_path:
                whisper = await groq_client.transcribe(audio_path, language=None)
                text = (whisper.get("text") or "").strip()
                segments = whisper.get("segments") or []
                if segments:
                    import math
                    probs = [math.exp(s["avg_logprob"]) for s in segments if "avg_logprob" in s]
                    avg_conf = sum(probs) / len(probs) if probs else 1.0
                else:
                    avg_conf = 1.0
                if _is_sufficient_text(text) and avg_conf >= 0.5:
                    raw_text, extraction_method = text, "whisper"

        if raw_text is None:
            await report_step("Аудио не дало текста — анализирую кадры видео")
            video_path = await ytdlp_tools.download_video(url, work_dir)
            if video_path:
                frames = await ytdlp_tools.extract_frames(video_path, work_dir, fps=1, max_frames=10)
                if frames:
                    text = await groq_client.vision_extract_text(frames, context_hint=meta["title"])
                    if _is_sufficient_text(text):
                        raw_text, extraction_method = text, "multimodal"

        need_review = False
        if raw_text is None:
            # Не нашли текста ни одним способом — всё равно пробуем собрать рецепт
            # из title/description, но помечаем как требующий ручной проверки.
            raw_text = meta["title"]
            extraction_method = extraction_method or "multimodal"
            need_review = True

        await report_step("Собираю структурированный рецепт (LLM)")
        full_text = raw_text
        if meta.get("description"):
            full_text += f"\n\nОписание видео: {meta['description'][:800]}"

        structured = await groq_client.structure_recipe(
            raw_text=full_text,
            video_title=meta["title"],
            ingredient_catalog_text=ingredients.catalog_prompt_text(),
        )

        recipe_ingredients = []
        custom_ingredients: dict = {}
        known_ids = ingredients.catalog_ids()
        has_placeholder_amount = False
        for item in structured.get("ingredients", []):
            match_id = item.get("match_id")
            amount = max(1, round(float(item.get("amount_g") or 0)))
            if amount <= 2:
                # Модели свойственно подставлять 0/1 г как заглушку, когда граммовка
                # не прозвучала в источнике — это хуже честной оценки, форсируем low.
                has_placeholder_amount = True
            if match_id and match_id in known_ids:
                recipe_ingredients.append({"id": match_id, "g": amount})
                continue
            new_ing = item.get("new_ingredient") or {}
            cid = _slugify(item.get("name") or match_id or "ingredient")
            custom_ingredients[cid] = {
                "id": cid,
                "name": item.get("name") or cid,
                "cat": new_ing.get("cat") or "other",
                "kcal": float(new_ing.get("kcal") or 0),
                "p": float(new_ing.get("p") or 0),
                "f": float(new_ing.get("f") or 0),
                "c": float(new_ing.get("c") or 0),
            }
            recipe_ingredients.append({"id": cid, "g": amount})

        confidence = structured.get("confidence") or "medium"
        if not recipe_ingredients or not structured.get("steps"):
            confidence = "low"
        if need_review or has_placeholder_amount:
            confidence = "low"

        recipe = {
            "title": structured.get("title") or meta["title"] or "Рецепт без названия",
            "meal": structured.get("meal") if structured.get("meal") in ("breakfast", "lunch", "dinner", "snack") else "lunch",
            "time": max(1, int(structured.get("time") or 15)),
            "servings": max(1, int(structured.get("servings") or 1)),
            "ingredients": recipe_ingredients,
            "steps": [s for s in (structured.get("steps") or []) if s],
            "tags": [t for t in (structured.get("tags") or []) if t],
            "image": meta.get("thumbnail"),
            "custom": True,
            "source_url": url,
            "source_video_id": video_id,
            "extraction_method": extraction_method,
            "confidence": confidence,
        }

        result = {
            "status": "ok",
            "extraction_method": extraction_method,
            "confidence": confidence,
            "recipe": recipe,
            "customIngredients": custom_ingredients,
            "meta": {
                "video_id": video_id,
                "channel": meta.get("channel"),
                "thumbnail": meta.get("thumbnail"),
                "title": meta.get("title"),
            },
        }
        if structured.get("notes"):
            result["notes"] = structured["notes"]
        return result
    except ytdlp_tools.BotDetected as e:
        raise PipelineError("bot_detected", str(e)) from e
    except ytdlp_tools.InvalidUrl as e:
        raise PipelineError("invalid_url", str(e)) from e
    except groq_client.GroqError as e:
        raise PipelineError("groq_error", str(e)) from e
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
