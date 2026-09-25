"""Request dependencies: DB session, HTTP Basic auth with roles.

The user table is an env-var stub for SSO (see docs/honesty.md, "Not built
(deliberately)"). Denied requests are audit-logged.
"""

from __future__ import annotations

import hashlib
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from sqlalchemy.orm import Session

from backstop.config import Settings, get_settings
from backstop.core import audit
from backstop.db import get_session

security = HTTPBasic(realm="backstop", auto_error=False)

# Unauthenticated callers can make us write audit rows. Keep one auth.denied
# row per username per window so a credential-stuffing loop cannot flood the
# append-only log (the log line is still emitted on every attempt).
_DENY_WINDOW_SECONDS = 60
_deny_seen: dict[str, float] = {}
_deny_lock = threading.Lock()
# Compared against when the username is unknown, so response time does not
# reveal which usernames exist.
_DUMMY_PASSWORD = secrets.token_urlsafe(16)


def _should_audit_denial(username: str) -> bool:
    now = time.monotonic()
    with _deny_lock:
        if len(_deny_seen) > 10_000:
            _deny_seen.clear()
        last = _deny_seen.get(username)
        if last is not None and now - last < _DENY_WINDOW_SECONDS:
            return False
        _deny_seen[username] = now
        return True


def _unknown_user(name: str | None) -> str:
    return "unknown-user:" + hashlib.sha256((name or "").encode()).hexdigest()[:12]


@dataclass(frozen=True)
class User:
    name: str
    role: str


def current_user(
    request: Request,
    credentials: Annotated[HTTPBasicCredentials | None, Depends(security)],
    settings: Annotated[Settings, Depends(get_settings)],
    session: Annotated[Session, Depends(get_session)],
) -> User:
    # The SPA sends X-Requested-With; omitting the Basic challenge for it stops
    # browsers from popping their native login dialog over the app's own form.
    from_spa = request.headers.get("X-Requested-With") == "XMLHttpRequest"
    challenge = None if from_spa else {"WWW-Authenticate": "Basic"}
    if credentials is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not authenticated", headers=challenge)
    table = settings.user_table()
    entry = table.get(credentials.username)
    expected = entry[0] if entry is not None else _DUMMY_PASSWORD
    password_ok = secrets.compare_digest(expected.encode(), credentials.password.encode())
    if not (entry is not None and password_ok):
        # A known account is named; anything else is hashed, because people paste
        # passwords into the username field and this log can never be edited.
        username = (credentials.username if entry is not None else _unknown_user(credentials.username))[: audit.ACTOR_MAX]
        if _should_audit_denial(username):
            audit.record(session, actor=username, role="unauthenticated", event_type="auth.denied",
                         entity_type="auth", entity_id="basic", payload={"reason": "bad credentials"})
            session.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials", headers=challenge)
    return User(name=credentials.username, role=entry[1])


def require_role(*roles: str):
    def _dep(user: Annotated[User, Depends(current_user)], session: Annotated[Session, Depends(get_session)]) -> User:
        if user.role not in roles:
            audit.record(session, actor=user.name, event_type="auth.denied", entity_type="auth",
                         entity_id="role", payload={"required": list(roles), "role": user.role})
            session.commit()
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"role '{user.role}' may not do this")
        return user

    # Read by /api/me's consistency test: the permission table must match what routes enforce.
    _dep.required_roles = frozenset(roles)  # type: ignore[attr-defined]
    return _dep


SessionDep = Annotated[Session, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
UserDep = Annotated[User, Depends(current_user)]
