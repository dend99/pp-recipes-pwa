import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import config, pipeline, store, ytdlp_tools
from .auth import require_app_key
from .ratelimit import limiter
from .schemas import ImportRequest

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("main")

app = FastAPI(title="Recipe Import Pipeline")
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-App-Key"],
)


@dataclass
class Job:
    job_id: str
    url: str
    video_id: str
    status: str = "pending"  # pending | processing | done | error
    step: Optional[str] = None
    result: Optional[dict[str, Any]] = None
    error: Optional[dict[str, Any]] = None


JOBS: dict[str, Job] = {}
QUEUE: "asyncio.Queue[str]" = asyncio.Queue()
# video_id уже в очереди/в обработке — не дублируем задачи на один и тот же ролик
IN_FLIGHT: dict[str, str] = {}


@app.on_event("startup")
async def on_startup():
    await store.init_db()
    asyncio.create_task(worker_loop())


async def worker_loop():
    while True:
        job_id = await QUEUE.get()
        job = JOBS.get(job_id)
        if not job:
            continue
        job.status = "processing"
        try:
            async def report_step(text: str):
                job.step = text

            result = await pipeline.run_pipeline(job.job_id, job.url, job.video_id, report_step)
            job.result = result
            job.status = "done"
            await store.save_cache(job.video_id, job.url, result)
        except pipeline.PipelineError as e:
            job.status = "error"
            job.error = {"reason": e.reason, "message": e.message}
        except Exception as e:  # noqa: BLE001
            log.exception("Pipeline crashed for job %s", job_id)
            job.status = "error"
            job.error = {"reason": "internal_error", "message": str(e)}
        finally:
            IN_FLIGHT.pop(job.video_id, None)


@app.get("/health")
async def health():
    return {"status": "ok", "groq_requests_remaining_today": limiter.remaining_today}


@app.post("/import-recipe", dependencies=[Depends(require_app_key)])
async def import_recipe(req: ImportRequest):
    try:
        video_id = ytdlp_tools.extract_video_id(req.url)
    except ytdlp_tools.InvalidUrl as e:
        raise HTTPException(status_code=400, detail={"status": "error", "reason": "invalid_url", "message": str(e)})

    cached = await store.get_cached(video_id)
    if cached:
        return {"status": "ok", "cached": True, **cached}

    existing_job_id = IN_FLIGHT.get(video_id)
    if existing_job_id and existing_job_id in JOBS:
        return {"job_id": existing_job_id, "video_id": video_id, "cached": False}

    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = Job(job_id=job_id, url=req.url, video_id=video_id)
    IN_FLIGHT[video_id] = job_id
    await QUEUE.put(job_id)
    return {"job_id": job_id, "video_id": video_id, "cached": False}


@app.get("/import-recipe/{job_id}", dependencies=[Depends(require_app_key)])
async def import_recipe_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail={"status": "error", "message": "job_id не найден"})
    return {
        "job_id": job.job_id,
        "status": job.status,
        "step": job.step,
        "result": job.result,
        "error": job.error,
    }
