"""Database session management.

Portable across SQLite (tests, zero-dependency local runs) and Postgres
(docker-compose). Models use only generic SQLAlchemy types so both work.

Schema ownership differs by path. SQLite is created from the models at startup.
Postgres is a deployed database: Alembic owns its schema (``alembic upgrade head``
from backend/), and startup refuses to run against one that is not at head.
"""

from __future__ import annotations

from collections.abc import Generator
from pathlib import Path

from sqlalchemy import Engine, create_engine, event, inspect, text
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


class SchemaNotMigrated(RuntimeError):
    """A deployed database whose schema is not at the Alembic head this code expects."""


def init_schema() -> None:
    """Make the database ready at startup: create it on SQLite, verify it everywhere else."""
    from backstop import models  # noqa: F401 - registers mappings

    if engine.dialect.name == "sqlite":
        Base.metadata.create_all(engine)
        with engine.begin() as conn:
            install_append_only_guard(conn)
        return
    require_migrated(engine)


def require_migrated(bind: Engine) -> None:
    """Raise SchemaNotMigrated unless Alembic has brought the database to head."""
    from alembic.runtime.migration import MigrationContext

    with bind.connect() as conn:
        current = set(MigrationContext.configure(conn).get_current_heads())
        has_tables = inspect(conn).has_table("rules")
    if not current:
        hint = (" It has tables but no revision (created by an older build): check they match the models, "
                "then run `alembic stamp head` once." if has_tables else "")
        raise SchemaNotMigrated(f"database has no Alembic revision; run `alembic upgrade head` in backend/.{hint}")
    expected = _migration_heads()
    if expected is not None and current != expected:
        raise SchemaNotMigrated(f"database is at revision {sorted(current)}, this build expects {sorted(expected)}; "
                                "run `alembic upgrade head` in backend/")


def _migration_heads() -> set[str] | None:
    """Head revision(s) of the migration scripts, or None when they are not on disk here.

    An editable install finds backend/alembic.ini next to the package; the image runs from
    /app/backend, where the working directory has it. A wheel installed elsewhere has neither.
    """
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    for directory in (Path(__file__).resolve().parents[1], Path.cwd()):
        ini = directory / "alembic.ini"
        if ini.is_file() and (directory / "alembic" / "env.py").is_file():
            return set(ScriptDirectory.from_config(Config(str(ini))).get_heads())
    return None
