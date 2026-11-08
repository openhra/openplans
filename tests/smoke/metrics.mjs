import { createDatabase } from './dist/db/database.js';
const db = createDatabase();
try {
  const tables = ['snapshot','state_rating_rule','zcta_county','zcta_centroid','plan','plan_variant','rate',
    'service_area_county','rx_concept','rx_relation','rx_ndc','qhp_index','qhp_child_url',
    'formulary_edge','npi_provider','npi_taxonomy','npi_address','npi_deactivation',
    'qhp_provider_record','qhp_provider_address','qhp_provider_plan','address_point','geocode_attempt'];
  const counts = {};
  for (const table of tables) counts[table] = Number((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const size = Number((await db.query('SELECT pg_database_size(current_database()) AS n')).rows[0].n);
  console.log(JSON.stringify({row_counts:counts,db_size_bytes:size}));
} finally { await db.close(); }
