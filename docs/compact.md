# Compact a build database

Run `worker compact --dry-run` after imports and geocoding finish. It checks the same conditions
as `worker compact` and prints the planned table list and current sizes as one JSON object.
It does not truncate, vacuum or analyze tables. Its `after` sizes equal `before`.

Run `worker compact` before cutting the database artifact. It truncates the seven tables marked
`staging` in `src/db/table-classes.ts`, in one transaction with `RESTRICT`. Foreign-key dependencies
outside that list make the transaction fail. The command keeps served data, evidence, run ledgers
and derived search keys. Table definitions remain, so the next build can ingest into them without
rerunning old migrations. Use a new geocode run ID after compaction, since completed run ledgers
remain but their queues are empty.

An unfinished snapshot, unstaged geocode run, pending batch, missing result or unpublished input
blocks compaction. A snapshot in `DISCOVERED` has not started an import and does not block it.
Finish or quarantine an unfinished import before retrying. A new, unclassified table also blocks
compaction until its retention class is recorded. This includes tables added by plugins.

Worker imports and bootstrap hold a shared advisory lock until their database closes. Compact
holds the exclusive lock, plus the existing geocoder and migration locks, through vacuuming.
A writer already using any table makes the preflight fail without truncating anything. Run this
command on the build database while its other writers are stopped. API reads can continue during
preflight, but a full vacuum takes an exclusive lock on the table it rewrites.

After truncating, the command vacuums and analyzes each core table except the PostGIS extension
lookup table. It uses `FULL` on retained tables whose statistics report dead tuples. Staging heaps,
indexes and TOAST data are already reclaimed by truncation. Full vacuum needs temporary disk space
for a replacement table and indexes. If vacuum fails, staging remains compacted; retrying is safe.

The JSON report lists database bytes, each table's total bytes including indexes and TOAST, planned
vacuum modes, and the relation bytes reclaimed. Database bytes can also change with catalog writes
and concurrent activity, so use the relation totals when measuring reclaimed table space.

The inventory records whether a table is bound to a plan year. Compact does not retire plan years
or remove `geocode_attempt` evidence. Those are separate retention operations.

Matched geocode attempts live in `geocode_match_archive`, a `build-only` table. Compact keeps
that archive for importer reuse. The generation builder removes it and its provenance registry
entry before either export, then checks that no build-only table remains. Serving generations
keep `address_point` and unresolved `geocode_attempt` rows. A later build recreates the archive
and reuses matched points without sending those addresses to the geocoder again. Compact refuses
until `worker backfill geocode-archive` has moved existing matches out of `geocode_attempt`.
