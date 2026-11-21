const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const migration = readFileSync(join(process.cwd(),
  'supabase/migrations/20261114121000_marketplace_participant_review_readback_v1.sql'), 'utf8');

test('review projection checks the current request flag and keeps internal metadata private', () => {
  const view = migration.match(/CREATE VIEW public\.marketplace_participant_request_review_read_v1[\s\S]*?;/)[0];
  expect(view).toContain('WITH (security_invoker = true)');
  expect(view).toContain("r.status = 'pending'");
  expect(view).toContain("r.decision_metadata->>'request_additional_docs'");
  expect(view).not.toMatch(/r\.decision_metadata\s*,/);
  expect(view).toContain('END AS requested_documents');
  expect(view).toContain("public.user_has_resource_capability_v1('marketplace_participant_requests', 'read')");
  expect(view).toContain('public.marketplace_org_match_v1(r.requested_organization_id)');
  expect(view).toContain('public.marketplace_org_match_v1(r.approved_organization_id)');
});

test('review registry promotion uses the canonical history writer and checks cache parity', () => {
  expect(migration).toMatch(/FOR UPDATE OF s,\s*sv/);
  expect(migration).toContain("public.upsert_settings_value_v1('ui_read_registry'");
  expect(migration).toContain('Marketplace review registry normalization changed unrelated metadata');
  expect(migration).toContain('s.cached_value=sv.value AND sv.effective_until IS NULL');
  expect(migration).not.toMatch(/UPDATE\s+public\.settings_versions\s+SET\s+(?:value|version)\b/i);
});

test('the review epoch grants only the view read privilege and limits cache invalidation', () => {
  expect(migration).toContain("OR jsonb_array_length(delta)<>1");
  expect(migration).toContain("GRANT SELECT ON public.marketplace_participant_request_review_read_v1 TO ui_rpc_executor");
  expect(migration.match(/GRANT SELECT ON public\.marketplace_participant_request_review_read_v1/g)).toHaveLength(1);
  const invalidation = migration.match(/DELETE FROM public\.settings_cache[^;]+;/)[0];
  const patterns = [...invalidation.matchAll(/cache_key LIKE '([^']+)'/g)].map((match) => match[1]);
  expect(patterns).toEqual(['ui_read_registry:%', '%:marketplace_participant_requests:%']);
});
