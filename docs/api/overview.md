# API Documentation

This folder contains the public API contract for partners/clients.

- `openapi.json` - curated OpenAPI 3.1 spec for:
  - webhook intake (`POST /v1/webhook`, async event ingestion only)
  - compatibility mirror routes (`/api/...`, DB-driven via `api_route_packs` + `api_routes`)
- `index.html` - lightweight API reference viewer (loads `openapi.json` via Scalar).

Notes:
- The runtime behavior is policy-driven (`webhook_ingest_policy`, route packs) and may vary by source/client/sender.
- The public contract stays stable; internal DB objects and workflows remain row-driven and can evolve without changing client-visible shapes.
- `/v1/webhook` is for asynchronous inbound events only; it is not the synchronous shipment command API surface.
- `/v1/webhook` replays the previously emitted ACK for duplicate `event.id` / `Idempotency-Key` values instead of creating a second intake record.
- `/api/...` routes are compatibility/provider-mirror ingress adapters, not the long-term canonical MasarX shipment write contract.
- `/api/...` route responses are decided per route policy (`proxy` or `accepted_async`); shipment materialization remains downstream of the mirror contract and reuses the authoritative shipment-create handlers after provider response processing.
- Regenerate the OpenAPI artifact from SSOT (DB route packs) with: `node scripts/docs/generate-public-openapi.js`.
- Legacy URL-token support remains accepted for onboarding compatibility, but header auth is preferred. `?token=<token>` is migration-only and deprecated; `/t/<token>/...` is compatibility-only and also treated as legacy posture.
