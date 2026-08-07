from __future__ import annotations

import asyncio
import json
import re
import shutil
from pathlib import Path

from . import config

def _resolve_bin(name: str, preferred: list[str]) -> str:
    for p in preferred:
        if Path(p).exists():
            return p
    return shutil.which(name) or name


# Предпочитаем системные бинарники, а не случайно затенённые из venv/pip
YTDLP_BIN = _resolve_bin("yt-dlp", ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"])
FFMPEG_BIN = _resolve_bin("ffmpeg", ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"])

VIDEO_ID_PATTERNS = [
    r"(?:youtube\.com/shorts/)([A-Za-z0-9_-]{11})",
    r"(?:youtu\.be/)([A-Za-z0-9_-]{11})",
    r"(?:youtube\.com/watch\?v=)([A-Za-z0-9_-]{11})",
    r"(?:youtube\.com/embed/)([A-Za-z0-9_-]{11})",
    r"[?&]v=([A-Za-z0-9_-]{11})",
]


class BotDetected(RuntimeError):
    pass


class InvalidUrl(RuntimeError):
    pass


def extract_video_id(url: str) -> str:
    for pat in VIDEO_ID_PATTERNS:
        m = re.search(pat, url)
        if m:
            return m.group(1)
    raise InvalidUrl(f"Не удалось распознать YouTube video_id в ссылке: {url}")


def _cookie_args() -> list[str]:
    if config.YTDLP_COOKIES_FILE:
        return ["--cookies", config.YTDLP_COOKIES_FILE]
    return []


async def _run(*args: str, timeout: int = 90) -> tuple[str, str, int]:
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise
    return out.decode("utf-8", "ignore"), err.decode("utf-8", "ignore"), proc.returncode


def _check_bot_detection(stderr: str):
    low = stderr.lower()
    if "sign in to confirm" in low or "not a bot" in low:
        raise BotDetected("YouTube требует подтверждения, что вы не бот (нужны cookies залогиненного аккаунта на сервере).")
    if "429" in stderr and "too many requests" in low:
        raise BotDetected("YouTube вернул 429 Too Many Requests — временная блокировка по IP, попробуйте позже.")


async def fetch_metadata(url: str) -> dict:
    args = [YTDLP_BIN, "--skip-download", "--dump-json", *_cookie_args(), url]
    out, err, code = await _run(*args)
    if code != 0:
        _check_bot_detection(err)
        raise RuntimeError(f"yt-dlp metadata failed: {err[-800:]}")
    data = json.loads(out)
    return {
        "title": data.get("title") or "",
        "channel": data.get("channel") or data.get("uploader") or "",
        "duration": data.get("duration"),
        "thumbnail": data.get("thumbnail"),
        "upload_date": data.get("upload_date"),
        "description": data.get("description") or "",
    }


async def fetch_subtitles(url: str, work_dir: Path) -> str | None:
    """Пробует официальные/автосубтитры ru>en, возвращает очищенный текст или None."""
    for langs in ("ru", "en"):
        out_tpl = str(work_dir / "subs.%(ext)s")
        args = [
            YTDLP_BIN, "--skip-download", "--write-sub", "--write-auto-sub",
            "--sub-langs", langs, "--sub-format", "vtt", "-o", out_tpl,
            *_cookie_args(), url,
        ]
        _, err, code = await _run(*args)
        if code != 0:
            _check_bot_detection(err)
            continue
        vtt_files = sorted(work_dir.glob("subs*.vtt"))
        if vtt_files:
            text = parse_vtt(vtt_files[0].read_text(encoding="utf-8", errors="ignore"))
            for f in vtt_files:
                f.unlink(missing_ok=True)
            if text:
                return text
    return None


def parse_vtt(raw: str) -> str:
    lines = raw.splitlines()
    seen = set()
    out = []
    tag_re = re.compile(r"<[^>]+>")
    ts_re = re.compile(r"^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->")
    for line in lines:
        line = line.strip()
        if not line or line.upper() == "WEBVTT":
            continue
        if ts_re.match(line) or line.isdigit() or "-->" in line:
            continue
        if line.startswith(("Kind:", "Language:", "NOTE")):
            continue
        clean = tag_re.sub("", line).strip()
        if not clean:
            continue
        if clean in seen:
            continue
        seen.add(clean)
        out.append(clean)
    return " ".join(out)


async def download_audio(url: str, work_dir: Path) -> Path | None:
    out_tpl = str(work_dir / "audio.%(ext)s")
    args = [
        YTDLP_BIN, "-f", "bestaudio", "--extract-audio", "--audio-format", "wav",
        "--postprocessor-args", "ExtractAudio:-ar 16000 -ac 1",
        "-o", out_tpl, *_cookie_args(), url,
    ]
    _, err, code = await _run(*args, timeout=180)
    if code != 0:
        _check_bot_detection(err)
        return None
    files = sorted(work_dir.glob("audio.wav"))
    return files[0] if files else None


async def download_video(url: str, work_dir: Path) -> Path | None:
    out_tpl = str(work_dir / "video.%(ext)s")
    args = [
        YTDLP_BIN, "-f", "mp4/best", "-o", out_tpl, *_cookie_args(), url,
    ]
    _, err, code = await _run(*args, timeout=240)
    if code != 0:
        _check_bot_detection(err)
        return None
    files = sorted(work_dir.glob("video.*"))
    return files[0] if files else None


async def extract_frames(video_path: Path, work_dir: Path, fps: int = 1, max_frames: int = 10) -> list[Path]:
    pattern = str(work_dir / "frame_%03d.jpg")
    args = [FFMPEG_BIN, "-y", "-i", str(video_path), "-vf", f"fps={fps}", "-q:v", "3", pattern]
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    await asyncio.wait_for(proc.communicate(), timeout=60)
    frames = sorted(work_dir.glob("frame_*.jpg"))
    if len(frames) > max_frames:
        step = len(frames) / max_frames
        frames = [frames[int(i * step)] for i in range(max_frames)]
    return frames
