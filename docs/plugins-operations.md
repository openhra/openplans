# Running plugins

This page is the operator's checklist for the first-party plugins: turn on the status page
or the signed webhook, run the scheduler, tighten a pass-through cache level, and take and restore
a backup. It assumes the Compose install from [self-hosting](self-host.md). Concepts, load
refusals and writing your own plugin are in the [plugin guide](plugins.md); every environment
variable has a row in the [configuration reference](configuration.md).

Plugins are trusted code. Install only packages you have reviewed.

## The config file

`OPENPLANS_CONFIG` points at a JSON file. The path must be absolute and the file must carry
`"version": 1`. Any other version, bad JSON or an unreadable file stops the process at start.
Core settings use the section names in `src/config/index.ts`. An environment variable wins over
the file for the settings it names. Plugin options and cache levels go only in the file.

This file turns on the status page and the webhook, and tightens one cache level:

```json
{
  "version": 1,
  "listen": {
    "port": 3000
  },
  "cache": {
    "enabled": true,
    "maxMb": 64
  },
  "db": {
    "provider": "pg"
  },
  "blobs": {
    "provider": "local"
  },
  "plugins": {
    "entries": [
      {
        "package": "@openplans/plugin-status",
        "sources": {
          "cms-marketplace-api": {
            "cacheLevel": "memory"
          }
        }
      },
      {
        "package": "@openplans/plugin-webhook",
        "options": {
          "events": ["ingest.failed", "readiness.failed"]
        }
      }
    ],
    "approvedList": "./plugins.approved.json",
    "lockfile": "./plugins.lock.json"
  }
}
```

Rules that trip people up:

- `OPENPLANS_PLUGINS` replaces the whole `plugins.entries` list, including each entry's `options` and
  `sources`. Leave it unset when the file holds your plugin settings.
- Set `"enabled": false` on an entry to keep it in the file and skip it.
- A plugin that has no options schema refuses any `options`.
- The `sources` map belongs to the entry it is written in, but the core reads every enabled entry's
  map. Put a source's settings in any enabled entry. A later entry wins for the same source id.
- A startup refusal prints one JSON line with the plugin and a code, then exits 1. The codes are in
  [load order and refusals](plugins.md#load-order-and-refusals).

Compose mounts the file read-only at the same path in the `api`, `worker` and `scheduler`
services. Set `OPENPLANS_CONFIG` in `.env` to its absolute path on the Docker host.

## Variables

| Variable                                                                                                     | Where                | Effect                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `OPENPLANS_CONFIG`                                                                                           | `.env`               | Absolute path of the config file. Empty reads none.                                                                      |
| `OPENPLANS_PLUGINS`                                                                                          | `.env`               | Comma-separated package names with default options. Replaces the file's list. Empty keeps the file's list.               |
| `OPENPLANS_OPERATOR_TOKEN`                                                                                   | `.env`, API only     | Bearer token for `/status/operator` and `/status/operator.json`. Unset means 404. Use 32+ random characters.             |
| `OPENPLANS_ACCESS_MANIFEST`                                                                                  | every plugin service | Your admission manifest. Every host a plugin declares must be `allowed` in it.                                           |
| `OPENPLANS_WEBHOOK_URL`                                                                                      | every plugin service | Secret. The receiver's full `https://` URL.                                                                              |
| `OPENPLANS_WEBHOOK_HOST`                                                                                     | every plugin service | The receiver's host name. It must match the URL.                                                                         |
| `OPENPLANS_WEBHOOK_SECRET`                                                                                   | every plugin service | Secret, 32+ characters. The HMAC key for `X-OpenPlans-Signature`.                                                        |
| `OPENPLANS_BLOB_S3_ENDPOINT`, `_REGION`, `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_SESSION_TOKEN` | every plugin service | Settings of the S3-compatible blob store. The session token is optional. See its [README](../plugins/blob-s3/README.md). |

"Every plugin service" means `api`, `worker` and `scheduler`. Each process loads the plugin list
and checks the plugin's secrets and hosts, so a service that lacks one refuses to start with
`plugin_secret_missing` or `plugin_network_host_not_allowed`.

`compose.yml` forwards `OPENPLANS_PLUGINS`, `OPENPLANS_CONFIG` and `OPENPLANS_OPERATOR_TOKEN`
(API only). It does not forward the webhook or blob store variables, and the `api` service
has no access manifest. Add them in a local `compose.override.yml`, which Compose reads
automatically. This one wires the webhook into all three services and mounts your manifest read-only:

```yaml
x-webhook-environment: &webhook-environment
  OPENPLANS_WEBHOOK_URL: ${OPENPLANS_WEBHOOK_URL:-}
  OPENPLANS_WEBHOOK_HOST: ${OPENPLANS_WEBHOOK_HOST:-}
  OPENPLANS_WEBHOOK_SECRET: ${OPENPLANS_WEBHOOK_SECRET:-}
  OPENPLANS_ACCESS_MANIFEST: /run/openplans/operator-access.json
x-access-manifest: &access-manifest
  type: bind
  source: ${OPENPLANS_ACCESS_MANIFEST_FILE:?Set the host path of your access manifest}
  target: /run/openplans/operator-access.json
  read_only: true

services:
  api:
    environment: *webhook-environment
    volumes: [*access-manifest]
  worker:
    environment: *webhook-environment
    volumes: [*access-manifest]
  scheduler:
    environment: *webhook-environment
    volumes: [*access-manifest]
```

The container user must be able to read the manifest file, so use mode 644. Check the result with
`docker compose --profile scheduler config` before you start anything.

A manifest is the file described under [adding your own manifest](self-host.md#adding-your-own-manifest).
The webhook needs an entry for its host. Fill in the template in the
[webhook README](../plugins/webhook/README.md#setup) with your own terms review.

## Status page and the operator token

1. Generate a token and put it in `.env`. Do not print it into logs or share it:

   ```sh
   export OPENPLANS_OPERATOR_TOKEN="$(openssl rand -hex 32)"
   printf 'OPENPLANS_OPERATOR_TOKEN=%s\n' "$OPENPLANS_OPERATOR_TOKEN" >> .env
   ```

2. Enable the plugin and recreate the services:

   ```sh
   printf 'OPENPLANS_PLUGINS=@openplans/plugin-status\n' >> .env
   docker compose up -d api
   ```

3. Check both views:

   ```sh
   curl http://127.0.0.1:3000/status.json
   curl -H "Authorization: Bearer $OPENPLANS_OPERATOR_TOKEN" http://127.0.0.1:3000/status/operator.json
   ```

The public routes `/status` and `/status.json` show coarse health, data coverage and source age.
The token unlocks `/status/operator` and `/status/operator.json`, which add exact retrieval times,
import failure codes, cache and pass-through counters, each loaded plugin's name, version and
package hash, and the last events and health changes. Without a token the operator routes answer
404, and a wrong token gets 401. Neither view shows hostnames, paths, keys or request data.
Expose only the two public routes at your proxy and read the operator view from the host. The
full list is in the [status plugin README](../plugins/status/README.md).

## The scheduler

The status probe, event delivery for the webhook, and every plugin schedule run from
`worker schedule run`. A plain `docker compose up` does not start them. The `scheduler` profile
runs the loop, one tick a minute in UTC:

```sh
docker compose --profile scheduler up -d scheduler
docker compose --profile scheduler logs -f scheduler
```

Natively, run `npm run worker -- schedule run --loop`. One tick without the loop is
`worker schedule run`. An advisory lock stops two schedulers from running the same schedule in
the same minute, so a second scheduler is harmless but pointless.

Without a running scheduler, events wait in the outbox and nothing posts. The status page reports
the worker as down, because it looks for a `deliver-events` run in the last 5 minutes. Stop
delivery by stopping the service:

```sh
docker compose --profile scheduler stop scheduler
```

The scheduler needs the same plugin variables as the API and worker. See the override above.

## Signed webhook

1. Set `OPENPLANS_WEBHOOK_URL`, `OPENPLANS_WEBHOOK_HOST` and `OPENPLANS_WEBHOOK_SECRET`
   in `.env`. Keep the URL and HMAC secret out of the config file and shell history.
2. Admit the receiver's host in your access manifest using the template in the
   [webhook README](../plugins/webhook/README.md#setup).
3. Add `@openplans/plugin-webhook` with an explicit `events` list to the config file,
   as in the example above. Include `health.changed` to receive the test event below.
4. Add the Compose override from the variables section, then recreate the services:

   ```sh
   docker compose --profile scheduler up -d api scheduler
   ```

5. Send a test event:

   ```sh
   docker compose run --rm -T worker emit health.changed \
     --payload '{"component":"worker","from":"ok","to":"ok"}' \
     --idempotency-key "webhook-test-$(date -u +%Y%m%dT%H%M%SZ)"
   ```

The [webhook README](../plugins/webhook/README.md) explains the request headers,
signature verification and delivery rules. Answer 204 and drop duplicate deliveries by
`X-OpenPlans-Event-Id`. Non-2xx responses retry with backoff for up to 20 attempts.

Pause deliveries with `docker compose --profile scheduler stop scheduler`. Events wait in
the outbox until the scheduler runs again. To remove the webhook, delete its config entry
or set `"enabled": false`, remove its secrets, then recreate `api` and `scheduler`.
Pending deliveries stay in the outbox while the plugin is disabled.

Rotate `OPENPLANS_WEBHOOK_SECRET` on the receiver and in `.env` together, then recreate
all services that load plugins. After changing a plugin, refresh its version and hash in
[the approved list](#the-approved-plugin-list) from the built image's `/status/operator.json`.

For rollback notifications, include `release.rolled_back` in `events`. It carries the
restored version and image and the version it left as `version`, `imageId` and `fromVersion`.

## Pass-through cache levels

A pass-through source asks an outside service at request time for answers your loaded files leave
`unknown`. The source declares how much of an answer may be kept. You can only keep less:

| Level     | What is kept                                                                      |
| --------- | --------------------------------------------------------------------------------- |
| `none`    | Nothing. Each eligible question is a live call within budget.                     |
| `request` | The answer for one inbound request.                                               |
| `memory`  | A shared entry in the cache store, with a TTL. Lost on restart, never in backups. |
| `stored`  | Rows in the database under a record policy.                                       |

Strictest first, the order is `none`, `request`, `memory`, `stored`. The strictest level wins:

- Your setting can match the source's level or be stricter. A looser setting stops startup with
  `passthrough_level_loosened`, and at `memory` a `ttl` or `negativeTtl` longer than the source's
  does the same.
- A response that mixes several sources takes the strictest level among them.
- In a `none` or `request` scope, nothing is written to disk.

The CMS Marketplace API fallback (source id `cms-marketplace-api`, active while
`OPENPLANS_CMS_FALLBACK=on`) declares `stored`. To keep its answers only in the response cache's
store, use the `sources` entry in the example above. To keep nothing, use
`"cacheLevel": "none"`. Recreate the `api`, `worker` and
`scheduler` services, then read the level back on the operator status page under `passthrough`.

Tightening a `stored` source to a lower level expires its stored rows and stops new writes. It
does not delete them. Loosening again is a refusal, not a rollback: remove your `sources` entry to
return to the declared level. For a `stored` source the worker applies changed `ttl`,
`staleWindow` and `negativeTtl` at start through `worker record-policy set`.

## Backups and restores

The full procedure with the dump, the cache archive and the restore is under
[back up and restore](self-host.md#back-up-and-restore). Three details matter for plugins.

**`worker backup-args`.** Pass-through answers are fetched for one question each and expire, so a
backup leaves them out. The tool prints the names so you do not type them. They include the tables
of any registered pass-through source that stores answers:

```sh
docker compose run --rm --no-deps -T worker backup-args           # pg_dump --exclude-table-data arguments
docker compose run --rm --no-deps -T worker backup-args --tar     # tar --exclude arguments
docker compose run --rm --no-deps -T worker backup-args --manifest > manifest.json
```

Run it with the same plugin list as production, or the list misses a plugin's tables. Keep
`manifest.json` with the dump.

**`worker backup-restored`.** The dump keeps the `snapshot` receipts of the answers it left out.
After `pg_restore` and before the API starts, run:

```sh
docker compose run --rm --no-deps -T worker backup-restored --manifest - < manifest.json
```

It marks those receipts `QUARANTINED` with the quality issue `answers_excluded_from_backup`, so no
`ACTIVE` receipt points at an answer that is missing. It touches only pass-through receipts with
no answer row, never catalog or provider data, and a second run changes nothing. Run it only on a
restored copy and before the API stores new answers.

**`inputs.json`.** If you keep a prepared provider profile at `reports/inputs.json`, the cache
archive already holds it, because the archive includes `reports`. Copy it next to the dump as well
and audit a restore against that copy, not the live file, which can list data loaded after the
dump. The backup tooling that OpenHRA runs for its public instance does the same and records the
copy's hash with the backup.

The backup keeps the plugin outbox and state tables (`plugin_event_outbox`,
`plugin_event_delivery`, `plugin_state`) and the shared daily call budget, so a restore does not
reset a day's count.

## The approved-plugin list

The loader reads this file before importing any enabled package. Configure its path with
`plugins.approvedList` or `OPENPLANS_PLUGINS_APPROVED_LIST`, and set the lock path with
`plugins.lockfile` or `OPENPLANS_PLUGINS_LOCKFILE`. Public mode requires both files. With no packages enabled, use an empty approval array and
a lockfile with an empty `packages` array.

Build the packages, then run `worker plugin lock` against the exact tree that will run,
including its file modes. A checkout and a container image can contain different package files,
so create the candidate inside the intended runtime filesystem. Review the candidate and the
validation evidence before writing approval. For each reviewed lock entry, copy `name`, `version`,
`digest` and `legacySha256` into the approval file, renaming `legacySha256` to `sha256`:

```json
[
  {
    "name": "@openplans/plugin-status",
    "version": "<reviewed lock version>",
    "sha256": "<reviewed legacySha256, 64 lowercase hex characters>",
    "digest": "<reviewed digest, 64 lowercase hex characters>"
  }
]
```

Run `worker plugin verify --json` before startup. A missing entry, changed version or digest,
invalid hash, or unreadable package refuses startup with one JSON line and exit 1. Bundled
packages need the same approval as local packages. Locking and installation do not write the
approval file. Mount both files read-only and keep the package tree unchanged while it runs.

The operator status list still reports `name`, `version` and the legacy `sha256`. Release image
validation and its authenticated bindings keep using that identity. A `null` or empty approval
hash is invalid. Rebuild and review a new lock after every package change.

## Release preflight

Run this before you move an installation to a new image, and again afterwards. Each step is
read-only except the optional test event:

1. `OPENPLANS_OPERATOR_TOKEN` is set in `.env` and has at least 32 characters. Check the length
   without printing the token.
2. Build the image, create its lock candidate without loading plugins, review the validation
   evidence and write exact approvals. Run `worker plugin verify --json` in that image before
   starting any host. The public profile mounts both files from its isolated work directory.
3. Your plugin settings load with the new image:

   ```sh
   docker compose run --rm -T worker migrate --check
   ```

   A refused plugin stops it with exit 1 and one line naming the plugin and the code.

4. The webhook access manifest entry is `allowed`, and its `expiresAt`
   dates are in the future. An expired terms review stops the plugin from loading.
5. The scheduler runs and has delivered recently. `/status.json` shows `db` and `api` as `ok`,
   and `worker` is not down.
6. A fresh backup exists and its `manifest.json` and `inputs.json` copy are next to it. Test the
   restore in a separate Compose project, as the self-hosting guide describes.
7. For the webhook, send the test event from the signed webhook section and confirm it arrived.

If a step fails, fix it before the update.

## Package changes

Use the same config file, data directory and plugin directory for every package command and
for the services that load the packages. Run `plugin list --json` to compare the candidate lock
with the approved list before a restart. A successful registry signature check grants no local
approval. Publishing provenance identifies the build's repository, commit and workflow; inspect
the full statement in the JSON inventory when reviewing a package.

For an update, stop services before changing the candidate lock if you need restarts to keep
working during review. Run `plugin update <name> --to <version>`, review the returned digest,
then approve those exact bytes and update the config entrypoint. The old version remains on
disk. `plugin remove <name>` removes every managed version of that name, so disable every config
entry for it first. Removal does not undo SQL migrations or erase imported data.

Back up the config, lock, approved list, plugin bytes and `<dataDir>/registries/` together.
The registry directory holds the reviewed trust file, accepted version counters, clock state
and cached catalog notices. Preserve independently reviewed root files too. Restoring only
package archives loses the local approval and rollback state needed to review a restart.

## Offline installs

On the connected machine, export an exact version from a trusted catalog:

```sh
node dist/worker/cli.js plugin bundle @example/plugin@2.0.0 --out /tmp/plugin-bundle
```

Add `--registry <URL>` to select a particular trusted origin or configured mirror. Otherwise an
installed name uses its locked origin, and a new name uses the first matching registry.
The output directory must not exist. The command copies the selected archive, the original
signed target index, timestamp and snapshot, and the root chain. It verifies the result with a
fresh client before finishing. Signed metadata stays intact because a client cannot re-sign a
smaller target index. Only the selected archive is included; other catalog entries may be
visible in search but cannot be installed from this bundle.

Transfer that directory to the disconnected machine. Obtain the initial root independently
and check it through your usual trusted channel. The included `bootstrap-root.json` is a copy
for inspection, not permission to trust the bundle. The disconnected config can name the
bundle as a mirror of the original registry:

```json
{
  "version": 1,
  "plugins": {
    "registries": [
      {
        "url": "https://packages.example.org/",
        "root": "/srv/trust/reviewed-root.json",
        "namespaces": ["@example"],
        "mirrors": ["file:///srv/plugin-bundle/"]
      }
    ],
    "lockfile": "/srv/openplans/plugins.lock.json",
    "approvedList": "/srv/openplans/plugins.approved.json",
    "requireApproval": true
  }
}
```

Then install using the mirror explicitly:

```sh
node dist/worker/cli.js plugin install @example/plugin@2.0.0 --registry file:///srv/plugin-bundle/
```

This command performs no network reads. It applies the normal root, signature, rollback,
expiry, archive and package checks, and records the original registry as the origin. Review
and approve the installed digest locally before enabling it. No approval file, credentials or
signing keys travel in the bundle. Code packages already bundle their runtime dependencies and
bind exact host peers from the destination core; the destination needs a compatible core build.
Data activation is outside this command.

Bundles retain the origin's two-day timestamp. An expired bundle cannot install or update a
package. Export a fresh bundle on the connected machine and transfer it again. There is no
stale-catalog override. An unchanged approved local deployment keeps running and can restart
without contacting a registry. `plugin list` warns when the catalog is stale or unavailable.
