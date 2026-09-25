"""Structured JSON logging with request IDs.

"If the platform provides adequate logs" is the reviewer's own phrase. Every
request gets an id (honoring an inbound X-Request-ID), the id is echoed in the
response header, and every log line is one JSON object with the fields an
operator greps for: ts, level, logger, request_id, method, path, status,
duration_ms, actor.
"""

from __future__ import annotations

import contextvars
import json
import logging
import re
import time
import uuid
from datetime import UTC, datetime

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.now(UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "request_id": request_id_var.get(),
            "msg": record.getMessage(),
        }
        for key in ("method", "path", "status", "duration_ms", "actor", "run_id", "scan_id"):
            if hasattr(record, key):
                payload[key] = getattr(record, key)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging(level: int = logging.INFO) -> None:
    root = logging.getLogger()
    root.handlers.clear()
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root.addHandler(handler)
    root.setLevel(level)
    # uvicorn's access log duplicates ours; keep its error log.
    logging.getLogger("uvicorn.access").disabled = True
    logging.getLogger("uvicorn.error").handlers = [handler]


_REQUEST_ID = re.compile(r"[A-Za-z0-9._-]{8,64}")


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # A caller's X-Request-ID is honoured only if it looks like one: it becomes the
        # audit correlation id, so free text (or someone else's id) must not get in.
        supplied = request.headers.get("x-request-id", "")
        rid = supplied if _REQUEST_ID.fullmatch(supplied) else uuid.uuid4().hex[:16]
        token = request_id_var.set(rid)
        started = time.perf_counter()
        log = logging.getLogger("backstop.http")
        try:
            response = await call_next(request)
        except Exception:
            log.exception("unhandled error", extra={"method": request.method, "path": request.url.path})
            request_id_var.reset(token)
            raise
        duration = round((time.perf_counter() - started) * 1000, 1)
        response.headers["X-Request-ID"] = rid
        log.info(
            "request",
            extra={"method": request.method, "path": request.url.path, "status": response.status_code,
                   "duration_ms": duration},
        )
        request_id_var.reset(token)
        return response
