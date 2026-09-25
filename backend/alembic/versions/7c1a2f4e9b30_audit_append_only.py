"""audit_events is append-only (UPDATE/DELETE/TRUNCATE raise)

Revision ID: 7c1a2f4e9b30
Revises: 448d0e112242
Create Date: 2026-09-23 06:00:00
"""
from __future__ import annotations

from alembic import op
from backstop.db import install_append_only_guard

revision = "7c1a2f4e9b30"
down_revision = "448d0e112242"
branch_labels = None
depends_on = None


def upgrade() -> None:
    install_append_only_guard(op.get_bind())


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events")
        op.execute("DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events")
        op.execute("DROP FUNCTION IF EXISTS audit_events_append_only()")
    elif bind.dialect.name == "sqlite":
        op.execute("DROP TRIGGER IF EXISTS audit_events_no_update")
        op.execute("DROP TRIGGER IF EXISTS audit_events_no_delete")
