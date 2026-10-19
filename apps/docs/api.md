# Management API

Base path `/api`. Mutating gateway traffic lives on the gateway paths; this API drives the simulator itself. Workspace header: `x-workspace-key` (default `local-default`).

## Apps

| Method | Path            | Body                                          |
| ------ | --------------- | --------------------------------------------- |
| GET    | `/api/apps`     | —                                             |
| POST   | `/api/apps`     | `{gateway, name, credentials}` — fake-guarded |
| PATCH  | `/api/apps/:id` | `{defaultScenarioId}`                         |

## Transactions

| Method | Path                               | Body                                  |
| ------ | ---------------------------------- | ------------------------------------- |
| GET    | `/api/txns?gateway=&state=&limit=` | —                                     |
| GET    | `/api/txns/:id`                    | Detail: txn + events + deliveries     |
| POST   | `/api/txns/:id/scenario`           | `{scenarioId}` override (null clears) |
| POST   | `/api/txns/:id/replay`             | `{deliveryId?}` re-queue a callback   |

## Scenarios & clock

| Method | Path                      | Body         |
| ------ | ------------------------- | ------------ |
| GET    | `/api/scenarios?gateway=` | —            |
| GET    | `/api/clock`              | —            |
| POST   | `/api/clock/advance`      | `{ms}`       |
| PUT    | `/api/clock`              | `{offsetMs}` |
| POST   | `/api/clock/reset`        | —            |

## Specs & live updates

| Method | Path                       | Notes                                |
| ------ | -------------------------- | ------------------------------------ |
| GET    | `/api/specs`               | All gateway manifests                |
| GET    | `/api/specs/:gateway`      | One manifest (fidelity badge source) |
| GET    | `/api/health` `/api/ready` | Liveness / readiness (DB check)      |
| GET    | `/api/stream`              | SSE: txn + delivery + clock events   |

Bodies over 16KB are stored in object storage (key in the row); secrets are redacted in stored headers/bodies; every state change appends an event.
