// templates.arabic.test.tsx: the workflow template studio renders its own copy in Arabic; template names and step data stay as data.
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { TemplatesModule } from '@/modules/workflows/templates';
import { englishT, fill } from '@/lib/i18n';
import * as apiMod from '@/lib/api';
import { typedSpy } from '@/test/helpers/typed-spy';
import ar from '@/lib/seed-raw/i18n/areas/ar/workflow-templates';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('TemplatesModule in Arabic', () => {
  it('renders the studio brand and palette tabs in Arabic', async () => {
    renderWithProviders(<TemplatesModule />, { locale: 'ar', capabilities: ['all'] });

    await waitFor(() => expect(screen.getByText(ar.workflowTemplates.topbar.title)).toBeInTheDocument());
    // The palette renders once the templates load.
    expect(await screen.findByRole('tab', { name: ar.workflowTemplates.palette.operations })).toBeInTheDocument();

    const chrome = [...document.querySelectorAll('.wf-topbar__brand, .wf-palette__tabs')];
    expect(chrome.length).toBe(2);
    expect(chrome.flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<TemplatesModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.workflowTemplates.header.denied)).toBeInTheDocument();
  });

  it('builds fallback step labels and template codes from the Arabic catalog', async () => {
    const templateId = 'tpl_ar_fallbacks';
    const originalListResource = apiMod.ui_list_resource_v1;
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    const page = (rows: Array<Record<string, unknown>>) =>
      Promise.resolve({ rows, total: rows.length, page: 0, page_size: 200 } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>);
    listSpy.mockImplementation((resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
      if (resource === 'workflow_templates') {
        // A binding template with no template code and a step with no label or operation.
        return page([{
          id: templateId,
          template_key: 'workflow_binding.pickup.dispatch',
          status: 'active',
          version: '',
          metadata: { binding_key: 'pickup', stage_key: 'dispatch' },
          steps: [{ id: 'step_ar_fallback', workflow_template_id: templateId, sequence_order: 1 }],
        }]);
      }
      if (resource === 'workflow_template_directory' || resource === 'workflow_runs' || resource === 'recent_workflow_events') {
        return page([]);
      }
      return originalListResource(resource, opts);
    });
    try {
      renderWithProviders(<TemplatesModule />, { locale: 'ar', capabilities: ['all'] });

      const code = fill(ar.workflowTemplates.palette.stageFlow, { stage: 'Dispatch' });
      await waitFor(() => expect(document.querySelector(`.wf-tpl-card [title="${code}"]`)).not.toBeNull());
      expect(findUntranslated(document.querySelector(`.wf-tpl-card [title="${code}"]`)!, ['Dispatch'])).toEqual([]);

      const stepLabels = await screen.findAllByText(fill(ar.workflowTemplates.canvas.stepFallback, { ref: '1' }));
      expect(stepLabels.flatMap((element) => findUntranslated(element))).toEqual([]);
    } finally {
      listSpy.mockRestore();
    }
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('workflowTemplates.canvas.stepFallback')).toBe('Step {ref}');
    expect(englishT('workflowTemplates.palette.stageFlow')).toBe('{stage} flow');
    expect(englishT('workflowTemplates.palette.workflowCode')).toBe('Workflow');
    expect(lookup(ar, 'workflowTemplates.canvas.stepFallback')).toBe('الخطوة {ref}');
    expect(lookup(ar, 'workflowTemplates.palette.stageFlow')).toBe('مسار {stage}');
    expect(lookup(ar, 'workflowTemplates.palette.workflowCode')).toBe('سير العمل');
    expect(englishT('workflowTemplates.topbar.title')).toBe('Template Studio');
    expect(englishT('workflowTemplates.inputs.exprPlaceholder')).toBe('Drop variable here or type {{ expression }}');
    expect(englishT('workflowTemplates.card.runs')).toBe('{count} runs');
    expect(lookup(ar, 'workflowTemplates.topbar.title')).toBe('استوديو القوالب');
    expect(lookup(ar, 'workflowTemplates.inputs.exprPlaceholder')).toBe('أسقط متغيرًا هنا أو اكتب {{ expression }}');
    expect(lookup(ar, 'workflowTemplates.card.runs')).toBe('{count} عمليات تشغيل');
  });
});
