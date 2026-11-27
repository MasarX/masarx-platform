// runs.arabic.test.tsx: the workflow run history renders its own copy in Arabic; run ids and template names stay as data.
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { RunsModule } from '@/modules/workflows/runs';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/workflow-runs';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('RunsModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/workflows/runs');
  });

  it('renders the run history tabs in Arabic', async () => {
    renderWithProviders(<RunsModule />, { locale: 'ar', capabilities: ['all'] });

    const tablist = await screen.findByRole('tablist', { name: ar.workflowRuns.runsModule.workflowRunsTabs });
    expect(screen.getByRole('tab', { name: ar.workflowRuns.tabs.runs.aria })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: ar.workflowRuns.tabs.schedules.aria })).toBeInTheDocument();
    expect(findUntranslated(tablist, ['cron'])).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<RunsModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.workflowRuns.runsModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('workflowRuns.tabs.triggers.label')).toBe('Triggers');
    expect(englishT('workflowRuns.runsModule.runHistoryStepTimeline')).toBe('Run history · step timeline');
    expect(englishT('workflowRuns.runsModule.workflowRunInspectedOther')).toBe('{count} workflow runs inspected');
    expect(lookup(ar, 'workflowRuns.tabs.triggers.label')).toBe('المشغّلات');
    expect(lookup(ar, 'workflowRuns.runsModule.runHistoryStepTimeline')).toBe('سجل التشغيل · المخطط الزمني للخطوات');
  });
});
