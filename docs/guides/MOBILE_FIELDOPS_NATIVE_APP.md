# Mobile Field Ops Native App

This file is intentionally a **pointer** to the canonical guide (single source of truth):

- `docs/product/guides/mobile-field-ops-native-app.md`

We avoid duplicating architecture/policy text across `docs/` trees. Use the canonical guide for:
- SSOT contracts (navigation/read/command registries)
- Offline outbox + idempotency rules
- Security posture (MASVS alignment) + policy ladder usage
- How to add new mobile features without hardcoding

Developer entrypoints:
- `npm run dev:fieldops`
- Shared packages: `@masarx/auth/mobile`, `@masarx/api/mobile`, `@masarx/mobile-core`
