// bindings.arabic.test.tsx: the workflow bindings page renders its own copy in Arabic; event names and counts stay as data.
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { BindingsModule } from '@/modules/workflows/bindings';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/workflow-bindings';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('BindingsModule in Arabic', () => {
  it('renders the tabs and the event catalog headings in Arabic', async () => {
    renderWithProviders(<BindingsModule />, { locale: 'ar', capabilities: ['all'] });

    expect(await screen.findByRole('tab', { name: ar.workflowBindings.tabs.bindings.aria })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll('.wf-bindings-events .section-eyebrow').length).toBeGreaterThan(0));
    expect(await screen.findByRole('button', { name: new RegExp(`^${ar.workflowBindings.bindingsModule.newBinding}`) })).toBeInTheDocument();

    const chrome = [...document.querySelectorAll('[data-testid="wf-bindings-tabs"], .wf-bindings-events .section-eyebrow')];
    expect(chrome.length).toBeGreaterThan(1);
    expect(chrome.flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<BindingsModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.workflowBindings.bindingsModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('workflowBindings.bindingsModule.newBinding')).toBe('New binding');
    expect(englishT('workflowBindings.conditionBuilder.blockerOther')).toBe('{count} blockers');
    expect(englishT('workflowBindings.tabs.dispatches.label')).toBe('Dispatches');
    expect(lookup(ar, 'workflowBindings.bindingsModule.newBinding')).toBe('ربط جديد');
    expect(lookup(ar, 'workflowBindings.conditionBuilder.blockerOther')).toBe('{count} عوائق');
    expect(lookup(ar, 'workflowBindings.tabs.dispatches.label')).toBe('عمليات الإرسال');
  });
});
