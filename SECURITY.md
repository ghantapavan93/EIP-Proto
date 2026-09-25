# Security

Backstop is a prototype. It holds no real customer data: every call transcript
and internal artifact in this repository is synthetic, and the public web pages
under `fixtures/` were fetched once, read-only, and frozen.

## Reporting a vulnerability

Please report security issues privately to the repository owner through
GitHub's private vulnerability reporting (**Security → Report a vulnerability**)
rather than a public issue. Include the affected path or endpoint, steps to
reproduce, and the impact you observed. Reports are acknowledged within two
business days.

## Scope and controls

The threat model, with the mitigation in place for each threat and the change
a production deployment would need, is in [`docs/threat-model.md`](docs/threat-model.md).
In summary:

| Area | Control in this prototype |
|---|---|
| Authentication | HTTP Basic with roles (`analyst`, `engineer`, `admin`); a stand-in for SSO |
| Authorization | Operating endpoints require `engineer` or `admin`; governance (access review, rule-corpus adoption, audit checkpoints) requires `admin`; review decisions require a named user |
| Audit | Append-only table (database triggers), SHA-256 hash chain, `GET /api/audit/verify`, admin checkpoints kept outside the database |
| Personal data | Ingest and the sandbox redact PII before storage or matching (`backend/backstop/core/pii.py`) |
| Model egress | Real transcripts go only to a local model unless explicitly allowed (`RealDataGuard`) |
| Secrets | Environment variables only; `.env` is never committed; see [`.env.example`](.env.example) |
| Network | Only the nginx gateway is published; API and database bind to localhost; strict security headers |

The demo accounts in `.env.example` use password = username and are for
localhost only. The tunnel scripts refuse to publish while any account still
uses them.

## Dependency audit

`npm audit` on 2026-09-25 reports seven advisories. None is exploitable in the shipped
console, and each has a planned fix:

| Package | Where it runs | Advisory | Assessment | Plan |
|---|---|---|---|---|
| `react-router-dom` 6.x | Production bundle | Open redirect via a backslash in a link path; SSR hydration issue | The only user-controlled navigation is the post-login `?next=` path, and `lib/redirect.ts` already rejects `//`, `/\` and control characters; there is no server-side rendering | Upgrade to 7.x (a major version) |
| `vite` 5.x, `esbuild` | Local dev server only | Path traversal and cross-origin reads against the dev server | Not part of the built bundle served by nginx | Upgrade with the Vite major |
| `vitest` 2.x | Local test runner only | File read when the Vitest UI server is listening | The UI server is never started | Upgrade with the Vitest major |

Python dependencies are pinned in `backend/requirements.lock` and installed with it in CI
and in the Docker image.
