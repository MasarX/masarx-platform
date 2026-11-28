BEGIN READ ONLY;
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = pg_catalog;

SELECT jsonb_build_object(
  'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
  'authenticated_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
  'execute_acl', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'grantor', pg_get_userbyid(a.grantor),
      'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
    ) ORDER BY a.grantor, a.grantee)
    FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
    WHERE a.privilege_type = 'EXECUTE'
  ), '[]'::jsonb)
)
FROM pg_proc AS p
WHERE p.oid = 'public.find_extent(regclass, text)'::regprocedure;

ROLLBACK;
