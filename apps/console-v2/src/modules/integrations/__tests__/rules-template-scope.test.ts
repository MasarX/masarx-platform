import { describe, expect, it } from 'vitest';
import {
  isRuleWorkflowTemplateRelevantForWebhookEvent,
  isRuleWorkflowTemplateVisibleForTenant,
  sortRuleWorkflowTemplates,
  type RuleWorkflowTemplateScopeRow,
} from '@/modules/integrations/rules-template-scope';

describe('rules-template-scope', () => {
  const tenantId = 'tenant-first';

  it('allows global and active-tenant workflow templates for webhook rule picking', () => {
    expect(
      isRuleWorkflowTemplateVisibleForTenant(
        { id: 'global-template', scope_type: 'global', scope_id: null },
        tenantId,
      ),
    ).toBe(true);
    expect(
      isRuleWorkflowTemplateVisibleForTenant(
        { id: 'tenant-template', scope_type: 'tenant', scope_id: tenantId },
        tenantId,
      ),
    ).toBe(true);
  });

  it('hides other-tenant workflow templates from the webhook rule picker', () => {
    expect(
      isRuleWorkflowTemplateVisibleForTenant(
        { id: 'other-template', scope_type: 'tenant', scope_id: 'tenant-other' },
        tenantId,
      ),
    ).toBe(false);
  });

  it('keeps canonical global templates discoverable before tenant clones', () => {
    const rows: RuleWorkflowTemplateScopeRow[] = [
      { id: 'tenant-template', name: 'Tenant Clone', scope_type: 'tenant', scope_id: tenantId },
      { id: 'global-template', name: 'webhook_intake_v1', scope_type: 'global', scope_id: null },
    ];

    expect(sortRuleWorkflowTemplates(rows).map((row) => row.id)).toEqual([
      'global-template',
      'tenant-template',
    ]);
  });

  it('keeps webhook rule picking scoped to webhook-relevant templates', () => {
    const rows: RuleWorkflowTemplateScopeRow[] = [
      { id: 'webhook-entry', name: 'webhook_intake_v1' },
      { id: 'webhook-trigger', name: 'Exampleparcel KSA inbound intake', trigger: 'webhook.shipment.created' },
      { id: 'webhook-notes', name: 'shipment_update_status_v1', notes: 'Logestechs status webhook mirror workflow' },
      { id: 'bank', name: 'bank_deposit_reconciliation_v2', trigger: 'finance.bank_recon.start' },
    ];

    expect(
      rows
        .filter((row) => isRuleWorkflowTemplateRelevantForWebhookEvent(row, 'shipment.created'))
        .map((row) => row.id),
    ).toEqual(['webhook-entry', 'webhook-trigger', 'webhook-notes']);
  });

  it('keeps an existing selected template visible while editing legacy rules', () => {
    expect(
      isRuleWorkflowTemplateRelevantForWebhookEvent(
        { id: 'legacy-selected', name: 'shipment_amend_cancel_v1', trigger: 'shipment.amend_cancel' },
        'shipment.updated',
        'legacy-selected',
      ),
    ).toBe(true);
  });
});
