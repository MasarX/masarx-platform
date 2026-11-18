BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

SELECT ok(
  to_regprocedure('public.marketplace_refresh_reputation_snapshots_for_visible_v1(uuid)') IS NOT NULL,
  'public marketplace reputation refresh console wrapper exists'
);

SELECT ok(
  to_regprocedure('api.marketplace_refresh_reputation_snapshots_for_visible_v1(uuid)') IS NOT NULL,
  'api marketplace reputation refresh console wrapper exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.marketplace_refresh_reputation_snapshots_for_visible_v1(uuid)', 'EXECUTE'),
  'authenticated can execute api marketplace reputation refresh wrapper'
);

SELECT ok(
  has_function_privilege('service_role', 'api.marketplace_refresh_reputation_snapshots_for_visible_v1(uuid)', 'EXECUTE'),
  'service_role can execute api marketplace reputation refresh wrapper'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.marketplace_refresh_reputation_snapshots_for_visible_v1(uuid)', 'EXECUTE'),
  'anon cannot execute api marketplace reputation refresh wrapper'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.marketplace_refresh_reputation_snapshots_for_visible_v1(uuid)', 'EXECUTE'),
  'authenticated can execute public marketplace reputation refresh wrapper'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.marketplace_refresh_reputation_snapshots_for_visible_v1(uuid)', 'EXECUTE'),
  'anon cannot execute public marketplace reputation refresh wrapper'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.marketplace_refresh_reputation_snapshots_for_visible_v1(uuid)'))
    ~ 'marketplace_refresh_reputation_snapshot_v1',
  'console wrapper delegates to canonical reputation snapshot scorer'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.marketplace_refresh_reputation_snapshots_for_visible_v1(uuid)'))
    ~ 'marketplace_participants\.write',
  'tenant refresh path is capability-gated by marketplace_participants.write'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.marketplace_refresh_reputation_snapshots_for_visible_v1(uuid)'))
    ~ 'marketplace_participant_requests\.review',
  'platform refresh path is capability-gated by marketplace participant review'
);

SELECT * FROM finish();

ROLLBACK;
