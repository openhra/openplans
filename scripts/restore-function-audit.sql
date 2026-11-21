-- Functions evaluated by stored expressions must not inherit pg_restore's empty search_path.
WITH RECURSIVE expression_functions(oid) AS (
  SELECT d.refobjid FROM pg_catalog.pg_depend d
  WHERE d.refclassid = 'pg_catalog.pg_proc'::regclass AND (
    (d.classid = 'pg_catalog.pg_constraint'::regclass AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.oid = d.objid AND c.contype = 'c'))
    OR d.classid = 'pg_catalog.pg_attrdef'::regclass
    OR (d.classid = 'pg_catalog.pg_class'::regclass AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid = d.objid)))
  UNION
  SELECT d.refobjid FROM expression_functions f JOIN pg_catalog.pg_depend d
    ON d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = f.oid
    AND d.refclassid = 'pg_catalog.pg_proc'::regclass
)
SELECT n.nspname AS schema, p.proname AS name,
  pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
  p.proconfig AS settings
FROM expression_functions f JOIN pg_catalog.pg_proc p ON p.oid = f.oid
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend e
    WHERE e.classid = 'pg_catalog.pg_proc'::regclass AND e.objid = p.oid
      AND e.refclassid = 'pg_catalog.pg_extension'::regclass AND e.deptype = 'e')
ORDER BY n.nspname, p.proname, arguments;
