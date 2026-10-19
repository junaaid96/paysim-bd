# 0003 — PGlite evaluation (zero-dependency npx mode)

Question: is PGlite viable for a future zero-dependency mode?

## Findings (2026-10-19)

- **Maintained: yes.** `@electric-sql/pglite@0.5.10` was published 2026-10-14
  (5 days before this check), with steady releases through 2026
  (0.4.x → 0.5.x roughly monthly).
- **Drizzle-compatible: yes.** Drizzle documents a PGlite dialect
  (`https://orm.drizzle.team/docs/connect-pglite`, HTTP 200 on 2026-10-19).

## Decision: defer

PGlite is still 0.x (pre-1.0 API surface) and a second dialect would double
migration verification work from Phase 1 on. The brief scopes this as an
optional evaluation, so: **no PGlite dependency in Phase 0**. Revisit after
Phase 5 if a zero-dependency `npx` mode is prioritised — the evaluation says
it is technically viable.
