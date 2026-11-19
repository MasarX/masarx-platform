-- pgTAP: Console V2 provider credential actions must be lookup-metadata driven.

BEGIN;

SELECT plan(5);

SELECT is(
  (
    SELECT lv.metadata->>'lifecycle'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'provider_auth_status'
      AND lv.value = 'active'
    LIMIT 1
  ),
  'active',
  'provider_auth_status.active carries active lifecycle metadata'
);

SELECT is(
  (
    SELECT lv.metadata->>'is_revoked'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'provider_auth_status'
      AND lv.value = 'revoked'
    LIMIT 1
  ),
  'true',
  'provider_auth_status.revoked carries revoked terminal flag'
);

SELECT is(
  (
    SELECT lv.metadata->>'is_terminal'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'provider_auth_status'
      AND lv.value = 'expired'
    LIMIT 1
  ),
  'true',
  'provider_auth_status.expired carries terminal lifecycle metadata'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'provider_auth_status'
      AND lv.value IN ('active', 'pending', 'rotating', 'revoked', 'expired')
      AND COALESCE(lv.metadata->>'lifecycle', '') = ''
  ),
  'all required provider_auth_status rows expose lifecycle metadata'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'provider_auth_status'
      AND lv.value IN ('active', 'pending', 'rotating', 'revoked', 'expired')
      AND (
        lv.metadata ? 'is_revoked'
      ) IS FALSE
  ),
  'all required provider_auth_status rows expose is_revoked metadata'
);

SELECT * FROM finish();

ROLLBACK;
