# Label renderer credentials

`label_provider` settings hold renderer URLs and configuration. Credential values
are stored in Vault; each provider carries only an `invoke_secret_ref` reference.
Database write guards seal inline `invoke_secret` input before settings versions
or caches are stored. Historical settings values are converted by migration.

Trusted provisioning uses `upsert_label_provider_settings_v1`. Authenticated
settings changes retain the existing scope and capability checks in
`request_settings_change_v1`. Its internal writer accepts an explicit replacement
credential or preserves a preview marker from the same scope. A new tenant
override requires its own credential; it cannot copy a global or foreign reference.

Scoped previews expose `REDACTED` for configured credentials. Preview markers are
reserved and cannot become stored credential values. Existing tenant URL-only
changes preserve the tenant credential without returning it to the form.

The restricted `resolve_label_renderer_invoke_config_v1` and
`resolve_label_renderer_invoke_request_v1` functions resolve Vault references for
trusted synchronous and asynchronous dispatch. Cron readiness uses the same
credential resolver. Browser roles cannot execute the raw credential helpers.
Settings audit snapshots and legacy cache projections are redacted as well.
