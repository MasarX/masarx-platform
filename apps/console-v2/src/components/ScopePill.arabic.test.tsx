// ScopePill.arabic.test.tsx: the scope pill's name and title come from the EN/AR catalogs (#302 slice 28).
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { ar } from '@/lib/seed-raw/i18n/areas/scope';
import { ScopePill } from './ScopePill';

describe('ScopePill', () => {
  it('keeps the English name and title', () => {
    renderWithProviders(<ScopePill scopeType="tenant" />);
    expect(screen.getByTitle('Resolved from tenant scope')).toHaveTextContent('tenant');
  });

  it('renders the scope name and title in Arabic', () => {
    const { container } = renderWithProviders(<ScopePill scopeType="tenant" />, { locale: 'ar' });
    const pill = screen.getByTitle('مستمد من نطاق المستأجر');
    expect(pill).toHaveTextContent(ar.scopePill.type.tenant);
    expect(findUntranslated(container)).toEqual([]);
  });

  it('falls back to the raw token for a scope type the catalog does not know', () => {
    renderWithProviders(<ScopePill scopeType="unlisted_scope" />, { locale: 'ar' });
    expect(screen.getByTitle('مستمد من نطاق unlisted_scope')).toHaveTextContent('unlisted_scope');
  });
});
