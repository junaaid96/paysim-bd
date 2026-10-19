# Fake clock

All simulator time logic reads `clock.now(workspaceId)` — wall clock plus a per-workspace offset. Expiry, token lifetimes, and scheduled steps all respect it.

| Endpoint                         | Effect                                                   |
| -------------------------------- | -------------------------------------------------------- |
| `GET /api/clock`                 | Current offset + virtual now                             |
| `POST /api/clock/advance` `{ms}` | Move forward (shifts pending fake-timeline jobs with it) |
| `PUT /api/clock` `{offsetMs}`    | Set an absolute offset                                   |
| `POST /api/clock/reset`          | Back to wall clock                                       |

Jumping forward 24 hours expires a session that would otherwise need a day. The dashboard clock panel shows the offset (`+24.0h`) and jumps in one click.

Notes:

- Offsets are per workspace; `local-default` is the local one.
- Pending jobs pinned to the fake timeline shift with jumps, so a `settle_later` step still fires after you advance past it.
- Delivery backoff stays on the wall clock — retries measure real failures, not virtual time.
