"""Database session management.

Portable across SQLite (tests, zero-dependency local runs) and Postgres
(docker-compose). Models use only generic SQLAlchemy types so both work.
"""

from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from backstop.config import get_settings


class Base(DeclarativeBase):
    pass


def _make_engine(url: str):
    connect_args = {}
    if url.startswith("sqlite"):
        connect_args = {"check_same_thread": False}
    engine = create_engine(url, connect_args=connect_args, future=True)
    if url.startswith("sqlite"):

        @event.listens_for(engine, "connect")
        def _fk_on(dbapi_conn, _record):  # pragma: no cover - trivial
            dbapi_conn.execute("PRAGMA foreign_keys=ON")

    return engine


engine = _make_engine(get_settings().database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


def get_session() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


# The audit log is append-only in the database, not just by convention: any
# UPDATE or DELETE (and TRUNCATE on Postgres) raises. Idempotent; mirrored by
# the Alembic revision 7c1a2f4e9b30.
APPEND_ONLY_DDL: dict[str, list[str]] = {
    "sqlite": [
        "CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events "
        "BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END",
        "CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events "
        "BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END",
    ],
    "postgresql": [
        "CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger AS $$ "
        "BEGIN RAISE EXCEPTION 'audit_events is append-only'; END; $$ LANGUAGE plpgsql",
        "DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events",
        "CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events "
        "FOR EACH ROW EXECUTE FUNCTION audit_events_append_only()",
        "DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events",
        "CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events "
        "FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only()",
    ],
}


def install_append_only_guard(bind) -> None:
    for statement in APPEND_ONLY_DDL.get(bind.dialect.name, []):
        bind.execute(text(statement))


def init_schema() -> None:
    """Create tables if they do not exist (prototype path; Alembic holds the history)."""
    from backstop import models  # noqa: F401 - registers mappings

    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        install_append_only_guard(conn)
