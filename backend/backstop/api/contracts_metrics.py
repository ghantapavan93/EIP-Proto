"""GET /api/contracts/{code}/metrics: per-contract accuracy against ground truth.

The computation lives in core/metrics.py; this router resolves the contract and run.
"""

from __future__ import annotations

from datetime import date
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import select

from backstop import schemas as s
from backstop.api.deps import SessionDep, UserDep
from backstop.core import metrics
from backstop.models import Contract, Run

router = APIRouter(tags=["contracts"])


@router.get("/contracts/{code}/metrics", response_model=s.ContractMetricsOut)
def contract_metrics(code: str, session: SessionDep, user: UserDep, run_id: str | None = None,
                     corpus: Literal["synthetic", "holdout", "ingested", "all"] = Query("synthetic"),
                     rule_date: date | None = None, trend_limit: int = Query(50, ge=1, le=500)):
    """Confusion matrix, precision/recall with Wilson CIs, per-scenario slices, and a trend.

    With run_id: that run. Without: the latest COMPLETE run per model and prompt version
    on `corpus` (default: the development calls), optionally at one rule date.
    """
    contract = session.scalar(select(Contract).where(Contract.code == code))
    if contract is None:
        raise HTTPException(404, "contract not found")
    run = None
    if run_id is not None:
        run = session.get(Run, run_id)
        if run is None:
            raise HTTPException(404, "run not found")
    return metrics.contract_metrics(session, contract, run=run, corpus=corpus, rule_date=rule_date,
                                    trend_limit=trend_limit)
