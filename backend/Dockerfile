FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install the package first so the layer is cached across source edits.
COPY backend/pyproject.toml backend/requirements.lock /app/backend/
COPY backend/backstop/__init__.py /app/backend/backstop/__init__.py
RUN pip install --quiet -c /app/backend/requirements.lock /app/backend

COPY backend /app/backend
COPY rules /app/rules
COPY contracts /app/contracts
COPY fixtures /app/fixtures
RUN pip install --quiet -c /app/backend/requirements.lock /app/backend

# The rule corpus, contracts and fixtures are resolved relative to the repo root.
ENV BACKSTOP_RULES_DIR=/app/rules \
    BACKSTOP_CONTRACTS_DIR=/app/contracts \
    BACKSTOP_FIXTURES_DIR=/app/fixtures

# Nothing in the container writes to disk (state lives in Postgres), so it runs unprivileged.
RUN useradd --create-home --uid 10001 app
USER app

EXPOSE 8000
CMD ["sh", "-c", "backstop demo && backstop serve --host 0.0.0.0 --port 8000"]
