# Security Policy

## Supported versions

| Version                    | Supported                               |
| -------------------------- | --------------------------------------- |
| `main` HEAD (pre-1.0, 0.x) | Yes                                     |
| Older commits/tags         | No — please verify against `main` first |

## Reporting a vulnerability

Email **codejborg@junaidul.pro.bd** with:

- What is affected (route, package, dashboard page) and the commit you tested.
- Steps to reproduce or a minimal proof of concept.
- The impact as you see it.

Please do **not** open a public issue, pull request, or discussion for a
suspected vulnerability. PaySim BD never needs real gateway credentials — do
not include any in your report.

You will get an acknowledgement within 72 hours. Fixes ship on `main` with a
CHANGELOG entry. Tell us if you would like to be credited.

## Scope notes

- Reportable: SSRF-guard bypasses (callback/IPN targets), secrets leaking into
  stored request bodies or logs (redaction gaps), injection, path traversal in
  storage drivers, and insecure defaults in the Docker or hosted setup.
- Out of scope: denial of service against the shared public playground, and
  upstream dependency issues without a PaySim BD–specific exploit path (still
  welcome as a dependency-update PR).

## Self-host checklist

- Keep `ALLOW_PRIVATE_CALLBACK_TARGETS=false` on anything reachable from the
  internet.
- Use `STORAGE_DRIVER=s3` in production and keep `S3_*` secrets out of the web
  build.
- Use `sslmode=require` for hosted Postgres and restrict database access to
  the API host.
