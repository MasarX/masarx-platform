# Label Download UX (Signed URL + Refresh)

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
- Do not persist signed URLs beyond session scope.
- Do not expose storage paths; only show label bundle id and file metadata.
- Do not auto-refresh without user intent; require explicit user action.
