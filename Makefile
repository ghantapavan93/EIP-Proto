# Convenience targets for Linux/macOS (PY uses the venv's bin/). Windows: use the
# PowerShell lines in README.md or scripts/demo-up.ps1; make is usually not installed there.

PY ?= backend/.venv/bin/python

.DEFAULT_GOAL := help
.PHONY: help setup seed scan demo run-gate test lint typecheck check api ui up down reset clean

help:             ## list targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

setup:            ## create the backend venv and install everything
	python -m venv backend/.venv && $(PY) -m pip install -q -c backend/requirements.lock -e "backend[dev]" && cd frontend && npm install

seed:             ## rules, contracts, workflow, models, corpus, inventory (idempotent)
	$(PY) -m backstop.cli seed

scan:             ## replay frozen page snapshots, match, evaluate staleness as of Oct 1 2026
	$(PY) -m backstop.cli scan --as-of 2026-10-01

demo:             ## seed + scan + eleven runs (four simulated, five recorded replays, two held-out replays)
	$(PY) -m backstop.cli demo

run-gate:         ## CI-style gate on the updated prompt (exit 1 on RED)
	$(PY) -m backstop.cli run --prompt 2 --model sim-large --rule-date 2026-10-01 --gate

test:             ## backend (SQLite) + frontend tests; CI also runs the backend suite on Postgres
	$(PY) -m pytest backend/tests -q && cd frontend && npm run test -- --run

lint:             ## ruff + eslint
	$(PY) -m ruff check backend/backstop backend/tests && cd frontend && npm run lint

api:              ## API on :8000 (SQLite)
	$(PY) -m backstop.cli serve --reload

ui:               ## Vite dev server on :5173 (proxies /api → :8000)
	cd frontend && npm run dev

up:               ## Postgres + API + UI in Docker
	docker compose up --build

down:            ## stop the stack, keep the database
	docker compose down

reset:           ## stop the stack AND delete the database volume (demo data is reseeded on start)
	docker compose down -v

typecheck:        ## mypy (backend) + tsc (frontend)
	$(PY) -m mypy --config-file backend/pyproject.toml backend/backstop && cd frontend && npx tsc -p tsconfig.app.json --noEmit

check: lint typecheck test  ## everything CI runs except Postgres, Docker and Terraform

clean:            ## remove local SQLite databases
	rm -f backstop.db ci.db
