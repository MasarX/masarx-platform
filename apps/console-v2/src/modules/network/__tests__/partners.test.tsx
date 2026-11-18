// partners.test.tsx — covers the enriched PartnersModule behavior (claim H):
//   • renders the four-KPI strip and shows balance + listings counts.
//   • opens a partner drawer with chip header + KvGrid + insets + quick links.
//   • partner row click is wired through useDrawer (drawer.node mounted).
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { CAP } from '@/lib/capabilities';
import { PartnersModule } from '../partners';

describe('PartnersModule (claim H)', () => {
  it('denies partner roster on the canonical marketplace read gate', async () => {
    renderWithProviders(<PartnersModule />, {
      capabilities: [CAP.FINANCE_READ],
    });

    expect(await screen.findByText('You cannot view this here')).toBeInTheDocument();
    expect(screen.getByText(/marketplace\.read/i)).toBeInTheDocument();
  });

  it('renders the partners KPI strip', async () => {
    renderWithProviders(<PartnersModule />);
    await waitFor(() =>
      expect(screen.getByText('Active listings')).toBeInTheDocument()
    );
    expect(screen.getByText('Pending compliance')).toBeInTheDocument();
    expect(screen.getByText('Total balance')).toBeInTheDocument();
    expect(screen.getByText('Open disputes')).toBeInTheDocument();
  });

  it('renders partner roster with balance column header', async () => {
    renderWithProviders(<PartnersModule />);
    await waitFor(() => expect(screen.getByText(/Exampledepot/i)).toBeInTheDocument());
    expect(screen.getByText(/Balance \(SAR\)/i)).toBeInTheDocument();
  });

  it('opens a partner drawer on row click with insets', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PartnersModule />);
    const exampledepot = await screen.findByText(/Exampledepot/i);
    await user.click(exampledepot);
    const titles = await screen.findAllByText(/Partner · Exampledepot/i);
    expect(titles.length).toBeGreaterThan(0);
    // The drawer renders Contracts + Disputes section eyebrows and a unique
    // "Quick links" label. KvGrid labels collide with column headers, so we
    // assert with getAllByText where overlap is expected.
    expect(screen.getAllByText('Contracts').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Disputes').length).toBeGreaterThan(0);
    expect(screen.getByText('Quick links')).toBeInTheDocument();
  });

  it('opens partner-scoped Finance quick links from the drawer', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PartnersModule />);
    const exampledepot = await screen.findByText(/Exampledepot/i);
    await user.click(exampledepot);
    await screen.findByText('Quick links');

    await user.click(screen.getByRole('button', { name: /^Settlements$/i }));
    await waitFor(() => {
      expect(window.location.pathname).toBe('/finance/settlements');
      expect(new URLSearchParams(window.location.search).get('partner')).toBe('mpp_exampledepot');
    });

    await user.click(screen.getByRole('button', { name: /^Disputes$/i }));
    await waitFor(() => {
      expect(window.location.pathname).toBe('/finance/disputes');
      expect(new URLSearchParams(window.location.search).get('partner')).toBe('mpp_exampledepot');
    });

    await user.click(screen.getByRole('button', { name: /^Ledger$/i }));
    await waitFor(() => {
      expect(window.location.pathname).toBe('/finance/ledger');
      expect(new URLSearchParams(window.location.search).get('partner')).toBe('mpp_exampledepot');
    });
  });
});
