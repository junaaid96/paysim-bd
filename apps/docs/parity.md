# Parity suite

`@paysim/parity` replays recorded request/response fixtures against a running simulator and diffs response **shape** — the mechanism behind the fidelity badges.

## Honesty labels

Every fixture declares a `source`:

| Source             | Meaning                                    | Badge cap |
| ------------------ | ------------------------------------------ | --------- |
| `docs-sample`      | Transcribed from official doc samples      | docs-only |
| `community-sample` | Transcribed from community SDKs/captures   | docs-only |
| `real-sandbox`     | Recorded against the vendor's real sandbox | verified  |

A gateway earns `verified` **only** when every implemented endpoint is covered by a passing `real-sandbox` fixture. Docs samples prove the sim matches the docs, not the sandbox — green docs-sample runs can never promote past docs-only, and the runner rejects a `verified` claim without proof (CI fails).

Current state: SSLCommerz and bKash ship docs-sample fixtures covering all implemented endpoints; Nagad ships none (its sealed flow can't be captured statically, and its shapes are unverified inventions — replaying them would be theater).

## Fixture format (v1)

```json
{
  "version": 1,
  "name": "init-validate",
  "gateway": "sslcommerz",
  "source": "docs-sample",
  "setupApp": { "gateway": "sslcommerz", "name": "...", "credentials": {} },
  "steps": [
    {
      "name": "init",
      "covers": ["POST /gwprocess/v4/api.php"],
      "request": { "method": "POST", "path": "/gwprocess/v4/api.php", "form": {} },
      "expect": { "status": 200, "shape": { "status": "SUCCESS" } },
      "capture": { "sessionkey": "sessionkey" }
    }
  ]
}
```

- `covers` uses verbatim `spec/vN.json` endpoint strings and drives badge coverage.
- Later steps reuse earlier responses via `{{variables}}` (dotted capture paths, e.g. `0.metadata.valId`); per-run builtins `{{$uuid}}`, `{{$rand8}}`, `{{$timestamp}}` keep idempotency-keyed fields unique so fixtures are re-runnable.
- Shapes support `{"$any": "string"|…}`, `{"$regex": "…"}`, `{"$optional": …}`; a single-item array is a per-item shape. Objects are strict both ways.
- Large bodies live outside the JSON: `jsonKey`/`shapeKey` refs resolve from the fixtures dir or `s3://bucket/key` (recording storage for big captures).

## Running it

```sh
# Against local compose:
pnpm build
pnpm parity -- --base-url http://127.0.0.1:3001 [--gateway bkash]
```

CI boots the API and runs the full suite; `apps/api/tests/parity.integration.test.ts` replays the same fixtures inside `pnpm test`. To contribute a `real-sandbox` fixture: capture vendor sandbox traffic for the endpoint, transcribe request/response into the v1 format with `source: real-sandbox` and a note describing the capture, and open a PR.
