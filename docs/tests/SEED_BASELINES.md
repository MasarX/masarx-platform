# Seed Baseline Reference

The deterministic seed script (`scripts/data/seed-test-data.js`) primes the database with enough data to exercise all documented workflows. Run it after provisioning a fresh environment (cloud project-per-workspace) or after resetting a local stack.

Safety:
- Do not run destructive resets against shared cloud environments (staging/prod or shared dev). Prefer `npm run cloud:provision` (isolated cloud) or a local stack.

## Core Entities

| Table | Seeded Rows | Notes |
| --- | --- | --- |
| `organizations` | 3 (`Test Organization Alpha/Beta/Gamma`) | Timezone `Asia/Riyadh`, locale `ar-SA` |
| `clients` | 9 (3 per org) | SLA tiers distributed across economy/standard/premium |
| `senders` | 9 | Auto-provisioned flag disabled to test webhook recreation logic |
| `shipments` | 100 / 10,000 / 100,000 | Partitioned by `client_id`; deterministic tracking numbers (`DLX000000001` ...) |

Seed invariants:
- Shipment `status` and `service_type` are resolved from canonical lookup rows, not hardcoded literals.
- Recipient/address pool identifiers are deterministic so rerunning the seed on the same local database remains FK-safe.
- Workflow/orchestration seed rows are rerun-safe for `npm run local:verify` on one workspace.

## Webhook & Provider Infrastructure

- **Providers**
  - `twilio_sms` (comms)
  - `here_geocoding` (geocoding)
  - `dialog360_whatsapp` (comms - WhatsApp sandbox)
  - `logestechs_3pl` (delivery)
- **Provider Auth Configs**
  - HMAC signing secret for `twilio_sms`
  - API keys for HERE / 360dialog (seeded sandbox values)
  - Basic credentials for Logestechs (seeded sandbox values)
- **Mapping Configs**
  - `webhook_inbound/test-basic-source::shipment.created`
  - `webhook_inbound/test-hmac-source::shipment.created`
  - `webhook_inbound/test-async-source::shipment.created`
- **Webhook Sources**
  - `test-basic-source` (partner token `EXAMPLE_PASSWORD`; stored as bcrypt hash, Shopify-style payloads)
  - `test-hmac-source` (token `EXAMPLE_PASSWORD`; HMAC validation required)
  - `test-async-source` (token `EXAMPLE_PASSWORD`; async 202 ACK with workflow-driven follow-up)
- **Webhook Policies** (`settings_versions` / `settings`)
  - Global/default: idempotency required on `event.id`; missing idempotency returns HTTP 400 unless a source policy explicitly opts out.
    - Integration tests send `event.id` and may also send `Idempotency-Key: <event.id>`.
  - HMAC source: synchronous ACK, validates `x-signature`
  - Async source: `ack.mode = accepted_async`, returns 202 with correlation id, and creates a workflow run for provider callbacks and communications
- **Client Policies** (`scope_type = 'client'`)
  - `test-client-1-1`: full pipeline (geocoding + comms + provider callback + Logestechs routing)
  - `test-client-1-2`: communications only (WhatsApp primary, SMS fallback)
  - `test-client-1-3`: geocoding enrichment only with callback notification
  - `test-client-2-1`: processing disabled (no geocoding, comms, callback, or 3PL routing)

## Seed Script Execution

```bash
ENV_FILE=config/env/.env.cloud node scripts/data/seed-test-data.js 10000  # default volume (cloud)
ENV_FILE=config/env/.env.cloud node scripts/data/seed-test-data.js 100    # smoke / CI runs (cloud)

# Local (after npm run local:env / npm run local:start)
ENV_FILE=config/env/.env.local node scripts/data/seed-test-data.js 10000
```

Repeatability:
- On a healthy local workspace the seed script is rerun-safe; this is required for `npm run local:verify`.
- If Windows/Docker port allocation is unstable, prefer a fresh explicit workspace name before debugging the seed logic itself.

Progress logs confirm each stage:

- `[1/5] Seeding organizations...`
- `[2/5] Seeding clients...`
- `[3/5] Seeding senders...`
- `[3.5/5] Seeding recipients + addresses pools...`
- `[4/5] Seeding <N> shipments...`
- `[Bonus] Seeding webhook + provider infrastructure...`
- `[5/5] Seeding workflow templates, steps, and operation metadata...`

## Post-Seed Validations

```sql
-- Providers & auth
SELECT name, provider_type, enabled FROM providers;
SELECT auth_type, credentials FROM provider_auth_configs;

-- Webhook sources (tokens hashed at rest)
SELECT source_identifier, auth_token_hash IS NOT NULL AS hash_present, mapping_config_id FROM webhook_sources;

-- Client workflow policies
SELECT c.slug, s.category, s.cached_value
FROM clients c
JOIN settings s ON s.scope_type = 'client' AND s.scope_id = c.id
WHERE c.slug IN ('test-client-1-1','test-client-1-2','test-client-1-3','test-client-2-1');

-- Settings ladder sanity
SELECT scope_type, scope_id, cached_value
FROM settings
WHERE category = 'webhook_ingest_policy';
```

Update the seed script whenever schema changes affect these tables to keep the automation deterministic.
