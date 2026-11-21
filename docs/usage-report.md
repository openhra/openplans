# Usage report

The usage report is an optional, anonymous summary of how an install is set up. It is off by
default. Nothing is sent, and no timer, sender code or database write exists for it, until an
operator turns it on.

## Turning it on or off

- Environment: `OPENPLANS_USAGE_REPORT=on`. Any other value, including `yes`, `1`, `true` and
  `ON`, leaves it off.
- Config file: `usageReport.enabled` (boolean, default `false`). The variable wins over the file.
- `usageReport.url` is the address a report would go to. It must be `https://`, with no user info
  and no query.

## Seeing what it would say

- `worker usage-report show` prints the state (`on` or `off`), the address, whether an install id
  exists, the last send and the exact JSON that would be sent now. It makes no network call and
  writes nothing. With the report off it does not open the database, so it works with no
  database and no network; the database facts are then empty.
- `worker usage-report send --dry-run` builds and checks the same body and prints it. It sends
  nothing.
- `worker usage-report reset` deletes the stored state (install id, previous version, last send).

The field list is in [usage-report.schema.json](usage-report.schema.json).

## Start-up line and status page

The API logs one line at start: `usage report: off (see docs/usage-report.md)`, or
`usage report: on; daily to <address>; see docs/usage-report.md`. The status page and
`/status.json` carry one field, `usage_report`, with the value `off` or `on`.

## Local state

One small table, `usage_report_state`, holds the install id, the version seen at the previous
start, and the last send. It is written only while the report is on, and by `reset`.

Usage data never justifies a compatibility shim, a delayed hard swap or a held release.
