# 0001 — Dependency versions (Phase 0)

Date: 2026-10-19. All versions verified the same day via
`npm view <pkg> version` against registry.npmjs.org (authoritative),
Docker Hub API v2 (images), and GitHub Releases API (actions).
Exact pins, no ranges — the lockfile is the source of truth afterwards.

## Runtime

| Package                | Pinned   | Registry latest that day   | Note                                              |
| ---------------------- | -------- | -------------------------- | ------------------------------------------------- |
| express                | 5.3.0    | 5.3.0 (`latest-4`: 4.22.3) | Current stable major, as required                 |
| zod                    | 4.6.7    | 4.6.7                      | Post-4.6.6 (malicious commit reverted before npm) |
| pino                   | 10.4.0   | 10.4.0                     |                                                   |
| drizzle-orm            | 0.45.4   | 0.45.4                     | `rc` tag is 1.0.0-rc.4 — deliberately avoided     |
| postgres (postgres.js) | 3.4.9    | 3.4.9                      | See 0002                                          |
| @aws-sdk/client-s3     | 3.1153.0 | 3.1153.0                   |                                                   |
| cors                   | 2.8.6    | 2.8.6                      |                                                   |
| helmet                 | 8.3.0    | 8.3.0                      |                                                   |
| dotenv                 | 18.0.8   | 18.0.8                     |                                                   |
| react / react-dom      | 19.3.1   | 19.3.1                     |                                                   |
| @tanstack/react-query  | 5.104.5  | 5.104.5                    |                                                   |

## Toolchain

| Package                         | Pinned  | Registry latest that day | Note                                               |
| ------------------------------- | ------- | ------------------------ | -------------------------------------------------- |
| typescript                      | 5.9.3   | **7.0.2**                | See below — latest 5.x, deliberately               |
| typescript-eslint               | 8.72.0  | 8.72.0                   | Peer requires TS `>=4.8.4 <6.1.0`                  |
| eslint                          | 10.13.0 | 10.13.0                  |                                                    |
| @eslint/js                      | 10.0.1  | 10.0.1                   |                                                    |
| eslint-config-prettier          | 10.1.8  | 10.1.8                   |                                                    |
| prettier                        | 3.9.10  | 3.9.10                   |                                                    |
| drizzle-kit                     | 0.31.11 | 0.31.11                  |                                                    |
| vite                            | 8.3.4   | 8.3.4                    |                                                    |
| @vitejs/plugin-react            | 6.1.2   | 6.1.2                    |                                                    |
| tailwindcss / @tailwindcss/vite | 4.3.3   | 4.3.3                    | v4, CSS-first                                      |
| vitest                          | 5.0.5   | 5.0.5                    | Peer allows vite 6/7/8                             |
| supertest                       | 7.3.1   | 7.3.1                    |                                                    |
| @types/supertest                | 7.2.1   | 7.2.1                    |                                                    |
| tsx                             | 4.23.15 | 4.23.15                  |                                                    |
| pino-pretty                     | 13.2.0  | 13.2.0                   | Dev-only log transport                             |
| @types/node                     | 22.20.5 | 26.6.5                   | Pinned to the **runtime** line (engines: node>=22) |
| @types/express                  | 5.0.6   | 5.0.6                    |                                                    |
| @types/cors                     | 2.8.19  | 2.8.19                   |                                                    |
| @types/react / @types/react-dom | 19.3.0  | 19.3.0                   |                                                    |
| pnpm (`packageManager`)         | 12.4.1  | 12.14.0                  | Local toolchain; CI installs the same              |

## Images and actions

| Artifact                      | Pinned        | Source                     |
| ----------------------------- | ------------- | -------------------------- |
| postgres:17-alpine            | digest varies | Docker Hub API: tag exists |
| node:22-alpine                | —             | Docker Hub API: tag exists |
| nginx:stable-alpine           | —             | Docker Hub API: tag exists |
| actions/checkout@v7           | v7.0.1 latest | GitHub Releases API        |
| actions/setup-node@v7         | v7.1.0 latest | GitHub Releases API        |
| pnpm/action-setup@v6          | v6.1.0 latest | GitHub Releases API        |
| docker/setup-buildx-action@v4 | v4.4.1 latest | GitHub Releases API        |

## Why TypeScript 5.9.3 instead of 7.0.2

`typescript@latest` is 7.0.2 (the native port line), but
`typescript-eslint@8.72.0` — the current lint chain — peers on
`typescript >=4.8.4 <6.1.0`. Pinning TS 7 would drop type-aware linting and
risk ecosystem incompatibilities (drizzle-kit, tsx, vite plugins). 5.9.3 is
the latest 5.x and universally supported. Revisit when typescript-eslint
supports TS 7.
