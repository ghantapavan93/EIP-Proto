"""The compliance calendar's "today".

Rule versions flip on legal calendar dates (CMS marketing dates are read in Eastern time),
not on the server's clock. A container on UTC reaches 2026-10-01 at 8 p.m. on September 30
in New York and would start enforcing October's rules four hours early. Every default
"as of today" for rule evaluation goes through `compliance_today`.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from backstop.config import get_settings


def _now() -> datetime:
    """The current instant. Tests replace this to pin the clock."""
    return datetime.now(UTC)


def compliance_today() -> date:
    """Today's date in the compliance time zone (``BACKSTOP_COMPLIANCE_TZ``)."""
    return _now().astimezone(ZoneInfo(get_settings().compliance_tz)).date()
