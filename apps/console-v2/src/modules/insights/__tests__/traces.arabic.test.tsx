// traces.arabic.test.tsx: the activity history page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { TracesModule } from '@/modules/insights/traces';
import { englishT, fill } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/insights-traces';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

/** Runs the shared untranslated check on one filled template; `data` names the values the test supplied. */
function untranslatedIn(text: string, data: readonly string[]): string[] {
  const node = document.createElement('span');
  node.textContent = text;
  return findUntranslated(node, data);
}

describe('TracesModule in Arabic', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the page header and lookup in Arabic', async () => {
    renderWithProviders(<TracesModule />, { locale: 'ar', capabilities: ['observability.read'] });

    const [accent] = await screen.findAllByText(ar.insightsTraces.tracesModule.activity);
    expect(findUntranslated(accent)).toEqual([]);
    expect(screen.getAllByText(ar.insightsTraces.tracesModule.titlePlain).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: ar.insightsTraces.tracesModule.findActivity })).toBeInTheDocument();
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<TracesModule />, { locale: 'ar', capabilities: ['shipments.read'] });
    expect(await screen.findByText(ar.insightsTraces.tracesModule.youNeedActivityHistory)).toBeInTheDocument();
  });

  it.each([
    ['insightsTraces.tracesModule.titlePlain', 'history'],
    ['insightsTraces.eventDrawerBody.event', 'Event: {value}'],
    ['insightsTraces.workflowRunCard.workflowTemplate', 'Workflow: Recorded · Template: {value}'],
    ['insightsTraces.tracesModule.activityReferenceValue', 'Activity reference: {value}'],
  ])('keeps the English copy for %s and has Arabic', (key, english) => {
    expect(englishT(key)).toBe(english);
    expect(lookup(ar, key)).toMatch(/[؀-ۿ]/);
  });

  it.each([
    ['observabilityRow.durationMs', { ms: '12' }, '12ms'],
    ['observabilityRow.eventEventTypeDurms', { event_type: 'shipment.created', durMs: '12' }, 'Event shipment.created, 12 ms'],
    ['eventDrawerBody.durationMs', { ms: '12' }, '12ms'],
    ['eventDrawerBody.additionalDetailsCountOne', { count: '1' }, '1 additional detail recorded for support review.'],
    ['eventDrawerBody.additionalDetailsCount', { count: '3' }, '3 additional details recorded for support review.'],
    ['tracesModule.totalMs', { ms: '1,250' }, 'total · 1,250ms'],
    ['tracesModule.totalValueMs', { value: '1,250' }, ' · total 1,250ms'],
    ['tracesModule.eventCounts', { events: '4', domain: '2', workflows: '1' }, '4 events · 2 domain · 1 workflows'],
  ])('fills %s in English and has no English left in Arabic', (key, values, english) => {
    expect(fill(englishT(`insightsTraces.${key}`), values)).toBe(english);
    expect(untranslatedIn(fill(String(lookup(ar.insightsTraces, key)), values), Object.values(values))).toEqual([]);
  });

  it('fills the drawer templates in both languages', () => {
    expect(fill(englishT('insightsTraces.eventDrawerBody.duration'), { value: '12ms' })).toBe('Duration: 12ms');
    expect(fill(ar.insightsTraces.eventDrawerBody.duration, { value: '12ms' })).toContain('12ms');
  });
});
