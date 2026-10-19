# 0006 — Scheduler, fake clock and delivery (Phase 2)

## Jobs table + single-timer scheduler

- `jobs` rows (`scenario-step`, `session-expiry`, `delivery-retry`) persist
  every future action. The `Scheduler` arms exactly ONE in-process timer for
  the earliest pending row and disarms when the queue empties — an idle
  simulator issues zero queries, so Neon free still scales to zero. No
  polling loop anywhere.
- `start()` reclaims `running` rows (crash recovery) and runs everything
  overdue. `kick()` wakes the loop after scheduling and after clock jumps.
- Single-scheduler assumption: local mode and the free hosted deploy each
  run one process. Claiming still uses `FOR UPDATE SKIP LOCKED` so a second
  scheduler degrades to lock-skipping rather than double execution.

## Wall-clock run_at + shift on clock jumps

- `run_at` is wall-clock. Fake and wall time advance together except across
  jumps, so a wall-based delay is exactly fake-timeline-correct — EXCEPT the
  jump itself, which is repaired by `shiftPendingJobs`: every clock
  advance/set/reset shifts pending `scenario-step`/`session-expiry` rows by
  the jump delta, then kicks.
- Scheduling on `clock.now()` instead would double-count an existing offset
  (verified by a failing test during implementation).
- Delivery retries are wall-clock by design (a down merchant does not
  recover on simulator-clock jumps) and are never shifted.

## Scenario execution layers

- The scheduler does NOT skip steps on terminal transactions: post-completion
  steps (`send_ipn_duplicate`, `send_ipn_late`) are meant to run on settled
  payments. Plugins skip inapplicable actions tolerantly per the
  `runScenarioAction` contract (a scheduler-level guard broke duplicate-IPN
  during implementation and was removed).
- `session-expiry` keeps a scheduler-level terminal check so settled
  transactions do not collect `timeout.skipped` noise a day later.
- `settle_later` runs inline (its step delay already elapsed while the job
  waited) and ends the scenario; `stay_pending` ends it untouched.
- `engine.attach()` schedules both the first step AND the session-expiry
  timer (idempotent via `hasPendingJob`), so one call owns all per-txn
  timers. Dashboard overrides reuse it via `applyScenarioOverride`, which
  cancels pending `scenario-step` jobs first.
- Steps are snapshotted into jobs at attach time; later scenario edits do
  not affect running scenarios.

## Crash semantics (accepted edges)

- A crash between a state transition and its callback delivery loses that
  callback: the reclaimed job re-runs against a now-terminal transaction and
  the plugin tolerantly skips. No duplicate side effects, one lost IPN in a
  narrow window. Acceptable for a simulator; not worth a two-phase protocol.

## Delivery policy

- 6 attempts max (1 sync + 5 retries), backoff 2s/4s/8s/16s/32s, capped at
  5 minutes. Any completed non-2xx response retries (a merchant 500 is often
  transient while the dev watches the timeline); SSRF blocks never retry.
- Lifecycle events stay sparse: delivery rows record every attempt;
  `callback.blocked` and `callback.dead` events mark terminal outcomes only.

## SSRF guard

- `safePost` allows http(s) only, resolves each redirect hop's hostname and
  rejects when ANY resolved IP is non-public (literal IPs checked directly),
  follows at most 3 redirects, caps bodies at 64 KB and each hop at 10 s.
- Threat model is footgun prevention (a hosted simulator must never probe
  internal infra), not a hostile merchant — the merchant is the simulator's
  own user. DNS-rebinding TOCTOU between check and connect is documented in
  `ssrf.ts` and out of scope.

## Scenario selection (SSLCommerz)

- Magic marker in `value_d` (`SIM:<name>`), then app default, then manual.
  Unknown magic fails the init with gateway-shaped `FAILED` before any row
  is written. Workspace scenarios shadow global presets by name.
- `redirect_*` steps accept a `skipIpn` param so `late-ipn` can suppress the
  immediate IPN and deliver the first IPN from a later step.
