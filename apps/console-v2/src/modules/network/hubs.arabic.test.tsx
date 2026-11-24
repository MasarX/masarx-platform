// hubs.arabic.test.tsx: the deprecated hubs page renders its own copy in Arabic; the canonical table and column tokens stay as data.
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/customers-network';
import { HubsModule } from './hubs';

// The module redirects on mount; the test harness has no RouterProvider, so useNavigate is stubbed as in route-integration.test.tsx.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
}));

describe('HubsModule in Arabic', () => {
  it('renders the deprecation notice in Arabic', () => {
    const { container } = renderWithProviders(<HubsModule />, { locale: 'ar', capabilities: ['all'] });
    expect(screen.getByText(ar.hubs.moved.title)).toBeInTheDocument();
    expect(findUntranslated(container, ["branches.type='hub'"])).toEqual([]);
  });

  it('keeps the English strings the trunk test asserts', () => {
    expect(englishT('hubs.moved.title')).toBe('This surface moved');
    expect(englishT('hubs.deprecated')).toBe('deprecated');
    expect(ar.hubs.moved.title).toBe('انتقلت هذه الصفحة');
  });
});
