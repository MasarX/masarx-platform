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
- Webhook shipment defaults are source-bound and fail closed: shipment-creating events require an active sender/client binding, an event mapping that resolves to a typed shipment intent such as `shipment.create`, terminal inbox readback, and workflow/shipment lineage before Console can treat the event as successful shipment intake.
- Webhook update defaults should stay typed rather than generic: prefer `update.status`, `update.address`, `update.driver`, `update.action`, or `update.attachment`; generic `shipment.updated` is compatibility-only and must resolve to exactly one typed intent.
- Webhook cancellation defaults use the canonical event name `shipment.canceled` (`shipment.cancelled` is treated only as a compatibility spelling during mapping), require a cancellation reason, and must resolve to the workflow-backed shipment cancel path before Console can show terminal success.
- Webhook reschedule defaults should use `shipment.rescheduled` with the requested delivery date/window and must resolve to the workflow-backed shipment reschedule path; until a tenant mapping explicitly enables it, reschedule payloads should remain failed/queued for mapping review instead of silently mutating shipment truth.
- `/api/...` routes are compatibility/provider-mirror ingress adapters, not the long-term canonical MasarX shipment write contract.
- `/api/...` route responses are decided per route policy (`proxy` or `accepted_async`); shipment-creating routes default to workflow-engine processing, provider dispatch, canonical shipment readback, and Console-visible request/workflow/shipment lineage.
- Regenerate the OpenAPI artifact from SSOT (DB route packs) with: `node scripts/docs/generate-public-openapi.js`.
- Legacy URL-token support remains accepted for onboarding compatibility, but header auth is preferred. `?token=<token>` is migration-only and deprecated; `/t/<token>/...` is compatibility-only and also treated as legacy posture.
