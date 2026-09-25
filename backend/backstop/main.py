"""FastAPI application."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backstop import __version__
from backstop.api import (
    admin,
    assets,
    audit,
    contracts_metrics,
    evidence,
    meta,
    ops,
    readiness,
    review,
    rules,
    runs,
    sandbox,
)
from backstop.config import get_settings
from backstop.db import init_schema
from backstop.logging_setup import RequestIdMiddleware, configure_logging


@asynccontextmanager
async def lifespan(_: FastAPI):
    configure_logging()
    settings = get_settings()
    settings.user_table()  # fail fast on a malformed BACKSTOP_USERS
    if settings.uses_default_credentials():
        logging.getLogger("backstop").warning(
            "BACKSTOP_USERS still has the demo accounts (password == username). "
            "Fine for the prototype; set BACKSTOP_USERS before exposing this anywhere."
        )
    init_schema()
    yield


app = FastAPI(
    title="Backstop",
    version=__version__,
    description="Rules → contracts → evidence for EIP's sales-AI workflows. Prototype; synthetic data.",
    lifespan=lifespan,
)
app.add_middleware(RequestIdMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID"],
)

# ops first: /rules/{code}/sources and /prompts/diff must win over the generic routes.
for router in (meta.router, audit.router, ops.router, rules.router, assets.router, runs.router, review.router, evidence.router,
               sandbox.router, contracts_metrics.router, readiness.router, admin.router):
    app.include_router(router, prefix="/api")
