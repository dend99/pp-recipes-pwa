import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL_TRANSCRIBE = os.environ.get("GROQ_MODEL_TRANSCRIBE", "whisper-large-v3-turbo")
GROQ_MODEL_VISION = os.environ.get("GROQ_MODEL_VISION", "qwen/qwen3.6-27b")
GROQ_MODEL_STRUCTURE = os.environ.get("GROQ_MODEL_STRUCTURE", "openai/gpt-oss-120b")

GROQ_RPM_LIMIT = int(os.environ.get("GROQ_RPM_LIMIT", "20"))
GROQ_RPD_LIMIT = int(os.environ.get("GROQ_RPD_LIMIT", "300"))
GROQ_MAX_RETRIES = int(os.environ.get("GROQ_MAX_RETRIES", "3"))

YTDLP_COOKIES_FILE = os.environ.get("YTDLP_COOKIES_FILE", "").strip() or None

PORT = int(os.environ.get("PORT", "8099"))

DATA_DIR = BASE_DIR / "data"
WORK_DIR = BASE_DIR / "work"
DB_PATH = BASE_DIR / "cache.db"
USAGE_PATH = BASE_DIR / "groq_usage.json"
INGREDIENTS_PATH = DATA_DIR / "ingredients.json"

WORK_DIR.mkdir(exist_ok=True)

# "Достаточно" субтитров/транскрипта — критерий из шага 3/4 спецификации
MIN_TEXT_WORDS = 15
