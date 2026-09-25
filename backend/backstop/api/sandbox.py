"""Sandbox endpoints: try pasted text against the rules and the workflow. Nothing is stored.

Any signed-in role may use them. Each request writes exactly one audit row
(hash and counts, never the text); text is never logged. Requests are capped
by size and rate-limited per user.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request

from backstop import schemas as s
from backstop.api.deps import SessionDep, User, current_user
from backstop.api.ratelimit import TokenBucket
from backstop.core import audit
from backstop.core import sandbox as sb
from backstop.harness import sandbox as tsb

router = APIRouter(prefix="/sandbox", tags=["sandbox"])

ARTIFACT_LIMIT = TokenBucket(capacity=30, per_seconds=60)
TRANSCRIPT_LIMIT = TokenBucket(capacity=6, per_seconds=60)

# A JSON-escaped character is at most 12 bytes (an emoji as two escaped UTF-16 halves); anything
# larger than that plus envelope slack cannot be a valid request, so refuse it unread.
_ENVELOPE_BYTES = 4_096


def _body_cap(max_chars: int):
    limit = max_chars * 12 + _ENVELOPE_BYTES

    def _dep(request: Request) -> None:
        declared = request.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > limit:
            raise HTTPException(413, f"request body over {limit // 1000} KB; the text limit is {max_chars} characters")

    return _dep


def _limited(bucket: TokenBucket, what: str):
    def _dep(user: Annotated[User, Depends(current_user)]) -> User:
        wait = bucket.take(user.name)
        if wait > 0:
            per_minute = int(bucket.capacity)
            raise HTTPException(429, f"{what} is limited to {per_minute} per minute per user; try again in "
                                     f"{max(1, round(wait))} s", headers={"Retry-After": str(max(1, round(wait)))})
        return user

    return _dep


def _text_or_422(text: str, max_chars: int) -> str:
    try:
        return sb.check_text(text, max_chars=max_chars)
    except sb.SandboxTextError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/samples", response_model=s.SandboxSamplesOut)
def samples(user: Annotated[User, Depends(current_user)]):
    return sb.SAMPLES


@router.post("/artifact", response_model=s.SandboxArtifactOut,
             dependencies=[Depends(_body_cap(sb.ARTIFACT_MAX_CHARS))])
def check_artifact(body: s.SandboxArtifactRequest, session: SessionDep,
                   user: Annotated[User, Depends(_limited(ARTIFACT_LIMIT, "artifact checking"))]):
    text = _text_or_422(body.text, sb.ARTIFACT_MAX_CHARS)
    try:
        label = sb.check_label(body.label)
    except sb.SandboxTextError as exc:
        raise HTTPException(422, str(exc)) from exc
    as_of = body.as_of or date.today()
    result = sb.check_artifact(session, text, as_of=as_of, label=label)
    audit.record(session, actor=user.name, role=user.role, event_type="sandbox.artifact_checked",
                 entity_type="sandbox", entity_id=result["text_sha256"],
                 payload={"text_sha256": result["text_sha256"], "chars": result["chars"],
                          "matches": result["summary"]["matches"], "stale": result["summary"]["stale"],
                          "as_of": as_of.isoformat(), "label": label})
    session.commit()
    return result


@router.post("/transcript", response_model=s.SandboxTranscriptOut,
             dependencies=[Depends(_body_cap(sb.TRANSCRIPT_MAX_CHARS))])
def check_transcript(body: s.SandboxTranscriptRequest, session: SessionDep,
                     user: Annotated[User, Depends(_limited(TRANSCRIPT_LIMIT, "transcript checking"))]):
    text = _text_or_422(body.text, sb.TRANSCRIPT_MAX_CHARS)
    digest = sb.sha256(text)
    base = {"text_sha256": digest, "chars": len(text)}
    try:
        result = tsb.check_transcript(session, text, product_line=body.product_line, model_id=body.model_id)
    except (tsb.Timeout, tsb.ModelFailed) as exc:
        # The attempt reached a model: it is worth a row, without the text.
        audit.record(session, actor=user.name, role=user.role, event_type="sandbox.transcript_checked",
                     entity_type="sandbox", entity_id=digest,
                     payload={**base, "model_id": exc.model_id or body.model_id, "latency_ms": None, "outcomes": {},
                              "error": type(exc).__name__})
        session.commit()
        raise HTTPException(exc.status, exc.message) from exc
    except tsb.SandboxError as exc:
        raise HTTPException(exc.status, exc.message) from exc
    audit.record(session, actor=user.name, role=user.role, event_type="sandbox.transcript_checked",
                 entity_type="sandbox", entity_id=digest,
                 payload={**base, "model_id": result["model_id"], "latency_ms": result["latency_ms"],
                          "outcomes": {c["code"]: c["outcome"] for c in result["contracts"]}})
    session.commit()
    return result
