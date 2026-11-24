// route-plans.arabic.test.tsx: route plans render their own copy in Arabic; seeded record values stay as data.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { RoutePlansModule } from '@/modules/operate/route-plans';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/dispatch';
import * as ds from '@/lib/data-source';
import * as supabase from '@/lib/supabase';
import { routePlanningListResource } from './__tests__/route-plans.fixtures';

const LIST_RESOURCE = ds.ui_list_resource_v1;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(supabase, 'rpc').mockResolvedValue([]);
  vi.spyOn(ds, 'ui_list_resource_v1').mockImplementation((key, opts) => routePlanningListResource(key, opts, LIST_RESOURCE));
});

describe('RoutePlansModule in Arabic', () => {
  it('renders the header actions and table column labels in Arabic', async () => {
    renderWithProviders(<RoutePlansModule />, { locale: 'ar', capabilities: ['all'] });
    await waitFor(() => expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: new RegExp(ar.routePlans.actions.newPlan) })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New plan/ })).toBeNull();

    const head = document.querySelector('.dt__table thead')?.textContent ?? '';
    for (const label of [ar.routePlans.columns.plan, ar.routePlans.columns.wave, ar.routePlans.columns.status]) {
      expect(head).toContain(label);
    }

    const chrome = [...document.querySelectorAll('.page-header__actions')];
    expect(chrome.length).toBeGreaterThan(0);
    expect(chrome.flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('keeps the English strings the trunk tests assert', () => {
    expect(englishT('routePlans.actions.newPlan')).toBe('New plan');
    expect(englishT('routePlans.actions.validateConstraints')).toBe('Validate constraints');
    expect(englishT('routePlans.denied')).toBe('You do not have permission to view route plans.');
    expect(ar.routePlans.actions.newPlan).not.toBe(englishT('routePlans.actions.newPlan'));
  });
});
