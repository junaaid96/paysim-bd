# Contributing to PaySim BD

PaySim BD is free and open-source software under the [MIT License](LICENSE).
Thanks for helping make payment integrations easier to test.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Report issues

Open a GitHub issue using the bug-report or feature-request template. Include
steps to reproduce, expected vs actual behavior, and the relevant API log line.

**Do not file public issues for security vulnerabilities** — see
[SECURITY.md](SECURITY.md).

## Hard rules

- **Never real credentials.** Fixtures, tests and docs use obviously fake
  store IDs, keys and phone numbers.
- **Official docs first.** Gateway behavior must follow the provider's public
  documentation; note the source in the plugin's `spec/vN.json`.
- **No trademarked assets** (logos, brand artwork) in the repo.
- **Secure by default.** Hosted mode must fail closed (see
  `docs/decisions/0004-config-defaults.md`).

## Contribute code

1. Fork the repo and clone your fork, then follow the
   [README getting started guide](README.md#getting-started).
2. Branch from `main`: `git checkout -b feat/short-name` (or `fix/…`, `docs/…`).
   Use small conventional commits.
3. Keep changes focused and match surrounding conventions.
4. Run the same gates CI runs (`.github/workflows/ci.yml`):

   | Gate       | Command             |
   | ---------- | ------------------- |
   | Format     | `pnpm format:check` |
   | Lint       | `pnpm lint`         |
   | Types      | `pnpm typecheck`    |
   | Build      | `pnpm build`        |
   | Migrations | `pnpm db:migrate`   |
   | Tests      | `pnpm test`         |

5. Bug fixes need a regression test; new behavior needs test coverage. New
   environment variables go in `.env.example`, `apps/api/src/env.ts` and the
   README table. Schema changes need a migration (`pnpm db:generate`).
6. Open a PR against `main` describing the change and how you verified it.

New here? Issues labeled `good first issue` are the fastest way in.
