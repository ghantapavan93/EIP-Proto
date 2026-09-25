"""audit attribution + hash chain; rule-version applicability and ranked sources

Revision ID: b4e81d2c6a15
Revises: 7c1a2f4e9b30
Create Date: 2026-09-23 08:00:00
"""
from __future__ import annotations

import sqlalchemy as sa

from alembic import op
from backstop.db import install_append_only_guard

revision = "b4e81d2c6a15"
down_revision = "7c1a2f4e9b30"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Existing rows keep role "system" and an empty hash: /api/audit/verify reports
    # the chain from the first hashed row. A fresh database is fully chained.
    with op.batch_alter_table("audit_events") as batch:
        batch.add_column(sa.Column("actor_role", sa.String(length=32), nullable=False, server_default="system"))
        batch.add_column(sa.Column("correlation_id", sa.String(length=64), nullable=True))
        batch.add_column(sa.Column("prev_hash", sa.String(length=64), nullable=False, server_default=""))
        batch.add_column(sa.Column("row_hash", sa.String(length=64), nullable=False, server_default=""))
        batch.create_index("ix_audit_events_correlation_id", ["correlation_id"])
    with op.batch_alter_table("rule_versions") as batch:
        batch.add_column(sa.Column("regulation_effective", sa.Date(), nullable=True))
        batch.add_column(sa.Column("sources", sa.JSON(), nullable=False, server_default="[]"))
    # SQLite's batch mode rebuilds audit_events, which drops its triggers.
    install_append_only_guard(op.get_bind())


def downgrade() -> None:
    with op.batch_alter_table("rule_versions") as batch:
        batch.drop_column("sources")
        batch.drop_column("regulation_effective")
    with op.batch_alter_table("audit_events") as batch:
        batch.drop_index("ix_audit_events_correlation_id")
        batch.drop_column("row_hash")
        batch.drop_column("prev_hash")
        batch.drop_column("correlation_id")
        batch.drop_column("actor_role")
