BEGIN;
SELECT plan(4);

SELECT has_index('public', 'tracking_sessions', 'idx_tracking_sessions_active_expires_created_v1', 'active expiring session index exists');
SELECT has_index('public', 'tracking_sessions', 'idx_tracking_sessions_active_null_expiry_created_v1', 'active permanent session index exists');

SELECT is(
  (SELECT regexp_replace(split_part(indexdef, ' WHERE ', 2), '::text|[()[:space:]]', '', 'g')
     FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'tracking_sessions'
      AND indexname = 'idx_tracking_sessions_active_expires_created_v1'),
  $predicate$status='active'$predicate$,
  'active expiring session index filters to active sessions'
);

SELECT is(
  (SELECT regexp_replace(split_part(indexdef, ' WHERE ', 2), '::text|[()[:space:]]', '', 'g')
     FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'tracking_sessions'
      AND indexname = 'idx_tracking_sessions_active_null_expiry_created_v1'),
  $predicate$status='active'ANDexpires_atISNULL$predicate$,
  'active permanent session index filters to active sessions with no expiry'
);

SELECT * FROM finish();
ROLLBACK;
