import secrets
import time

from fastapi import HTTPException, Request

from . import config

# {ip: [timestamps of failed attempts]}
_failures: dict[str, list[float]] = {}
# {ip: locked_until_ts}
_locked: dict[str, float] = {}


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _record_failure(ip: str) -> None:
    now = time.time()
    hits = [t for t in _failures.get(ip, []) if now - t < config.AUTH_FAIL_WINDOW_SEC]
    hits.append(now)
    _failures[ip] = hits
    if len(hits) >= config.AUTH_FAIL_LIMIT:
        _locked[ip] = now + config.AUTH_LOCKOUT_SEC
        _failures[ip] = []


async def require_app_key(request: Request) -> None:
    if not config.APP_SHARED_SECRET:
        return  # аутентификация выключена (локальная разработка без .env)

    ip = _client_ip(request)
    now = time.time()
    locked_until = _locked.get(ip)
    if locked_until and now < locked_until:
        raise HTTPException(
            status_code=429,
            detail={"status": "error", "reason": "too_many_attempts", "message": f"Попробуйте снова через {int(locked_until - now)} сек."},
        )

    # Клиент шлёт sha256(пароль) в hex — заголовок остаётся ASCII, пароль не летает по сети открытым текстом.
    key = request.headers.get("x-app-key", "")
    if not key or not secrets.compare_digest(key.lower().encode(), config.APP_SHARED_SECRET.lower().encode()):
        _record_failure(ip)
        raise HTTPException(status_code=401, detail={"status": "error", "reason": "unauthorized", "message": "Неверный ключ приложения"})

    _failures.pop(ip, None)
