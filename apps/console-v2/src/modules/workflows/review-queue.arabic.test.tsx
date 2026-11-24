// review-queue.arabic.test.tsx: the review queue renders its filters and empty states in Arabic; task ids and subjects stay as data.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { ReviewQueueModule } from '@/modules/workflows/review-queue';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/workflow-review-queue';

vi.mock('@/lib/supabase', () => ({
  getSupabaseClient: () => null,
}));

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('ReviewQueueModule in Arabic', () => {
  beforeEach(() => {
    window.localStorage.removeItem('console-v2.review-queue.views');
    window.history.pushState(null, '', '/workflows/review-queue');
  });

  it('renders the filter chips in Arabic', async () => {
    renderWithProviders(<ReviewQueueModule />, {
      locale: 'ar',
      capabilities: ['tasks.read', 'tasks.write', 'tasks.complete', 'audit_log.read', 'console_metadata.read'],
    });

    await screen.findByRole('button', { name: new RegExp(ar.workflowReviewQueue.filters.mine) });
    expect(screen.getByRole('button', { name: new RegExp(ar.workflowReviewQueue.filters.breach) })).toBeInTheDocument();
    const chips = [...document.querySelectorAll('.wf-rq-filterchip:not(.wf-rq-filterchip--saved)')];
    expect(chips.length).toBe(5);
    expect(chips.flatMap((chip) => findUntranslated(chip))).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<ReviewQueueModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.workflowReviewQueue.reviewQueueModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('workflowReviewQueue.filters.mine')).toBe('Assigned to me');
    expect(englishT('workflowReviewQueue.reviewQueueModule.taskCountOther')).toBe('{count} tasks');
    expect(lookup(ar, 'workflowReviewQueue.filters.mine')).toBe('المُسندة إليّ');
    expect(lookup(ar, 'workflowReviewQueue.sortModes.sla_due')).toBe('موعد اتفاقية مستوى الخدمة');
  });
});
