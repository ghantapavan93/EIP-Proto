## Summary

<!-- What changes, and why. One or two sentences. -->

## Trigger

- [ ] Rule change (`rules/`)
- [ ] Prompt change
- [ ] Model or adapter change
- [ ] Application code only

## Checks

- [ ] `pytest backend/tests -q` passes
- [ ] `ruff check backend/backstop backend/tests` is clean
- [ ] `npm run lint`, `npm run test -- --run` and `npm run build` pass in `frontend/`
- [ ] Contract gate: `backstop run --prompt 2 --model sim-large --rule-date 2026-10-01 --gate`
- [ ] Rule versions are appended, never edited in place
- [ ] Docs updated where behaviour changed
