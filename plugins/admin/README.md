# Admin console

`@openplans/plugin-admin` adds an operator overview at `GET /admin`. It reuses the status plugin's observations. The package is optional and stays disabled unless explicitly listed in `OPENPLANS_PLUGINS` or the plugin configuration. Keep it disabled on public installations.

The operator bearer credential protects the routes. With no credential, the host returns 404. Missing or incorrect bearer credentials receive 401. Private HTTPS browser sessions are also supported when the host's origin, ingress review and single-instance requirements are configured. See [admin access](../../docs/admin-access.md).

The overview reports scope availability, source snapshots, worker observations, events and cache state. Unknown evidence stays unknown. Section links open Configuration, Coverage and freshness, Metrics, Releases and recovery, and Customizations. Those pages currently return 503 with an unavailable message. Inspection, proposal and business-action routes also return 503 after authorization. They perform no writes and show no working action controls.

## Page contracts

`src/contracts.ts` defines `AdminPageDependencies` and `AdminPageRegistrar`. Each section owns a registrar in its `index.ts`. Shared `pages.ts` invokes all five registrars. A page receives the route registry, optional operator diagnostics, status host and clock. Read the request's `pluginDb` and `pluginSignal` for database access and cancellation. Do not query during setup. The optional `evidenceMount` plugin option supplies a fixed absolute `directory` and `deploymentId` to the receipt reader. It is configuration, never a request parameter or rendered value. No receipt reader is installed by this slice.

`configuration/index.ts` owns Configuration and proposal routes. `coverage/index.ts`, `metrics/index.ts` and `evidence/index.ts` own their section routes. `customizations/index.ts` owns inspection and invokes the draft, preview, publication and history registrars. Preserve those invocations when implementing inspection. Later form modules replace only their own unavailable registrar or capability predicate. Forms, fields and overrides report unavailable until their implementation ships. The customization registrar dispatches the fixed `view=source`, `view=fields` and `view=overrides` selectors. Preserve those branches when implementing inspection. Field and override handlers run only when their module reports its capability available. Route changes require a shared-contract update.

`OperatorHost` is an optional SDK 0.1 contract granted by `operatorDiagnostics`. Its configuration projection contains allowlisted values and recorded environment/file/default origins. Secret rows report only configured or unset. Paths, raw options and environment values are excluded. Loaded plugin identity is separate from approval evidence. Approvals remain unverified when evidence is unavailable, including when the loaded hash is null.

The host initializes diagnostics after all plugin setups complete. Availability and catalog readers use the caller's read-only request database and cancellation signal. The MSoT facade calls only the configured MSoT provider and retains its public facts and annotation provenance. Missing providers are unavailable. The facade adds no MCP tools, policy sources, collector, commands or persistence.

The core collector can install or remove its reader through `setOperatorTelemetryReader` in `src/plugins/operator-host.ts`. Existing host facades then expose the bounded telemetry interface. With no reader, `operator.telemetry` is absent. The handoff creates no collector, database table or background job.

Retained metrics require the admin plugin and `OPENPLANS_METRICS=on` on the API
host. Run `worker migrate` with the plugin enabled before starting collection.
The API never creates tables. Without both switches, startup allocates no recorder,
writer or timer. Disabling collection keeps existing history.

The host flushes on a 60-second timer and at shutdown through a separate database
connection, with a five-second deadline. It retains five-minute rows for seven days
and hourly rows for 90 days. Two pending windows and 128 series per window bound
the flush buffer. Failed writes retry without adding counts twice. A restart gets
a new boot ID; unflushed samples can be lost. Retained observations remain partial
because other instances and collection gaps cannot be inferred.

Telemetry has a 256 MiB storage limit. Cleanup removes expired and oldest rows,
reserving 2 KiB per live row for labels, histograms, provenance and indexes. If
allocated PostgreSQL pages still exceed 256 MiB, the host clears disposable
telemetry history and reports dropped windows. Business audit is never trimmed.
The host reader offers `1h`, `24h`, `7d` and `90d` windows; the admin page shows the
current process and its last successful flush. The 90-day window uses hourly rows
only, so it does not count detailed rows twice. Empty history is not collected,
never a successful zero. Refresh approved admin package hashes after upgrading.
