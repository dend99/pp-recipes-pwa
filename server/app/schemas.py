from typing import Any, Literal, Optional

from pydantic import BaseModel


class ImportRequest(BaseModel):
    url: str


class ImportAccepted(BaseModel):
    job_id: str
    video_id: str
    cached: bool = False


class JobStatus(BaseModel):
    job_id: str
    status: Literal["pending", "processing", "done", "error"]
    step: Optional[str] = None
    result: Optional[dict[str, Any]] = None
    error: Optional[dict[str, Any]] = None
