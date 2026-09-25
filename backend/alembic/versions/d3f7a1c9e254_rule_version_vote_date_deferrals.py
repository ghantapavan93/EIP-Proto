"""rule versions: vacated/stayed statuses, undated proposals, vote_date, deferrals

A proposed version may have no effective date yet (an FCC item awaiting its vote), so
``effective_from`` becomes nullable. ``vote_date`` and ``deferrals`` are annotations the
loader refreshes in place. The new statuses (``vacated``, ``stayed``) and the
``RESTORES_PRIOR`` classification are plain strings; no schema change is needed for them.
``audit_events`` is not touched, so its append-only triggers survive untouched.

Revision ID: d3f7a1c9e254
Revises: b4e81d2c6a15
Create Date: 2026-09-25 09:00:00
"""
from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "d3f7a1c9e254"
down_revision = "b4e81d2c6a15"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("rule_versions") as batch:
        batch.alter_column("effective_from", existing_type=sa.Date(), nullable=True)
        batch.add_column(sa.Column("vote_date", sa.Date(), nullable=True))
        batch.add_column(sa.Column("deferrals", sa.JSON(), nullable=False, server_default="[]"))


def downgrade() -> None:
    undated = op.get_bind().execute(
        sa.text("SELECT COUNT(*) FROM rule_versions WHERE effective_from IS NULL")
    ).scalar()
    if undated:
        # Refuse rather than delete history: an undated proposal cannot live in the old schema.
        raise RuntimeError(
            f"{undated} rule version(s) have no effective_from (undated proposals); "
            "remove them from rules/*.yaml and reseed before downgrading"
        )
    with op.batch_alter_table("rule_versions") as batch:
        batch.drop_column("deferrals")
        batch.drop_column("vote_date")
        batch.alter_column("effective_from", existing_type=sa.Date(), nullable=False)
