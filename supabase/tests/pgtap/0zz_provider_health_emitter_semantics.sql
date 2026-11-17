-- Test: provider_health_logs trigger semantics (state transitions emit org + correlation)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

DO $$
DECLARE
  v_org UUID := 'aaaa8888-0000-0000-0000-000000008801';
  v_provider UUID := 'bbbb8888-0000-0000-0000-000000008801';
  v_circuit UUID := 'cccc8888-0000-0000-0000-000000008801';
BEGIN
  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Provider Health Semantics Org', 'provider-health-semantics-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO providers (id, organization_id, name, provider_type)
  VALUES (v_provider, v_org, 'pgtap-provider-health', 'http')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO circuit_breaker_state (id, provider_id, operation_name, state, manual_intervention_required)
  VALUES (v_circuit, v_provider, 'probe_operation', 'closed', FALSE)
  ON CONFLICT (id) DO NOTHING;
END$$;

-- Transition: closed -> open
UPDATE circuit_breaker_state
SET state = 'open',
    failure_count = failure_count + 1,
    updated_at = now()
WHERE id = 'cccc8888-0000-0000-0000-000000008801'::uuid;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM provider_health_logs
    WHERE provider_id = 'bbbb8888-0000-0000-0000-000000008801'::uuid
      AND organization_id = 'aaaa8888-0000-0000-0000-000000008801'::uuid
      AND status = 'down'
      AND (metadata->>'new_state') = 'open'
  ),
  'provider_health_logs emitted for open transition (down)'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM provider_health_logs
    WHERE provider_id = 'bbbb8888-0000-0000-0000-000000008801'::uuid
      AND status = 'down'
      AND correlation_id IS NOT NULL
      AND (metadata->>'new_state') = 'open'
  ),
  'provider_health_logs includes correlation_id'
);

-- Transition: open -> closed
UPDATE circuit_breaker_state
SET state = 'closed',
    success_count = success_count + 1,
    updated_at = now()
WHERE id = 'cccc8888-0000-0000-0000-000000008801'::uuid;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM provider_health_logs
    WHERE provider_id = 'bbbb8888-0000-0000-0000-000000008801'::uuid
      AND organization_id = 'aaaa8888-0000-0000-0000-000000008801'::uuid
      AND status = 'healthy'
      AND (metadata->>'new_state') = 'closed'
  ),
  'provider_health_logs emitted for closed transition (healthy)'
);

SELECT finish();

ROLLBACK;

