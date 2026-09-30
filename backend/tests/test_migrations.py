"""The migrations and the models must describe the same schema.

SQLite creates its tables from the models at startup, while Alembic owns every deployed
(Postgres) database. If the two drift, a fresh demo works and an upgraded production
database does not. These tests apply every migration to an empty database, compare the
result with the models table by table and column by column, and check that startup
refuses a deployed database that was not migrated.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import DatabaseError

from backstop import (
    db,
    models,  # noqa: F401 - registers every table on Base.metadata
)
from backstop.db import Base, SchemaNotMigrated, require_migrated

BACKEND = Path(__file__).resolve().parents[1]


def test_alembic_head_matches_the_models(tmp_path):
    url = f"sqlite:///{(tmp_path / 'migrated.db').as_posix()}"
    env = {**os.environ, "BACKSTOP_DATABASE_URL": url}
    done = subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=BACKEND, env=env,
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stderr[-2000:]

    engine = create_engine(url)
    try:
        migrated = inspect(engine)
        tables = set(migrated.get_table_names()) - {"alembic_version"}
        assert tables == set(Base.metadata.tables), (
            f"only in migrations: {sorted(tables - set(Base.metadata.tables))}; "
            f"only in models: {sorted(set(Base.metadata.tables) - tables)}")
        for name, table in Base.metadata.tables.items():
            columns = {c["name"]: c for c in migrated.get_columns(name)}
            assert set(columns) == {c.name for c in table.columns}, (
                f"{name}: only in migrations {sorted(set(columns) - {c.name for c in table.columns})}, "
                f"only in models {sorted({c.name for c in table.columns} - set(columns))}")
            for column in table.columns:
                assert columns[column.name]["nullable"] == column.nullable, f"{name}.{column.name} nullability differs"
    finally:
        engine.dispose()


def _alembic(url: str, *args: str) -> None:
    done = subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND,
                          env={**os.environ, "BACKSTOP_DATABASE_URL": url}, capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stderr[-2000:]


def test_migrations_install_the_append_only_guard(tmp_path):
    url = f"sqlite:///{(tmp_path / 'guarded.db').as_posix()}"
    _alembic(url, "upgrade", "head")
    engine = create_engine(url)
    try:
        with engine.begin() as conn:
            conn.execute(text("INSERT INTO audit_events (ts, actor, actor_role, event_type, entity_type, entity_id, "
                              "payload, prev_hash, row_hash) VALUES (CURRENT_TIMESTAMP, 'a', 'system', 'e', 't', 'i', "
                              "'{}', '', '')"))
        with pytest.raises(DatabaseError, match="append-only"), engine.begin() as conn:
            conn.execute(text("UPDATE audit_events SET actor = 'b'"))
        with pytest.raises(DatabaseError, match="append-only"), engine.begin() as conn:
            conn.execute(text("DELETE FROM audit_events"))
    finally:
        engine.dispose()


def test_startup_refuses_a_database_alembic_has_not_migrated(tmp_path):
    url = f"sqlite:///{(tmp_path / 'deployed.db').as_posix()}"
    engine = create_engine(url)
    try:
        with pytest.raises(SchemaNotMigrated, match="no Alembic revision"):
            require_migrated(engine)
        Base.metadata.create_all(engine)  # what older builds did to Postgres
        with pytest.raises(SchemaNotMigrated, match="alembic stamp head"):
            require_migrated(engine)
    finally:
        engine.dispose()


def test_startup_refuses_a_database_behind_head_and_accepts_head(tmp_path):
    url = f"sqlite:///{(tmp_path / 'behind.db').as_posix()}"
    _alembic(url, "upgrade", "7c1a2f4e9b30")
    engine = create_engine(url)
    try:
        with pytest.raises(SchemaNotMigrated, match="7c1a2f4e9b30"):
            require_migrated(engine)
        _alembic(url, "upgrade", "head")
        require_migrated(engine)
    finally:
        engine.dispose()


def test_only_sqlite_is_created_from_the_models(monkeypatch):
    checked = []
    monkeypatch.setattr(db, "engine", type("PgEngine", (), {"dialect": type("D", (), {"name": "postgresql"})()})())
    monkeypatch.setattr(db, "require_migrated", checked.append)
    monkeypatch.setattr(db.Base.metadata, "create_all", lambda *a, **k: pytest.fail("create_all on Postgres"))
    db.init_schema()
    assert checked == [db.engine]
