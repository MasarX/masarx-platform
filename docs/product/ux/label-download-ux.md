# Label Download UX (Signed URL + Refresh)

## Print, import and localized feedback acceptance (F356)

Selection `resource-print-import-feedback-browser` extends the existing F30 download and F223 batch selections only where their predicates match; it does not count their observations again or substitute batch refresh for import refresh. Bind the admitted candidate, Console/Portal build and backend identities, browser, owned disposable actor/rows/artifacts/import file, configured actions, permitted readback and cleanup. Run the applicable observations in English and Arabic on each app's actual configured surface. Missing fixtures, transient-state controls or screen-reader observation remain explicit prerequisites, not omitted passing observations.

- **Print progress and settlement:** invoke the existing print action with an owned fixture whose canonical label job/artifact readback can be observed. Bind a supported isolated control for incomplete readiness and pending job completion/artifact persistence; identify its exact request/response and invocation before use. Observe partial ready/expected count taking precedence over apparent completion (for example, two of three remains partial rather than 100%), and busy/pending feedback until the real backend completion and artifact persistence are positively read back. If an isolated response is used to expose a transient UI state, label that observation browser handling only; restore the control and require authentic final backend readback for settlement. Opening a URL is not backend settlement.
- **Print lineage and failure:** reconcile supplied async-request IDs, completion flags, label/job/version/active-version identities, print mode and artifact kind with authoritative response/readback. An optional field genuinely absent from the canonical result is recorded absent, never fabricated. Use an admitted request-scoped failure control to observe the widget's alert/assertive and atomic feedback; confirm pending/ordinary status remains polite. Inspect the actual accessibility tree and screen-reader announcement, not only source attributes. Do not generate duplicate print/reprint jobs to retry a read or manufacture lineage.
- **Import report and refresh:** on an existing configured import surface, verify a disallowed Import control is disabled with its associated trimmed accessible explanation. For an allowed owned disposable import, submit once and observe its completed report and report-ready list refresh without close-time route reload. To test refresh failure, use the F223 isolation discipline but identify this import invocation's actual follow-up list read independently: method, endpoint, resource/filter arguments and actor. Intercept only that read after the import report exists; never intercept/replay the import mutation or unrelated traffic. Require the report/drawer to remain usable, a refresh warning rather than false import failure, and no duplicate import. Remove the owned interception and use supported read-only refresh to reconcile canonical imported rows.
- **Persistent download feedback:** reuse F30's pending/single/bulk/partial/failure observations and exact artifact readback. In both locales additionally inspect the persistent assistive status region and its actual announcement through pending and outcome transitions; a toast alone is insufficient. Retain request correlation and sanitized failure behavior.
- **Tracking empty search:** through the current tracking search form, submit empty input and observe the configured localized empty-search message with no navigation. Then enter an owned valid fixture identifier and verify the intended tracking navigation. Cover the default-message contract and a supplied-message surface only where the existing configuration/caller permits them; do not invent a production setting or alter customer tracking data. If a supplied-message browser fixture is unavailable, retain the exact source parameter cases and record that browser binding missing.

Settle outstanding requests before cleanup. Remove only owned interceptions/downloads and use supported disposable fixture cleanup, preserving print/import history and uncertain remote operations. Do not publish signed URLs, credentials, customer documents or unrestricted HAR. These are manual selections, not executed results or a discovered case denominator.

For the five retained build/config selections (Console/Portal Next configs, Console/Portal Tailwind configs and shared Jest configuration), preserve the cp89 architectural disposition: current workspace package exports, Next transpilation/tracing, canonical `@masarx/ui/tailwind-preset`, and current Jest resolution replace donor static aliases/preset copies. From the canonical repository root the current package commands are `npm --prefix apps/console run build`, `npm --prefix apps/console run typecheck`, `npm --prefix apps/portal run build`, and `npm --prefix apps/portal run typecheck`; both typecheck scripts run `next typegen && tsc --noEmit`. Bind exact candidate/dependencies/environment and existing affected Jest receipts/configs; serialize build/typegen writes to each app. Command availability is not execution proof, and no obsolete alias restoration is authorized.

## Shared action and form acceptance (F370)

Selection `resource-detail-pickup-form-navigation-browser` covers the remaining F370 callers on Console and Portal. Reuse the admission, evidence restrictions and cleanup in `resource-download-browser-single-bulk`, the read-only failure isolation in `resource-batch-verified-result-refresh-browser`, and the existing build/type commands above. Reuse [F115 canonical creation acceptance](../../ops/runbooks/shipment-manual-create.md#f115-rendered-catalog-and-canonical-creation-acceptance); do not repeat its creation lineage or the download/batch matrix as new coverage.

Before acting, bind candidate/tree, app/backend identities, normal authenticated actor and capabilities, configured resource/action routes, owned disposable rows, and permitted authoritative readback. Record each actual request identity and supported fixture cleanup. Missing configured actions, scoped failure controls or fixtures remain blocked. Do not change production policy or create duplicate mutations to obtain observations.

- **Detail action and refresh:** open an owned selected detail and invoke its configured action once. Confirm the actual mutation targets that detail ID and reconcile its committed result with canonical readback. Observe the associated list refresh and server-rendered detail refresh. For warning handling, reuse F223's request-scoped follow-up-read isolation, bound independently to this detail caller; retain committed outcome, surface the stale-read warning, and prove no repeated mutation or false mutation failure. Restore the owned control and refresh read-only to reconcile.
- **Pickup form:** on each configured pickup request/wave/failure surface that exposes the selected form, record initial scope defaults and enter distinct owned values. Use an admitted deterministic validation rejection or precisely isolated request rejection that cannot conceal a committed operation; in the same form context require the entered values to remain. After restoration, submit the permitted operation once, verify authoritative success, and require reset to that surface's scoped defaults. Confirm actual list loading uses the configured pickup API-schema RPC, not an application raw-table fallback. If outcome is uncertain, read back before any retry.
- **Manual navigation:** on the F115 form, observe pristine submit state, edit a supported field, then restore its initial value and observe the pristine state again. Use the existing same-app `return_to` contract and cancel control; verify cancel makes no creation request. For an already required F115 successful creation, verify the submitted return context and resulting navigation stay within the configured app and preserve the confirmed shipment/detail identity. Use only an inert, non-navigated rejected return value when exercising the unsafe-return fallback; do not navigate to another origin or create an extra shipment solely for navigation evidence.
- **Shipment/detail visibility and review:** with an owned shipment selection, set the existing `detail_open=0` query contract and verify closed detail does not initiate its detail read or render its action footer; opening it must resolve the selected identity. Use separately admitted actors with and without the relevant correlation-read capability to check copy-control visibility and authorized clipboard content, without granting privileges or exposing another actor's identifiers. On the configured customer change-review surface, submit one owned pending decision, reconcile the actual decision, observe resolved feedback and disabled review controls, and confirm canonical server refresh rather than a browser reload or duplicate decision.
- **Nullable route workspace:** navigate the existing configured route/exception workspace with and without its optional workspace base binding where the supported caller permits it. Observe valid same-app navigation and no literal null/undefined destination. A missing alternate caller fixture is an explicit binding gap, not permission to add a production setting.

Record per-app observations, sanitized request/result and rendered-state evidence; distinguish intercepted browser handling from genuine backend outcomes. Settle outstanding requests, remove only owned interceptions/downloads/clipboard evidence, and use the admitted supported fixture cleanup without deleting audit history or uncertain operations.

Runtime source suites linked to F370 remain separate from this browser selection. The existing owned lifecycle must supply exact candidate-bound owner/start admission, Docker dependency readiness and finalization evidence. This document does not authorize manufacturing address-pool exhaustion, removing networks, bypassing ownership holds or treating source mocks as native recovery proof. The exact supported native recovery selection remains an explicit mapping gap until linked; do not silently count it passed.

## Purpose
- Provide a secure, workflow-first label download experience in Console and Portal.
- Avoid direct bucket access; use signed URLs from edge/workflow.

## Constraints
- Labels bucket is not directly readable by authenticated users.
- Signed URLs are time-limited and must be re-signed after expiry.
- Reprint is a separate request and must never be conflated with refresh.
- Label bundle metadata is read-only from UI read APIs; no direct storage paths.

## Primary flow
1. User requests "Generate label bundle" (command).
2. UI shows workflow run state (submitted -> in_review -> applied/failed).
3. When applied, UI displays label bundle metadata and a signed download link.
4. Download uses the signed URL and records download action in audit trail.

## Refresh flow (no reprint)
- If the signed URL is expired or missing, show "Refresh download link".
- Refresh calls the signer endpoint with bundle_id or file_id.
- The response returns a new signed URL and expires_at; UI replaces the previous link.

## Reprint and rebundle (separate command)
- Reprint is a distinct request with its own approval and workflow run.
- UI must differentiate Refresh (new URL) from Reprint (new bundle).
- After reprint, show the new bundle as a separate entry with its own request_id.

## States and UX handling
- generating: show progress with workflow status and request timeline.
- ready: show download link, file metadata, expires_at.
- expired: show refresh CTA and explain that reprint is not required.
- refresh_in_progress: disable CTA and show spinner.
- refresh_failed: show error category and retry guidance.
- access_denied: show policy reason and required capability.

## Error taxonomy (displayed to user)
- validation: request payload invalid (show fields, no retry without fix).
- policy_denied: capability or policy denied (show capability + policy source).
- workflow_failed: downstream system failure (show retry if policy allows).
- signer_failed: URL signing error (retry Refresh only).

## Audit and observability
- Each download and refresh is logged via decision_log or domain_events.
- The UI surfaces correlation_id and request_id for all label actions.

## Security and caching
- The signer checks each object key against the organization on the authorized record before issuing a download URL.
- Do not persist signed URLs beyond session scope.
- Do not expose storage paths; only show label bundle id and file metadata.
- Do not auto-refresh without user intent; require explicit user action.

