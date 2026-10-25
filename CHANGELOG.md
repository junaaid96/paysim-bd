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
- Optional Real sandbox mode per app: SSLCommerz (session, validation, IPN,
  refund) and bKash tokenized checkout (grant, create, execute, status, refund)
  proxied to the providers' sandboxes with AES-GCM encrypted keys
  (`PAYSIM_SECRETS_KEY`). Nagad is marked as requiring merchant credentials.
- Realistic checkout pages: bKash/Nagad wallet number, OTP and PIN steps and an
  SSLCommerz cards / mobile banking / net banking picker, with a persistent
  "PaySim sandbox — test only, no real money" label. No OTP/PIN/card values
  are sent or stored.
- Real sandbox is now its own sidebar page (marked Extra): per-store keys,
  connection test, status (not configured / connected / error) and an on/off
  switch. Store settings and the simulator are unchanged.
- Nagad real-sandbox adapter (initialize + complete with RSA-sealed data and
  signature, verify, refund), active only when a store saves Nagad merchant
  credentials; tested with mocked Nagad responses.

### Changed

- Vercel serverless entry shares the API boot sequence (`bootApp`), so hosted
  and long-lived deploys wire the same stores, engine and scheduler.
