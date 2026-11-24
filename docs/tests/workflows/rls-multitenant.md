# Workflow: RLS & Multi-Tenant Isolation

## Goals

- Ensure organizations can only see their own clients, senders, shipments.
- Verify webhook policies resolve via the scope ladder (source -> sender -> client -> tenant -> global).
- Confirm pg roles align with Plan.md (service role vs anon vs client API keys).

## Automation

| Scenario | Command | Assertions |
| --- | --- | --- |
| Shipments restricted by client | `npm run test:integration` (rls-policies) | `tests/integration/rls-policies.test.js` |
| Settings ladder resolution | `npm run test:integration` (settings-resolution) | `tests/integration/settings-resolution.test.js` |
| Webhook policy scope selection | `npm test` (webhook-ingest suite) | Duplicate/HMAC tests exercise source vs global policy resolution |
| Tenant signup reversal | Hosted pgTAP | [Approval reversal](../../../supabase/tests/pgtap/0zz_tenant_signup_approval_reversal.sql) verifies service-only admission, removal of approval-created access, preservation of existing access, and decision evidence |

## Manual Queries

```sql
-- Verify RLS enabled
SELECT relname, relrowsecurity
FROM pg_class
WHERE relname IN ('shipments', 'clients', 'senders');

-- Ladder resolution (global vs source policy)
SELECT scope_type, scope_id, cached_value
FROM settings
WHERE category = 'webhook_ingest_policy';
```

When introducing new tenant-specific flows, add integration tests that impersonate the appropriate JWT (see existing RLS suite for examples) and document the scenario here.
