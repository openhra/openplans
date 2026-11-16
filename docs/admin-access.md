# Private admin access

The optional `@openplans/plugin-admin` package is disabled unless installed and explicitly
configured. Keep it disabled on the public instance. Browser sign-in uses the existing operator
credential, entered only in a password form over HTTPS. Existing bearer clients still work.

Before enabling browser access, set `admin.origin` to the private HTTPS origin, set
`admin.ingressReviewed` to true after reviewing ingress, and keep `admin.instances` at one:

```json
{
  "version": 1,
  "admin": {
    "origin": "https://admin.private.test",
    "ingressReviewed": true,
    "instances": 1
  },
  "trustProxy": ["127.0.0.1"],
  "plugins": [{ "package": "@openplans/plugin-admin", "enabled": true }]
}
```

This example hostname is a placeholder. Use the installation's private HTTPS origin without a
trailing slash or path. Bind the API to loopback and reach it locally, through a VPN or through
an SSH tunnel to the reviewed TLS terminator. HTTPS is required even on loopback. The operator
credential remains in `OPENPLANS_OPERATOR_TOKEN`, outside the configuration file.

A TLS terminator must preserve the private Host and set exactly one `X-Forwarded-Proto: https`
and `X-Forwarded-Host` matching the configured origin. Forwarded headers are accepted only from
an exact address in `trustProxy`. The terminator must replace incoming forwarded headers.
Forwarded chains and the alternate `Forwarded` header are refused. Direct HTTPS also works.
A matching Host alone grants no access. The ingress review flag records the operator's explicit
configuration decision; the application cannot verify the surrounding network.

Allow `/admin` and its descendants only on that private ingress. Public ingress must return
404 for them and for operator endpoints. This package does not edit ingress or enable itself.
Ingress exclusion needs its own deployment checks before use.

Open `/admin/login`. The page contains no installation inventory. It uses an expiring one-use
nonce and an exact Origin check. Sign-in redirects to `/admin`. The overview provides ordinary
forms for sign-out and recent authentication; JavaScript is unnecessary. Redirect destinations
are fixed. Return URLs and extra sign-in fields are refused.

Sessions live only in the API process, with a maximum of 256 sessions and 512 pre-login nonces.
Only ID digests and authorization timestamps are retained. Login attempts have independent
bounded source and installation limits. Excess allocation is refused. The session cookie is
`__Secure-openplans_admin`, HttpOnly, Secure, SameSite=Strict, host-only, and scoped to `/admin`.
The credential is never put in a cookie, URL or browser storage.

Sessions expire after 30 idle minutes or eight hours total. Recent authentication rotates the
ID and CSRF token without extending the eight-hour limit. Sign-out revokes the current session.
Restart signs everyone out. Removal or rotation of the resolved credential, or removal of admin
routes, revokes session authority on the next request. Apply startup configuration changes by
restarting the process. Draft persistence is outside this slice.

Browser sessions support exactly one serving API instance. A configured replica count above
one refuses application startup while browser access is configured. Do not add replicas or use
sticky routing. A shared revocable session store must come first.

Every cookie-authenticated POST requires its session's CSRF token and the exact Origin before
the handler runs. Admin POSTs cannot substitute bearer authentication for CSRF. Cookies do not
authorize status operator endpoints, public APIs, MCP or other plugins. With browser access
unconfigured, the overview retains bearer access and session endpoints return 404.

Admin responses, failures and redirects use `no-store`, `nosniff`, no-referrer and a fixed CSP
that permits same-origin forms and inline styles but no scripts, frames or remote resources.
Requests are bounded to 64 KiB, HTML and JSON responses to 1 MiB, and requests to 15 seconds.
Admin routes bypass the shared response cache by route identity. Existing status and default
HTML policies are unchanged.
