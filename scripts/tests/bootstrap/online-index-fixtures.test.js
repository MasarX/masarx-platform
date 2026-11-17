const assert = require('node:assert/strict');
const { test } = require('node:test');
const registry = require('../../../config/ops/online-index-phases.json');
const { indexFixtureSql, disposableIndexTarget } = require('./online-index-fixtures');

test('registry fixtures preserve every key, collation, predicate and recursive attachment', () => {
  const sql = registry.phases.flatMap(phase => phase.indexes.map(indexFixtureSql));
  assert.deepEqual(sql, [
    'CREATE INDEX IF NOT EXISTS "idx_workflow_runs_triggered_by_request_id_not_null" ON "public"."workflow_runs" USING btree ("triggered_by_request_id" "uuid_ops" ASC NULLS LAST) WHERE "triggered_by_request_id" IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS "idx_decision_log_org_correlation_not_null" ON "public"."decision_log" USING btree ("organization_id" "uuid_ops" ASC NULLS LAST, "correlation_id" "uuid_ops" ASC NULLS LAST) WHERE "correlation_id" IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS "idx_domain_events_org_correlation_resource_not_null" ON "public"."domain_events" USING btree ("organization_id" "uuid_ops" ASC NULLS LAST, "correlation_id" "uuid_ops" ASC NULLS LAST, "resource_type" COLLATE "default" "text_ops" ASC NULLS LAST, "resource_id" "uuid_ops" ASC NULLS LAST) WHERE "correlation_id" IS NOT NULL AND "resource_id" IS NOT NULL',
  ]);
});

test('malformed identifiers, ordering and free-form predicates fail before SQL execution', () => {
  const spec = registry.phases[0].indexes[0];
  for (const index of [
    { ...spec, index_name: 'bad; SELECT 1' },
    { ...spec, relation: 'public.workflow_runs.extra' },
    { ...spec, keys: [{ ...spec.keys[0], order: 'ASC; SELECT 1' }] },
    { ...spec, keys: [{ ...spec.keys[0], opclass: 'uuid_ops; SELECT 1' }] },
    { ...spec, predicate_not_null_columns: ['unregistered'] },
  ]) assert.throws(() => indexFixtureSql(index));
});

test('index preparation rejects remote or unqualified databases', () => {
  const env = { PGTAP_FULL_LOCAL_QUALIFICATION: '1', DATABASE_URL: 'postgres://fixture@127.0.0.1:5432/postgres' };
  assert.equal(disposableIndexTarget(env), env.DATABASE_URL);
  assert.throws(() => disposableIndexTarget({ ...env, PGTAP_FULL_LOCAL_QUALIFICATION: '0' }));
  assert.throws(() => disposableIndexTarget({ ...env, DATABASE_URL: 'postgres://fixture@database.example.invalid/postgres' }));
  assert.throws(() => disposableIndexTarget({ ...env, DATABASE_URL: 'https://localhost/postgres' }));
});
