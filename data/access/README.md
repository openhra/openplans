# Shipped publisher manifests

`federal-publishers.json` is the access manifest OpenPlans ships, in the format described in
[the fetch guide](../../src/fetch/README.md). It clears the federal public-domain hosts that
`worker bootstrap` needs on a new installation and records the hosts OpenPlans holds, with the
reason. Collection still reads each host's robots.txt and checks its terms hash before every
transfer, so a robots `Disallow` or a changed terms document stops collection even though the
manifest clears the host.

| Host | State | Used for | Pacing | Per-session caps |
| --- | --- | --- | --- | --- |
| www.cms.gov | allowed | PUF and state-based PUF landing pages, state rating-area pages, PY2026 state-based PUF archives, the loaded CY2026 and CY2027 Medicare plan archives and their listing pages | 10 s | 20 requests, 256 MiB |
| download.cms.gov | allowed | Exchange PUFs PY2025, PY2026 and PY2027, NPPES files | 5 s | 20 requests, 2 GiB |
| data.cms.gov | allowed | Part D formulary, pharmacy network and pricing files: the loaded CY2026 quarterly and CY2027 monthly archives and their dataset listings | 10 s | 10 requests, 256 MiB |
| www2.census.gov | allowed | ZCTA to county relationship file, ZCTA Gazetteer, county outlines (2024 cartographic boundary file) | 30 s | 10 requests, 64 MiB |
| geocoding.geo.census.gov | allowed | Census batch geocoder (POST uploads) | 5 s | 10 requests, 32 MiB |
| download.nlm.nih.gov | robots-disallowed | RxNorm Current Prescribable Content | none | none |
| www.nlm.nih.gov | robots-disallowed | RxNorm files page (its files are on the host above) | none | none |
| rxnav.nlm.nih.gov | allowed, used only with `OPENPLANS_RXNAV_IDENTITY=on` | RxNorm API identity lookups for single RxCUIs (properties, history status), drug names and the API version | 5 s | 5,000 requests, 32 MiB |
| download.geonames.org | robots-disallowed | GeoNames postal codes | none | none |
| tigerweb.geo.census.gov | bot-protected | Formerly county bounds for geocoding; now read from the www2.census.gov boundary file | none | none |
| marketplace.api.healthcare.gov | allowed, keyed API (`cms-marketplace-api.json`, loaded only with `OPENPLANS_CMS_FALLBACK=on` and `CMS_API_KEY`) | per-question coverage lookups | 1 s | 600 requests, 64 MiB |
| www.nucc.org | terms-restricted | NUCC taxonomy, which needs the operator's own terms review | none | none |

Every cleared entry lists exact permitted paths. The NPPES file names change with each release,
so `/nppes/` is the one directory entry. A host has one entry, so the Medicare paths on www.cms.gov
share the Exchange PUF disclaimer as the pinned terms document; their basis adds the CMS.gov
public-domain statement. The data.cms.gov entry rests on the 2023 Agreement for Use. Its 256 MiB
cap is enough to check freshness but not to download the 2 GB Part D archives, so collecting those
still takes an operator manifest. Each terms entry names its reviewer and quotes the
publisher text it relies on. download.cms.gov, geocoding.geo.census.gov and rxnav.nlm.nih.gov
answer robots.txt with a direct 404, which means no robots rules; the manifest records the country
that was observed from. The rxnav.nlm.nih.gov terms page lives on www.lhncbc.nlm.nih.gov, whose
robots file allows it. Receipts record the collecting installation's `OPENPLANS_EGRESS_COUNTRY`, which does not
restrict collection.

## Site approvals

`site-approvals.json` is the registry of per-site approval slugs: for each issuer, its hosts, the
slug and what the approval turns on. No shipped manifest carries entries for those hosts yet; an
operator manifest supplies them with the `approval: { kind: "owner-env", env }` field described
in [the self-hosting guide](../../docs/self-host.md#sites-that-need-your-approval). The registry
keeps the slugs stable. `check-publisher-review` does not read it.

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
