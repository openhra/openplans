# Full Postgres smoke

Run `scripts/smoke.sh --full` with the shared `OPENPLANS_DATA_DIR` cache. The default
project is `openplans-h2`. It refuses existing project resources and tears down its
containers, network and database volume on success or failure. It never reads `.env`.

The full run uses production migration/ingestion code on PostgreSQL 16 + PostGIS:
rating rules, TX geography, TX PY2026 PUFs, full RxNorm CPC, registry-backed cached
QHP discovery, Cigna formulary, TX NPPES full + deactivation, Cigna providers, then
Harris County geocoding. Cached discovery records missing issuer snapshots as
`cache_error`/unknown; it does not fabricate a prior publisher HTTP error. Cigna
must be complete. The cached official weekly NPPES link was unavailable (404), so
weekly acquisition is excluded from this reproducible baseline.

The script supplies `cached-worker.mjs` on stdin to the existing production image. It uses
public dependency injection points and the production fetcher's hash verification
to reuse cached publisher bytes. It refuses uncached downloads and Census requests.
Geocoding replays complete original cached Census batches through the production
parser/persistence code, then requires the current deduplicating ingester to reuse
all Harris NPPES observations (`source=npi_address`) with zero requests. Issuer
address geocoding is covered by the provider lane, not this cache baseline.

The check verifies cached source ingestion on Postgres without contacting
publishers again. It does not test current publisher availability or load synthetic records. Compose also mounts `work/` writable for the NPPES temporary XLSX; smoke creates
`reports/` and `work/` and probes both as the image user before ingestion.
Full smoke makes `/data/raw` writable for request-index/cache metadata;
normal Compose and plain smoke retain the read-only default. Raw payloads remain
content addressed and hash checked.

HTTP checks cover 121 Harris catalog plans across all pages, an authenticated
52928-cent monthly premium, RxCUIs 311354/860975/259255 on 76589TX0010015, and a
nonempty `/v1/data-availability`. Missing/wrong bearer and wrong-database controls
must fail. Each completed worker step saves wall seconds, exact table row counts
and `pg_database_size` under `reports/h2-smoke-<UTC>/`; the summary marks PASS only
after verifying resource teardown. Row totals in the printed table are cumulative
across the explicitly named tables; JSON retains each individual count.

On macOS the default Colima VM may not see the host data volume. The preflight
prints a temporary-profile command before creating a stack. For example:

```sh
export OPENPLANS_DATA_DIR=/absolute/path/to/cache
colima start openplans-h2 --activate=false --cpu 4 --memory 10 \
  --mount "$OPENPLANS_DATA_DIR:w" --mount "$HOME:w"
DOCKER_CONTEXT=colima-openplans-h2 ./scripts/smoke.sh --full
colima delete openplans-h2 --force
```

Use `--activate=false` and scoped `DOCKER_CONTEXT`; never change the owner's
default profile. Delete only a profile you created. Plain smoke can use the
existing daemon and a temporary cache under the shared home directory.
