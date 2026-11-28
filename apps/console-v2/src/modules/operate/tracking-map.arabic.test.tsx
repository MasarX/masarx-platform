// tracking-map.arabic.test.tsx: the tracking map renders its own copy in Arabic; seeded record values stay as data.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { TrackingMapModule } from '@/modules/operate/tracking-map';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/dispatch';

describe('TrackingMapModule in Arabic', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the header actions, pills and sidebar heading in Arabic', async () => {
    renderWithProviders(<TrackingMapModule />, { locale: 'ar', capabilities: ['all'] });
    await waitFor(() => expect(document.querySelector('.map-canvas')).not.toBeNull());
    expect(screen.getByText(ar.trackingMap.pills.category)).toBeInTheDocument();
    expect(screen.queryByText('Clustering policy')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Clustering: \d+px grid/);

    const chrome = [...document.querySelectorAll('.page-header__actions, .section-eyebrow')];
    expect(chrome.length).toBeGreaterThan(1);
    expect(chrome.flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('keeps the English strings the trunk tests assert', () => {
    expect(englishT('trackingMap.pills.category')).toBe('Clustering policy');
    expect(englishT('trackingMap.legendOther')).toBe('Clustering: {grid}px grid, {n} shipments minimum. Click a cluster to zoom.');
    expect(ar.trackingMap.pills.category).not.toBe(englishT('trackingMap.pills.category'));
  });
});
