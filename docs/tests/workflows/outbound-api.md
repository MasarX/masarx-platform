# Workflow: Outbound API Templates & Provider Calls

Although full HTTP callouts are mocked in local development, we validate the configuration scaffolding that powers them.

## Seed Baseline

- Provider `twilio_sms` (`providers`).
- Auth config secret `signing_secret` is stored in Supabase Vault (referenced by `provider_auth_configs.credentials_vault_id`); resolve via `public.get_provider_auth_credential(<auth_config_id>, 'signing_secret')` (service_role).
- Operation templates and rate limits are currently smoke-tested via SQL snapshots (future work: add dynamic call simulations).

## Regression Checklist

| Scenario | Command | Validation |
| --- | --- | --- |
| Provider present & enabled | `node scripts/data/seed-test-data.js` (implicit) | `SELECT name, enabled FROM providers WHERE name = 'twilio_sms';` |
| Auth config accessible | Same | `SELECT auth_type, credentials_vault_id FROM provider_auth_configs WHERE provider_id = ...;` |
| Auth secret resolvable (service_role) | Same | `SELECT public.get_provider_auth_credential(<auth_config_id>, 'signing_secret');` |
| Mapping config connected to operation_template | Same | `SELECT mapping_config_id FROM operation_templates WHERE provider_id = ...;` |
| Worker registry knows about outbound API handler | `npm run test:integration` (`partition-functions` + existing suites) | `SELECT handler_key FROM worker_action_handlers WHERE handler_key = 'call_supplier_api';` |

## Future Automation

- Introduce a mocked outbound HTTP endpoint (e.g., using `msw` or a local Deno function) and verify:
  - Template rendering (headers/body placeholders).
  - Rate-limit enforcement / circuit breaker transitions.
  - API call logging in `api_call_log`.
- Extend docs with payload/response templates per provider once the mocks exist.

For now, the smoke checks ensure configuration drift is caught during CI, and the detailed plan above provides the roadmap for deeper simulations.
