// lookups.test.ts — coverage for the canonical lookup catalog SSOT
// (W27-cycle-D Platform+Insights closure additions).
//
// Verifies:
//   • New lookup categories landed by the W27-cycle-D closure are present
//     and carry the brief-specified tones (email_auth_audit_status,
//     trace_event_source).
//   • The pre-existing `tenant_signup_request_status` and `api_status_class`
//     catalogs (W50 / W54-D) still expose the canonical values consumed by
//     the W27-cycle-D fixes (organizations + api-gateway).
//   • The existing `alert_trigger_status` catalog tones now align with the
//     operator severity expectation (`fired:danger`, `acknowledged:warn`,
//     `resolved:good`).
//   • `workflow_run_status` retains the canonical SSOT (`succeeded`, not
//     the legacy `'completed'` alias).

import { describe, expect, it } from 'vitest';
// @ts-expect-error - seed-raw/*.js has no declaration file by design
import * as lookupsModule from '../seed-raw/lookups.js';

// platform-alerts.js mutates `lookups` via Object.assign on import, so import
// it eagerly to ensure the alert_trigger_status row is materialised.
import '../seed-raw/platform-alerts.js';
interface LookupRow {
  value: string;
  label?: string;
  tone?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

const { lookupRow, lookups, lookup_definitions } = lookupsModule as {
  lookupRow: (category: string, value: string) => LookupRow | null;
  lookups: Record<string, LookupRow[]>;
  lookup_definitions: Array<{ category: string }>;
};

describe('seed-raw/lookups · W27-cycle-D Platform+Insights catalog additions', () => {
  it('lookupRow returns the matching row with label and tone', () => {
    const row = lookupRow('workflow_run_status', 'succeeded');
    expect(row).toBeTruthy();
    expect(row?.label).toBe('Succeeded');
    expect(row?.tone).toBe('good');
  });

  it('lookupRow returns null for unknown values (fail-loud default)', () => {
    expect(lookupRow('workflow_run_status', 'completed')).toBeNull();
    expect(lookupRow('workflow_run_status', 'unknown_state')).toBeNull();
  });

  it('lookupRow returns null for unknown categories', () => {
    expect(lookupRow('not_a_real_category', 'pending')).toBeNull();
  });

  it('tenant_signup_request_status mirrors the canonical CHECK constraint', () => {
    expect(lookupRow('tenant_signup_request_status', 'pending')?.tone).toBe('warn');
    expect(lookupRow('tenant_signup_request_status', 'approved')?.tone).toBe('good');
    expect(lookupRow('tenant_signup_request_status', 'rejected')?.tone).toBe('danger');
    // Sanity: the CHECK enum has exactly three values (pending/approved/
    // rejected). An additional value would flag a drift with backend SSOT.
    const allValues = lookups.tenant_signup_request_status.map((r) => r.value);
    expect(allValues.sort()).toEqual(['approved', 'pending', 'rejected']);
  });

  it('api_status_class catalog covers the four HTTP class buckets', () => {
    expect(lookupRow('api_status_class', '2xx')?.tone).toBe('good');
    expect(lookupRow('api_status_class', '3xx')?.tone).toBe('neutral');
    expect(lookupRow('api_status_class', '4xx')?.tone).toBe('warn');
    expect(lookupRow('api_status_class', '5xx')?.tone).toBe('danger');
  });

  it('email_auth_audit_status maps the policy traffic-light states to tones', () => {
    expect(lookupRow('email_auth_audit_status', 'green')?.tone).toBe('good');
    expect(lookupRow('email_auth_audit_status', 'yellow')?.tone).toBe('warn');
    expect(lookupRow('email_auth_audit_status', 'red')?.tone).toBe('danger');
  });

  it('trace_event_source covers observability_events.event_source values', () => {
    expect(lookupRow('trace_event_source', 'decision_log')?.tone).toBe('info');
    expect(lookupRow('trace_event_source', 'audit_log')?.tone).toBe('neutral');
    expect(lookupRow('trace_event_source', 'error_log')?.tone).toBe('danger');
    expect(lookupRow('trace_event_source', 'system_log')?.tone).toBe('neutral');
    expect(lookupRow('trace_event_source', 'api_call_log')?.tone).toBe('neutral');
  });

  it('alert_trigger_status assigns danger to fired (W27-cycle-D §4 alignment)', () => {
    // Brief specified fired(danger)/acknowledged(warn)/resolved(good).
    expect(lookupRow('alert_trigger_status', 'fired')?.tone).toBe('danger');
    expect(lookupRow('alert_trigger_status', 'acknowledged')?.tone).toBe('warn');
    expect(lookupRow('alert_trigger_status', 'resolved')?.tone).toBe('good');
  });

  it('workflow_run_status retains the canonical "succeeded" SSOT (no legacy "completed")', () => {
    const values = lookups.workflow_run_status.map((r) => r.value);
    expect(values).toContain('succeeded');
    // The legacy alias `completed` MUST NOT be in the canonical workflow_run
    // catalog — projections that emit it must normalize to `succeeded` first.
    expect(values).not.toContain('completed');
  });

  it('task_type rows expose Console V2 operator route targets', () => {
    expect(lookupRow('task_type', 'dispatch_exception_review')?.metadata).toMatchObject({
      console_path: '/operate/exceptions',
      console_focus_param: 'task',
      console_focus_source: 'id',
    });
    expect(lookupRow('task_type', 'route_stop_execute')?.metadata).toMatchObject({
      console_path: '/operate/dispatch',
      console_focus_param: 'route_stop',
      console_focus_source: 'resource_id',
    });
  });

  it('mapping_target declares required output paths for shipment create remediation', () => {
    const metadata = lookupRow('mapping_target', 'shipments.create')?.metadata;
    expect(metadata).toMatchObject({
      target_resource: 'shipments',
      target_action: 'create',
      required_output_paths: expect.arrayContaining([
        expect.objectContaining({ path: 'recipient.name' }),
        expect.objectContaining({ path: 'recipient.phone' }),
        expect.objectContaining({ path: 'address.line1' }),
        expect.objectContaining({ path: 'address.city' }),
        expect.objectContaining({ path: 'address.country_code' }),
      ]),
    });
  });

  it('mapping_target exposes client API mutation breadth defaults', () => {
    expect(lookupRow('mapping_target', 'shipments.create')?.metadata).toMatchObject({
      target_resource: 'shipments',
      target_action: 'create',
      canonical_intent: 'shipment.create',
      workflow_template_name: 'webhook_shipment_create_v1',
      api_gateway_workflow_template_name: 'api_gateway_shipment_create_default_v1',
      workflow_templates_by_mapping_type: {
        webhook_inbound: 'webhook_shipment_create_v1',
        api_gateway_inbound: 'api_gateway_shipment_create_default_v1',
      },
      allowed_mapping_types: expect.arrayContaining(['api_gateway_inbound', 'webhook_inbound']),
    });
    expect(lookupRow('mapping_target', 'shipments.update')?.metadata).toMatchObject({
      target_resource: 'shipments',
      target_action: 'update',
      canonical_intent: 'shipment.update',
      workflow_template_name: 'api_gateway_shipment_update_default_v1',
      allowed_mapping_types: expect.arrayContaining(['api_gateway_inbound']),
    });
    expect(lookupRow('mapping_target', 'shipments.delete')?.metadata).toMatchObject({
      target_resource: 'shipments',
      target_action: 'delete',
      canonical_intent: 'shipment.delete',
      workflow_template_name: 'api_gateway_shipment_cancel_default_v1',
      allowed_mapping_types: expect.arrayContaining(['api_gateway_inbound']),
    });
    expect(lookupRow('mapping_target', 'shipments.cancel')?.metadata).toMatchObject({
      target_resource: 'shipments',
      target_action: 'cancel',
      canonical_intent: 'shipment.delete',
      workflow_template_name: 'shipment_delete_v1',
      api_gateway_workflow_template_name: 'api_gateway_shipment_cancel_default_v1',
      workflow_templates_by_mapping_type: {
        webhook_inbound: 'shipment_delete_v1',
        api_gateway_inbound: 'api_gateway_shipment_cancel_default_v1',
      },
      allowed_mapping_types: expect.arrayContaining(['api_gateway_inbound', 'webhook_inbound']),
    });
    expect(lookupRow('mapping_target', 'shipments.reschedule')?.metadata).toMatchObject({
      target_resource: 'shipments',
      target_action: 'reschedule',
      canonical_intent: 'shipment.reschedule',
      workflow_template_name: 'shipment_reschedule_v1',
      allowed_mapping_types: expect.arrayContaining(['api_gateway_inbound', 'webhook_inbound']),
    });
  });

  it('new W27-cycle-D categories are registered in lookup_definitions metadata', () => {
    const categories = new Set(lookup_definitions.map((d) => d.category));
    expect(categories.has('email_auth_audit_status')).toBe(true);
    expect(categories.has('trace_event_source')).toBe(true);
  });
});
