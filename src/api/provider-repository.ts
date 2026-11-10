import { searchOperatorPoints } from "../ingest/geocode/operator-store.js";
import type { SqlSession } from "../db/database.js";
import {
  classifyProviderEvidence,
  providerSpecialties,
} from "../domain/providers/index.js";
import type { ProviderEvidence } from "../domain/providers/index.js";
import { providerAvailability } from "../domain/providers/availability.js";

export interface ProviderSearch {
  plan?: string;
  year?: number;
  taxonomy?: string;
  specialty?: string;
  name?: string;
  type?: "INDIVIDUAL" | "FACILITY" | "GROUP";
  page: number;
  origin?: {
    latitude: number;
    longitude: number;
    method: string;
    snapshot_id?: string;
  };
  radius?: number;
}
interface SearchRow extends Record<string, unknown> {
  record_id: string;
  snapshot_id: string;
  npi: string | null;
  type: string;
  addresses: Record<string, unknown>[];
  evidence: ProviderEvidence[];
  distance_miles: number | null;
}
// Match JavaScript trim/whitespace normalization in the compatibility mapper.
const whitespace =
  "[\\u0009-\\u000d \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";
const wireKey = (alias: string) =>
  `ARRAY[${["line_1", "line_2", "city", "state", "zip5"]
    .map(
      (field) =>
        `upper(btrim(regexp_replace(coalesce(${alias}.${field},''),U&'${whitespace.replaceAll("\\u", "\\")}+',' ','g')) COLLATE "und-x-icu")`,
    )
    .join(",")}]`;

// The optional name dataset may be empty or absent on a code-only installation.
export async function taxonomyRelation(db: SqlSession): Promise<string> {
  const exists = (
    await db.query(
      `SELECT to_regclass('provider_taxonomy') IS NOT NULL AS present`,
    )
  ).rows[0]?.present;
  return exists
    ? "provider_taxonomy"
    : `(SELECT NULL::text AS code,NULL::text AS display_name,
    NULL::text AS classification,NULL::text AS specialization WHERE false)`;
}

export async function taxonomyLoaded(db: SqlSession): Promise<boolean> {
  const relation = await taxonomyRelation(db);
  return (
    (await db.query(`SELECT 1 FROM ${relation} taxonomy LIMIT 1`)).rows.length >
    0
  );
}

export interface ProviderLocationPage {
  offset: number;
  size: number;
  reverse?: boolean;
}

/** Plan searches use issuer records. Identity addresses never establish plan membership. */
export const searchProviders = (db: SqlSession, q: ProviderSearch) =>
  readProviders(db, q);

/** Compatibility counts normalized locations and needs only the missing-address flag. */
export async function searchProviderLocations(
  db: SqlSession,
  q: ProviderSearch,
  page: ProviderLocationPage,
) {
  const result = await readProviders(db, q, page);
  return {
    providers: result.providers,
    total: result.location_total!,
    unlocated: result.meta.unlocated > 0,
    approximate: Boolean(result.location_approximate),
    taxonomy_unknown: Boolean(result.location_taxonomy_unknown),
  };
}

async function readProviders(
  db: SqlSession,
  q: ProviderSearch,
  locationPage?: ProviderLocationPage,
) {
  if (locationPage && (q.plan || !q.origin || q.radius === undefined))
    throw new Error("Location paging requires an identity radius search");
  const taxonomy = await taxonomyRelation(db);
  const operatorPoints = await searchOperatorPoints(db);
  const pointsRelation = operatorPoints.length
    ? "effective_points"
    : "address_point";
  const issuer = Boolean(q.plan),
    source = issuer ? "qhp_provider_address" : "npi_address";
  const postgis =
    q.origin &&
    (
      await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='address_point' AND column_name='point'`)
    ).rows.length > 0;
  const spatialRadius = Boolean(postgis && q.radius !== undefined);
  const parameters: unknown[] = [
    q.plan ?? null,
    q.year ?? null,
    q.taxonomy ?? null,
    q.specialty ?? null,
    q.name ?? null,
    q.type ?? null,
  ];
  // A literal word cannot cross concat_ws's space separator. Use it as a coarse
  // name filter before fetching NPPES identities, then retain the exact full filter.
  const recordFilter = Boolean(q.taxonomy || q.specialty || q.name || q.type);
  const namePrefilter = issuer && q.name && !/[%_\\]/.test(q.name);
  const nameTerm = `(SELECT term FROM regexp_split_to_table($5::text,'[[:space:]]+')
    WITH ORDINALITY words(term,ordinal) ORDER BY length(term) DESC,ordinal LIMIT 1)`;
  // Shorter indexable qualifiers can distinguish multiword organizations after
  // their longest token. This only chooses a lossless coarse refinement.
  const otherTerm = `(SELECT term FROM regexp_split_to_table($5::text,'[[:space:]]+')
    WITH ORDINALITY words(term,ordinal) WHERE length(term)>=4 AND term<>${nameTerm}
    ORDER BY length(term),ordinal LIMIT 1)`;
  const recordLookup = `FROM (SELECT snapshot_id,array_agg(record_id) AS record_ids
    FROM plan_records GROUP BY snapshot_id) keys JOIN LATERAL (SELECT * FROM qhp_provider_record r
    WHERE r.snapshot_id=keys.snapshot_id AND r.record_id=ANY(keys.record_ids) OFFSET 0) r ON true`;
  // A single trigram is too broad for common three-letter names; scan the plan keys instead.
  const indexedName =
    namePrefilter &&
    Math.max(...q.name!.split(/\s+/).map((word) => [...word].length)) >= 4;
  const recordNameTokens = `(ARRAY['snapshot:'||r.snapshot_id] || provider_search_trigrams(
    coalesce(r.name::text,'')||' '||coalesce(r.facility_name,'')||' '||coalesce(r.group_name,'')))`;
  const refineName = indexedName && q.name!.trim().split(/\s+/).length > 1;
  const recordNames = (
    term: string,
  ) => `SELECT r.snapshot_id,r.record_id,r.npi FROM qhp_provider_record r
    WHERE ${recordNameTokens} @> provider_search_trigrams(${term})
      AND ${recordNameTokens} && ARRAY(SELECT 'snapshot:'||snapshot_id FROM active_shards)`;
  const identityNames = (
    term: string,
    withIndex: boolean,
  ) => `SELECT npi FROM npi_provider WHERE
    ${
      withIndex
        ? `provider_search_trigrams(coalesce(organization_name,'')||' '||coalesce(first_name,'')||' '||coalesce(last_name,''))
      @> provider_search_trigrams(${term}) AND`
        : ""
    }
    concat_ws(' ',organization_name,first_name,last_name) ILIKE '%'||${term}||'%'`;
  // Materialize name keys before checking plan scope. Selective names should not
  // require reading every plan key or probing identities outside current shards.
  // A single shard uses batched shard-first keys; multiple shards use NPI-first
  // probes to avoid a shard x name product. Above 2,000 coarse keys, another
  // literal word narrows issuer-or-identity matches; remaining broad sets use a
  // hashed plan intersection. These cutoffs choose work, never limit results.
  // All candidate paths require a positive plan edge before expanding record data;
  // the page-only evidence JSON still retains negative/conflicting ordinals.
  const membership = issuer
    ? `active_shards AS MATERIALIZED (
    SELECT s.*,snap.final_url AS source_url,snap.retrieved_at,snap.publisher_updated_at FROM provider_active_set a JOIN provider_shard s ON s.source_set_id=a.snapshot_id
    JOIN snapshot snap ON snap.snapshot_id=s.snapshot_id AND snap.validation_state='ACTIVE'
    WHERE a.issuer_id=left($1,5) AND a.state=substring($1,6,2) AND a.plan_year=$2
  ), plan_groups AS MATERIALIZED (
    SELECT group_id,source_plan_index FROM provider_plan_group_edge WHERE base_hios_id=$1 AND plan_year=$2
      AND evidence_status='listed_participating'
  ), plan_records AS MATERIALIZED (
    SELECT e.snapshot_id,e.record_id FROM qhp_provider_plan_legacy e JOIN active_shards s USING(snapshot_id)
    WHERE e.base_hios_id=$1 AND e.plan_year=$2 AND e.evidence_status='listed_participating'
    UNION ALL
    SELECT l.snapshot_id,l.record_id FROM plan_groups e JOIN provider_record_plan_group l USING(group_id)
    JOIN active_shards s ON s.snapshot_id=l.snapshot_id
    WHERE NOT EXISTS (SELECT 1 FROM provider_plan_override x WHERE x.snapshot_id=l.snapshot_id
      AND x.record_id=l.record_id AND x.source_plan_index=e.source_plan_index)
      AND NOT EXISTS (SELECT 1 FROM provider_plan_suppressed x WHERE x.snapshot_id=l.snapshot_id
        AND x.record_id=l.record_id AND x.source_plan_index=e.source_plan_index)
  ), ${
    namePrefilter
      ? `matching_names AS MATERIALIZED (
    ${identityNames(nameTerm, Boolean(indexedName))}
  ), ${
    indexedName
      ? `record_names AS MATERIALIZED (
    ${recordNames(nameTerm)}
  ), identity_record_names AS MATERIALIZED (
    SELECT r.snapshot_id,r.record_id,r.npi FROM active_shards s JOIN LATERAL (
      SELECT r.snapshot_id,r.record_id,r.npi FROM qhp_provider_record r WHERE r.snapshot_id=s.snapshot_id
        AND r.npi=ANY(ARRAY(SELECT npi FROM matching_names ORDER BY npi)) OFFSET 0) r ON true
    WHERE (SELECT count(*) FROM active_shards)=1
    UNION ALL
    SELECT r.snapshot_id,r.record_id,r.npi FROM matching_names n JOIN LATERAL (
      SELECT r.snapshot_id,r.record_id,r.npi FROM qhp_provider_record r WHERE r.npi=n.npi OFFSET 0) r ON true
    WHERE (SELECT count(*) FROM active_shards)>1
      AND r.snapshot_id=ANY(ARRAY(SELECT snapshot_id FROM active_shards))
  ), coarse_names AS MATERIALIZED (
    SELECT * FROM record_names UNION SELECT * FROM identity_record_names
  ), ${
    refineName
      ? `other_record_names AS MATERIALIZED (${recordNames(otherTerm)}),
    other_identity_names AS MATERIALIZED (
      SELECT npi FROM npi_provider WHERE npi=ANY(ARRAY(SELECT DISTINCT npi FROM coarse_names ORDER BY npi))
        AND concat_ws(' ',organization_name,first_name,last_name) ILIKE '%'||${otherTerm}||'%'
    ), `
      : ""
  }qualified_names AS MATERIALIZED (
    SELECT r.* FROM coarse_names r ${
      refineName
        ? `WHERE CASE WHEN (SELECT count(*) FROM coarse_names)>2000
      AND length(${otherTerm})>=4 THEN
        (r.snapshot_id,r.record_id) IN (SELECT snapshot_id,record_id FROM other_record_names)
        OR r.npi IN (SELECT npi FROM other_identity_names) ELSE true END`
        : ""
    }
  ), `
      : ""
  }name_candidates AS MATERIALIZED (
    ${
      indexedName
        ? `SELECT r.snapshot_id,r.record_id FROM qualified_names r
      WHERE CASE WHEN (SELECT count(*) FROM qualified_names)<=2000 THEN
        EXISTS (SELECT 1 FROM qhp_provider_plan e WHERE e.snapshot_id=r.snapshot_id AND e.record_id=r.record_id
          AND e.base_hios_id=$1 AND e.plan_year=$2 AND e.evidence_status='listed_participating' OFFSET 0)
      ELSE (r.snapshot_id,r.record_id) IN (SELECT snapshot_id,record_id FROM plan_records) END`
        : `SELECT r.snapshot_id,r.record_id ${recordLookup}
        WHERE concat_ws(' ',r.name::text,r.facility_name,r.group_name) ILIKE '%'||${nameTerm}||'%'
          OR r.npi IN (SELECT npi FROM matching_names)`
    }
  ), `
      : ""
  }`
    : "";
  const identityPredicate = `n.in_scope
      AND $1::text IS NULL AND $2::integer IS NULL
      AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM npi_taxonomy t WHERE t.npi=n.npi AND t.code=$3))
      AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM npi_taxonomy t LEFT JOIN ${taxonomy} nt ON nt.code=t.code
        WHERE t.npi=n.npi AND (t.code ILIKE '%'||$4||'%' OR nt.display_name ILIKE '%'||$4||'%'
          OR nt.classification ILIKE '%'||$4||'%' OR nt.specialization ILIKE '%'||$4||'%')))
      AND ($5::text IS NULL OR concat_ws(' ',n.organization_name,n.first_name,n.last_name) ILIKE '%'||$5||'%')
      AND ($6::text IS NULL OR CASE WHEN n.entity_type='1' THEN 'INDIVIDUAL' ELSE 'GROUP' END=$6)`;
  let selected;
  if (issuer) {
    if (recordFilter) {
      selected = `SELECT r.snapshot_id,r.record_id
    ${
      namePrefilter
        ? `FROM name_candidates keys JOIN LATERAL (SELECT * FROM qhp_provider_record r
      WHERE r.snapshot_id=keys.snapshot_id AND r.record_id=keys.record_id OFFSET 0) r ON true`
        : recordLookup
    }
    ${q.name ? "LEFT JOIN LATERAL (SELECT n.* FROM npi_provider n WHERE n.npi=r.npi OFFSET 0) n ON true" : ""}
    WHERE ($3::text IS NULL OR EXISTS (SELECT 1 FROM npi_taxonomy t WHERE t.npi=r.npi AND t.code=$3))
      AND ($4::text IS NULL OR coalesce(r.speciality,r.specialty)::text ILIKE '%'||$4||'%'
        OR EXISTS (SELECT 1 FROM npi_taxonomy t LEFT JOIN ${taxonomy} nt ON nt.code=t.code
          WHERE t.npi=r.npi AND (nt.display_name ILIKE '%'||$4||'%' OR nt.classification ILIKE '%'||$4||'%'
            OR nt.specialization ILIKE '%'||$4||'%')))
      ${q.name ? `AND concat_ws(' ',r.name::text,r.facility_name,r.group_name,n.organization_name,n.first_name,n.last_name) ILIKE '%'||$5||'%'` : "AND $5::text IS NULL"}
      AND ($6::text IS NULL OR r.type=$6)`;
    } else {
      selected =
        "SELECT DISTINCT snapshot_id,record_id FROM plan_records WHERE $3::text IS NULL AND $4::text IS NULL AND $5::text IS NULL AND $6::text IS NULL";
    }
  } else if (spatialRadius && !q.name && !q.type) {
    selected = `SELECT keys.record_id,NULL::text AS snapshot_id
      FROM (SELECT DISTINCT record_id FROM radius_locations) keys
      WHERE $1::text IS NULL AND $2::integer IS NULL AND $5::text IS NULL AND $6::text IS NULL
        AND NOT EXISTS (SELECT 1 FROM npi_provider n WHERE NOT n.in_scope AND n.npi=keys.record_id)
        AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM npi_taxonomy t WHERE t.npi=keys.record_id AND t.code=$3))
        AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM npi_taxonomy t LEFT JOIN ${taxonomy} nt ON nt.code=t.code
          WHERE t.npi=keys.record_id AND (t.code ILIKE '%'||$4||'%' OR nt.display_name ILIKE '%'||$4||'%'
            OR nt.classification ILIKE '%'||$4||'%' OR nt.specialization ILIKE '%'||$4||'%'))) `;
  } else {
    selected = `SELECT n.npi AS record_id,n.snapshot_id FROM ${
      spatialRadius
        ? `(SELECT DISTINCT record_id FROM radius_locations ORDER BY record_id) keys
      JOIN LATERAL (SELECT n.npi,n.snapshot_id FROM npi_provider n WHERE n.npi=keys.record_id
        AND ${identityPredicate} OFFSET 0) n ON true`
        : "npi_provider n"
    }
      WHERE ${spatialRadius ? "true" : identityPredicate}`;
  }
  const batchLocations = issuer && spatialRadius && !recordFilter;
  const location = issuer
    ? `SELECT a.record_id,a.snapshot_id,a.address_index
      ${batchLocations ? "" : ",a.snapshot_id||':'||a.record_id||':'||a.address_index::text AS source_row"}
    ${
      batchLocations
        ? `FROM (SELECT a.* FROM active_shards s JOIN LATERAL (
      SELECT a.record_id,a.snapshot_id,a.address_index FROM qhp_provider_address a
      WHERE a.snapshot_id=s.snapshot_id OFFSET 0) a ON true OFFSET 0) a
      WHERE EXISTS (SELECT 1 FROM selected r WHERE r.snapshot_id=a.snapshot_id AND r.record_id=a.record_id)`
        : "FROM qhp_provider_address a JOIN selected r USING(record_id,snapshot_id)"
    }`
    : `SELECT a.npi AS record_id,a.snapshot_id,a.ordinal AS address_index,a.line_1,a.line_2,a.city,a.state,a.zip5 AS zip,
      a.phone,a.npi||':'||a.kind||':'||a.ordinal::text AS source_row
    FROM npi_address a JOIN selected r ON r.record_id=a.npi WHERE a.kind='practice'`;
  const pointFields = `p.normalization,p.latitude,p.longitude,p.method,p.match_status,p.match_quality,p.snapshot_id AS point_snapshot_id,
      p.centroid_snapshot_id,p.geocoded_at`;
  // Keep the spatial scan behind a materialization boundary. Match the full source
  // key AND its snapshot, so obsolete geocodes cannot lend a current address a point.
  // Validate identity keys here; fetch address text only for the final page.
  const radiusProjection = `p.normalization,p.source_snapshot_id,p.source_row,p.latitude,p.longitude,p.method,
    p.match_status,p.match_quality,p.snapshot_id,p.centroid_snapshot_id,p.geocoded_at`;
  const radiusLocations = spatialRadius
    ? `radius_points AS MATERIALIZED (
    ${
      issuer
        ? `SELECT p.* FROM active_shards s JOIN LATERAL (
      SELECT ${radiusProjection} FROM ${pointsRelation} p WHERE p.source_table='${source}'
        AND p.source_snapshot_id=s.snapshot_id
        AND ST_DWithin(p.point,ST_SetSRID(ST_MakePoint($8,$7),4326)::geography,$9*1609.344,false) OFFSET 0) p ON true`
        : `SELECT ${radiusProjection} FROM ${pointsRelation} p WHERE p.source_table='${source}'
        AND ST_DWithin(p.point,ST_SetSRID(ST_MakePoint($8,$7),4326)::geography,$9*1609.344,false)`
    }
  ), radius_locations AS MATERIALIZED (
    SELECT ${issuer ? "a.record_id,a.snapshot_id,a.address_index" : "a.npi AS record_id,a.snapshot_id,a.ordinal AS address_index"},p.source_row,${pointFields}
    FROM (SELECT * FROM radius_points ORDER BY ${issuer ? "source_snapshot_id,source_row" : "source_row,source_snapshot_id"}) p ${
      issuer
        ? `JOIN selected r ON r.snapshot_id=p.source_snapshot_id
      AND r.record_id=regexp_replace(substring(p.source_row FROM length(p.source_snapshot_id)+2),':[^:]*$','')`
        : ""
    }
    JOIN LATERAL (SELECT ${issuer ? "*" : "a.npi,a.snapshot_id,a.ordinal"} FROM ${source} a WHERE
      ${
        issuer
          ? `a.snapshot_id=p.source_snapshot_id
        AND a.record_id=regexp_replace(substring(p.source_row FROM length(p.source_snapshot_id)+2),':[^:]*$','')
        AND a.address_index=CASE WHEN substring(p.source_row FROM '[^:]*$') ~ '^[0-9]{1,10}$'
          THEN substring(p.source_row FROM '[^:]*$')::bigint END
        AND a.snapshot_id||':'||a.record_id||':'||a.address_index::text=p.source_row`
          : `a.kind='practice' AND a.npi=split_part(p.source_row,':',1)
        AND a.ordinal=CASE WHEN split_part(p.source_row,':',3) ~ '^[0-9]{1,10}$'
          THEN split_part(p.source_row,':',3)::bigint END
        AND a.npi||':practice:'||a.ordinal::text=p.source_row AND a.snapshot_id=p.source_snapshot_id`
      } OFFSET 0) a ON true
  ), `
    : "";
  // Each candidate address has one source key. Count matching distinct keys per
  // shard, so repeated geocodes cannot reduce the exact missing-address count.
  const countPoints = issuer && (!q.origin || (spatialRadius && !recordFilter));
  let currentPoints;
  if (batchLocations) {
    currentPoints = `current_points AS MATERIALIZED (
    SELECT p.source_snapshot_id,p.record_id,p.address_index FROM active_shards s JOIN LATERAL (
      SELECT p.source_snapshot_id,p.source_row,
        substring(p.source_row FROM length(p.source_snapshot_id)+2 FOR greatest(0,
          length(p.source_row)-length(p.source_snapshot_id)-length(split_part(p.source_row,':',-1))-2)) AS record_id,
        CASE WHEN split_part(p.source_row,':',-1) ~ '^[0-9]{1,10}$'
          THEN split_part(p.source_row,':',-1)::bigint END AS address_index
      FROM ${pointsRelation} p WHERE p.source_table='qhp_provider_address'
        AND p.source_snapshot_id=s.snapshot_id OFFSET 0
    ) p ON true WHERE p.source_row=p.source_snapshot_id||':'||p.record_id||':'||p.address_index::text
  ), `;
  } else if (countPoints) {
    currentPoints = `current_point_counts AS MATERIALIZED (
    SELECT count(DISTINCT p.source_row)::int AS located FROM (SELECT snapshot_id,
      array_agg(${batchLocations ? "snapshot_id||':'||record_id||':'||address_index::text" : "source_row"}) AS source_rows
      FROM locations GROUP BY snapshot_id) s JOIN LATERAL (
      SELECT p.source_snapshot_id,p.source_row FROM ${pointsRelation} p
      WHERE p.source_table='qhp_provider_address' AND p.source_snapshot_id=s.snapshot_id
        AND p.source_row=ANY(s.source_rows) OFFSET 0
    ) p ON true GROUP BY s.snapshot_id
  ), `;
  } else {
    currentPoints = "";
  }
  const pageLocations = issuer && !q.origin;
  const pageKeys = pageLocations
    ? `page_keys AS MATERIALIZED (
    SELECT record_id,snapshot_id FROM selected ORDER BY record_id,snapshot_id LIMIT 50 OFFSET ${(q.page - 1) * 50}
  ), `
    : "";
  const selectedCte = `selected AS MATERIALIZED (${selected}), `;
  const identityCandidates =
    !issuer && (spatialRadius || locationPage)
      ? `identity_candidates AS NOT MATERIALIZED (
    SELECT n.npi FROM npi_provider n WHERE ${identityPredicate}
  ), `
      : "";
  function unfilteredLocationJoin() {
    if (issuer) {
      return "";
    } else if (!recordFilter) {
      return `WHERE $1::text IS NULL AND $2::integer IS NULL
      AND NOT EXISTS (SELECT 1 FROM npi_provider n WHERE NOT n.in_scope AND n.npi=a.record_id)`;
    } else {
      return "JOIN selected r ON a.record_id=r.record_id";
    }
  }
  const ctes = `WITH ${identityCandidates}${membership}${issuer ? selectedCte + pageKeys + radiusLocations : radiusLocations + selectedCte}locations AS MATERIALIZED (${location}), ${currentPoints}located AS (
    ${
      spatialRadius
        ? `SELECT a.* FROM radius_locations a ${unfilteredLocationJoin()}`
        : `SELECT a.*,${pointFields} FROM locations a ${pageLocations ? "JOIN page_keys keys USING(record_id,snapshot_id)" : ""} LEFT JOIN ${pointsRelation} p
      ON p.source_table='${source}' AND p.source_row=a.source_row AND p.source_snapshot_id=a.snapshot_id`
    })`;
  // Missing-point counts do not need coordinate heaps or the radius. Use an anti
  // join independently of the spatial candidates; the count remains exact.
  let unlocated;
  if (batchLocations) {
    unlocated = `(SELECT count(*)::int FROM locations a WHERE NOT EXISTS (SELECT 1 FROM current_points p WHERE p.source_snapshot_id=a.snapshot_id AND p.record_id=a.record_id AND p.address_index=a.address_index))`;
  } else if (countPoints) {
    unlocated = `(SELECT count(*)::int FROM locations)-(SELECT coalesce(sum(located),0)::int FROM current_point_counts)`;
  } else if (spatialRadius) {
    if (issuer) {
      unlocated = `(SELECT count(*)::int FROM locations a WHERE NOT EXISTS (
    SELECT 1 FROM ${pointsRelation} p WHERE p.source_table='${source}'
      AND p.source_row=a.source_row AND p.source_snapshot_id=a.snapshot_id))`;
    } else {
      unlocated = `(SELECT count(*)::int FROM (SELECT npi,snapshot_id,ordinal::text AS address_index FROM npi_address WHERE kind='practice'
        ORDER BY npi,snapshot_id,ordinal::text OFFSET 0) a ${recordFilter ? "JOIN identity_candidates n ON n.npi=a.npi" : ""}
      WHERE true ${recordFilter ? "" : "AND NOT EXISTS (SELECT 1 FROM npi_provider n WHERE NOT n.in_scope AND n.npi=a.npi)"} AND NOT EXISTS (
        SELECT 1 FROM ${pointsRelation} p WHERE p.source_table='npi_address'
          AND p.source_row=split_part(p.source_row,':',1)||':practice:'||split_part(p.source_row,':',3)
          AND split_part(p.source_row,':',1)=a.npi AND split_part(p.source_row,':',3)=a.address_index
          AND p.source_snapshot_id=a.snapshot_id))`;
    }
  } else {
    unlocated = "(SELECT count(*)::int FROM located WHERE latitude IS NULL)";
  }
  let distance = "NULL::float8",
    radiusFilter = "";
  if (q.origin) {
    parameters.push(q.origin.latitude, q.origin.longitude);
    if (postgis) {
      distance = `ST_Distance(ST_SetSRID(ST_MakePoint(longitude,latitude),4326)::geography,
        ST_SetSRID(ST_MakePoint($8,$7),4326)::geography,false)/1609.344`;
      if (q.radius !== undefined) {
        parameters.push(q.radius);
      }
    } else {
      // Same WGS84 sphere and miles as the existing geo domain's haversine fallback.
      distance = `CASE WHEN latitude IS NOT NULL THEN 2*6371008.771415059/1609.344*asin(sqrt(least(1.0,greatest(0.0,
        power(sin(radians(latitude-$7)/2),2)+cos(radians($7))*cos(radians(latitude))*power(sin(radians(longitude-$8)/2),2))))) END`;
      if (q.radius !== undefined) {
        parameters.push(q.radius);
        radiusFilter = "WHERE distance_miles <= $9";
      }
    }
  }
  const direction = locationPage?.reverse ? "DESC" : "ASC";
  // A lone radius address is already unique within its NPI. Normalize only
  // records with multiple hits, including duplicate point evidence.
  const wireCtes = locationPage
    ? `wire_addresses AS MATERIALIZED (
    SELECT a.*,g.distance_miles AS record_distance,coalesce(addr.address_key,ARRAY[]::text[]) AS address_key
    FROM (SELECT a.*,count(*) OVER (PARTITION BY record_id) AS location_count FROM distances a) a
    JOIN grouped g USING(record_id)
    LEFT JOIN LATERAL (SELECT ${wireKey("addr")} AS address_key FROM npi_address addr
      WHERE a.location_count>1 AND addr.npi=a.record_id AND addr.kind='practice'
      AND addr.ordinal=a.address_index AND addr.snapshot_id=a.snapshot_id OFFSET 0) addr ON true
  ), wire_keys AS MATERIALIZED (
    SELECT DISTINCT ON (record_id,address_key) record_id,address_key,distance_miles,record_distance,address_index
    FROM wire_addresses ORDER BY record_id,address_key,distance_miles,address_index
  ), wire_page AS MATERIALIZED (
    SELECT * FROM wire_keys ORDER BY distance_miles ${direction},record_distance ${direction},record_id ${direction},
      address_index ${direction} LIMIT ${locationPage.size} OFFSET ${locationPage.offset}
  ), `
    : "";
  function distanceSelection() {
    if (!q.origin) {
      return "SELECT record_id,snapshot_id,NULL::float8 AS distance_miles FROM selected";
    } else if (q.radius !== undefined) {
      if (issuer) {
        return "SELECT record_id,snapshot_id,min(distance_miles) AS distance_miles FROM distances GROUP BY record_id,snapshot_id";
      } else {
        return "SELECT record_id,NULL::text AS snapshot_id,min(distance_miles) AS distance_miles FROM distances GROUP BY record_id";
      }
    } else {
      return `SELECT r.record_id,r.snapshot_id,min(a.distance_miles) AS distance_miles
    FROM selected r ${q.radius !== undefined ? "JOIN" : "LEFT JOIN"} distances a ON a.record_id=r.record_id
      ${issuer ? "AND a.snapshot_id=r.snapshot_id" : ""}
    GROUP BY r.record_id,r.snapshot_id`;
    }
  }
  function addressFields() {
    if (issuer) {
      return `||jsonb_build_object(
      'line_1',addr.address,'line_2',addr.address_2,'city',addr.city,'state',addr.state,'zip',addr.zip,'phone',addr.phone)`;
    } else if (spatialRadius) {
      return `||jsonb_build_object(
      'line_1',addr.line_1,'line_2',addr.line_2,'city',addr.city,'state',addr.state,'zip',addr.zip5,'phone',addr.phone)`;
    } else {
      return "";
    }
  }
  function addressJoin() {
    if (issuer) {
      return `JOIN qhp_provider_address addr ON addr.snapshot_id=a.snapshot_id
        AND addr.record_id=a.record_id AND addr.address_index=a.address_index`;
    } else if (spatialRadius) {
      return `JOIN npi_address addr ON addr.npi=a.record_id
        AND addr.kind='practice' AND addr.ordinal=a.address_index AND addr.snapshot_id=a.snapshot_id`;
    } else {
      return "";
    }
  }
  let query = `${ctes}, measured AS (
    SELECT located.*,${distance} AS distance_miles FROM located
  ), distances AS (SELECT * FROM measured ${radiusFilter}), grouped AS (
    ${distanceSelection()}
  ), ${wireCtes}paged AS (${
    locationPage
      ? `SELECT g.* FROM grouped g
    WHERE EXISTS (SELECT 1 FROM wire_page w WHERE w.record_id=g.record_id)`
      : `SELECT * FROM grouped ORDER BY distance_miles NULLS LAST,record_id,snapshot_id LIMIT 50 OFFSET ${(q.page - 1) * 50}`
  }), page_addresses AS MATERIALIZED (
    SELECT a.* FROM ${locationPage ? "wire_addresses" : "distances"} a JOIN paged p ON p.record_id=a.record_id
      ${issuer ? "AND p.snapshot_id=a.snapshot_id" : ""}
      ${locationPage ? "WHERE EXISTS (SELECT 1 FROM wire_page w WHERE w.record_id=a.record_id AND w.address_key=a.address_key)" : ""}
  )
  SELECT (SELECT count(*)::int FROM grouped) AS total,
    ${
      locationPage
        ? `CASE WHEN EXISTS (SELECT 1 FROM npi_address a ${recordFilter ? "JOIN identity_candidates n ON n.npi=a.npi" : ""}
      WHERE a.kind='practice' ${recordFilter ? "" : "AND NOT EXISTS (SELECT 1 FROM npi_provider n WHERE NOT n.in_scope AND n.npi=a.npi)"} AND NOT EXISTS (SELECT 1 FROM ${pointsRelation} p WHERE p.source_table='npi_address'
        AND split_part(p.source_row,':',1)=a.npi
          AND p.source_row=a.npi||':practice:'||a.ordinal::text AND p.source_snapshot_id=a.snapshot_id)) THEN 1 ELSE 0 END`
        : unlocated
    } AS unlocated,
    ${
      locationPage
        ? `(SELECT count(*)::int FROM wire_keys) AS location_total,
      EXISTS (SELECT 1 FROM distances WHERE method='zcta_centroid') AS location_approximate,
      EXISTS (SELECT 1 FROM grouped s WHERE NOT EXISTS (SELECT 1 FROM npi_taxonomy t JOIN ${taxonomy} nt ON nt.code=t.code
        WHERE t.npi=s.record_id AND nullif(nt.display_name,'') IS NOT NULL AND t.ordinal=(SELECT t2.ordinal FROM npi_taxonomy t2 WHERE t2.npi=s.record_id
          ORDER BY (t2.is_primary IS TRUE) DESC,t2.ordinal LIMIT 1))) AS location_taxonomy_unknown,`
        : ""
    }
    coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object(
    ${!issuer ? `'record_id',r.npi,'type',CASE WHEN r.entity_type='1' THEN 'INDIVIDUAL' ELSE 'GROUP' END,'evidence','[]'::jsonb,` : ""}
    ${
      issuer
        ? `'entity_type',n.entity_type,'deactivated',n.deactivated,'organization_name',n.organization_name,
    'first_name',n.first_name,'last_name',n.last_name,'nppes_snapshot_id',n.snapshot_id,
    'source_set_id',s.source_set_id,'raw_snapshot_id',s.raw_snapshot_id,'source_url',s.source_url,
    'retrieved_at',s.retrieved_at,'publisher_updated_at',s.publisher_updated_at,
    'evidence',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.source_plan_index)
      FROM qhp_provider_plan e WHERE e.snapshot_id=p.snapshot_id AND e.record_id=p.record_id
        AND e.base_hios_id=$1 AND e.plan_year=$2),`
        : ""
    }
    'addresses',coalesce((SELECT jsonb_agg(${locationPage ? "(to_jsonb(a)-'address_key'-'record_distance'-'location_count')" : "to_jsonb(a)"}${addressFields()}
      ORDER BY a.distance_miles NULLS LAST,a.address_index)
      FROM page_addresses a ${addressJoin()}
      WHERE a.record_id=p.record_id ${issuer ? "AND a.snapshot_id=p.snapshot_id" : ""}
      ),'[]'::jsonb),
    'distance_miles',p.distance_miles,
    'taxonomy',coalesce((SELECT jsonb_agg(jsonb_build_object('code',t.code,'is_primary',t.is_primary,'snapshot_id',t.snapshot_id,
      'display_name',nt.display_name,'taxonomy_display_name',nt.display_name,
      'taxonomy_source',CASE WHEN nt.code IS NULL THEN 'nppes_code_only' ELSE 'nucc' END,
      'classification',nt.classification,'specialization',nt.specialization,
      'taxonomy_status',CASE WHEN nt.code IS NULL THEN 'unknown_code' ELSE 'known' END)
      ORDER BY t.ordinal) FROM npi_taxonomy t LEFT JOIN ${taxonomy} nt ON nt.code=t.code WHERE t.npi=r.npi),'[]'::jsonb))
    ORDER BY p.distance_miles NULLS LAST,p.record_id,p.snapshot_id)
    FROM paged p JOIN ${issuer ? "qhp_provider_record" : "npi_provider"} r ON r.${issuer ? "record_id" : "npi"}=p.record_id ${issuer ? "AND r.snapshot_id=p.snapshot_id" : ""}
      ${issuer ? "LEFT JOIN npi_provider n ON n.npi=r.npi JOIN active_shards s ON s.snapshot_id=p.snapshot_id" : ""}),'[]'::jsonb) AS providers`;
  // The SQL body contains only application SQL and validated numeric page bounds.
  // Every request value stays bound through the invoker-rights, read-only function.
  while (parameters.length < 9) parameters.push(null);
  if (operatorPoints.length) {
    parameters.push(JSON.stringify(operatorPoints));
    const publicColumns =
      "address_hash,source_table,source_row,source_snapshot_id,latitude,longitude,method,match_status,match_quality,snapshot_id,centroid_snapshot_id,geocoded_at,normalization";
    const publicProjection = publicColumns
      .split(",")
      .map((c) => `p.${c}`)
      .join(",");
    const geometry = postgis
      ? ",ST_SetSRID(ST_MakePoint(o.longitude,o.latitude),4326)::geography AS point"
      : "";
    const overlay = `operator_points AS MATERIALIZED (SELECT * FROM json_to_recordset($10::json) AS o(
      address_hash text,latitude float8,longitude float8,county_fips text,as_of date,bounds_snapshot_id text)),
      effective_points AS NOT MATERIALIZED (
        SELECT ${publicProjection}${postgis ? ",p.point" : ""} FROM address_point p
        WHERE NOT EXISTS(SELECT 1 FROM operator_points o WHERE o.address_hash=p.address_hash AND p.method='zcta_centroid')
        UNION ALL SELECT a.address_hash,a.source_table,a.source_row,a.source_snapshot_id,o.latitude,o.longitude,
          'operator_geocoder',a.match_status,NULL::text,o.bounds_snapshot_id,NULL::text,o.as_of::timestamptz,NULL::jsonb${geometry}
        FROM operator_points o JOIN geocode_attempt a USING(address_hash)
        WHERE a.match_status IN ('Tie','No_Match')
      ), `;
    query = `WITH ${overlay}${query.slice(5)}`;
  }
  const result = await db.query<{
    result: {
      total: number;
      unlocated: number;
      providers: SearchRow[];
      location_total?: number;
      location_approximate?: boolean;
      location_taxonomy_unknown?: boolean;
    };
  }>(
    `SELECT provider_search_query(
    $provider_query$${query}$provider_query$,$1::text,$2::integer,$3::text,$4::text,$5::text,$6::text,
    $7::double precision,$8::double precision,$9::numeric${operatorPoints.length ? ", $10::json" : ""}) AS result`,
    parameters,
  );
  const row = result.rows[0]!.result;
  const providers = row.providers.map((provider) => ({
    ...provider,
    participation: issuer
      ? classifyProviderEvidence(provider.evidence, true)
      : "not_evaluated",
    participation_scope: issuer ? "provider_record" : null,
    warnings:
      issuer && provider.evidence.some((e) => e.tier_status === "unresolved")
        ? ["UNRESOLVED_NETWORK_TIER"]
        : [],
    specialties: issuer
      ? providerSpecialties({
          speciality: provider.speciality,
          specialty: provider.specialty,
        })
      : [],
    addresses: provider.addresses.map((a) => {
      function geocodeLabel() {
        if (a.method === "operator_geocoder") {
          return "operator_geocoder";
        } else if (a.method === "census_geocoder") {
          if (a.normalization) {
            return "census_match_after_normalisation";
          } else {
            return "census_match";
          }
        } else if (a.method === "zcta_centroid") {
          return "zcta_fallback";
        } else {
          return null;
        }
      }
      function geocodePrecision() {
        if (a.method === "operator_geocoder") {
          return "operator_reported";
        } else if (a.method === "zcta_centroid") {
          return "approximate";
        } else if (a.method === "census_geocoder") {
          if (a.match_quality === "Exact") {
            return "exact";
          } else {
            return "non_exact";
          }
        } else {
          return null;
        }
      }
      return {
        ...a,
        source: source,
        participation: "not_evaluated",
        participation_scope: issuer ? "provider_record" : null,
        geocode_label: geocodeLabel(),
        geocode_as_of: a.method === "operator_geocoder" ? a.geocoded_at : null,
        precision: geocodePrecision(),
      };
    }),
  }));
  return {
    ...(locationPage
      ? {
          location_total: row.location_total,
          location_approximate: row.location_approximate,
          location_taxonomy_unknown: row.location_taxonomy_unknown,
        }
      : {}),
    providers,
    total: row.total,
    page: q.page,
    page_size: 50,
    next_page: q.page * 50 < row.total ? q.page + 1 : null,
    meta: {
      unlocated: Number(row.unlocated),
      unlocated_scope: "candidate_addresses",
      origin: q.origin ?? null,
      radius_miles: q.radius ?? null,
      participation_scope: issuer ? "provider_record" : null,
    },
  };
}

export async function providerDetail(
  db: SqlSession,
  npi: string,
  year: number | undefined,
) {
  const taxonomy = await taxonomyRelation(db);
  const identity =
    (
      await db.query(
        `SELECT n.*,coalesce((SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object(
      'display_name',nt.display_name,'taxonomy_display_name',nt.display_name,
      'taxonomy_source',CASE WHEN nt.code IS NULL THEN 'nppes_code_only' ELSE 'nucc' END,
      'classification',nt.classification,'specialization',nt.specialization,
      'taxonomy_status',CASE WHEN nt.code IS NULL THEN 'unknown_code' ELSE 'known' END) ORDER BY t.ordinal)
      FROM npi_taxonomy t LEFT JOIN ${taxonomy} nt ON nt.code=t.code WHERE t.npi=n.npi),'[]') AS taxonomy,
    coalesce((SELECT jsonb_agg(to_jsonb(a)||jsonb_build_object('source','npi_address','participation','not_evaluated')
      ORDER BY a.kind,a.ordinal) FROM npi_address a WHERE a.npi=n.npi),'[]') AS addresses
    FROM npi_provider n WHERE n.npi=$1`,
        [npi],
      )
    ).rows[0] ?? null;
  const records = (
    await db.query(
      `SELECT r.*,active.issuer_id,active.plan_year,active.state,s.source_set_id,s.raw_snapshot_id,snap.final_url AS source_url,
      snap.retrieved_at,snap.publisher_updated_at,
    coalesce((SELECT jsonb_agg(to_jsonb(a)||jsonb_build_object('source','qhp_provider_address','participation','not_evaluated')
      ORDER BY a.address_index) FROM qhp_provider_address a WHERE a.record_id=r.record_id AND a.snapshot_id=r.snapshot_id),'[]') AS addresses,
    coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.plan_year,e.base_hios_id,e.source_plan_index) FROM qhp_provider_plan e
      WHERE e.record_id=r.record_id AND e.snapshot_id=r.snapshot_id AND ($2::integer IS NULL OR e.plan_year=$2)),'[]') AS plan_participations
    FROM qhp_provider_record r JOIN provider_shard s USING(snapshot_id)
    JOIN provider_active_set active ON active.snapshot_id=s.source_set_id
    JOIN snapshot snap ON snap.snapshot_id=r.snapshot_id AND snap.validation_state='ACTIVE'
    WHERE r.npi=$1 AND ($2::integer IS NULL OR active.plan_year=$2) ORDER BY r.snapshot_id,r.source_record`,
      [npi, year ?? null],
    )
  ).rows;
  if (!identity && !records.length) return null;
  const coverage = (await providerAvailability(db)).filter((p) =>
    records.some(
      (r) =>
        r.issuer_id === p.issuer_id &&
        r.plan_year === p.plan_year &&
        r.state === p.state,
    ),
  );
  const pairs = new Map<
    string,
    { base_hios_id: string; plan_year: number; evidence: ProviderEvidence[] }
  >();
  for (const record of records)
    for (const edge of record.plan_participations as (ProviderEvidence & {
      base_hios_id: string;
      plan_year: number;
    })[]) {
      const key = `${edge.base_hios_id}:${edge.plan_year}`,
        pair = pairs.get(key) ?? {
          base_hios_id: edge.base_hios_id,
          plan_year: edge.plan_year,
          evidence: [],
        };
      pair.evidence.push({
        ...edge,
        npi,
        source_updated_at: record.source_updated_at as string | null,
        source_set_id: record.source_set_id as string,
        raw_snapshot_id: record.raw_snapshot_id as string,
        source_url: record.source_url as string | null,
      });
      pairs.set(key, pair);
    }
  const participations = [...pairs.values()].map((pair) => {
    const source = coverage.find(
      (p) =>
        p.issuer_id === pair.base_hios_id.slice(0, 5) &&
        p.state === pair.base_hios_id.slice(5, 7) &&
        p.plan_year === pair.plan_year,
    );
    return {
      ...pair,
      status:
        source?.status === "access_denied"
          ? "unknown"
          : classifyProviderEvidence(
              pair.evidence,
              source?.status === "complete",
            ),
      participation_scope: "provider_record",
      warnings: [
        ...(source?.status !== "complete" ? ["SOURCE_INCOMPLETE"] : []),
        ...(pair.evidence.some((e) => e.tier_status === "unresolved")
          ? ["UNRESOLVED_NETWORK_TIER"]
          : []),
      ],
    };
  });
  return {
    npi,
    identity,
    issuer_records: records,
    plan_participations: participations,
    participation_scope: "provider_record",
    provider_coverage: coverage,
  };
}

export interface UnlocatedStateSearch {
  name: string;
  /** Practice-address states of the requested ZIP, from published geography only. */
  states: string[];
  taxonomy?: string;
  specialty?: string;
  type?: "INDIVIDUAL";
  /** True when the ZIP has no origin: no address can be radius-checked, located or not. */
  includeLocated?: boolean;
}
export interface UnlocatedStatePage {
  offset: number;
  /** Omitted: every matching location (the facade's native-mapping path pages in memory). */
  size?: number;
}
/** Same labels as radius results for the public point methods. */
function pointQuality(a: Record<string, unknown>) {
  if (a.method === "census_geocoder")
    return {
      geocode_label: a.normalization
        ? "census_match_after_normalisation"
        : "census_match",
      precision: a.match_quality === "Exact" ? "exact" : "non_exact",
    };
  if (a.method === "zcta_centroid")
    return { geocode_label: "zcta_fallback", precision: "approximate" };
  return { geocode_label: null, precision: null };
}
/** Marks NPPES locations returned without a radius evaluation. */
export const RADIUS_NOT_CHECKED = "provider_radius_not_checked";

/**
 * Name matches at in-state practice addresses that no radius could evaluate:
 * addresses without a current point, or every in-state address when the ZIP has
 * no origin. Distance is always null and rows carry the radius-not-checked flag.
 * Coordinates come only from a current public geocode point, never inferred.
 */
export async function searchUnlocatedInState(
  db: SqlSession,
  q: UnlocatedStateSearch,
  page: UnlocatedStatePage,
) {
  const states = q.states.filter((state) => /^[A-Z]{2}$/.test(state));
  if (!states.length || !q.name.trim()) return { providers: [], total: 0 };
  const taxonomy = await taxonomyRelation(db);
  const operatorHashes = (await searchOperatorPoints(db)).map(
    (p) => p.address_hash,
  );
  // The longest literal word feeds the optional trigram index; ILIKE stays authoritative.
  const words = q.name.trim().split(/\s+/);
  const longest = words.reduce((a, b) =>
    [...b].length > [...a].length ? b : a,
  );
  const indexed = !/[%_\\]/.test(q.name) && [...longest].length >= 4;
  const limit =
    page.size === undefined
      ? ""
      : `LIMIT ${Math.max(0, Math.floor(page.size))}`;
  const { rows } = await db.query<{
    total: number;
    providers: SearchRow[];
  }>(
    `WITH names AS MATERIALIZED (
    SELECT n.npi FROM npi_provider n WHERE n.in_scope
      ${
        indexed
          ? `AND provider_search_trigrams(coalesce(n.organization_name,'')||' '||coalesce(n.first_name,'')||' '||coalesce(n.last_name,''))
        @> provider_search_trigrams($6::text)`
          : "AND $6::text IS NULL"
      }
      AND concat_ws(' ',n.organization_name,n.first_name,n.last_name) ILIKE '%'||$1||'%'
      AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM npi_taxonomy t WHERE t.npi=n.npi AND t.code=$2))
      AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM npi_taxonomy t LEFT JOIN ${taxonomy} nt ON nt.code=t.code
        WHERE t.npi=n.npi AND (t.code ILIKE '%'||$3||'%' OR nt.display_name ILIKE '%'||$3||'%'
          OR nt.classification ILIKE '%'||$3||'%' OR nt.specialization ILIKE '%'||$3||'%')))
      AND ($4::text IS NULL OR CASE WHEN n.entity_type='1' THEN 'INDIVIDUAL' ELSE 'GROUP' END=$4)
  ), candidates AS MATERIALIZED (
    SELECT a.npi,a.snapshot_id,a.ordinal,${wireKey("a")} AS address_key
    FROM names JOIN npi_address a ON a.npi=names.npi
    WHERE a.kind='practice' AND a.state=ANY($5::text[])
      AND ($8::boolean OR NOT EXISTS (SELECT 1 FROM address_point p WHERE p.source_table='npi_address'
        AND split_part(p.source_row,':',1)=a.npi
        AND p.source_row=a.npi||':practice:'||a.ordinal::text AND p.source_snapshot_id=a.snapshot_id)
      AND NOT EXISTS (SELECT 1 FROM geocode_attempt g WHERE g.source_table='npi_address'
        AND g.source_row=a.npi||':practice:'||a.ordinal::text AND g.source_snapshot_id=a.snapshot_id
        AND g.match_status IN ('Tie','No_Match') AND g.address_hash=ANY($7::text[])))
  ), locations AS MATERIALIZED (
    SELECT DISTINCT ON (npi,address_key) * FROM candidates ORDER BY npi,address_key,ordinal
  ), paged AS MATERIALIZED (
    SELECT * FROM locations ORDER BY npi,ordinal ${limit} OFFSET ${Math.max(0, Math.floor(page.offset))}
  )
  SELECT (SELECT count(*)::int FROM locations) AS total,
    coalesce((SELECT jsonb_agg(to_jsonb(n)||jsonb_build_object(
      'record_id',n.npi,'type',CASE WHEN n.entity_type='1' THEN 'INDIVIDUAL' ELSE 'GROUP' END,
      'evidence','[]'::jsonb,'distance_miles',NULL,
      'addresses',(SELECT jsonb_agg(jsonb_build_object('record_id',a.npi,'snapshot_id',a.snapshot_id,
        'address_index',a.ordinal,'source_row',a.npi||':practice:'||a.ordinal::text,
        'line_1',a.line_1,'line_2',a.line_2,'city',a.city,'state',a.state,'zip',a.zip5,'phone',a.phone,
        'latitude',p.latitude,'longitude',p.longitude,'method',p.method,'match_quality',p.match_quality,
        'normalization',p.normalization,'distance_miles',NULL) ORDER BY a.ordinal)
        FROM paged k JOIN npi_address a ON a.npi=k.npi AND a.kind='practice' AND a.ordinal=k.ordinal
          AND a.snapshot_id=k.snapshot_id
        LEFT JOIN LATERAL (SELECT p.* FROM address_point p WHERE p.source_table='npi_address'
          AND split_part(p.source_row,':',1)=a.npi AND p.source_row=a.npi||':practice:'||a.ordinal::text
          AND p.source_snapshot_id=a.snapshot_id ORDER BY p.geocoded_at DESC LIMIT 1) p ON true
        WHERE k.npi=n.npi),
      'taxonomy',coalesce((SELECT jsonb_agg(jsonb_build_object('code',t.code,'is_primary',t.is_primary,'snapshot_id',t.snapshot_id,
        'display_name',nt.display_name,'taxonomy_display_name',nt.display_name,
        'taxonomy_source',CASE WHEN nt.code IS NULL THEN 'nppes_code_only' ELSE 'nucc' END,
        'classification',nt.classification,'specialization',nt.specialization,
        'taxonomy_status',CASE WHEN nt.code IS NULL THEN 'unknown_code' ELSE 'known' END)
        ORDER BY t.ordinal) FROM npi_taxonomy t LEFT JOIN ${taxonomy} nt ON nt.code=t.code WHERE t.npi=n.npi),'[]'::jsonb))
      ORDER BY n.npi)
    FROM npi_provider n WHERE n.npi IN (SELECT npi FROM paged)),'[]'::jsonb) AS providers`,
    [
      q.name.trim(),
      q.taxonomy ?? null,
      q.specialty ?? null,
      q.type ?? null,
      states,
      indexed ? longest : null,
      operatorHashes,
      q.includeLocated === true,
    ],
  );
  const row = rows[0]!;
  return {
    total: Number(row.total),
    providers: row.providers.map((provider) => ({
      ...provider,
      participation: "not_evaluated",
      participation_scope: null,
      warnings: [],
      specialties: [],
      location_check: RADIUS_NOT_CHECKED,
      addresses: provider.addresses.map((a) => ({
        ...a,
        source: "npi_address",
        participation: "not_evaluated",
        participation_scope: null,
        ...pointQuality(a),
        geocode_as_of: null,
      })),
    })),
  };
}
