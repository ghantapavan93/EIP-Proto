"""Artifacts and scans: the inventory of rule-encoding artifacts and the scans that read them.

    GET  /api/assets            every tracked artifact, real pages first
    GET  /api/assets/{code}     one artifact with its fetched versions
    POST /api/scans             fetch, hash and match artifacts (engineer)
    GET  /api/scans[/{id}]      scan history and per-scan statistics
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select

from backstop import schemas as s
from backstop.api.deps import SessionDep, SettingsDep, User, UserDep, require_role
from backstop.api.serializers import asset_out
from backstop.models import Asset, Scan
from backstop.scanner.service import run_scan

router = APIRouter(tags=["assets"])


@router.get("/assets", response_model=list[s.AssetOut])
def list_assets(session: SessionDep, user: UserDep):
    assets = session.scalars(select(Asset).order_by(Asset.is_synthetic, Asset.type, Asset.code)).all()
    return [asset_out(session, a) for a in assets]


@router.get("/assets/{code}", response_model=s.AssetDetailOut)
def get_asset(code: str, session: SessionDep, user: UserDep):
    asset = session.scalar(select(Asset).where(Asset.code == code))
    if asset is None:
        raise HTTPException(404, f"asset {code} not found")
    return asset_out(session, asset, detail=True)


@router.post("/scans", response_model=s.ScanOut)
def create_scan(body: s.ScanRequest, session: SessionDep, settings: SettingsDep,
                user: User = Depends(require_role("engineer", "admin"))):
    as_of = (body.as_of or date.today()).isoformat()
    key = body.idempotency_key or f"{date.today().isoformat()}:{user.name}:manual:{as_of}:{'live' if body.live else 'snapshot'}"
    outcome = run_scan(session, settings, idempotency_key=key, live=body.live, as_of=body.as_of, actor=user.name)
    out = s.ScanOut.model_validate(outcome.scan)
    out.deduplicated = outcome.deduplicated
    return out


@router.get("/scans", response_model=list[s.ScanOut])
def list_scans(session: SessionDep, user: UserDep):
    return [s.ScanOut.model_validate(x) for x in session.scalars(select(Scan).order_by(Scan.started_at.desc())).all()]


@router.get("/scans/{scan_id}", response_model=s.ScanOut)
def get_scan(scan_id: str, session: SessionDep, user: UserDep):
    scan = session.get(Scan, scan_id)
    if scan is None:
        raise HTTPException(404, "scan not found")
    return s.ScanOut.model_validate(scan)
