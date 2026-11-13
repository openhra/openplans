# Running plugins

This page is the operator's checklist for the first-party plugins: turn on the status page, Slack
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

This file turns on the status page, Slack and the webhook, and tightens one cache level:

```json
{
  "version": 1,
  "listen": { "port": 3000 },
  "cache": { "enabled": true, "maxMb": 64 },
  "db": { "provider": "pg" },
  "blobs": { "provider": "local" },
  "plugins": [
    {
      "package": "@openplans/plugin-status",
      "sources": {
        "cms-marketplace-api": { "cacheLevel": "memory" }
      }
    },
    {
      "package": "@openplans/plugin-slack",
      "options": {
        "events": ["ingest.failed", "readiness.failed", "health.changed"],
        "minSeverity": "warning"
      }
    },
    {
      "package": "@openplans/plugin-webhook",
      "options": { "events": ["ingest.failed", "readiness.failed"] }
    }
  ]
}
```

Rules that trip people up:

- `OPENPLANS_PLUGINS` replaces the whole `plugins` list, including each entry's `options` and
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
| `OPENPLANS_SLACK_WEBHOOK_URL`                                                                                | every plugin service | Secret. The incoming webhook URL.                                                                                        |
| `OPENPLANS_SLACK_HOST`                                                                                       | every plugin service | The webhook's host. Default `hooks.slack.com`.                                                                           |
| `OPENPLANS_WEBHOOK_URL`                                                                                      | every plugin service | Secret. The receiver's full `https://` URL.                                                                              |
| `OPENPLANS_WEBHOOK_HOST`                                                                                     | every plugin service | The receiver's host name. It must match the URL.                                                                         |
| `OPENPLANS_WEBHOOK_SECRET`                                                                                   | every plugin service | Secret, 32+ characters. The HMAC key for `X-OpenPlans-Signature`.                                                        |
| `OPENPLANS_BLOB_S3_ENDPOINT`, `_REGION`, `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_SESSION_TOKEN` | every plugin service | Settings of the S3-compatible blob store. The session token is optional. See its [README](../plugins/blob-s3/README.md). |

"Every plugin service" means `api`, `worker` and `scheduler`. Each process loads the plugin list
and checks the plugin's secrets and hosts, so a service that lacks one refuses to start with
`plugin_secret_missing` or `plugin_network_host_not_allowed`.

`compose.yml` forwards `OPENPLANS_PLUGINS`, `OPENPLANS_CONFIG` and `OPENPLANS_OPERATOR_TOKEN`
(API only). It does not forward the Slack, webhook or blob store variables, and the `api` service
has no access manifest. Add them in a local `compose.override.yml`, which Compose reads
automatically. This one wires Slack into all three services and mounts your manifest read-only:

```yaml
x-slack-environment: &slack-environment
  OPENPLANS_SLACK_WEBHOOK_URL: ${OPENPLANS_SLACK_WEBHOOK_URL:-}
  OPENPLANS_SLACK_HOST: ${OPENPLANS_SLACK_HOST:-hooks.slack.com}
  OPENPLANS_ACCESS_MANIFEST: /run/openplans/operator-access.json
x-access-manifest: &access-manifest
  type: bind
  source: ${OPENPLANS_ACCESS_MANIFEST_FILE:?Set the host path of your access manifest}
  target: /run/openplans/operator-access.json
  read_only: true

services:
  api:
    environment: *slack-environment
    volumes: [*access-manifest]
  worker:
    environment: *slack-environment
    volumes: [*access-manifest]
  scheduler:
    environment: *slack-environment
    volumes: [*access-manifest]
```

For the webhook, replace the three Slack variables with `OPENPLANS_WEBHOOK_URL`,
`OPENPLANS_WEBHOOK_HOST` and `OPENPLANS_WEBHOOK_SECRET` the same way. The container user must be
able to read the manifest file, so use mode 644. Check the result with
`docker compose --profile scheduler config` before you start anything.

A manifest is the file described under [adding your own manifest](self-host.md#adding-your-own-manifest).
Slack and the webhook each need an entry for their host. The plugin READMEs have a template to
fill in with your own terms review: [Slack](../plugins/slack/README.md#setup),
[webhook](../plugins/webhook/README.md#setup).

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

The status probe, event delivery for Slack and the webhook, and every plugin schedule run from
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

## Slack

1. Create an incoming webhook for the channel in Slack and copy its URL into `.env` as
   `OPENPLANS_SLACK_WEBHOOK_URL`. Keep it out of the config file and out of shell history.
2. Write your access manifest with an `allowed` entry for `hooks.slack.com`, using the template in
   the [Slack README](../plugins/slack/README.md#setup).
3. Add the plugin to the config file, as in the example above. `events` picks a subset of the
   eight events, and `minSeverity` is `info`, `warning` or `error`. Both are optional.
4. Add the override from the variables section, set `OPENPLANS_ACCESS_MANIFEST_FILE` in `.env` to
   the manifest's host path, then recreate everything that loads plugins:

   ```sh
   docker compose --profile scheduler up -d api scheduler
   ```

5. Send a test event. It reaches the channel as
   `OpenPlans: Health of worker changed from ok to ok.` within a minute or two:

   ```sh
   docker compose run --rm -T worker emit health.changed \
     --payload '{"component":"worker","from":"ok","to":"ok"}' \
     --idempotency-key "slack-test-$(date -u +%Y%m%dT%H%M%SZ)"
   ```

The plugin posts at most 20 messages a minute and shows only short codes, never URLs or paths.
Failed posts retry with backoff for up to 20 attempts.

Switch it off:

- Pause everything and keep the setup: `docker compose --profile scheduler stop scheduler`.
  Events queue, and the next scheduler run delivers them within the rate limit.
- Remove Slack: delete its entry from the file (or set `"enabled": false`, or drop it from
  `OPENPLANS_PLUGINS`), delete `OPENPLANS_SLACK_WEBHOOK_URL`, then recreate `api` and `scheduler`.
  Deliveries still pending stay in the outbox, and nothing reads them while the plugin is off.
- To be sure nothing more reaches the channel, delete the incoming webhook in Slack as well.

### Upgrade to Slack 0.2.0

Version 0.2.0 adds a message for `release.rolled_back`, at severity `warning`:
`OpenPlans: Release rolled back from 1.4.0 to 1.3.2.` It shows the version the rollback left and
the version it went back to, never the image ID. Rollback messages count toward the same 20 a
minute as every other message.

- Without an `events` option, the plugin posts rollbacks as soon as the new version loads.
- With an `events` list, add `"release.rolled_back"` to it to get them. Version 0.1.0 refuses
  that value with `plugin_options_invalid`, so change the list only together with the upgrade.
- With `minSeverity` set to `error`, rollbacks are dropped.

The new files give the plugin a new package hash, so the
[approved list](#the-approved-plugin-list) needs a new entry. OpenPlans v0.4.4 ships version
0.2.1, which posts the same messages and pins a newer hono. Replace the
`@openplans/plugin-slack` entry for `0.1.0` or `0.2.0` with this one, and keep your other
entries:

```json
[
  {
    "name": "@openplans/plugin-slack",
    "version": "0.2.1",
    "sha256": "949d147a1c0895b4d1d86cc78d3eed74f189437d6055398a5291ec1cf6592647"
  }
]
```

That hash covers what the image holds of the plugin: `package.json` and `dist/`, built with the
compiler in `package-lock.json`. Before you edit the file, start the new image on the side and
read the Slack entry from `/status/operator.json`, as in [release preflight](#release-preflight)
step 2. A different hash there means your build differs from this release. Review the plugin again
before you approve it.

## Signed webhook

The setup is the Slack setup with three variables, an entry for your receiver's host in the
manifest, and the `@openplans/plugin-webhook` entry with its `events` list. The
[webhook README](../plugins/webhook/README.md) gives the request headers, a test vector for the
signature, a Node receiver and the delivery rules. For a test, add `health.changed` to the
`events` list and send the Slack test event. A receiver that
answers outside 2xx makes the outbox retry, so answer 204 and drop repeats by
`X-OpenPlans-Event-Id`. Switch it off the same way as Slack, and rotate `OPENPLANS_WEBHOOK_SECRET`
by changing it on the receiver and in `.env` together, then recreating the services.

To hear about rollbacks, add `release.rolled_back` to the webhook's `events`. It carries the
version and image the release went back to and the version it left (`version`, `imageId`,
`fromVersion`). Slack posts it from version 0.2.0 on; see
[upgrade to Slack 0.2.0](#upgrade-to-slack-020).

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
docker compose run --rm -T worker backup-args           # pg_dump --exclude-table-data arguments
docker compose run --rm -T worker backup-args --tar     # tar --exclude arguments
docker compose run --rm -T worker backup-args --manifest > manifest.json
```

Run it with the same plugin list as production, or the list misses a plugin's tables. Keep
`manifest.json` with the dump.

**`worker backup-restored`.** The dump keeps the `snapshot` receipts of the answers it left out.
After `pg_restore` and before the API starts, run:

```sh
docker compose run --rm -T worker backup-restored --manifest - < manifest.json
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

Plugins can change what runs inside your processes, so keep a short file of the plugins you have
reviewed and compare it with what is loaded. Each entry is the name, version and package hash that
the operator status view reports:

```json
[
  {
    "name": "@openplans/plugin-status",
    "version": "0.1.0",
    "sha256": "<hash from /status/operator.json>"
  }
]
```

Write the entry after you review a plugin, by copying the three values from
`/status/operator.json`. The SDK README explains how the hash is computed, so you can recompute it
from a checkout. After any upgrade or plugin change, compare the file with the live list. This
prints nothing when they match:

```sh
curl -s -H "Authorization: Bearer $OPENPLANS_OPERATOR_TOKEN" http://127.0.0.1:3000/status/operator.json \
  | jq -S '[.plugins[] | {name, version, sha256}] | sort_by(.name)' > loaded.json
jq -S 'sort_by(.name)' plugins.approved.json | diff - loaded.json
```

A `null` hash means the host could not compute it. Treat that as a mismatch.

## Release preflight

Run this before you move an installation to a new image, and again afterwards. Each step is
read-only except the optional test event:

1. `OPENPLANS_OPERATOR_TOKEN` is set in `.env` and has at least 32 characters. Check the length
   without printing the token.
2. The approved list matches the new build's plugins. Build the image first, start it on the
   side, and run the comparison above against it.
3. Your plugin settings load with the new image:

   ```sh
   docker compose run --rm -T worker migrate --check
   ```

   A refused plugin stops it with exit 1 and one line naming the plugin and the code.

4. The access manifest entries for Slack and the webhook are `allowed`, and their `expiresAt`
   dates are in the future. An expired terms review stops the plugin from loading.
5. The scheduler runs and has delivered recently. `/status.json` shows `db` and `api` as `ok`,
   and `worker` is not down.
6. A fresh backup exists and its `manifest.json` and `inputs.json` copy are next to it. Test the
   restore in a separate Compose project, as the self-hosting guide describes.
7. For Slack or the webhook, send the test event from the Slack section and confirm it arrived.

If a step fails, fix it before the update.
