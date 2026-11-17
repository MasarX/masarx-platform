# Workflow & Plugin Handlers – Use Case Matrix

This matrix maps each workflow handler to its primary use cases, inputs/outputs, and automated coverage. It complements runbooks and keeps tests aligned with our plugin architecture.

## Handlers

| Handler | Use Case | Inputs (metadata/context) | Outputs | Tests | Docs |
| --- | --- | --- | --- | --- | --- |
| `start_workflow` | Start a sub-workflow | `child_workflow_template_id`, `context_patch` | Child run id | `tests/integration/workflows/subworkflow-handlers.test.js` | Runbook |
| `wait_workflow` | Wait for child run | `child_workflow_run_id`, `poll_interval_seconds` | Pending/completed/failed | `tests/integration/workflows/subworkflow-handlers.test.js` | Runbook |
| `geocode_cache` | Geocode cache read/write | `action`, optional `geocode` | Context patch, no job | `tests/integration/geocoding.workflow.test.js` | Geocoding runbook |
| `geo_coordinate` | Provided coordinate validation | `validate_bounds` | Context patch, no job | `tests/integration/geocoding.workflow.test.js` | Geocoding runbook |
| `geo_normalize` | Normalize address | context-derived | Context patch, no job | `tests/integration/geocoding.workflow.test.js` | Geocoding runbook |
| `provider_dispatch` | Build provider-specific overrides | provider policy | `override_url` in step metadata | `tests/integration/geocoding.workflow.test.js` | Geocoding runbook |
| `geo_decision` | Choose success/fallback/manual | thresholds + attempts | Decision + context patch | `tests/integration/geocoding.workflow.test.js` | Geocoding runbook |
| `geocode_manual_review_enqueue` | Queue manual review | reason + address | Task row | `tests/integration/geocoding.workflow.test.js` | Geocoding runbook |

Notes
- Operation template `call_type` is enforced and propagated (pgTAP: `supabase/tests/pgtap/010_operation_templates_call_type.sql`).
- Handler registry resolution is enforced (pgTAP: `supabase/tests/pgtap/007_workflow_handlers.sql`).
