# Signed webhook plugin

`@openplans/plugin-webhook` sends OpenPlans events to a URL you run, as signed JSON. It is a
durable subscriber: events go through the outbox, and `worker deliver-events` posts them and
retries failures.

## Setup

1. Pick the event types. Any subset of the catalog in
   [`plugins/sdk/src/events.ts`](../sdk/src/events.ts) works, for example `ingest.failed`,
   `readiness.failed` and `health.changed`.
2. Set three environment variables for the worker:

   | Variable                   | Secret | Value                                                     |
   | -------------------------- | ------ | --------------------------------------------------------- |
   | `OPENPLANS_WEBHOOK_HOST`   | no     | The receiver's host name, for example `hooks.example.org` |
   | `OPENPLANS_WEBHOOK_URL`    | yes    | The full `https://` URL, on that host                     |
   | `OPENPLANS_WEBHOOK_SECRET` | yes    | The HMAC key you share with the receiver, 32+ characters  |

   The worker reads `OPENPLANS_WEBHOOK_HOST` when it loads the plugin. The plugin declares that
   host as its only network host, and setup refuses a URL on any other host. The loader refuses the plugin when the
   host is not `allowed` in an admission manifest (step 4). Setup refuses a URL that is not
   HTTPS, names another host or carries a user name or password.

3. Add the plugin to the config file that `OPENPLANS_CONFIG` points at:

   ```json
   {
     "version": 1,
     "plugins": [
       {
         "package": "@openplans/plugin-webhook",
         "options": { "events": ["ingest.failed", "readiness.failed"] }
       }
     ]
   }
   ```

4. Admit the host in your operator manifest (`OPENPLANS_ACCESS_MANIFEST`). The loader and every
   post check that the entry is `allowed` and that its `terms` review has not expired. A post is
   a delivery to your own endpoint, not data collection, so it never fetches `/robots.txt` or the
   terms URL and is not paced. The `terms` fields record your own review of the receiver. The
   entry below is a template: put in your own host, paths, hash and dates.

   ```json
   {
     "version": 1,
     "publishers": [
       {
         "host": "hooks.example.org",
         "state": "allowed",
         "evidence": [
           {
             "url": "https://hooks.example.org/terms",
             "observedAt": "2026-11-11T00:00:00Z",
             "status": 200
           }
         ],
         "scope": { "products": ["events"], "states": ["TX"], "years": [2026] },
         "discoveryUrls": ["https://hooks.example.org/hooks/openplans"],
         "permittedPaths": ["/hooks/openplans"],
         "delegates": [],
         "attribution": "Operator-run event receiver",
         "updatePolicy": "Reviewed by the operator",
         "delayMs": 5000,
         "jobCaps": { "maxRequests": 1000, "maxTransferBytes": 16777216 },
         "terms": {
           "url": "https://hooks.example.org/terms",
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

## What the receiver gets

One `POST` per event:

| Header                  | Value                                                  |
| ----------------------- | ------------------------------------------------------ |
| `Content-Type`          | `application/json`                                     |
| `X-OpenPlans-Signature` | `sha256=` and the hex HMAC-SHA256 of the raw body      |
| `X-OpenPlans-Event-Id`  | The event `id`, the same value as in the body          |

The body is the event exactly as the outbox holds it, as compact JSON:

```json
{"id":"...","type":"ingest.failed","emittedAt":"...","emittedBy":"worker","idempotencyKey":"...","payload":{"sourceId":"...","command":["ingest","..."],"reasonCode":"..."}}
```

Payloads carry identifiers, counts, reason codes and timestamps only, as the catalog defines
them. The plugin adds nothing to them.

## Delivery rules

- Any status outside 2xx, a timeout or a refused request fails the attempt. The outbox retries
  with backoff of `min(2^attempts, 3600)` seconds plus jitter, up to 20 attempts.
- No redirect is followed. Answer at the configured URL itself.
- Each post has a 5 second deadline and one attempt. Posts are not paced, and `delayMs` in the
  manifest entry does not apply to them.
- A retry can repeat an event the receiver already accepted, for example when the answer was
  lost. Use `X-OpenPlans-Event-Id` or `idempotencyKey` to drop repeats.
- The plugin never logs the URL, the secret, the headers or the body. A failed attempt logs the
  event type, an error code and the HTTP status when there was one.

## Checking a signature

Compute HMAC-SHA256 over the raw request bytes, before any JSON parsing, and compare it in
constant time. Test vector:

- secret: `openplans-webhook-test-vector-secret`
- body:
  `{"id":"00000000-0000-4000-8000-000000000001","type":"readiness.failed","emittedAt":"2026-01-01T00:00:00.000Z","emittedBy":"worker","idempotencyKey":"test-vector-1","payload":{"check":"bootstrap.migrate","reasonCode":"exit_1"}}`
- header:
  `sha256=f520254edfab39c7a21486788f69e668a5b79215d096bf27a6f1cbc63a53d7b5`

```sh
printf '%s' '<body>' | openssl dgst -sha256 -hmac 'openplans-webhook-test-vector-secret'
```

A minimal Node receiver:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const secret = process.env.OPENPLANS_WEBHOOK_SECRET;
const seen = new Set();

createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks);
    const expected = Buffer.from(
      `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    );
    const received = Buffer.from(request.headers["x-openplans-signature"] ?? "");
    if (
      request.method !== "POST" ||
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      response.writeHead(401).end();
      return;
    }
    const id = request.headers["x-openplans-event-id"];
    if (!seen.has(id)) {
      seen.add(id);
      const event = JSON.parse(body.toString("utf8"));
      console.log(event.type, event.payload);
    }
    response.writeHead(204).end();
  });
}).listen(8080);
```

Run it behind your own HTTPS front end. The package also exports `signBody` and
`verifySignature` for receivers written in TypeScript.
