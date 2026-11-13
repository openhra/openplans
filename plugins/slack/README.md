# Slack plugin

`@openplans/plugin-slack` sends notifications to a Slack channel through an incoming webhook.
It is a durable subscriber: events go through the outbox, and `worker deliver-events` posts
them and retries failures.

## Events and messages

The plugin posts one short message for each of these events:

| Event                          | Severity                                 | Example message                                                                      |
| ------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `release.deployed`             | info                                     | `OpenPlans: Release 1.4.0 deployed. Previous version: 1.3.2.`                        |
| `ingest.failed`                | error                                    | `OpenPlans: Ingest failed for cms-puf: exit_1.`                                      |
| `readiness.failed`             | error                                    | `OpenPlans: Readiness check bootstrap.migrate failed: exit_1.`                       |
| `audit.failed`                 | error                                    | `OpenPlans: Audit step row_provenance failed: missing_rule.`                         |
| `passthrough.budget_exhausted` | warning                                  | `OpenPlans: Fallback budget used up for cms-marketplace-api: all 500 requests for today are spent.` |
| `passthrough.breaker_open`     | warning                                  | `OpenPlans: Fallback paused for cms-marketplace-api after failed calls, until 2026-11-11T01:00:00.000Z.` |
| `health.changed`               | info to `ok`, warning to `degraded`, error to `down` | `OpenPlans: Health of db changed from ok to degraded.`                   |

Other catalog events get no message and never reach the plugin. That includes
`release.rolled_back`, which was added to the catalog after these seven.

The API emits `passthrough.budget_exhausted` once per source and UTC day, when the pass-through core
refuses a call because that day's allowance is spent. A refusal for call spacing alone does not count.
It emits `passthrough.breaker_open` once per pause, when failed calls stop a source for a while.

Each message reads a fixed set of payload fields (`MESSAGE_FIELDS` in the source) and nothing
else. A value goes in only if it is a short code: letters, digits, `.`, `_`, `:` and `-`, up to
64 characters. Any other value shows as `[withheld]`. Messages never carry the image ID, the
command line, URLs or file paths.

## Rate limit

The plugin sends at most 20 messages a minute. When the limit is reached, it holds further
events back: the handler fails on purpose, so the outbox keeps the event and retries it. The
first retry after the minute is up sends one summary per event type, for example
`OpenPlans: The rate limit held back 30 more ingest failures.` The other held events of that
type then succeed without a message of their own, and the outbox marks them delivered. If the worker
restarts while events are held, the retries post them one by one, still within the limit.

## Setup

1. Create an incoming webhook for the channel in your Slack workspace and copy its URL.
2. Set the variables for the worker:

   | Variable                      | Secret | Value                                                         |
   | ----------------------------- | ------ | ------------------------------------------------------------- |
   | `OPENPLANS_SLACK_WEBHOOK_URL` | yes    | The incoming webhook URL                                      |
   | `OPENPLANS_SLACK_HOST`        | no     | The webhook's host name. Default: `hooks.slack.com`           |

   The worker reads `OPENPLANS_SLACK_HOST` when it loads the plugin. The plugin declares that
   host as its only network host. Setup refuses a URL that is not HTTPS, is on another host or
   carries a user name or password. The loader refuses the plugin when the host is not
   `allowed` in an admission manifest (step 4).

3. Add the plugin to the config file that `OPENPLANS_CONFIG` points at. Both options are
   optional: `events` is a subset of the seven events above (default: all seven), and
   `minSeverity` is `info`, `warning` or `error` (default: `info`). The plugin drops
   events below `minSeverity` without a message.

   ```json
   {
     "version": 1,
     "plugins": [
       {
         "package": "@openplans/plugin-slack",
         "options": {
           "events": ["ingest.failed", "readiness.failed", "health.changed"],
           "minSeverity": "warning"
         }
       }
     ]
   }
   ```

4. Admit the host in your operator manifest (`OPENPLANS_ACCESS_MANIFEST`). The loader and every
   post check that the entry is `allowed` and that its `terms` review has not expired. A post is
   a delivery to your own channel, not data collection, so it never fetches `/robots.txt` or the
   terms URL and is not paced. The `terms` fields record your own review of the service terms.
   The entry below is a template: put in your own terms URL, hash and dates.

   ```json
   {
     "version": 1,
     "publishers": [
       {
         "host": "hooks.slack.com",
         "state": "allowed",
         "evidence": [
           {
             "url": "<terms URL you reviewed>",
             "observedAt": "2026-11-11T00:00:00Z",
             "status": 200
           }
         ],
         "scope": { "products": ["events"], "states": ["TX"], "years": [2026] },
         "discoveryUrls": ["https://hooks.slack.com/services/"],
         "permittedPaths": ["/services/"],
         "delegates": [],
         "attribution": "Operator's Slack notifications",
         "updatePolicy": "Reviewed by the operator",
         "delayMs": 5000,
         "jobCaps": { "maxRequests": 1000, "maxTransferBytes": 16777216 },
         "terms": {
           "url": "<terms URL you reviewed>",
           "disposition": "allowed",
           "sha256": "<sha256 of the terms page body>",
           "reviewedAt": "2026-11-11T00:00:00Z",
           "expiresAt": "2027-11-11T00:00:00Z"
         }
       }
     ]
   }
   ```

5. Run `worker deliver-events` on a schedule (the core schedule runs it every minute through
   `worker schedule run`).

## Delivery rules

- Any status outside 2xx, a timeout or a refused request fails the attempt. The outbox retries
  with backoff of `min(2^attempts, 3600)` seconds plus jitter, up to 20 attempts.
- No redirect is followed.
- Each post has a 5 second deadline and one attempt. Posts are not paced, and `delayMs` in the
  manifest entry does not apply to them.
- A retry can repeat a message the channel already shows, for example when the answer was lost.
- The plugin never logs the webhook URL or the message body. A failed attempt logs the event
  type, an error code and the HTTP status when there was one.
