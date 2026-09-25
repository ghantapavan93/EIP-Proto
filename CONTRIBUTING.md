# Contributing

How to work on Backstop: set up, make a change, and prove it did not break anything.

## Set up

Requirements: Python 3.12, Node 22, and Docker if you want the full stack.

```bash
python -m venv backend/.venv
backend/.venv/bin/pip install -c backend/requirements.lock -e "./backend[dev]"   # Windows: backend\.venv\Scripts\pip
cd frontend && npm install
```

Optional, once: `pip install pre-commit && pre-commit install` runs the formatters and
linters on every commit (see [`.pre-commit-config.yaml`](.pre-commit-config.yaml)).

Run the app locally with `backstop demo` then `backstop serve` (backend on :8000) and
`npm run dev` (console on :5173), or everything at once with `docker compose up --build`.

## Where things go

| Change | Where | Notes |
|---|---|---|
| A new rule version | `rules/<code>.yaml` | Append a version; never edit a published one (the loader refuses) |
| A new contract | `contracts/contracts.yaml` + `backend/backstop/harness/contracts.py` | See [`contracts/README.md`](contracts/README.md) |
| An API endpoint | `backend/backstop/api/<resource>.py` | One router per resource; guard writes with `require_role` and add the action to `core/permissions.py` |
| Domain logic | `backend/backstop/core/` | Keep it pure where possible; the API layer only translates |
| A screen | `frontend/src/pages/` + `components/<feature>/` | Types mirror `backend/backstop/schemas.py` |
| A design decision | `docs/adr/` or `docs/decisions.md` | One decision per record, with the alternatives |

## Before you push

```bash
backend/.venv/bin/python -m ruff check backend/backstop backend/tests
backend/.venv/bin/python -m mypy --config-file backend/pyproject.toml backend/backstop
backend/.venv/bin/python -m pytest backend/tests -q
cd frontend && npm run lint && npm run typecheck && npm run test -- --run && npm run build
```

CI runs the same checks, the backend suite on both SQLite and PostgreSQL, and the
contract gate. A change to measured behaviour needs a test that pins the new number, and
a line in [`docs/honesty.md`](docs/honesty.md) if it changes a published result.

## Conventions

- **Commits:** imperative mood, one change per commit, subject under about 60 characters
  ("Add held-out check to run comparisons").
- **Claims:** every number in the docs or the UI is either measured, simulated, recorded
  or assumed, and says which.
- **Secrets:** never in the repository. Configuration comes from the environment; see
  [`.env.example`](.env.example).
- **Security issues:** report privately; see [`SECURITY.md`](SECURITY.md).
