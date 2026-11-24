// templates.arabic.test.tsx: the workflow template studio renders its own copy in Arabic; template names and step data stay as data.
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { TemplatesModule } from '@/modules/workflows/templates';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/workflow-templates';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('TemplatesModule in Arabic', () => {
  it('renders the studio brand and palette tabs in Arabic', async () => {
    renderWithProviders(<TemplatesModule />, { locale: 'ar', capabilities: ['all'] });

    await waitFor(() => expect(screen.getByText(ar.workflowTemplates.topbar.title)).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: ar.workflowTemplates.palette.operations })).toBeInTheDocument();

    const chrome = [...document.querySelectorAll('.wf-topbar__brand, .wf-palette__tabs')];
    expect(chrome.length).toBe(2);
    expect(chrome.flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<TemplatesModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.workflowTemplates.header.denied)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('workflowTemplates.topbar.title')).toBe('Template Studio');
    expect(englishT('workflowTemplates.inputs.exprPlaceholder')).toBe('Drop variable here or type {{ expression }}');
    expect(englishT('workflowTemplates.card.runs')).toBe('{count} runs');
    expect(lookup(ar, 'workflowTemplates.topbar.title')).toBe('استوديو القوالب');
    expect(lookup(ar, 'workflowTemplates.inputs.exprPlaceholder')).toBe('أسقط متغيرًا هنا أو اكتب {{ expression }}');
    expect(lookup(ar, 'workflowTemplates.card.runs')).toBe('{count} عمليات تشغيل');
  });
});
