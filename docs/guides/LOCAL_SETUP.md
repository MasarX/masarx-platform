# Local development

Use the Node.js version specified in the root `.nvmrc` and install the locked npm dependencies from the root. Use a disposable database and generated test data for work that writes application state. Keep environment files and credentials out of version control.

Run the application you are changing from the repository root.

| Application | Command |
| --- | --- |
| Console V2 | `npm run dev:console:v2` |
| Console | `npm run dev:console` |
| Portal | `npm run dev:portal` |
| FieldOps | `npm run dev:fieldops` |
| Landing site | `npm run dev:landing` |

Use separate backend configuration for each isolated checkout. Verify the configured database and API target before seeding data, applying migrations, or running integration tests. The [testing guide](TESTING_GUIDE.md) identifies which suites require a backend.

The `privileged_session_assurance` feature flag controls whether the Data API requires authenticator verification for privileged sessions. When enabled, sign in to Console V2, Console, or Portal, then use the setup QR code or manual key to add the account to an authenticator app. Enter the six-digit code to finish setup or verify a subsequent sign-in. The Supabase Auth [configuration](../../supabase/config.toml) sets the password minimum for new and changed passwords.

## Authenticator rollout and rollback

Keep the flag off until the updated frontends are deployed and hosted TOTP enrollment and verification are confirmed. Qualify privileged enrollment, repeat sign-in, ordinary sessions, invitation activation, and Edge requests on an isolated non-production target. Use the feature flag controls to activate and deactivate the requirement. This affects the Data API and the three associated table policies, including the UI executor. Verify Storage and Realtime separately.

If privileged access fails, an operator with a verified session can turn the flag off. If no operator can sign in, use the approved database operation for the affected environment and record the incident, before and after values, actor, and reason. The row can be disabled without changing grants, removing policies, or restarting PostgREST.

```sql
UPDATE public.feature_flags
SET enabled = false, updated_at = now()
WHERE name = 'privileged_session_assurance'
  AND scope_type = 'global'
  AND scope_id IS NULL
RETURNING name, enabled;
```

Verify one row returns with `enabled = false`, then verify a privileged synthetic session and the application rollback. To recover an individual lost authenticator, have support verify the account owner's identity and route the reset through a separately authorized Auth administrator. Reset only the confirmed lost factor, revoke the affected sessions, and confirm fresh enrollment and verification. Keep the setup key and recovery evidence out of logs.

## Local label rendering over HTTP

Set `EDGE_ENVIRONMENT=local` and `LABEL_RENDERER_INVOKE_URL` in the local Edge runtime. In the isolated database, have a database superuser set `app.local_label_renderer_url` to the same exact URL with `ALTER DATABASE <local_database> SET app.local_label_renderer_url = '<local_invoke_url>'`. Use that URL in the global `label_provider` settings and configure the signing key and gateway JWT for the local project. The URL must end in `/functions/v1/label-renderer`. Set this database parameter before running `0zz_label_renderer_url_policy_v1.sql` locally.
