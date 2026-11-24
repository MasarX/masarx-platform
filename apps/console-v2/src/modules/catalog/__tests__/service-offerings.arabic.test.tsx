// service-offerings.arabic.test.tsx: service offerings and product context setup render their own copy in Arabic (issue #302).
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { ServiceOfferingsModule } from '@/modules/catalog/service-offerings';
import { ProductContextSetupForm } from '@/modules/catalog/product-context-setup';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/catalog-service-offerings';
import { ar as setupAr } from '@/lib/seed-raw/i18n/areas/catalog-product-context-setup';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

const copy = ar.catalogServiceOfferings.serviceOfferingsModule;

describe('ServiceOfferingsModule in Arabic', () => {
  it('renders the page header and KPI strip in Arabic', async () => {
    renderWithProviders(<ServiceOfferingsModule />, {
      locale: 'ar',
      capabilities: ['service_offerings.read', 'service_offerings.write'],
    });

    const title = await screen.findByRole('heading', { name: `${copy.service} ${copy.offeringsPricingSlaCatalog}` });
    expect(findUntranslated(title)).toEqual([]);
    const [kpi] = await screen.findAllByText(copy.totalOfferings);
    expect(findUntranslated(kpi)).toEqual([]);
    expect((await screen.findAllByText(copy.catalogAccessCatalogUpdate)).length).toBeGreaterThan(0);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<ServiceOfferingsModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(copy.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    const keys: Array<[string, string]> = [
      ['catalogServiceOfferings.serviceOfferingsModule.toggledOfferingsWithFailures', 'Toggled {ok} of {count} offerings ({fail} failed).'],
      ['catalogServiceOfferings.serviceOfferingsModule.archivedOfferings', 'Archived {ok} of {count} offerings.'],
      ['catalogServiceOfferings.serviceOfferingsModule.noServiceLevelsCreate', 'No service levels — create the first via "New level".'],
      ['catalogServiceOfferings.serviceLevelChipTitle.serviceLevelLabelNotLinked', 'Service level {label} is not linked'],
      ['catalogServiceOfferings.drawerTabs.slaTerms', 'SLA terms'],
      ['catalogServiceOfferings.coverageTab.branchName', 'branch · {name}'],
    ];
    for (const [key, english] of keys) {
      expect(englishT(key)).toBe(english);
      expect(lookup(ar, key)).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('ProductContextSetupForm in Arabic', () => {
  it('renders the setup form labels in Arabic', async () => {
    renderWithProviders(
      <ProductContextSetupForm
        levels={[]}
        branches={[]}
        zones={[]}
        offerings={[]}
        activeTenantId="tenant-synthetic"
        tenantTimezoneIana="Asia/Riyadh"
        tenantCurrencyIso="SAR"
        serviceLevelKeyFromName={(name) => name.toLowerCase()}
        isOfferingActive={() => true}
        offeringStatusDefault="active"
        onReady={vi.fn()}
        onCancel={vi.fn()}
      />,
      { locale: 'ar', capabilities: ['all'] },
    );

    const form = setupAr.catalogProductContextSetup.productContextSetupForm;
    const [label] = await screen.findAllByText(form.serviceLevelName);
    expect(findUntranslated(label)).toEqual([]);
    expect((await screen.findAllByText(form.provisionSetup)).length).toBeGreaterThan(0);
    expect(englishT('catalogProductContextSetup.productContextSetupForm.provisionSetup')).toBe('Provision setup');
  });
});
