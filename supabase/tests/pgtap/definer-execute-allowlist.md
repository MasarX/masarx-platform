# SECURITY DEFINER EXECUTE allow-list

The SQL allow-list in `045a_definer_execute_allowlist.sql` covers effective
`EXECUTE` for `anon` and `authenticated` on SECURITY DEFINER functions in
`public` and `api`. `PUBLIC` and inherited grants count even when the caller
has no schema `USAGE`. Each row records an exact function signature, the allowed
roles, a reason and the function owner.

Entries must use the exact `p.oid::regprocedure::text` signature with its
schema qualifier. CI prints the schema-qualified catalog signature to copy
into the allow-list, including the exact argument types.

Bundles that add a definer function callable by `anon` or `authenticated` must
add an explicit `GRANT EXECUTE` to each intended caller role and an allow-list
entry with a reason. Revoke any broader grant. A PR that revokes EXECUTE from
any listed role must remove that role from the entry in the same PR or CI
fails with the signature and role. Delete the entry when removing its last
role. CI also fails on entries for functions that were dropped or are no
longer SECURITY DEFINER.

Reasons prefixed with `audit-static:` come from the static audit model.
Entries labeled `unreviewed: pending audit L-secdef-misses` were found in
the hosted catalog and await per-function review. Their owners are marked
`unverified` because the grant diagnostics did not include owners. Only
a later per-function review can promote an entry to `reviewed:`.
Pre-existing entries track grants pending remediation or follow-up review.

## Limits

- Approval is keyed by signature. `CREATE OR REPLACE` keeps the approval even
  when the function body changes.
- The owner column is informational. The guard does not verify it.
- Procedures (`prokind = 'p'`) are outside the guard's scope.
- Extension-owned functions are out of scope. Extensions are reviewed separately.

## pgTAP mutations

Hosted pgTAP checks the real catalog first. In the same transaction it
creates a throwaway definer with EXECUTE for `authenticated`, then verifies
that the unlisted-grant check returns that grant and the stale-role check
returns `anon` when both roles are listed. With only `authenticated` listed,
both checks must return no rows for that signature. The planted assertions
query only the fixture signature. The transaction rolls back the function,
its grants and the temporary allow-list.

On a disposable database, insert a synthetic SECURITY DEFINER function in
`public` or `api` inside the test transaction just before the assertion. Revoke
`EXECUTE` from `PUBLIC`, `anon` and `authenticated`, then grant it to one
caller role. Expect a failure naming the signature and role. Add an entry for
that signature and role and expect a pass. Grant the other role and expect a
failure naming the additional role. An entry for a different overload must
also fail. With a valid entry, drop the function, switch it to SECURITY INVOKER
or revoke EXECUTE from one listed role while another retains it in separate
runs. Expect the stale check to name the signature, role and why the entry
is stale. Use a temporary copy of the test for mutations and roll back.

## Hosted catalog findings

The first [hosted pgTAP replay](https://github.com/MasarX/masarx-platform/actions/runs/44792347491/job/136483098616)
reported 58 unlisted grant rows. They comprise 33 rows on corrected
signatures, six on excluded extension members, and 19 new application
grant rows labeled `unreviewed: pending audit L-secdef-misses`.

| Catalog signature | Roles | Disposition |
| --- | --- | --- |
| `api.add_support_tag_v1(jsonb)` | authenticated | Unreviewed |
| `api.assign_support_case_v1(jsonb)` | authenticated | Unreviewed |
| `api.bulk_assign_support_cases_v1(jsonb)` | authenticated | Unreviewed |
| `api.bulk_resolve_support_cases_v1(jsonb)` | authenticated | Unreviewed |
| `api.bulk_toggle_feature_flags_v1(jsonb)` | authenticated | reviewed: caller check assert_capability_v1 feature_flags.write platform scope (SEC-DEFINER-3) |
| `api.compute_cod_payment_collection_summary_v1(uuid, uuid, text, uuid, timestamp with time zone, timestamp with time zone)` | authenticated | Corrected signature, original reason retained |
| `api.create_feature_flag_v1(jsonb)` | authenticated | reviewed: caller check assert_capability_v1 feature_flags.write platform scope (SEC-DEFINER-3) |
| `api.create_support_case_v1(jsonb)` | authenticated | Unreviewed |
| `api.engage_kill_switch_v1(jsonb)` | authenticated | reviewed: caller check assert_capability_v1 feature_flags.write platform scope (SEC-DEFINER-3) |
| `api.integration_plugin_rotate_credentials_v1(uuid, text, jsonb, timestamp with time zone, text)` | authenticated | Unreviewed |
| `api.release_kill_switch_v1(jsonb)` | authenticated | reviewed: caller check assert_capability_v1 feature_flags.write platform scope (SEC-DEFINER-3) |
| `api.reopen_support_case_v1(jsonb)` | authenticated | Unreviewed |
| `api.resolve_support_case_v1(jsonb)` | authenticated | Unreviewed |
| `api.send_support_message_v1(jsonb)` | authenticated | Unreviewed |
| `api.set_rollout_v1(jsonb)` | authenticated | reviewed: caller check assert_capability_v1 feature_flags.write platform scope (SEC-DEFINER-3) |
| `api.toggle_feature_flag_v1(jsonb)` | authenticated | reviewed: caller check assert_capability_v1 feature_flags.write platform scope (SEC-DEFINER-3) |
| `api.update_feature_flag_v1(jsonb)` | authenticated | reviewed: caller check assert_capability_v1 feature_flags.write platform scope (SEC-DEFINER-3) |
| `api.update_support_case_v1(jsonb)` | authenticated | Unreviewed |
| `public.build_workflow_schedule_trigger_context_v1(workflow_schedule_triggers, text, uuid, timestamp with time zone, uuid)` | anon, authenticated | Corrected signature, original reason retained |
| `public.compute_cod_payment_collection_summary_v1(uuid, uuid, text, uuid, timestamp with time zone, timestamp with time zone)` | authenticated | Corrected signature, original reason retained |
| `public.compute_delivery_attempt_projection_v1(uuid, uuid, uuid, uuid, text, text, jsonb, timestamp with time zone)` | anon, authenticated | Corrected signature, original reason retained |
| `public.compute_shipment_promise_v1(timestamp with time zone, text, text, jsonb, date)` | anon, authenticated | Corrected signature, original reason retained |
| `public.compute_shipment_promise_v2(timestamp with time zone, text, jsonb, jsonb, date)` | anon, authenticated | Corrected signature, original reason retained |
| `public.integration_connection_rotate_v1(uuid, jsonb, boolean, timestamp with time zone)` | authenticated | Corrected signature, original reason retained |
| `public.integration_connection_upsert_v1(uuid, text, uuid, uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, text, boolean, timestamp with time zone)` | authenticated | Corrected signature, original reason retained |
| `public.integration_plugin_rotate_credentials_v1(uuid, text, jsonb, timestamp with time zone, text)` | authenticated | Corrected signature, original reason retained |
| `public.list_usage_events_v1(uuid, text, timestamp with time zone, timestamp with time zone, integer, integer)` | authenticated | Corrected signature, original reason retained |
| `public.marketplace_availability_upsert_v1(uuid, timestamp with time zone, timestamp with time zone, text, jsonb, jsonb)` | anon, authenticated | Corrected signature, original reason retained |
| `public.marketplace_award_offer_v1(uuid, text, jsonb, timestamp with time zone, jsonb)` | authenticated | Corrected signature, original reason retained |
| `public.marketplace_offer_counter_v1(uuid, text, jsonb, jsonb, timestamp with time zone, jsonb)` | anon, authenticated | Corrected signature, original reason retained |
| `public.marketplace_offer_submit_v1(uuid, text, jsonb, jsonb, timestamp with time zone, jsonb)` | authenticated | Corrected signature, original reason retained |
| `public.marketplace_request_create_v1(text, text, text, jsonb, jsonb, jsonb, timestamp with time zone, jsonb)` | authenticated | Corrected signature, original reason retained |
| `public.record_webhook_ack(uuid, uuid, text, integer, jsonb, jsonb, text, text, jsonb, timestamp with time zone, text, uuid, text, uuid, integer, uuid)` | anon, authenticated | Corrected signature, original reason retained |
| `public.request_settings_change_v1(text, text, uuid, jsonb, text, timestamp with time zone)` | anon, authenticated | Corrected signature, original reason retained |
| `public.st_estimatedextent(text, text)` | anon, authenticated | Extension member, excluded |
| `public.st_estimatedextent(text, text, text)` | anon, authenticated | Extension member, excluded |
| `public.st_estimatedextent(text, text, text, boolean)` | anon, authenticated | Extension member, excluded |
| `public.submit_fieldops_eod_recon_v1(integer, integer, numeric, numeric, text, uuid, uuid)` | authenticated | Unreviewed |
| `public.submit_fieldops_reschedule_v1(uuid, timestamp with time zone, timestamp with time zone, text, uuid)` | authenticated | Corrected signature, original reason retained |
| `public.touch_recipient_channel_session(uuid, text, timestamp with time zone)` | anon, authenticated | Corrected signature, original reason retained |
| `public.ui_execute_shipment_update_geocode_v1_base(text, text, text[], text, integer, jsonb)` | authenticated | Unreviewed |
| `public.ui_request_access_policy_change_v1(jsonb, text, uuid, text, timestamp with time zone)` | authenticated | Corrected signature, original reason retained |
| `public.upsert_provider_usage_tracking(uuid, uuid, uuid, uuid, text, timestamp with time zone, integer, numeric)` | anon, authenticated | Corrected signature, original reason retained |

## Feature flag implementation entries

| Catalog signature | Roles | Disposition |
| --- | --- | --- |
| `public.bulk_toggle_feature_flags_v1(jsonb)` | authenticated | reviewed: caller check assert_capability_v1 feature_flags.write platform scope (SEC-DEFINER-3) |
| `public.create_feature_flag_v1(jsonb)` | authenticated | reviewed: caller check assert_capability_v1 feature_flags.write platform scope (SEC-DEFINER-3) |
| `public.engage_kill_switch_v1(jsonb)` | authenticated | reviewed: caller check assert_capability_v1 feature_flags.write platform scope (SEC-DEFINER-3) |
| `public.release_kill_switch_v1(jsonb)` | authenticated | reviewed: caller check assert_capability_v1 feature_flags.write platform scope (SEC-DEFINER-3) |
| `public.set_rollout_v1(jsonb)` | authenticated | reviewed: caller check assert_capability_v1 feature_flags.write platform scope (SEC-DEFINER-3) |
| `public.toggle_feature_flag_v1(jsonb)` | authenticated | reviewed: caller check assert_capability_v1 feature_flags.write platform scope (SEC-DEFINER-3) |
| `public.update_feature_flag_v1(jsonb)` | authenticated | reviewed: caller check assert_capability_v1 feature_flags.write platform scope (SEC-DEFINER-3) |
