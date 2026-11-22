SET search_path = pg_catalog;
WITH namespaces AS (
  SELECT oid, nspname, nspowner, nspacl FROM pg_namespace
  WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
), objects AS (
  SELECT jsonb_build_array('schema', nspname, pg_get_userbyid(nspowner), nspacl::text) AS line FROM namespaces
  UNION ALL
  SELECT jsonb_build_array('relation', nspname, relname, relkind, pg_get_userbyid(relowner),
    relacl::text, relrowsecurity, relforcerowsecurity, reloptions,
    CASE WHEN relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid) END)
  FROM pg_class c JOIN namespaces n ON n.oid = relnamespace
  UNION ALL
  SELECT jsonb_build_array('column', nspname, relname, attnum, attname, format_type(atttypid, atttypmod),
    attnotnull, attidentity, attgenerated, attacl::text, pg_get_expr(adbin, adrelid))
  FROM pg_attribute a JOIN pg_class c ON c.oid = attrelid JOIN namespaces n ON n.oid = relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = attrelid AND d.adnum = attnum
  WHERE attnum > 0 AND NOT attisdropped
  UNION ALL
  SELECT jsonb_build_array('routine', nspname, proname, pg_get_function_identity_arguments(p.oid),
    pg_get_userbyid(proowner), proacl::text, CASE WHEN prokind <> 'a' THEN pg_get_functiondef(p.oid) END)
  FROM pg_proc p JOIN namespaces n ON n.oid = pronamespace
  UNION ALL
  SELECT jsonb_build_array('policy', nspname, relname, polname, polcmd, polpermissive,
    ARRAY(SELECT CASE WHEN role = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(role) END
      FROM unnest(polroles) AS role ORDER BY 1), pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid))
  FROM pg_policy JOIN pg_class c ON c.oid = polrelid JOIN namespaces n ON n.oid = relnamespace
  UNION ALL
  SELECT jsonb_build_array('default-acl', pg_get_userbyid(defaclrole), nspname, defaclobjtype, defaclacl::text)
  FROM pg_default_acl LEFT JOIN pg_namespace ON pg_namespace.oid = defaclnamespace
  UNION ALL
  SELECT jsonb_build_array('membership', pg_get_userbyid(roleid), pg_get_userbyid(member),
    pg_get_userbyid(grantor), admin_option, inherit_option, set_option)
  FROM pg_auth_members
)
SELECT line::text FROM objects ORDER BY line::text COLLATE "C";
