export interface RuleWorkflowTemplateScopeRow {
  id: string;
  name?: string;
  scope_type?: string | null;
  scope_id?: string | null;
  template_key?: string | null;
  trigger?: string | null;
  notes?: string | null;
}

function normalizedScopeType(row: RuleWorkflowTemplateScopeRow): string {
  return String(row.scope_type ?? '').trim().toLowerCase();
}

export function isRuleWorkflowTemplateVisibleForTenant(
  row: RuleWorkflowTemplateScopeRow,
  tenantId?: string | null,
): boolean {
  const scopeType = normalizedScopeType(row);
  const scopeId = row.scope_id == null ? '' : String(row.scope_id);

  if (scopeType === 'global' || !scopeId) return true;
  if (!tenantId) return false;
  return scopeType === 'tenant' && scopeId === tenantId;
}

export function sortRuleWorkflowTemplates<T extends RuleWorkflowTemplateScopeRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const aScope = normalizedScopeType(a);
    const bScope = normalizedScopeType(b);
    if (aScope !== bScope) {
      if (aScope === 'global') return -1;
      if (bScope === 'global') return 1;
    }
    return String(a.name ?? a.template_key ?? a.id).localeCompare(
      String(b.name ?? b.template_key ?? b.id),
    );
  });
}

export function isRuleWorkflowTemplateRelevantForWebhookEvent(
  row: RuleWorkflowTemplateScopeRow,
  eventType?: string | null,
  selectedTemplateId?: string | null,
): boolean {
  if (selectedTemplateId && row.id === selectedTemplateId) return true;

  const normalizedEvent = String(eventType ?? '').trim().toLowerCase();
  const webhookEvent = normalizedEvent ? `webhook.${normalizedEvent}` : '';
  const trigger = String(row.trigger ?? '').trim().toLowerCase();

  if (normalizedEvent && (trigger === normalizedEvent || trigger === webhookEvent)) return true;

  const rowText = [
    row.name,
    row.template_key,
    row.trigger,
    row.notes,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return rowText.includes('webhook');
}
