import { describe, it, expect } from 'vitest';
import * as api from './api';

describe('lib/api', () => {
  it('exports the canonical RPC surface', () => {
    expect(typeof api.ui_list_resource_v1).toBe('function');
    expect(typeof api.ui_list_resource_complete).toBe('function');
    expect(typeof api.ui_get_resource_v1).toBe('function');
    expect(typeof api.shipment_amend_cancel_v1).toBe('function');
    expect(typeof api.ui_solve_route_plan_v1).toBe('function');
    expect(typeof api.ui_publish_route_plan_v1).toBe('function');
    expect(typeof api.start_workflow_run).toBe('function');
    expect(typeof api.progress_workflow_run).toBe('function');
    expect(typeof api.record_scan_event_v1).toBe('function');
  });

  it('ui_list_resource_v1 returns rows + total shape', async () => {
    const res = await api.ui_list_resource_v1('shipments');
    expect(res).toHaveProperty('rows');
    expect(res).toHaveProperty('total');
    expect(Array.isArray(res.rows)).toBe(true);
  });

  it('listDecisionLog returns an array', async () => {
    const rows = await api.listDecisionLog({ limit: 3 });
    expect(Array.isArray(rows)).toBe(true);
  });

  it('hasCapability returns boolean', () => {
    expect(typeof api.hasCapability('any.capability')).toBe('boolean');
  });
});
