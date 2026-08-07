"""
Защита ключа Groq от шатдауна: скользящее окно RPM + дневной лимит,
персистентный на диске (переживает рестарт сервиса).
"""
import asyncio
import json
import time
from collections import deque
from datetime import date

from . import config


class DailyLimitExceeded(RuntimeError):
    pass


class GroqRateLimiter:
    def __init__(self, rpm_limit: int, rpd_limit: int, usage_path):
        self.rpm_limit = rpm_limit
        self.rpd_limit = rpd_limit
        self.usage_path = usage_path
        self._window = deque()  # timestamps последних запросов (для RPM)
        self._lock = asyncio.Lock()
        self._today, self._count_today = self._load_usage()

    def _load_usage(self):
        try:
            data = json.loads(self.usage_path.read_text())
            if data.get("date") == str(date.today()):
                return data["date"], int(data.get("count", 0))
        except (FileNotFoundError, ValueError, KeyError):
            pass
        return str(date.today()), 0

    def _save_usage(self):
        self.usage_path.write_text(json.dumps({"date": self._today, "count": self._count_today}))

    def _roll_day(self):
        today = str(date.today())
        if today != self._today:
            self._today = today
            self._count_today = 0

    async def acquire(self):
        """Блокирует вызывающего до тех пор, пока запрос не впишется в RPM-окно;
        поднимает DailyLimitExceeded, если дневной лимит уже исчерпан (не ждёт до завтра)."""
        async with self._lock:
            self._roll_day()
            if self._count_today >= self.rpd_limit:
                raise DailyLimitExceeded(
                    f"Дневной лимит запросов к Groq исчерпан ({self.rpd_limit}/день) — "
                    f"защита ключа от перерасхода. Попробуйте завтра или увеличьте GROQ_RPD_LIMIT."
                )
            now = time.monotonic()
            while self._window and now - self._window[0] > 60:
                self._window.popleft()
            if len(self._window) >= self.rpm_limit:
                wait_for = 60 - (now - self._window[0]) + 0.05
            else:
                wait_for = 0
            if wait_for > 0:
                await asyncio.sleep(wait_for)
                now = time.monotonic()
                while self._window and now - self._window[0] > 60:
                    self._window.popleft()
            self._window.append(now)
            self._count_today += 1
            self._save_usage()

    @property
    def remaining_today(self) -> int:
        self._roll_day()
        return max(0, self.rpd_limit - self._count_today)


limiter = GroqRateLimiter(config.GROQ_RPM_LIMIT, config.GROQ_RPD_LIMIT, config.USAGE_PATH)
