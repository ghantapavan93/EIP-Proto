# Convenience targets for Linux/macOS (PY uses the venv's bin/). Windows: use the
# PowerShell lines in README.md or scripts/demo-up.ps1; make is usually not installed there.

PY ?= backend/.venv/bin/python

.PHONY: setup seed scan demo run-gate test lint api ui up down reset clean

setup:            ## create the backend venv and install everything
	python -m venv backend/.venv && $(PY) -m pip install -q -e "backend[dev]" && cd frontend && npm install

seed:             ## rules, contracts, workflow, models, corpus, inventory (idempotent)
	$(PY) -m backstop.cli seed

scan:             ## replay frozen page snapshots, match, evaluate staleness as of Oct 1 2026
	$(PY) -m backstop.cli scan --as-of 2026-10-01

demo:             ## seed + scan + eleven runs (four simulated, five recorded replays, two held-out replays)
	$(PY) -m backstop.cli demo

run-gate:         ## CI-style gate on the updated prompt (exit 1 on RED)
	$(PY) -m backstop.cli run --prompt 2 --model sim-large --rule-date 2026-10-01 --gate

test:             ## backend + frontend tests
	$(PY) -m pytest backend/tests -q && cd frontend && npm run test -- --run

lint:
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

clean:
	rm -f backstop.db ci.db
