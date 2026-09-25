"""The migrations and the models must describe the same schema.

The app creates missing tables from the models at startup (the prototype path), while
Alembic holds the history a production database is upgraded with. If the two drift, a
fresh demo works and an upgraded production database does not. This test applies every
migration to an empty database and compares the result with the models, table by table
and column by column.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from sqlalchemy import create_engine, inspect

from backstop import models  # noqa: F401 - registers every table on Base.metadata
from backstop.db import Base

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
