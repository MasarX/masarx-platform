// CapabilityLock.arabic.test.tsx: permission phrases and capability names come from the EN/AR catalogs (#393).
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { CAP, formatCapabilityLabel, formatCapabilityRequirement, formatCapabilityTitle } from '@/lib/capabilities';
import { ar } from '@/lib/seed-raw/i18n/areas/capabilities';
import { CapabilityLock } from './CapabilityLock';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

const arT = (path: string, fallback?: string) => {
  const value = lookup(ar, path);
  return typeof value === 'string' ? value : (fallback ?? path);
};

describe('permission messages', () => {
  it('reads the same English phrases as before', () => {
    expect(formatCapabilityRequirement(CAP.USERS_READ)).toBe('User Access permission required');
    expect(formatCapabilityTitle(CAP.USERS_READ)).toBe('Requires user access permission');
    expect(formatCapabilityLabel('addresses.read', { titleCase: true })).toBe('Addresses Read');
    expect(formatCapabilityLabel(null)).toBe('permission');
  });

  it('reads Arabic phrases from the catalog', () => {
    expect(formatCapabilityRequirement(CAP.USERS_READ, arT)).toBe('يلزم إذن الوصول إلى المستخدمين');
    expect(formatCapabilityTitle(CAP.USER_DEVICES_READ, arT)).toBe('يتطلب إذن الوصول إلى الأجهزة');
    expect(formatCapabilityRequirement(null, arT)).toBe('يلزم إذن هذا الإجراء');
  });

  it('gives every capability key an Arabic label', () => {
    const missing = Object.values(CAP).filter(
      (key) => key.includes('.') && typeof lookup(ar, `capabilities.labels.${key}`) !== 'string',
    );
    expect(missing).toEqual([]);
  });

  it('renders the lock in Arabic', () => {
    renderWithProviders(<CapabilityLock capability={CAP.USERS_READ} />, { locale: 'ar' });
    const lock = screen.getByText('يلزم إذن الوصول إلى المستخدمين').closest('.cap-lock');
    expect(lock).toHaveAttribute('title', 'يتطلب إذن الوصول إلى المستخدمين');
    expect(findUntranslated()).toEqual([]);
  });
});
