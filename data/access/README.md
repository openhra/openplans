# Shipped publisher manifests

`federal-publishers.json` is the access manifest OpenPlans ships, in the format described in
[the fetch guide](../../src/fetch/README.md). It clears the federal public-domain hosts that
`worker bootstrap` needs on a new installation and records the hosts OpenPlans holds, with the
reason. Collection still reads each host's robots.txt and checks its terms hash before every
transfer, so a robots `Disallow` or a changed terms document stops collection even though the
manifest clears the host.

| Host | State | Used for | Pacing | Per-session caps |
| --- | --- | --- | --- | --- |
| www.cms.gov | allowed | PUF and state-based PUF landing pages, state rating-area pages, PY2026 state-based PUF archives | 10 s | 20 requests, 256 MiB |
| download.cms.gov | allowed | Exchange PUFs PY2026 and PY2027, NPPES files | 5 s | 20 requests, 2 GiB |
| www2.census.gov | allowed | ZCTA to county relationship file, ZCTA Gazetteer | 30 s | 10 requests, 64 MiB |
| geocoding.geo.census.gov | allowed | Census batch geocoder (POST uploads) | 5 s | 10 requests, 32 MiB |
| download.nlm.nih.gov | robots-disallowed | RxNorm Current Prescribable Content | none | none |
| www.nlm.nih.gov | robots-disallowed | RxNorm files page (its files are on the host above) | none | none |
| download.geonames.org | robots-disallowed | GeoNames postal codes | none | none |
| tigerweb.geo.census.gov | bot-protected | County bounds for geocoding | none | none |
| www.nucc.org | terms-restricted | NUCC taxonomy, which needs the operator's own terms review | none | none |

Every cleared entry lists exact permitted paths. The NPPES file names change with each release,
so `/nppes/` is the one directory entry. Each terms entry names its reviewer and quotes the
publisher text it relies on. download.cms.gov and geocoding.geo.census.gov answer robots.txt with
a direct 404, which means no robots rules; the manifest records the country that was observed
from. Receipts record the collecting installation's `OPENPLANS_EGRESS_COUNTRY`, which does not
restrict collection.

## Review cadence

The OpenPlans maintainers re-review every entry before each release. `node
scripts/check-publisher-review.mjs` runs in `scripts/ci.sh` and fails when:

- any terms review, robots check or evidence observation predates the previous release
  (`review-policy.json`, `previousRelease`);
- any of them is more than 90 days old (`maxAgeDays`);
- a cleared host lacks its reviewer, a quoted terms basis, pacing of at least 5 s, per-session caps
  or permitted paths, or its terms review has expired.

90 days is about one quarter, which is longer than the usual time between releases. A stale
manifest therefore blocks CI before it blocks a release. Each terms review sets `expiresAt` 180
days after review, so an installation running an older release keeps working through about two
review cycles. After that its shipped clearance lapses and collection stops with a message saying
the terms review expired.

To re-review:

1. Fetch each host's robots.txt and each terms document with the OpenPlans user agent. Note the
   HTTP status, content type and SHA-256 of each.
2. Read the terms again for the intended use. Update `basis` with the quoted text, and `sha256`,
   `reviewedAt`, `expiresAt` and the evidence `observedAt` values.
3. For held hosts, confirm the hold still applies, for example that robots still disallows `/`,
   and update the evidence. Clear a host only after a new review.
4. After tagging a release, set `previousRelease` in `review-policy.json` to that tag and its
   publication time.
5. Run `node scripts/check-publisher-review.mjs` and the fetch tests.
