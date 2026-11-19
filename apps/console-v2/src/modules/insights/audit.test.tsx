// audit.test.tsx — capability-denied flow + range-window smoke + canonical
// resource reconciliation (Wave 6 W6-3) for the audit module.
//
// Wave 6 W6-3 reconciliation: this module now consumes
// `useResourceList<AuditTableChangeRow>('audit_table_changes')` against the
// canonical SSOT (public.audit_table_changes from
// supabase/migrations/202512011211_audit_table_changes.sql). The capability
// key remains `audit_log.read` (canonical, declared in
// supabase/migrations/202601022113_access_control_policy_core.sql:215,241).

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { AuditModule } from './audit';
import { ui_list_resource_v1 } from '@/lib/data-source';

describe('AuditModule', () => {
  beforeEach(() => {
    // Each test gets a fresh stash so view persistence doesn't leak.
    localStorage.clear();
  });

  it('renders the capability-denied StateView when the role lacks audit permission', async () => {
    // The data-source's ui_list_resource_v1 fail-closes against
    // capability_read='audit_log.read' from the registry. With a constrained
    // role mock the IdentityProvider exposes a narrow capability set; the
    // page surface should reflect the audit_log.read gate.
    renderWithProviders(<AuditModule />, { capabilities: ['shipments.read'] });
    await waitFor(() => {
      // Either the denied state or its friendly permission hint should be visible.
      const denied = screen.queryByText(/audit activity|denied/i);
      expect(denied).toBeTruthy();
      expect(document.body.textContent ?? '').not.toMatch(/audit_log\.read/);
    });
  });

  it('renders the audit log surface (page header + window pill) when capability is present', async () => {
    renderWithProviders(<AuditModule />, { capabilities: ['all'] });
    // Page header titleAccent + plain.
    await waitFor(() => {
      expect(screen.getByText('Audit')).toBeTruthy();
    });
    // Window pill from J pass.
    expect(screen.getByText(/window · /)).toBeTruthy();
  });

  it('renders the operator-facing audit activity pill without raw registry names', async () => {
    renderWithProviders(<AuditModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(screen.getByText(/Audit activity · governed access/)).toBeTruthy();
      expect(document.body.textContent ?? '').not.toMatch(/audit_table_changes · audit_log\.read/i);
    });
  });
});

describe('audit_table_changes resource (Wave 6 W6-3)', () => {
  it('is registered in ui_read_registry and returns rows in canonical shape', async () => {
    const result = await ui_list_resource_v1<{
      id?: string;
      schema_name?: string;
      table_name?: string;
      op?: string;
      pk?: unknown;
      changed_by?: string;
      created_at?: string;
    }>('audit_table_changes', { page_size: 100 });
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      // SSOT columns from public.audit_table_changes
      // (supabase/migrations/202512011211_audit_table_changes.sql:10-24).
      expect(row.id).toBeDefined();
      expect(row.schema_name).toBeDefined();
      expect(row.table_name).toBeDefined();
      expect(['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']).toContain(row.op);
      expect(row.changed_by).toBeDefined();
      expect(row.created_at).toBeDefined();
      // Canonical: pk is JSONB-shaped (e.g. { id: 'shp_…' }).
      expect(typeof row.pk).toBe('object');
    }
  });
});
