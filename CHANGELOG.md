# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Phase 0 scaffold: pnpm monorepo, Express API, Drizzle migrations, storage
  drivers, React dashboard, CI, Docker Compose.
- Hosted playground on Vercel + Neon (`vercel.json`, `api/index.js`).
- Open-source project files: README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY,
  issue and PR templates.
- SSLCommerz, bKash and Nagad gateway plugins with mock payment pages.
- Scenario engine, fake clock, callback delivery with retries and SSRF guard.
- Parity replay suite with fidelity-badge enforcement (`pnpm parity`).
- VitePress docs site, GHCR release workflow, Render + Neon + R2 deploy guide.

### Changed

- Vercel serverless entry shares the API boot sequence (`bootApp`), so hosted
  and long-lived deploys wire the same stores, engine and scheduler.
