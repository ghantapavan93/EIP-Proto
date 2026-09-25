"""Runtime configuration.

Everything comes from the environment (or a .env file) so the same image runs
locally, in CI, and in a container. Secrets never live in code.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _find_repo_root() -> Path:
    """Locate the directory that holds rules/, contracts/ and fixtures/.

    An editable install resolves from the source tree; a regular install
    (CI's ``pip install ./backend``, the Docker image) lives in site-packages,
    so fall back to the working directory and its parents. BACKSTOP_REPO_ROOT
    overrides both.
    """
    explicit = os.environ.get("BACKSTOP_REPO_ROOT")
    if explicit:
        return Path(explicit).resolve()
    here = Path(__file__).resolve()
    candidates = [*here.parents, Path.cwd().resolve(), *Path.cwd().resolve().parents]
    for candidate in candidates:
        if (candidate / "rules").is_dir() and (candidate / "contracts").is_dir():
            return candidate
    return here.parents[2]


REPO_ROOT = _find_repo_root()
VALID_ROLES = {"analyst", "engineer", "admin"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="BACKSTOP_", env_file=".env", extra="ignore")

    # Persistence. SQLite is used for tests and zero-dependency local runs;
    # docker-compose provides Postgres.
    database_url: str = Field(default=f"sqlite:///{REPO_ROOT / 'backstop.db'}")

    # Git-owned corpora and fixtures.
    rules_dir: Path = Field(default=REPO_ROOT / "rules")
    contracts_dir: Path = Field(default=REPO_ROOT / "contracts")
    fixtures_dir: Path = Field(default=REPO_ROOT / "fixtures")

    # Auth. "user:password:role,..." — a deliberate stub for SSO.
    users: str = Field(default="analyst:analyst:analyst,engineer:engineer:engineer,admin:admin:admin")

    # Model adapters. Real models come from a local Ollama (no key) or free-tier
    # providers (GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY — read by
    # harness/providers.py); Anthropic is optional and paid.
    anthropic_api_key: str | None = Field(default=None, alias="ANTHROPIC_API_KEY")
    default_adapter: str = Field(default="cassette")  # simulated | cassette | live

    # Crawler etiquette.
    crawler_user_agent: str = Field(
        default="BackstopPrototype/0.1 (+https://github.com/ghantapavan93/EIP-Proto; read-only research crawl)"
    )
    crawler_delay_seconds: float = Field(default=2.0)
    crawler_live: bool = Field(default=False)  # False = replay frozen snapshots only

    # UI hints.
    environment_label: str = Field(default="PROTOTYPE · SYNTHETIC DATA")

    def user_table(self) -> dict[str, tuple[str, str]]:
        """Parse BACKSTOP_USERS into {username: (password, role)}.

        Entries are comma-separated ``user:password:role``. The password may
        contain ':' (username is before the first, role after the last) but
        not ','. A malformed entry raises ValueError at startup, not a 500 on
        every request.
        """
        table: dict[str, tuple[str, str]] = {}
        for entry in self.users.split(","):
            entry = entry.strip()
            if not entry:
                continue
            username, sep, rest = entry.partition(":")
            password, sep2, role = rest.rpartition(":")
            if not (sep and sep2 and username and password):
                raise ValueError(f"BACKSTOP_USERS entry for {username or '?'!r} must be user:password:role")
            if role not in VALID_ROLES:
                raise ValueError(f"BACKSTOP_USERS entry for {username!r} has unknown role {role!r}")
            table[username] = (password, role)
        return table

    def uses_default_credentials(self) -> bool:
        """True when any account's password equals its username (the shipped demo accounts)."""
        return any(user == password for user, (password, _) in self.user_table().items())


@lru_cache
def get_settings() -> Settings:
    return Settings()
